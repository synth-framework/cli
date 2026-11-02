import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSource = join(repository, 'fixtures', 'adoption-project');
let sandbox;
let installedTemplate;
let fixtureNumber = 0;

function npm(args, cwd) {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_cache: join(sandbox, 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  assert.equal(result.error, undefined, `npm could not start: ${result.error}`);
  assert.equal(result.status, 0, `npm ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function pathEntryExists(location) {
  try {
    lstatSync(location);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertIsolatedSandbox(location) {
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) {
    assert.ok(process.env[name] === undefined, `Installed fixture requires ${name} to be unset.`);
  }
  const fromRepository = relative(realpathSync(repository), location);
  assert.ok(
    fromRepository === '..' || fromRepository.startsWith(`..${sep}`),
    `Installed fixture must be outside the checkout: ${location}`,
  );
  for (let ancestor = location; ; ancestor = dirname(ancestor)) {
    assert.ok(!pathEntryExists(join(ancestor, '.git')), `Installed fixture must not inherit a Git worktree: ${ancestor}`);
    // Git directories can be discovered without a .git marker. This is a
    // conservative layout check, not a complete Git discovery implementation.
    const gitLayout = pathEntryExists(join(ancestor, 'HEAD')) && (
      pathEntryExists(join(ancestor, 'commondir')) ||
      (pathEntryExists(join(ancestor, 'objects')) && pathEntryExists(join(ancestor, 'refs')))
    );
    assert.ok(!gitLayout, `Installed fixture must not inherit Git repository metadata: ${ancestor}`);
    if (dirname(ancestor) === ancestor) break;
  }
}

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'synth-installed-test-')));
  try {
    assertIsolatedSandbox(sandbox);
  } catch (error) {
    rmSync(sandbox, { recursive: true, force: true });
    sandbox = undefined;
    throw error;
  }
  const packOutput = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', sandbox], repository);
  const pack = JSON.parse(packOutput);
  assert.equal(pack.length, 1);
  const tarball = join(sandbox, pack[0].filename);
  installedTemplate = join(sandbox, 'installed-fixture');
  cpSync(fixtureSource, installedTemplate, { recursive: true, verbatimSymlinks: true });
  const packageBefore = readFileSync(join(installedTemplate, 'package.json'), 'utf8');
  npm(
    ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--no-package-lock', tarball],
    installedTemplate,
  );
  assert.equal(readFileSync(join(installedTemplate, 'package.json'), 'utf8'), packageBefore);
  assert.ok(existsSync(join(installedTemplate, 'node_modules', '.bin', 'synth')));
  assert.equal(existsSync(join(installedTemplate, '.git')), false);
});

after(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function fixture() {
  const destination = join(sandbox, `fixture-${++fixtureNumber}`);
  cpSync(installedTemplate, destination, { recursive: true, verbatimSymlinks: true });
  const resolvedBinary = realpathSync(join(destination, 'node_modules', '.bin', 'synth'));
  assert.ok(resolvedBinary.startsWith(`${destination}${sep}`), 'fixture must use its own installed package');
  return destination;
}

function executable(directory) {
  return join(directory, 'node_modules', '.bin', 'synth');
}

function run(directory, args, options = {}) {
  const result = spawnSync(executable(directory), args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, `CLI could not run: ${result.error}`);
  return result;
}

function runWithPreload(directory, preload, args, options = {}) {
  const result = spawnSync(process.execPath, ['--require', preload, executable(directory), ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined, `CLI could not run: ${result.error}`);
  return result;
}

function jsonSuccess(result, command) {
  assert.equal(result.status, 0, `expected success; stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputVersion, 1);
  assert.equal(payload.ok, true);
  if (command) assert.equal(payload.command, command);
  return payload.data;
}

function jsonFailure(result, exitCode, code) {
  assert.equal(result.status, exitCode, `unexpected failure; stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.equal(result.stdout, '');
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.outputVersion, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  assert.equal(typeof payload.error.message, 'string');
  return payload;
}

function recordFile(directory) {
  return join(directory, '.synth', 'work.json');
}

function initialize(directory, intention = 'Make note titles predictable') {
  return jsonSuccess(run(directory, ['init', '--intent', intention, '--json']), 'init');
}

function snapshotTree(directory) {
  const entries = [];
  function walk(path) {
    const stat = lstatSync(path, { bigint: true });
    const item = {
      path: relative(directory, path) || '.',
      mode: String(stat.mode),
      modified: String(stat.mtimeNs),
    };
    if (stat.isSymbolicLink()) {
      item.type = 'symlink';
      item.target = readlinkSync(path);
    } else if (stat.isDirectory()) {
      item.type = 'directory';
      entries.push(item);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
      return;
    } else if (stat.isFile()) {
      item.type = 'file';
      item.hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    } else {
      item.type = 'other';
    }
    entries.push(item);
  }
  walk(directory);
  return entries;
}

function probeSandboxSetup(tempDirectory, extraEnv = {}) {
  const probe = mkdtempSync(join(sandbox, 'sandbox-probe-'));
  const bin = join(probe, 'bin');
  mkdirSync(bin);
  const marker = join(probe, 'npm-ran');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\n: > "$SYNTH_TEST_NPM_MARKER"\nexit 97\n', { mode: 0o755 });
  const target = '^minimal intention works in the independent, non-Git fixture and shows missing context$';
  const env = {
    ...process.env,
    ...extraEnv,
    NODE_OPTIONS: '',
    TMPDIR: tempDirectory,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    SYNTH_TEST_NPM_MARKER: marker,
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${target}`, fileURLToPath(import.meta.url)], {
    cwd: repository,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  assert.equal(result.error, undefined, `Sandbox probe could not run: ${result.error}`);
  assert.notEqual(result.status, 0, `An unsafe sandbox unexpectedly passed setup:\n${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(marker), false, 'Unsafe setup reached npm before rejecting the sandbox.');
  return `${result.stdout}\n${result.stderr}`;
}

test('fixture setup rejects TMPDIR inside the checkout before invoking npm', () => {
  const root = realpathSync(repository);
  const alias = join(sandbox, 'checkout-alias');
  symlinkSync(root, alias, 'dir');
  const existing = readdirSync(root).filter((name) => name.startsWith('synth-installed-test-')).sort();
  for (const tempDirectory of [root, alias]) {
    assert.match(probeSandboxSetup(tempDirectory), /Installed fixture must be outside the checkout/);
  }
  assert.deepEqual(readdirSync(root).filter((name) => name.startsWith('synth-installed-test-')).sort(), existing);
});

test('fixture setup rejects an unrelated Git ancestor before invoking npm', () => {
  for (const markerKind of ['directory', 'file']) {
    const parent = join(sandbox, `unrelated-worktree-${markerKind}`);
    mkdirSync(parent);
    if (markerKind === 'directory') mkdirSync(join(parent, '.git'));
    else writeFileSync(join(parent, '.git'), 'gitdir: /example/other-git-directory\n');
    assert.match(probeSandboxSetup(parent), /Installed fixture must not inherit a Git worktree/);
    assert.deepEqual(readdirSync(parent), ['.git']);
  }
});

test('fixture setup rejects an unrelated bare Git repository ancestor before invoking npm', () => {
  for (const layout of ['standard', 'common-directory']) {
    const parent = join(sandbox, `unrelated-bare-${layout}`);
    const common = layout === 'standard' ? parent : join(sandbox, 'unrelated-common-directory');
    mkdirSync(parent);
    if (common !== parent) mkdirSync(common);
    mkdirSync(join(common, 'objects'));
    mkdirSync(join(common, 'refs'));
    writeFileSync(join(common, 'config'), '[core]\n\trepositoryformatversion = 0\n\tbare = true\n');
    writeFileSync(join(parent, 'HEAD'), 'ref: refs/heads/unborn\n');
    if (common !== parent) writeFileSync(join(parent, 'commondir'), `${common}\n`);
    assert.match(probeSandboxSetup(parent), /Installed fixture must not inherit Git repository metadata/);
    assert.deepEqual(
      readdirSync(parent).sort(),
      layout === 'standard' ? ['HEAD', 'config', 'objects', 'refs'] : ['HEAD', 'commondir'],
    );
  }
});

test('fixture setup rejects inherited Git discovery overrides before invoking npm', () => {
  const parent = join(sandbox, 'git-environment-probe');
  mkdirSync(parent);
  const gitDirectory = join(realpathSync(repository), '.git');
  const overrides = [
    ['GIT_DIR', gitDirectory],
    ['GIT_WORK_TREE', gitDirectory],
    ['GIT_COMMON_DIR', gitDirectory],
    ['GIT_OBJECT_DIRECTORY', gitDirectory],
    ['GIT_DIR', ''],
    ['GIT_OBJECT_DIRECTORY', ''],
  ];
  for (const [name, value] of overrides) {
    assert.match(probeSandboxSetup(parent, { [name]: value }), new RegExp(`Installed fixture requires ${name} to be unset`));
    assert.deepEqual(readdirSync(parent), []);
  }
});

test('minimal intention works in the independent, non-Git fixture and shows missing context', () => {
  const dir = fixture();
  assert.equal(existsSync(join(dir, '.git')), false);
  const created = initialize(dir, 'Explore title behavior');
  assert.equal(created.record.schemaVersion, 3);
  assert.equal(created.record.originalIntention, 'Explore title behavior');
  assert.deepEqual(created.record.entries, []);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.originalIntention, 'Explore title behavior');
  assert.deepEqual(handoff.criteria, []);
  assert.ok(handoff.missingContext.includes('outcomes'));
  assert.ok(handoff.missingContext.includes('scope'));
  assert.ok(handoff.missingContext.includes('criteria'));
  assert.ok(handoff.missingContext.includes('questions'));
  assert.deepEqual(handoff.capabilities, {
    checks: 'available',
    evidence: 'available',
    evaluation: 'available',
    revisions: 'available',
    baselines: 'available',
    driftAssessment: 'available',
    acceptance: 'not_available',
    questionResolution: 'not_available',
    gapAndActionResolution: 'not_available',
    planAndDecisionSupersession: 'not_available',
  });
  const human = run(dir, ['handoff']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Desired outcome: not recorded\./);
  assert.match(human.stdout, /Verification: unverified/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(recordFile(dir)).mode & 0o077, 0);
    assert.equal(statSync(join(dir, '.synth')).mode & 0o077, 0);
  }
});

test('separate processes recover, answer, and extend the recorded handoff without gates', () => {
  const dir = fixture();
  initialize(dir, 'Make note titles predictable');
  // A gap and decision may precede a criterion; no phase is locked.
  const entries = [
    { kind: 'gap', text: 'No behavior evidence is recorded' },
    { kind: 'decision', text: 'Limit the work to title behavior', reason: 'Keep the change bounded' },
    { kind: 'decision', text: 'Prefer a small change' },
    { kind: 'question', text: 'Should internal whitespace collapse?' },
    { kind: 'criterion', text: 'Whitespace-only titles remain empty' },
    { kind: 'outcome', text: 'Titles behave predictably' },
    { kind: 'scope', text: 'Title normalization' },
    { kind: 'constraint', text: 'Use the existing Node tools' },
    { kind: 'non-goal', text: 'Change unrelated storage' },
    { kind: 'assumption', text: 'Titles arrive as strings' },
    { kind: 'plan', text: 'Inspect the existing behavior' },
    { kind: 'update', text: 'No implementation work has been recorded' },
    { kind: 'work-ref', text: 'src/title.js' },
    { kind: 'next', text: 'Clarify the whitespace behavior' },
  ];
  const added = jsonSuccess(run(dir, ['add', '--stdin', '--json'], { input: JSON.stringify(entries) }), 'add');
  assert.equal(added.entries.length, entries.length);
  assert.equal(added.entries.find((entry) => entry.kind === 'criterion').id, 'C1');
  assert.equal(added.entries.find((entry) => entry.kind === 'question').id, 'Q1');
  const first = jsonSuccess(run(dir, ['--json', 'handoff']), 'handoff').handoff;
  assert.equal(first.questions[0].state, 'unanswered');
  assert.equal(first.criteria[0].evaluation, 'unverified');
  assert.equal(first.decisions[0].reason, 'Keep the change bounded');
  assert.equal(first.decisions[1].reason, null);
  assert.equal(first.workReferences[0].text, 'src/title.js');
  assert.equal(first.gaps[0].text, 'No behavior evidence is recorded');
  assert.deepEqual(first.missingContext, ['verification']);

  jsonSuccess(run(dir, ['add', 'answer', '--question', 'Q1', '--text', 'Keep internal whitespace', '--reason', 'Developer clarified', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'answer', '--question', 'Q1', '--text', 'Keep internal whitespace, including tabs', '--reason', 'Clarified further', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'next', '--text', 'Inspect src/title.js', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'update', '--text', 'N1 was addressed by the recorded answer; N2 is next', '--json']), 'add');
  const resumed = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(resumed.originalIntention, 'Make note titles predictable');
  assert.equal(resumed.questions[0].state, 'response_recorded');
  assert.deepEqual(resumed.questions[0].answers.map((answer) => answer.id), ['ANS1', 'ANS2']);
  assert.equal(resumed.questions[0].answers[0].reason, 'Developer clarified');
  assert.equal(resumed.nextActions[1].id, 'N2');
  assert.equal(resumed.nextActions[1].text, 'Inspect src/title.js');
  assert.equal(resumed.updates[1].text, 'N1 was addressed by the recorded answer; N2 is next');
  assert.equal(resumed.criteria[0].evaluation, 'unverified');
  const human = run(dir, ['handoff']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /C1 \[unverified\]/);
  assert.match(human.stdout, /Q1 \[response recorded\]/);
  assert.match(human.stdout, /Reason: not recorded\./);
  assert.match(human.stdout, /Work references \(not inspected\)/);
  assert.match(human.stdout, /Next-action notes \(not automatically completed\)/);
  assert.match(human.stdout, /N1 was addressed by the recorded answer; N2 is next/);
});

test('a recorded response does not assert that an unknown is resolved', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'question', '--text', 'What happens at the boundary?', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'answer', '--question', 'Q1', '--text', 'Still unknown', '--json']), 'add');
  const question = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff.questions[0];
  assert.equal(question.state, 'response_recorded');
  assert.equal(question.answers[0].text, 'Still unknown');
  assert.equal('resolved' in question, false);
  const status = run(dir, ['status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /A recorded response does not establish that a question is resolved/);
});

test('a fresh process can choose and record a next action using only the handoff', () => {
  const dir = fixture();
  initialize(dir, 'Make title behavior clear');
  jsonSuccess(run(dir, ['add', '--stdin', '--json'], {
    input: JSON.stringify([
      { kind: 'criterion', text: 'Blank titles remain empty' },
      { kind: 'question', text: 'Should internal whitespace collapse?' },
      { kind: 'decision', text: 'Keep the work bounded', reason: 'Avoid unrelated changes' },
      { kind: 'gap', text: 'Behavior is not verified' },
    ]),
  }), 'add');
  // The consumer has no task-specific inputs; it reads the installed CLI's handoff.
  const readerScript = `
    const { spawnSync } = require('node:child_process');
    const cli = './node_modules/.bin/synth';
    function call(args) {
      const result = spawnSync(cli, args, { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return JSON.parse(result.stdout).data;
    }
    const h = call(['handoff', '--json']).handoff;
    const question = h.questions.find(item => item.state === 'unanswered');
    if (!question) throw new Error('No unanswered question in the handoff');
    const next = 'Clarify ' + question.id + ': ' + question.text;
    call(['add', 'next', '--text', next, '--json']);
    process.stdout.write(JSON.stringify({ intention: h.originalIntention, criteria: h.criteria.map(item => item.id), gap: h.gaps[0].text, next }));
  `;
  const reader = spawnSync(process.execPath, ['-e', readerScript], { cwd: dir, encoding: 'utf8', timeout: 15_000 });
  assert.equal(reader.error, undefined);
  assert.equal(reader.status, 0, reader.stderr);
  assert.deepEqual(JSON.parse(reader.stdout), {
    intention: 'Make title behavior clear',
    criteria: ['C1'],
    gap: 'Behavior is not verified',
    next: 'Clarify Q1: Should internal whitespace collapse?',
  });
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.nextActions[0].text, 'Clarify Q1: Should internal whitespace collapse?');
});

test('status, handoff, help, and version do not write files, with or without a record', () => {
  const dir = fixture();
  const beforeMissing = snapshotTree(dir);
  jsonFailure(run(dir, ['status', '--json']), 3, 'RECORD_NOT_FOUND');
  jsonFailure(run(dir, ['handoff', '--json']), 3, 'RECORD_NOT_FOUND');
  jsonSuccess(run(dir, ['--help', '--json']), 'help');
  const version = jsonSuccess(run(dir, ['--version', '--json']), 'version');
  assert.equal(version.version, JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version);
  assert.deepEqual(snapshotTree(dir), beforeMissing);
  assert.equal(existsSync(join(dir, '.synth')), false);

  initialize(dir);
  const beforeExisting = snapshotTree(dir);
  const status = jsonSuccess(run(dir, ['status', '--json']), 'status').handoff;
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(status, handoff);
  assert.equal(run(dir, ['status']).status, 0);
  assert.equal(run(dir, ['handoff']).status, 0);
  assert.deepEqual(snapshotTree(dir), beforeExisting);
});

test('unknown and malformed commands produce structured usage errors without creating state', () => {
  const dir = fixture();
  const before = snapshotTree(dir);
  for (const name of ['unknown', 'constructor', 'toString', '__proto__']) {
    jsonFailure(run(dir, [name, '--json']), 2, 'USAGE_ERROR');
  }
  jsonFailure(run(dir, ['init', '--intent', '  ', '--json']), 2, 'USAGE_ERROR');
  jsonFailure(run(dir, ['status', '--text', 'not allowed', '--json']), 2, 'USAGE_ERROR');
  jsonFailure(run(dir, ['status', '--json', '--json']), 2, 'USAGE_ERROR');
  assert.deepEqual(snapshotTree(dir), before);
  assert.equal(existsSync(join(dir, '.synth')), false);
});

test('explicit record paths work without discovering or creating a default record', () => {
  const dir = fixture();
  const custom = join(dir, 'another workspace', 'item.json');
  jsonSuccess(run(dir, ['--record', custom, 'init', '--intent', 'A separate work item', '--json']), 'init');
  assert.ok(existsSync(custom));
  assert.equal(existsSync(join(dir, '.synth')), false);
  const data = jsonSuccess(run(dir, ['handoff', '--json', '--record', custom]), 'handoff');
  assert.equal(data.handoff.originalIntention, 'A separate work item');
  jsonFailure(run(dir, ['status', '--json']), 3, 'RECORD_NOT_FOUND');
  const alias = join(dir, 'record-link.json');
  symlinkSync(custom, alias);
  jsonFailure(run(dir, ['status', '--record', alias, '--json']), 3, 'IO_ERROR');
});

test('corrupt, unsupported, and structurally invalid records are visible and never reset', () => {
  const dir = fixture();
  initialize(dir);
  const file = recordFile(dir);
  const valid = JSON.parse(readFileSync(file, 'utf8'));
  for (const [contents, expectedCode] of [
    ['{broken', 'RECORD_CORRUPT'],
    [JSON.stringify({ ...valid, schemaVersion: 999 }), 'UNSUPPORTED_SCHEMA'],
    [JSON.stringify({ ...valid, extraField: 'would be lost' }), 'RECORD_CORRUPT'],
    [JSON.stringify({ ...valid, entries: [{ id: 'C1', kind: 'criterion', text: 'Incomplete' }] }), 'RECORD_CORRUPT'],
  ]) {
    writeFileSync(file, contents);
    const before = snapshotTree(dir);
    jsonFailure(run(dir, ['status', '--json']), 3, expectedCode);
    assert.deepEqual(snapshotTree(dir), before);
    jsonFailure(run(dir, ['add', 'gap', '--text', 'A gap', '--json']), 3, expectedCode);
    jsonFailure(run(dir, ['init', '--intent', 'Overwrite?', '--json']), 3, 'RECORD_EXISTS');
    assert.equal(readFileSync(file, 'utf8'), contents);
    assert.equal(existsSync(`${file}.lock`), false);
  }
});

test('malformed UTF-8 is rejected on reads and writes without changing record bytes', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Claim X must be preserved', '--json']), 'add');
  const file = recordFile(dir);
  const valid = readFileSync(file);
  const marker = Buffer.from('Claim X must be preserved');
  const start = valid.indexOf(marker);
  assert.notEqual(start, -1);
  const damaged = Buffer.from(valid);
  damaged[start + marker.indexOf('X')] = 0xff;
  writeFileSync(file, damaged);

  jsonFailure(run(dir, ['status', '--json']), 3, 'RECORD_CORRUPT');
  assert.deepEqual(readFileSync(file), damaged);
  jsonFailure(run(dir, ['add', 'gap', '--text', 'Unrelated write', '--json']), 3, 'RECORD_CORRUPT');
  assert.deepEqual(readFileSync(file), damaged);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('a genuine replacement character is valid, while a leading UTF-8 BOM stays invalid JSON', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A genuine � is allowed', '--json']), 'add');
  const file = recordFile(dir);
  const valid = readFileSync(file);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].text, 'A genuine � is allowed');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]);
  writeFileSync(file, withBom);
  jsonFailure(run(dir, ['status', '--json']), 3, 'RECORD_CORRUPT');
  jsonFailure(run(dir, ['add', 'gap', '--text', 'Do not rewrite', '--json']), 3, 'RECORD_CORRUPT');
  assert.deepEqual(readFileSync(file), withBom);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('invalid batches and missing question references never partially modify a record', () => {
  const dir = fixture();
  initialize(dir);
  const file = recordFile(dir);
  const original = readFileSync(file, 'utf8');
  const inputs = [
    '[not json',
    JSON.stringify([{ kind: 'gap', text: 'Valid' }, { kind: 'evidence', text: 'Not in this slice' }]),
    JSON.stringify([{ kind: 'gap', text: 'Valid' }, { kind: 'answer', questionId: 'Q404', text: 'No such question' }]),
    JSON.stringify([{ kind: 'gap', text: 'Valid', surprise: true }]),
    JSON.stringify(Array.from({ length: 101 }, () => ({ kind: 'gap', text: 'Too many' }))),
    Buffer.concat([Buffer.from('[{"kind":"gap","text":"'), Buffer.from([0xff]), Buffer.from('"}]')]),
    ' '.repeat(1024 * 1024 + 1),
  ];
  for (const input of inputs) {
    jsonFailure(run(dir, ['add', '--stdin', '--json'], { input }), 2, 'USAGE_ERROR');
    assert.equal(readFileSync(file, 'utf8'), original);
    assert.equal(existsSync(`${file}.lock`), false);
  }
  jsonFailure(run(dir, ['add', 'criterion', '--text', ' ', '--json']), 2, 'USAGE_ERROR');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('schema 1 records remain read-only until an atomic schema 3 write', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Preserve this criterion', '--json']), 'add');
  const file = recordFile(dir);
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const old = { schemaVersion: 1, originalIntention: current.originalIntention, createdAt: current.createdAt, entries: current.entries };
  writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`);
  const before = snapshotTree(dir);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.recordVersion, 1);
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.deepEqual(snapshotTree(dir), before);
  jsonSuccess(run(dir, ['add', 'gap', '--text', 'Evidence is missing', '--json']), 'add');
  const migrated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.entries[0], old.entries[0]);
  assert.equal(migrated.entries[1].kind, 'gap');
  assert.deepEqual(migrated.checks, []);
  assert.deepEqual(migrated.evidence, []);
  assert.deepEqual(migrated.evaluations, []);
  assert.deepEqual(migrated.revisions, []);
  assert.deepEqual(migrated.baselines, []);
  assert.deepEqual(migrated.checkContexts, []);
  assert.deepEqual(migrated.evidenceContexts, []);
  assert.deepEqual(migrated.evaluationContexts, []);
});

test('schema 2 reads are untouched and migration preserves verification against the original criterion', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original criterion', '--json']), 'add');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'A report', '--source', 'Caller', '--subject', 'Original criterion', '--limitations', 'Not independently verified', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'Caller assessment', '--evidence', 'E1', '--json']), 'evaluate');
  const file = recordFile(dir);
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const old = { schemaVersion: 2, originalIntention: current.originalIntention, createdAt: current.createdAt, entries: current.entries, checks: current.checks, evidence: current.evidence, evaluations: current.evaluations };
  writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`);
  const original = readFileSync(file);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.recordVersion, 2);
  assert.equal(handoff.criteria[0].evaluation, 'supported');
  assert.equal(handoff.evidence[0].criterionContexts[0].state, 'current');
  assert.equal(handoff.baselineComparison, null);
  assert.deepEqual(readFileSync(file), original);
  jsonFailure(run(dir, ['revise', 'C404', '--text', 'Invalid target', '--json']), 2, 'USAGE_ERROR');
  assert.deepEqual(readFileSync(file), original);
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'New criterion', '--reason', 'Scope changed', '--json']), 'revise');
  const migrated = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.evidence, old.evidence);
  assert.deepEqual(migrated.evaluations, old.evaluations);
  assert.equal(migrated.evidenceContexts[0].revisionCount, 0);
  assert.equal(migrated.evaluationContexts[0].revisionCount, 0);
  const after = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(after.criteria[0].evaluation, 'unverified');
  assert.deepEqual(after.criteria[0].priorEvaluationIds, ['V1']);
  assert.equal(after.evidence[0].criterionContexts[0].state, 'changed');
});

test('checks and evidence can precede criteria and be explicitly linked later', () => {
  const dir = fixture();
  initialize(dir, 'Explore before defining criteria');
  const check = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--json', '--', process.execPath, '-e', 'process.stdout.write("observation")']), 'check').check;
  assert.deepEqual(check.criterionIds, []);
  const evidence = jsonSuccess(run(dir, ['evidence', 'add', '--summary', 'An early observation', '--source', 'CHK1', '--subject', 'Initial exploration', '--limitations', 'Criteria were not defined yet', '--check', 'CHK1', '--json']), 'evidence').evidence;
  assert.deepEqual(evidence.criterionIds, []);
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.criteria, []);
  assert.deepEqual(handoff.evidence[0].evaluatedFor, []);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A later criterion', '--json']), 'add');
  handoff = jsonSuccess(run(dir, ['status', '--json']), 'status').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'The early observation is limited', '--evidence', 'E1', '--json']), 'evaluate');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'inconclusive');
  assert.deepEqual(handoff.criteria[0].evidenceIds, ['E1']);
  assert.deepEqual(handoff.evidence[0].criterionIds, []);
  assert.deepEqual(handoff.evidence[0].evaluatedFor, ['C1']);
});

test('an output reference avoids recording command output or automatically evaluating criteria', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A bounded claim', '--json']), 'add');
  const secret = 'sensitive-output-not-for-the-record';
  const outputPath = join(dir, 'external-check.log');
  const script = 'const value = process.env.SYNTH_TEST_SECRET; require("node:fs").writeFileSync(process.env.SYNTH_TEST_LOG, value); process.stdout.write(value); process.stderr.write("warning");';
  const data = jsonSuccess(run(dir, ['check', 'run', '--output-ref', outputPath, '--criterion', 'C1', '--json', '--', process.execPath, '-e', script], {
    env: { ...process.env, SYNTH_TEST_SECRET: secret, SYNTH_TEST_LOG: outputPath },
  }), 'check');
  assert.equal(data.check.status, 'passed');
  assert.equal(data.check.invocation, 'run');
  assert.equal(data.check.exitCode, 0);
  assert.equal(data.check.revision, null);
  assert.equal(data.check.dirty, 'unknown');
  assert.equal(data.check.provenance, 'unknown');
  assert.equal(data.check.output.captured, false);
  assert.equal(data.check.output.stdout.bytes, Buffer.byteLength(secret));
  assert.equal(data.check.output.stdout.text, null);
  assert.equal(data.check.output.stderr.text, null);
  assert.equal(data.check.outputRef, outputPath);
  assert.equal(readFileSync(outputPath, 'utf8'), secret);
  assert.ok(data.check.startedAt && data.check.endedAt);
  assert.equal(readFileSync(recordFile(dir), 'utf8').includes(secret), false);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.equal(handoff.evidence.length, 0);
  assert.equal(handoff.evaluations.length, 0);
});

test('explicit captured output is bounded and command arguments after -- are not parsed as SYNTH options', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Output is bounded', '--json']), 'add');
  const script = 'if (process.argv[1] !== "--json") process.exit(9); process.stdout.write("x".repeat(20000)); process.stderr.write("err");';
  const result = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--revision', 'revision-reported-by-user', '--dirty', 'dirty', '--json', '--', process.execPath, '-e', script, '--', '--json']), 'check').check;
  assert.equal(result.status, 'passed');
  assert.equal(result.provenance, 'reported');
  assert.equal(result.revision, 'revision-reported-by-user');
  assert.equal(result.dirty, 'dirty');
  assert.equal(result.argv.at(-1), '--json');
  assert.equal(result.output.stdout.bytes, 20000);
  assert.equal(result.output.stdout.text.length, 16384);
  assert.equal(result.output.stdout.truncated, true);
  assert.equal(result.output.stderr.text, 'err');
  assert.equal(result.output.stderr.truncated, false);
  const boundary = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', 'process.stdout.write("x".repeat(16384))']), 'check').check;
  assert.equal(boundary.output.stdout.bytes, 16384);
  assert.equal(boundary.output.stdout.text.length, 16384);
  assert.equal(boundary.output.stdout.truncated, false);
  const binary = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', 'process.stdout.write(Buffer.from([255, 0]))']), 'check').check;
  assert.equal(binary.output.encoding, 'utf8-lossy');
  assert.equal(binary.output.stdout.bytes, 2);
  assert.equal(binary.output.stdout.text, '�\u0000');
});

test('a timeout requests termination of the selected POSIX process group', { timeout: 10_000 }, async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) { t.skip('This check requires POSIX process groups.'); return; }
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Timed-out process tree', '--json']), 'add');
  const started = join(dir, 'descendant-started');
  const late = join(dir, 'descendant-ran-after-timeout');
  const worker = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 1600);`;
  const parent = `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' }); setTimeout(() => {}, 2200);`;
  const result = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '700', '--json', '--', process.execPath, '-e', parent]), 'check').check;
  assert.equal(result.status, 'timed_out');
  assert.equal(existsSync(started), true, 'The descendant must start for this test to be meaningful.');
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1800));
  assert.equal(existsSync(late), false, 'The descendant continued after the timeout.');
});

test('a selected check does not invoke Git for provenance', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'No implicit Git', '--json']), 'add');
  const bin = join(dir, 'fake-bin');
  const marker = join(dir, 'git-was-run');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\n: > "$SYNTH_GIT_MARKER"\nexit 97\n', { mode: 0o755 });
  const result = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', 'process.exit(0)'], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, SYNTH_GIT_MARKER: marker },
  }), 'check').check;
  assert.equal(result.status, 'passed');
  assert.equal(result.provenance, 'unknown');
  assert.equal(existsSync(marker), false);
});

test('failed, timed-out, unstarted, skipped, and inconclusive checks remain distinct', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Checks can fail', '--json']), 'add');
  const failed = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', 'process.exit(7)']), 'check').check;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 7);
  const timedOut = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '150', '--json', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)']), 'check').check;
  assert.equal(timedOut.status, 'timed_out');
  assert.ok(timedOut.endedAt);
  const missing = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', join(dir, 'no-such-executable')]), 'check').check;
  assert.equal(missing.status, 'could_not_start');
  assert.equal(missing.startedAt, null);
  const marker = join(dir, 'should-not-run');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`;
  const skipped = jsonSuccess(run(dir, ['check', 'record', '--criterion', 'C1', '--status', 'skipped', '--reason', 'Not applicable to this environment', '--json', '--', process.execPath, '-e', script]), 'check').check;
  const inconclusive = jsonSuccess(run(dir, ['check', 'record', '--criterion', 'C1', '--status', 'inconclusive', '--reason', 'External result was ambiguous', '--json', '--', process.execPath, '-e', script]), 'check').check;
  assert.equal(skipped.status, 'skipped');
  assert.equal(inconclusive.status, 'inconclusive');
  assert.equal(skipped.invocation, 'reported');
  assert.equal(inconclusive.startedAt, null);
  assert.equal(existsSync(marker), false);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.checks.map((item) => item.status), ['failed', 'timed_out', 'could_not_start', 'skipped', 'inconclusive']);
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
});

test('invalid check requests never launch a command or change the record', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'An existing criterion', '--json']), 'add');
  const file = recordFile(dir);
  const before = readFileSync(file, 'utf8');
  const marker = join(dir, 'unexpected-command');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`;
  for (const args of [
    ['check', 'run', '--capture-output', '--criterion', 'C404', '--json', '--', process.execPath, '-e', script],
    ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '0', '--json', '--', process.execPath, '-e', script],
    ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '300001', '--json', '--', process.execPath, '-e', script],
    ['check', 'run', '--criterion', 'C1', '--json', '--', process.execPath, '-e', script],
    ['check', 'run', '--capture-output', '--criterion', 'C1', '--json'],
    ['check', 'record', '--criterion', 'C1', '--status', 'passed', '--reason', 'No', '--json', '--', process.execPath, '-e', script],
  ]) {
    jsonFailure(run(dir, args), 2, 'USAGE_ERROR');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(marker), false);
  }
});

test('evidence, evaluations, and freshness remain separate and preserve history', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', '--stdin', '--json'], { input: JSON.stringify([
    { kind: 'criterion', text: 'First claim' }, { kind: 'criterion', text: 'Second claim' },
  ]) }), 'add');
  const subject = join(dir, 'subject.txt');
  writeFileSync(subject, 'first version\n');
  const evidence = jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'An observation', '--source', 'Manual inspection', '--subject', 'subject.txt', '--limitations', 'Only this file was inspected', '--subject-file', subject, '--json']), 'evidence').evidence;
  assert.equal(evidence.id, 'E1');
  assert.equal(evidence.subjectFile.state, 'captured');
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.equal(handoff.evidence[0].freshness, 'matching');
  const before = readFileSync(recordFile(dir), 'utf8');
  jsonFailure(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'No evidence supplied', '--json']), 2, 'USAGE_ERROR');
  jsonFailure(run(dir, ['evaluate', 'C2', '--status', 'supported', '--reason', 'Missing evidence', '--evidence', 'E404', '--json']), 2, 'USAGE_ERROR');
  jsonFailure(run(dir, ['evaluate', 'C1', '--status', 'not_applicable', '--reason', 'No evidence supplied', '--json']), 2, 'USAGE_ERROR');
  assert.equal(readFileSync(recordFile(dir), 'utf8'), before);
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'A limited assessment', '--evidence', 'E1', '--json']), 'evaluate');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'supported');
  assert.equal(handoff.criteria[0].freshness, 'matching');
  writeFileSync(subject, 'changed version\n');
  const tree = snapshotTree(dir);
  handoff = jsonSuccess(run(dir, ['status', '--json']), 'status').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'supported');
  assert.equal(handoff.criteria[0].freshness, 'changed');
  assert.equal(handoff.evidence[0].freshness, 'changed');
  assert.deepEqual(snapshotTree(dir), tree);
  unlinkSync(subject);
  assert.equal(jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff.evidence[0].freshness, 'changed');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'contradicted', '--reason', 'Later assessment', '--evidence', 'E1', '--json']), 'evaluate');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'unverified', '--reason', 'Needs reassessment', '--json']), 'evaluate');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.equal(handoff.criteria[0].freshness, 'unknown');
  assert.deepEqual(handoff.evaluations.map((item) => item.verdict), ['supported', 'contradicted', 'unverified']);
  const notApplicable = jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'not_applicable', '--reason', 'Reasoned scope assessment', '--evidence', 'E1', '--json']), 'evaluate').evaluation;
  assert.equal(notApplicable.verdict, 'not_applicable');
  const inconclusive = jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'Evidence remains limited', '--evidence', 'E1', '--json']), 'evaluate').evaluation;
  assert.equal(inconclusive.verdict, 'inconclusive');
  assert.equal(handoff.capabilities.acceptance, 'not_available');
});

test('unavailable and unselected evidence subjects report unknown freshness', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A claim', '--json']), 'add');
  const target = join(dir, 'target.txt');
  const alias = join(dir, 'subject-link');
  const oversized = join(dir, 'oversized-subject');
  writeFileSync(target, 'content');
  writeFileSync(oversized, Buffer.alloc(8 * 1024 * 1024 + 1));
  symlinkSync(target, alias);
  for (const [subjectFile, expected] of [[undefined, null], [join(dir, 'missing.txt'), 'missing'], [alias, 'unavailable'], [oversized, 'unavailable']]) {
    const args = ['evidence', 'add', '--criterion', 'C1', '--summary', 'Reported information', '--source', 'A report', '--subject', 'A subject', '--limitations', 'Not independently verified', '--json'];
    if (subjectFile !== undefined) args.push('--subject-file', subjectFile);
    const item = jsonSuccess(run(dir, args), 'evidence').evidence;
    assert.equal(item.subjectFile?.state ?? null, expected);
  }
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.evidence.map((item) => item.freshness), ['unknown', 'unknown', 'unknown', 'unknown']);
});

test('multiple criterion links and evidence references are validated explicitly', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', '--stdin', '--json'], { input: JSON.stringify([
    { kind: 'criterion', text: 'First' }, { kind: 'criterion', text: 'Second' },
  ]) }), 'add');
  const check = jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--criterion', 'C2', '--json', '--', process.execPath, '-e', 'process.exit(0)']), 'check').check;
  assert.deepEqual(check.criterionIds, ['C1', 'C2']);
  const evidence = jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--criterion', 'C2', '--summary', 'One check', '--source', 'CHK1', '--subject', 'Both criteria', '--limitations', 'One short check', '--check', 'CHK1', '--json']), 'evidence').evidence;
  assert.deepEqual(evidence.criterionIds, ['C1', 'C2']);
  jsonSuccess(run(dir, ['evaluate', 'C2', '--status', 'inconclusive', '--reason', 'Not enough coverage', '--evidence', 'E1', '--json']), 'evaluate');
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.equal(handoff.criteria[1].evaluation, 'inconclusive');
  assert.equal(handoff.criteria[1].freshness, 'unknown');
  jsonFailure(run(dir, ['evidence', 'add', '--criterion', 'C1', '--criterion', 'C1', '--summary', 'Duplicate', '--source', 'Report', '--subject', 'Subject', '--limitations', 'Limited', '--json']), 2, 'USAGE_ERROR');
});

test('a file replaced while fingerprinting does not receive a captured snapshot', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'File observation', '--json']), 'add');
  const target = join(dir, 'racing-subject.txt');
  const backup = join(dir, 'old-subject.txt');
  const preload = join(dir, 'replace-during-read.cjs');
  writeFileSync(target, 'original content');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const target = ${JSON.stringify(target)};
    const oldOpen = fs.openSync; const oldRead = fs.readSync;
    let watched; let changed = false;
    fs.openSync = function(path, ...args) { const fd = oldOpen.call(this, path, ...args); if (path === target) watched = fd; return fd; };
    fs.readSync = function(fd, ...args) {
      const count = oldRead.call(this, fd, ...args);
      if (fd === watched && count > 0 && !changed) {
        changed = true; fs.renameSync(target, ${JSON.stringify(backup)}); fs.writeFileSync(target, 'replacement');
      }
      return count;
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const item = jsonSuccess(runWithPreload(dir, preload, ['evidence', 'add', '--criterion', 'C1', '--summary', 'File changed during capture', '--source', 'Inspection', '--subject', 'File', '--limitations', 'Concurrent replacement', '--subject-file', target, '--json']), 'evidence').evidence;
  assert.equal(item.subjectFile.state, 'unavailable');
  assert.equal(item.subjectFile.digest, null);
  assert.equal(jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff.evidence[0].freshness, 'unknown');
  unlinkSync(backup);
  writeFileSync(target, 'another original');
  const baseline = jsonSuccess(runWithPreload(dir, preload, ['baseline', 'capture', '--file', target, '--json']), 'baseline').baseline;
  assert.equal(baseline.files[0].state, 'unavailable');
  assert.equal(baseline.files[0].digest, null);
  assert.equal(jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--json']), 'baseline').comparison.areas.verification.state, 'unknown');
});

test('a failed final check write leaves a visible pending request', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Finalization failure', '--json']), 'add');
  const lock = `${recordFile(dir)}.lock`;
  const script = `require('node:fs').writeFileSync(${JSON.stringify(lock)}, 'simulated competing lock')`;
  const failure = jsonFailure(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', script]), 3, 'IO_ERROR');
  assert.match(failure.error.message, /was invoked but its final outcome could not be saved/);
  assert.ok(existsSync(lock));
  unlinkSync(lock);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'pending');
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
});

test('corrupt schema 2 and 3 verification fields and references are not rewritten', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Claim', '--json']), 'add');
  jsonSuccess(run(dir, ['check', 'run', '--capture-output', '--criterion', 'C1', '--json', '--', process.execPath, '-e', 'process.exit(0)']), 'check');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Observation', '--source', 'CHK1', '--subject', 'A subject', '--limitations', 'Limited', '--check', 'CHK1', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'A recorded assessment', '--evidence', 'E1', '--json']), 'evaluate');
  const file = recordFile(dir);
  const valid = JSON.parse(readFileSync(file, 'utf8'));
  const mutations = [
    (record) => { record.checks[0].unexpected = 'would be lost'; },
    (record) => { record.checks[0].criterionIds = ['C404']; },
    (record) => { record.evidence[0].checkId = 'CHK404'; },
    (record) => { record.evaluations[0].evidenceIds = []; },
    (record) => { record.evaluations[0].verdict = 'accepted'; },
  ];
  const v2 = { schemaVersion: 2, originalIntention: valid.originalIntention, createdAt: valid.createdAt, entries: valid.entries, checks: valid.checks, evidence: valid.evidence, evaluations: valid.evaluations };
  for (const source of [v2, valid]) {
    for (const mutate of mutations) {
      const damaged = JSON.parse(JSON.stringify(source));
      mutate(damaged);
      const bytes = Buffer.from(JSON.stringify(damaged));
      writeFileSync(file, bytes);
      jsonFailure(run(dir, ['status', '--json']), 3, 'RECORD_CORRUPT');
      jsonFailure(run(dir, ['add', 'gap', '--text', 'Do not replace', '--json']), 3, 'RECORD_CORRUPT');
      assert.deepEqual(readFileSync(file), bytes);
      assert.equal(existsSync(`${file}.lock`), false);
    }
  }
});

test('invalid generated state is rejected before replacing a valid record', () => {
  const dir = fixture();
  initialize(dir);
  const file = recordFile(dir);
  const original = readFileSync(file);
  const preload = join(dir, 'invalid-generated-state.cjs');
  writeFileSync(preload, `
    const original = JSON.stringify;
    JSON.stringify = function(value, ...args) {
      if (value && value.schemaVersion === 3 && Array.isArray(value.entries)) {
        return original.call(this, { ...value, wouldBeLost: true }, ...args);
      }
      return original.call(this, value, ...args);
    };
  `);
  const result = runWithPreload(dir, preload, ['add', 'gap', '--text', 'Do not write invalid state', '--json']);
  const error = jsonFailure(result, 1, 'INTERNAL_ERROR');
  assert.match(error.error.message, /Refusing to save invalid generated state/);
  assert.deepEqual(readFileSync(file), original);
  assert.equal(existsSync(`${file}.lock`), false);
});

async function waitForFile(path, child) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.ok(existsSync(path), `Selected command did not create ${path}`);
}

function collectChild(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
}

test('a pending check releases the lock and preserves concurrent context writes', { timeout: 10_000 }, async (t) => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Concurrent work', '--json']), 'add');
  const ready = join(dir, 'check-ready');
  const release = join(dir, 'check-release');
  const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer); }, 20);`;
  const child = spawn(executable(dir), ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '5000', '--json', '--', process.execPath, '-e', script], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = collectChild(child);
  t.after(() => { writeFileSync(release, 'stop'); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await waitForFile(ready, child);
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'pending');
  assert.equal(handoff.checks[0].startedAt, null);
  assert.equal(existsSync(`${recordFile(dir)}.lock`), false);
  jsonSuccess(run(dir, ['add', 'gap', '--text', 'Recorded while a check was running', '--json']), 'add');
  jsonSuccess(run(dir, ['baseline', 'capture', '--reason', 'During the pending check', '--json']), 'baseline');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Criterion revised while the check ran', '--json']), 'revise');
  writeFileSync(release, 'stop');
  const result = await closed;
  assert.equal(jsonSuccess(result, 'check').check.status, 'passed');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'passed');
  assert.equal(handoff.checks[0].criterionContexts[0].state, 'changed');
  assert.equal(handoff.baselineComparison.areas.criteria.state, 'changed');
  assert.equal(handoff.gaps[0].text, 'Recorded while a check was running');
});

test('SIGINT records an interrupted check without claiming success', { timeout: 10_000 }, async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) { t.skip('This signal test requires POSIX process groups.'); return; }
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Interruptible check', '--json']), 'add');
  const ready = join(dir, 'interrupt-ready');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`;
  const child = spawn(executable(dir), ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '5000', '--json', '--', process.execPath, '-e', script], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = collectChild(child);
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  await waitForFile(ready, child);
  child.kill('SIGINT');
  const result = await closed;
  assert.equal(result.status, 130, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.check.status, 'interrupted');
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'interrupted');
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
});

test('a hard-killed runner leaves a pending request rather than claiming success', { timeout: 10_000 }, async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) { t.skip('This interruption test requires POSIX signals.'); return; }
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Hard interruption', '--json']), 'add');
  const ready = join(dir, 'hard-kill-ready');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const child = spawn(executable(dir), ['check', 'run', '--capture-output', '--criterion', 'C1', '--timeout-ms', '5000', '--json', '--', process.execPath, '-e', script], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = collectChild(child);
  let selectedPid;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (selectedPid) { try { process.kill(selectedPid, 'SIGTERM'); } catch { /* It already exited. */ } }
  });
  await waitForFile(ready, child);
  selectedPid = Number(readFileSync(ready, 'utf8'));
  assert.ok(Number.isSafeInteger(selectedPid) && selectedPid > 1);
  child.kill('SIGKILL');
  const result = await closed;
  assert.equal(result.signal, 'SIGKILL');
  try { process.kill(selectedPid, 'SIGTERM'); } catch { /* It already exited. */ }
  selectedPid = undefined;
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'pending');
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
});

test('nonblocking FIFO stdin waits for a delayed producer', { timeout: 10_000 }, async (t) => {
  if (!['linux', 'darwin'].includes(process.platform)) {
    t.skip('This regression requires a POSIX nonblocking FIFO.');
    return;
  }
  const dir = fixture();
  const fifo = join(dir, 'agent-input.fifo');
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5_000 });
  if (created.error?.code === 'ENOENT') {
    t.skip('The POSIX mkfifo utility is unavailable.');
    return;
  }
  assert.equal(created.error, undefined);
  assert.equal(created.status, 0, created.stderr);
  initialize(dir);

  // The preload only signals when either input-reading strategy starts; it does
  // not change the pipe flags or the result of a read.
  const marker = 'SYNTH_TEST_STDIN_STARTED\n';
  const preload = join(dir, 'trace-stdin.cjs');
  writeFileSync(preload, `
    const fs = require('node:fs');
    const mark = () => fs.writeSync(2, ${JSON.stringify(marker)});
    const read = fs.readSync;
    fs.readSync = function (fd, ...args) { if (fd === 0) mark(); return read.call(this, fd, ...args); };
    const stdin = process.stdin;
    const iterator = stdin[Symbol.asyncIterator];
    stdin[Symbol.asyncIterator] = function (...args) { mark(); return iterator.apply(this, args); };
    require('node:module').syncBuiltinESMExports();
  `);
  let reader = null;
  let writer = null;
  let child;
  t.after(() => {
    if (reader !== null) closeSync(reader);
    if (writer !== null) closeSync(writer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
  writer = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  child = spawn(process.execPath, ['--require', preload, executable(dir), 'add', '--stdin', '--json'], {
    cwd: dir,
    stdio: [reader, 'pipe', 'pipe'],
  });
  closeSync(reader);
  reader = null;

  let stdout = '';
  let stderr = '';
  let signalReady;
  const ready = new Promise((resolveReady) => { signalReady = resolveReady; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes(marker)) signalReady(true);
  });
  const closed = new Promise((resolveClosed, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolveClosed({ status, signal, stdout, stderr }));
  });
  const enteredRead = await Promise.race([ready, closed.then(() => false)]);
  assert.equal(enteredRead, true, `CLI exited before reading stdin: ${stderr}`);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  let producerError;
  const text = 'Delayed 🌱 nonblocking input';
  const payload = Buffer.from(JSON.stringify([{ kind: 'gap', text }]));
  const character = Buffer.from('🌱');
  const characterStart = payload.indexOf(character);
  assert.notEqual(characterStart, -1);
  const split = characterStart + 2;
  try {
    assert.equal(writeSync(writer, payload.subarray(0, split)), split);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    assert.equal(writeSync(writer, payload.subarray(split)), payload.length - split);
  } catch (error) {
    producerError = error;
  } finally {
    closeSync(writer);
    writer = null;
  }
  const result = await closed;
  assert.equal(producerError, undefined, `Delayed producer failed: ${producerError}; CLI stderr: ${result.stderr}`);
  result.stderr = result.stderr.split(marker).join('');
  const added = jsonSuccess(result, 'add');
  assert.equal(added.entries.length, 1);
  assert.equal(added.entries[0].text, text);
});

function runAsync(directory, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable(directory), args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

test('cooperative concurrent initializations and updates cannot silently overwrite each other', async () => {
  const dir = fixture();
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    runAsync(dir, ['init', '--intent', `Intention ${index}`, '--json'])));
  const successes = attempts.filter((result) => result.status === 0);
  assert.equal(successes.length, 1);
  for (const result of attempts.filter((item) => item.status !== 0)) {
    assert.equal(result.status, 3);
    assert.ok(['RECORD_LOCKED', 'RECORD_EXISTS'].includes(JSON.parse(result.stderr).error.code));
  }
  const initial = jsonSuccess(successes[0], 'init');
  assert.equal(jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff.originalIntention, initial.record.originalIntention);

  const additions = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    runAsync(dir, ['add', 'gap', '--text', `Gap ${index}`, '--json'])));
  const recorded = [];
  for (const result of additions) {
    if (result.status === 0) recorded.push(jsonSuccess(result, 'add').entries[0].text);
    else jsonFailure(result, 3, 'RECORD_LOCKED');
  }
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.gaps.map((entry) => entry.text).sort(), recorded.sort());
  assert.equal(new Set(handoff.gaps.map((entry) => entry.id)).size, recorded.length);
  assert.equal(existsSync(`${recordFile(dir)}.lock`), false);
});

test('interruption before and after replacement preserves schema 1, 2, and 3 records and a recoverable lock', () => {
  for (const [schema, phase] of [[1, 'before'], [1, 'after'], [2, 'before'], [2, 'after'], [3, 'before'], [3, 'after']]) {
    const dir = fixture();
    initialize(dir);
    const file = recordFile(dir);
    if (schema !== 3) {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      const old = { schemaVersion: schema, originalIntention: current.originalIntention, createdAt: current.createdAt, entries: current.entries };
      if (schema === 2) Object.assign(old, { checks: current.checks, evidence: current.evidence, evaluations: current.evaluations });
      writeFileSync(file, `${JSON.stringify(old, null, 2)}\n`);
    }
    const original = readFileSync(file, 'utf8');
    const preload = join(dir, 'interrupt-write.cjs');
    writeFileSync(preload, `
      const fs = require('node:fs');
      const originalRename = fs.renameSync;
      fs.renameSync = (...args) => {
        if (process.env.SYNTH_TEST_INTERRUPT === 'before') process.kill(process.pid, 'SIGKILL');
        const result = originalRename(...args);
        if (process.env.SYNTH_TEST_INTERRUPT === 'after') process.kill(process.pid, 'SIGKILL');
        return result;
      };
      require('node:module').syncBuiltinESMExports();
    `);
    const interrupted = runWithPreload(dir, preload, ['add', 'gap', '--text', 'Possibly saved', '--json'], {
      env: { ...process.env, SYNTH_TEST_INTERRUPT: phase },
    });
    assert.equal(interrupted.signal, 'SIGKILL', `injection did not interrupt ${phase}: ${interrupted.stderr}`);
    assert.ok(existsSync(`${file}.lock`));
    const leftoverTemps = readdirSync(dirname(file)).filter((name) => /^\.work\.json\..+\.tmp$/.test(name));
    if (phase === 'before') {
      assert.equal(readFileSync(file, 'utf8'), original);
      assert.equal(leftoverTemps.length, 1);
    } else {
      assert.equal(leftoverTemps.length, 0);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[0].text, 'Possibly saved');
    }
    const beforeRead = snapshotTree(dir);
    const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
    assert.equal(handoff.gaps.length, phase === 'before' ? 0 : 1);
    assert.equal(handoff.recordVersion, phase === 'before' ? schema : 3);
    assert.deepEqual(snapshotTree(dir), beforeRead);
    jsonFailure(run(dir, ['add', 'gap', '--text', 'Blocked by lock', '--json']), 3, 'RECORD_LOCKED');
    assert.ok(existsSync(`${file}.lock`));
    // In this test the killed writer is known to be gone; a real user must verify that independently.
    unlinkSync(`${file}.lock`);
    for (const temp of leftoverTemps) unlinkSync(join(dirname(file), temp));
    jsonSuccess(run(dir, ['add', 'next', '--text', 'Resume after inspection', '--json']), 'add');
  }
});

test('core commands do not implicitly launch project scripts, child processes, or common network APIs', () => {
  const dir = fixture();
  const packagePath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.scripts.test = 'node should-not-run.cjs';
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, 'should-not-run.cjs'), "require('node:fs').writeFileSync('UNEXPECTED_EXECUTION', 'ran')\n");
  const preload = join(dir, 'deny-external.cjs');
  writeFileSync(preload, `
    const deny = () => { throw new Error('unexpected external action'); };
    const cp = require('node:child_process');
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = deny;
    const net = require('node:net');
    net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
    const dns = require('node:dns');
    dns.lookup = deny; dns.resolve = deny;
    const http = require('node:http'); const https = require('node:https');
    http.request = deny; http.get = deny; https.request = deny; https.get = deny;
    globalThis.fetch = deny;
    require('node:module').syncBuiltinESMExports();
  `);
  jsonSuccess(runWithPreload(dir, preload, ['init', '--intent', 'Work without implicit actions', '--json']), 'init');
  jsonSuccess(runWithPreload(dir, preload, ['add', 'gap', '--text', 'Not verified', '--json']), 'add');
  jsonSuccess(runWithPreload(dir, preload, ['add', 'criterion', '--text', 'A criterion', '--json']), 'add');
  jsonSuccess(runWithPreload(dir, preload, ['check', 'record', '--criterion', 'C1', '--status', 'skipped', '--reason', 'Not run', '--json', '--', 'node', 'should-not-run.cjs']), 'check');
  jsonSuccess(runWithPreload(dir, preload, ['evidence', 'add', '--criterion', 'C1', '--summary', 'A report', '--source', 'Caller', '--subject', 'Title file', '--limitations', 'Not independently verified', '--subject-file', 'src/title.js', '--json']), 'evidence');
  jsonSuccess(runWithPreload(dir, preload, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'No executed check', '--evidence', 'E1', '--json']), 'evaluate');
  jsonSuccess(runWithPreload(dir, preload, ['baseline', 'capture', '--file', 'src/title.js', '--json']), 'baseline');
  jsonSuccess(runWithPreload(dir, preload, ['revise', 'C1', '--text', 'Revised criterion', '--json']), 'revise');
  jsonSuccess(runWithPreload(dir, preload, ['baseline', 'compare', 'B1', '--json']), 'baseline');
  jsonSuccess(runWithPreload(dir, preload, ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'uncertain', '--reason', 'Needs review', '--evidence', 'E1', '--json']), 'baseline');
  jsonSuccess(runWithPreload(dir, preload, ['status', '--json']), 'status');
  jsonSuccess(runWithPreload(dir, preload, ['handoff', '--json']), 'handoff');
  assert.equal(existsSync(join(dir, 'UNEXPECTED_EXECUTION')), false);
});

test('the documented agent quick start matches the installed CLI', () => {
  const dir = fixture();
  const readme = readFileSync(join(repository, 'README.md'), 'utf8');
  const examples = [
    ["synth init --intent 'Make note titles predictable' --json", ['init', '--intent', 'Make note titles predictable', '--json']],
    ["synth add criterion --text 'Whitespace-only titles remain empty' --json", ['add', 'criterion', '--text', 'Whitespace-only titles remain empty', '--json']],
    ["synth add question --text 'Should internal whitespace be collapsed?' --json", ['add', 'question', '--text', 'Should internal whitespace be collapsed?', '--json']],
    ["synth add decision --text 'Limit this work to title behavior' --reason 'Keep the change bounded' --json", ['add', 'decision', '--text', 'Limit this work to title behavior', '--reason', 'Keep the change bounded', '--json']],
    ["synth add gap --text 'Behavior has not been verified' --json", ['add', 'gap', '--text', 'Behavior has not been verified', '--json']],
    ["synth add next --text 'Inspect the current title implementation' --json", ['add', 'next', '--text', 'Inspect the current title implementation', '--json']],
    ["synth add answer --question Q1 --text 'Keep internal whitespace unchanged' --reason 'Example answer, not independently verified' --json", ['add', 'answer', '--question', 'Q1', '--text', 'Keep internal whitespace unchanged', '--reason', 'Example answer, not independently verified', '--json']],
    ['synth handoff --json', ['handoff', '--json']],
  ];
  for (const [example, args] of examples) {
    assert.ok(readme.includes(example), `README is missing checked example: ${example}`);
    jsonSuccess(run(dir, args));
  }
  const batchExample = `printf '%s' '[{"kind":"outcome","text":"Titles behave predictably"},{"kind":"plan","text":"Inspect existing behavior"}]' | synth add --stdin --json`;
  assert.ok(readme.includes(batchExample));
  jsonSuccess(run(dir, ['add', '--stdin', '--json'], {
    input: JSON.stringify([{ kind: 'outcome', text: 'Titles behave predictably' }, { kind: 'plan', text: 'Inspect existing behavior' }]),
  }), 'add');
  const verificationExamples = [
    ['synth check run --criterion C1 --cwd . --timeout-ms 30000 --capture-output --json -- node --test test/title.test.js', ['check', 'run', '--capture-output', '--criterion', 'C1', '--cwd', '.', '--timeout-ms', '30000', '--json', '--', 'node', '--test', 'test/title.test.js']],
    ["synth evidence add --criterion C1 --summary 'Outcome recorded in CHK1' --source 'Check CHK1' --subject 'Tiny Notes title test' --limitations 'This test does not cover whitespace-only titles' --check CHK1 --subject-file src/title.js --json", ['evidence', 'add', '--criterion', 'C1', '--summary', 'Outcome recorded in CHK1', '--source', 'Check CHK1', '--subject', 'Tiny Notes title test', '--limitations', 'This test does not cover whitespace-only titles', '--check', 'CHK1', '--subject-file', 'src/title.js', '--json']],
    ["synth evaluate C1 --status inconclusive --reason 'The recorded test does not cover the stated criterion' --evidence E1 --json", ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'The recorded test does not cover the stated criterion', '--evidence', 'E1', '--json']],
  ];
  for (const [example, args] of verificationExamples) {
    assert.ok(readme.includes(example), `README is missing checked example: ${example}`);
    jsonSuccess(run(dir, args));
  }
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.checks[0].status, 'passed');
  assert.equal(handoff.criteria[0].evaluation, 'inconclusive');
  assert.equal(handoff.criteria[0].freshness, 'matching');
  const baselineExamples = [
    ["synth add scope --text 'Title normalization' --json", ['add', 'scope', '--text', 'Title normalization', '--json']],
    ["synth add verification --text 'Review the title tests' --json", ['add', 'verification', '--text', 'Review the title tests', '--json']],
    ["synth baseline capture --file test/title.test.js --reason 'Record the current working context' --json", ['baseline', 'capture', '--file', 'test/title.test.js', '--reason', 'Record the current working context', '--json']],
    ["synth revise C1 --text 'Title output is a string' --reason 'Example scope change' --evidence E1 --json", ['revise', 'C1', '--text', 'Title output is a string', '--reason', 'Example scope change', '--evidence', 'E1', '--json']],
    ['synth baseline compare B1 --json', ['baseline', 'compare', 'B1', '--json']],
    ["synth baseline assess B1 --area criteria --finding uncertain --reason 'Check whether the revised criterion meets intent' --evidence E1 --json", ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'uncertain', '--reason', 'Check whether the revised criterion meets intent', '--evidence', 'E1', '--json']],
    ["synth baseline capture --reason 'Record the changed working context' --json", ['baseline', 'capture', '--reason', 'Record the changed working context', '--json']],
    ['synth baseline compare B1 --to B2 --json', ['baseline', 'compare', 'B1', '--to', 'B2', '--json']],
  ];
  for (const [example, args] of baselineExamples) {
    assert.ok(readme.includes(example), `README is missing checked example: ${example}`);
    jsonSuccess(run(dir, args));
  }
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.deepEqual(handoff.criteria[0].priorEvaluationIds, ['V1']);
  assert.equal(handoff.previousBaselineComparison.areas.criteria.state, 'changed');
  assert.equal(handoff.driftAssessments[0].areaBasisState, 'unchanged');
});

test('revisions and verification notes are optional and do not require a baseline', () => {
  const dir = fixture();
  initialize(dir, 'Explore the original intention');
  const revision = jsonSuccess(run(dir, ['revise', 'intention', '--text', 'A narrower intention', '--json']), 'revise').revision;
  assert.equal(revision.id, 'R1');
  assert.equal(revision.reason, null);
  jsonSuccess(run(dir, ['add', 'update', '--text', 'R1 rationale: clarified after the change', '--json']), 'add');
  jsonSuccess(run(dir, ['evidence', 'add', '--summary', 'Early observation', '--source', 'Caller', '--subject', 'Exploration', '--limitations', 'No criterion existed yet', '--json']), 'evidence');
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A later criterion', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'verification', '--text', 'Exercise a boundary', '--json']), 'add');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'Early observation is limited', '--evidence', 'E1', '--json']), 'evaluate');
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.originalIntention, 'Explore the original intention');
  assert.equal(handoff.currentIntention, 'A narrower intention');
  assert.equal(handoff.intentionRevisionId, 'R1');
  assert.equal(handoff.revisions[0].reason, null);
  assert.equal(handoff.updates[0].text, 'R1 rationale: clarified after the change');
  assert.deepEqual(handoff.baselines, []);
  assert.equal(handoff.baselineComparison, null);
  assert.equal(handoff.verification[0].id, 'VR1');
  assert.equal(handoff.criteria[0].evaluation, 'inconclusive');
  assert.equal(handoff.capabilities.acceptance, 'not_available');
  const human = run(dir, ['handoff']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /R1 intention: .*reason: not recorded/);
  assert.match(human.stdout, /Baselines: not recorded/);
});

test('criterion revisions preserve checks and evidence without applying older evaluations to new versions', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original criterion', '--json']), 'add');
  jsonSuccess(run(dir, ['check', 'record', '--criterion', 'C1', '--status', 'skipped', '--reason', 'Not executed', '--json', '--', 'node', '--test']), 'check');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Caller report', '--source', 'Caller', '--subject', 'Original criterion', '--limitations', 'The selected check was skipped', '--check', 'CHK1', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'Caller assessment, not an automated conclusion', '--evidence', 'E1', '--json']), 'evaluate');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Changed criterion', '--reason', 'Intent changed', '--evidence', 'E1', '--json']), 'revise');
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].id, 'C1');
  assert.equal(handoff.criteria[0].originalText, 'Original criterion');
  assert.equal(handoff.criteria[0].text, 'Changed criterion');
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.deepEqual(handoff.criteria[0].priorEvaluationIds, ['V1']);
  assert.equal(handoff.checks[0].criterionContexts[0].state, 'changed');
  assert.equal(handoff.evidence[0].criterionContexts[0].state, 'changed');
  assert.equal(handoff.evaluations[0].criterionContext.state, 'changed');
  assert.equal(handoff.checks[0].status, 'skipped');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'Reconsidered for the revised criterion', '--evidence', 'E1', '--json']), 'evaluate');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'inconclusive');
  assert.equal(handoff.criteria[0].evaluationId, 'V2');
  assert.equal(handoff.evidence[0].criterionContexts[0].state, 'changed');
  jsonSuccess(run(dir, ['revise', 'C1', '--remove', '--reason', 'Temporarily out of scope', '--json']), 'revise');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'unverified', '--reason', 'Historical assessment while inactive', '--json']), 'evaluate');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].active, false);
  assert.equal(handoff.evaluations.at(-1).criterionContext.state, 'inactive');
  assert.ok(handoff.missingContext.includes('criteria'));
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Original criterion', '--reason', 'Restored', '--json']), 'revise');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].active, true);
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.deepEqual(handoff.criteria[0].priorEvaluationIds, ['V1', 'V2', 'V3']);
  assert.equal(handoff.evaluations.length, 3);
  assert.equal(handoff.revisions.length, 3);
});

test('explicit baselines surface intention, scope, criterion, and selected verification changes separately', () => {
  const dir = fixture();
  initialize(dir, 'Make title behavior predictable');
  jsonSuccess(run(dir, ['add', '--stdin', '--json'], { input: JSON.stringify([
    { kind: 'scope', text: 'Original title scope' },
    { kind: 'criterion', text: 'Whitespace-only titles are empty' },
    { kind: 'verification', text: 'Exercise whitespace-only titles' },
  ]) }), 'add');
  jsonSuccess(run(dir, ['check', 'record', '--criterion', 'C1', '--status', 'skipped', '--reason', 'Reported only', '--json', '--', 'node', '--test']), 'check');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Prior report', '--source', 'Caller', '--subject', 'Title implementation', '--limitations', 'No boundary check', '--check', 'CHK1', '--subject-file', 'src/title.js', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'Caller assessment of original criterion', '--evidence', 'E1', '--json']), 'evaluate');
  const baseline = jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'test/title.test.js', '--reason', 'Initial working agreement', '--json']), 'baseline').baseline;
  assert.equal(baseline.id, 'B1');
  assert.equal(baseline.files[0].state, 'captured');
  jsonSuccess(run(dir, ['revise', 'intention', '--text', 'Handle title formatting only', '--reason', 'Owner narrowed the work', '--json']), 'revise');
  jsonSuccess(run(dir, ['revise', 'S1', '--remove', '--reason', 'Scope was replaced', '--evidence', 'E1', '--json']), 'revise');
  jsonSuccess(run(dir, ['add', 'scope', '--text', 'Narrower title scope', '--reason', 'Replace S1', '--json']), 'add');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'The result is a string', '--reason', 'Narrowed criterion', '--evidence', 'E1', '--json']), 'revise');
  jsonSuccess(run(dir, ['revise', 'VR1', '--text', 'Exercise an ordinary title only', '--reason', 'Changed verification plan', '--json']), 'revise');
  const testFile = join(dir, 'test', 'title.test.js');
  writeFileSync(testFile, `${readFileSync(testFile, 'utf8')}\n// A changed test is not automatically adequate.\n`);
  const beforeReads = snapshotTree(dir);
  const result = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--json']), 'baseline').comparison;
  assert.equal(result.comparedTo, 'current');
  assert.equal(result.areas.intention.state, 'changed');
  assert.equal(result.areas.scope.state, 'changed');
  assert.equal(result.areas.criteria.state, 'changed');
  assert.equal(result.areas.verification.state, 'changed');
  assert.equal(result.areas.criteria.changes[0].before.text, 'Whitespace-only titles are empty');
  assert.equal(result.areas.criteria.changes[0].after.text, 'The result is a string');
  assert.equal(result.areas.criteria.changes[0].revisions[0].reason, 'Narrowed criterion');
  assert.deepEqual(result.areas.scope.changes.map((item) => item.change), ['removed', 'added']);
  assert.equal(result.areas.scope.changes[1].entryReason, 'Replace S1');
  assert.equal(result.areas.verification.files[0].change, 'changed');
  assert.equal(result.evidenceImpact, 'not_inferred');
  const candidate = result.affectedEvidenceCandidates.find((item) => item.evidenceId === 'E1');
  assert.ok(candidate.basis.includes('declared_by_revision'));
  assert.ok(candidate.basis.includes('check_inputs_unknown'));
  const human = run(dir, ['baseline', 'compare', 'B1']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /not a semantic drift judgment/);
  assert.match(human.stdout, /E1.*candidates|candidates.*E1/);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.equal(handoff.evidence[0].freshness, 'matching');
  assert.equal(handoff.evidence[0].criterionContexts[0].state, 'changed');
  assert.equal(handoff.baselineComparison.areas.verification.state, 'changed');
  assert.deepEqual(snapshotTree(dir), beforeReads);
});

test('baseline recapture retains selected files unless their selection is explicitly changed', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'verification', '--text', 'Title tests', '--json']), 'add');
  const b1 = jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'src/title.js', '--file', 'test/title.test.js', '--json']), 'baseline').baseline;
  assert.equal(b1.files.length, 2);
  const b2 = jsonSuccess(run(dir, ['baseline', 'capture', '--reason', 'Retain selection', '--json']), 'baseline').baseline;
  assert.deepEqual(b2.files.map((item) => item.path), b1.files.map((item) => item.path));
  const b3 = jsonSuccess(run(dir, ['baseline', 'capture', '--no-files', '--reason', 'Stop monitoring files', '--json']), 'baseline').baseline;
  assert.deepEqual(b3.files, []);
  let comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B2', '--to', 'B3', '--json']), 'baseline').comparison;
  assert.equal(comparison.areas.verification.state, 'changed');
  assert.deepEqual(comparison.areas.verification.files.map((item) => item.change), ['selection_removed', 'selection_removed']);
  comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B3', '--to', 'B1', '--json']), 'baseline').comparison;
  assert.equal(comparison.direction, 'reverse');
  assert.deepEqual(comparison.areas.verification.files.map((item) => item.change), ['selection_added', 'selection_added']);
  const b4 = jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'src/title.js', '--reason', 'Select one path', '--json']), 'baseline').baseline;
  assert.equal(b4.files.length, 1);
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.previousBaselineComparison.baselineId, 'B3');
  assert.equal(handoff.previousBaselineComparison.comparedTo, 'B4');
  assert.equal(handoff.previousBaselineComparison.areas.verification.files[0].change, 'selection_added');
  assert.deepEqual(handoff.baselines.map((item) => item.id), ['B1', 'B2', 'B3', 'B4']);
});

test('drift assessments are caller-reported and their assessed basis can become changed or unknown', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original behavior', '--json']), 'add');
  jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'test/title.test.js', '--json']), 'baseline');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'no_concern', '--reason', 'Recorded assessment', '--json']), 'baseline');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'verification', '--finding', 'uncertain', '--reason', 'Need another look', '--json']), 'baseline');
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.driftAssessments.map((item) => item.areaBasisState), ['unchanged', 'unchanged']);
  jsonSuccess(run(dir, ['evidence', 'add', '--summary', 'Later observation', '--source', 'Caller', '--subject', 'Possible context', '--limitations', 'Relevance has not been assessed', '--json']), 'evidence');
  jsonSuccess(run(dir, ['add', 'scope', '--text', 'An unrelated scope note', '--json']), 'add');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.driftAssessments[0].areaBasisState, 'unchanged');
  assert.deepEqual(handoff.driftAssessments[0].evidenceAddedSince, ['E1']);
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Revised behavior', '--json']), 'revise');
  const path = join(dir, 'test', 'title.test.js');
  const original = readFileSync(path);
  unlinkSync(path);
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.deepEqual(handoff.driftAssessments.map((item) => item.areaBasisState), ['changed', 'changed']);
  assert.equal(handoff.baselineComparison.areas.verification.files[0].change, 'changed');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'verification', '--finding', 'uncertain', '--reason', 'The selected file is missing', '--json']), 'baseline');
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.driftAssessments[2].areaBasisState, 'unknown');
  writeFileSync(path, original);
  handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.driftAssessments[1].areaBasisState, 'unchanged');
  assert.equal(handoff.driftAssessments[2].areaBasisState, 'changed');
  assert.match(run(dir, ['handoff']).stdout, /caller-reported, not independently verified/);
});

test('missing, oversized, directory, and symlink baseline files do not become matching evidence', () => {
  const dir = fixture();
  initialize(dir);
  const missing = join(dir, 'missing-test.js');
  const large = join(dir, 'oversized-test.js');
  const link = join(dir, 'test-link.js');
  writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  symlinkSync(join(dir, 'test', 'title.test.js'), link);
  const baseline = jsonSuccess(run(dir, ['baseline', 'capture', '--file', missing, '--file', large, '--file', link, '--file', 'test', '--json']), 'baseline').baseline;
  assert.deepEqual(baseline.files.map((item) => item.state), ['missing', 'unavailable', 'unavailable', 'unavailable']);
  let comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--json']), 'baseline').comparison;
  assert.equal(comparison.areas.verification.state, 'unknown');
  assert.ok(comparison.areas.verification.files.every((item) => item.change === 'unknown'));
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'verification', '--finding', 'uncertain', '--reason', 'Inputs unavailable', '--json']), 'baseline');
  let handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.driftAssessments[0].areaBasisState, 'unknown');
  assert.equal(handoff.driftAssessments[0].areaUnknownFileCount, 4);
  writeFileSync(missing, 'new input');
  comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--json']), 'baseline').comparison;
  assert.equal(comparison.areas.verification.state, 'changed');
  assert.equal(comparison.areas.verification.files[0].change, 'changed');
  assert.equal(comparison.areas.verification.files[1].change, 'unknown');
  assert.equal(comparison.areas.verification.unknownFileCount, 4);
  assert.match(run(dir, ['status']).stdout, /unknown selected files 4/);
});

test('invalid revision and baseline requests preserve the record and do not take lasting locks', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A criterion', '--json']), 'add');
  jsonSuccess(run(dir, ['add', 'question', '--text', 'A question', '--json']), 'add');
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  const before = snapshotTree(dir);
  const withoutLockDirectoryTime = (tree) => tree.map((item) => item.path === '.synth' ? { ...item, modified: null } : item);
  const requests = [
    ['revise', 'C1'],
    ['revise', 'C1', '--text', 'Text', '--remove'],
    ['revise', 'intention', '--remove'],
    ['revise', 'Q1', '--text', 'Unsupported target'],
    ['revise', 'C404', '--text', 'Missing target'],
    ['revise', 'C1', '--text', 'Text', '--evidence', 'E404'],
    ['baseline', 'capture', '--file', 'src/title.js', '--file', './src/title.js'],
    ['baseline', 'capture', '--file', 'src/title.js', '--no-files'],
    ['baseline', 'capture', ...Array.from({ length: 21 }, (_, i) => ['--file', `input-${i}`]).flat()],
    ['baseline', 'compare', 'B404'],
    ['baseline', 'compare', 'B1', '--to', 'B404'],
    ['baseline', 'compare', 'B1', '--file', 'src/title.js'],
    ['baseline', 'assess', 'B404', '--area', 'scope', '--finding', 'uncertain', '--reason', 'No baseline'],
    ['baseline', 'assess', 'B1', '--area', 'scope', '--finding', 'invalid', '--reason', 'Invalid finding'],
    ['baseline', 'assess', 'B1', '--area', 'scope', '--finding', 'uncertain'],
    ['baseline', 'assess', 'B1', '--area', 'scope', '--finding', 'uncertain', '--reason', 'Invalid link', '--evidence', 'E404'],
  ];
  for (const request of requests) {
    const immediatelyBefore = snapshotTree(dir);
    jsonFailure(run(dir, [...request, '--json']), 2, 'USAGE_ERROR');
    const after = snapshotTree(dir);
    if (request[0] === 'baseline' && request[1] === 'compare') assert.deepEqual(after, immediatelyBefore);
    assert.deepEqual(withoutLockDirectoryTime(after), withoutLockDirectoryTime(before), `request changed files: ${request.join(' ')}`);
    assert.equal(existsSync(`${recordFile(dir)}.lock`), false);
  }
});

test('corrupt schema 3 baseline history and verification contexts are never rewritten', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'A criterion', '--json']), 'add');
  jsonSuccess(run(dir, ['check', 'record', '--criterion', 'C1', '--status', 'skipped', '--reason', 'Not run', '--json', '--', 'node', '--test']), 'check');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Report', '--source', 'Caller', '--subject', 'Subject', '--limitations', 'Limited', '--check', 'CHK1', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'inconclusive', '--reason', 'Limited report', '--evidence', 'E1', '--json']), 'evaluate');
  jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'test/title.test.js', '--json']), 'baseline');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'A revised criterion', '--evidence', 'E1', '--json']), 'revise');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'verification', '--finding', 'uncertain', '--reason', 'Review required', '--json']), 'baseline');
  const file = recordFile(dir);
  const valid = JSON.parse(readFileSync(file, 'utf8'));
  const mutations = [
    (record) => { record.revisions[0].unexpected = true; },
    (record) => { record.revisions[0].target = 'C404'; },
    (record) => { record.revisions[0].entryCount = 0; },
    (record) => { record.revisions[0].evidenceIds = ['E404']; },
    (record) => { record.baselines[0].revisionCount = 99; },
    (record) => { record.baselines[0].evidenceCount = 0; },
    (record) => { record.baselines[0].files[0].digest = 'bad'; },
    (record) => { record.driftAssessments[0].baselineId = 'B404'; },
    (record) => { record.driftAssessments[0].files[0].path = '/different-path'; },
    (record) => { record.checkContexts = []; },
    (record) => { record.checkContexts[0].revisionCount = 99; },
    (record) => { record.evidenceContexts[0].entryCount = 0; },
    (record) => { record.evaluationContexts[0].evaluationId = 'V404'; },
    (record) => { record.evaluationContexts[0].unexpected = true; },
  ];
  for (const mutate of mutations) {
    const damaged = JSON.parse(JSON.stringify(valid));
    mutate(damaged);
    const bytes = Buffer.from(JSON.stringify(damaged));
    writeFileSync(file, bytes);
    jsonFailure(run(dir, ['handoff', '--json']), 3, 'RECORD_CORRUPT');
    jsonFailure(run(dir, ['baseline', 'capture', '--json']), 3, 'RECORD_CORRUPT');
    assert.deepEqual(readFileSync(file), bytes);
    assert.equal(existsSync(`${file}.lock`), false);
  }
});

test('a reverted criterion retains intervening revisions and does not reuse earlier evaluations', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original text', '--json']), 'add');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Original observation', '--source', 'Caller', '--subject', 'Criterion', '--limitations', 'Limited', '--json']), 'evidence');
  jsonSuccess(run(dir, ['evaluate', 'C1', '--status', 'supported', '--reason', 'Original assessment', '--evidence', 'E1', '--json']), 'evaluate');
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'no_concern', '--reason', 'Original state', '--json']), 'baseline');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Weaker text', '--reason', 'First change', '--json']), 'revise');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Original text', '--reason', 'Restored original wording', '--json']), 'revise');
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.criteria[0].text, 'Original text');
  assert.equal(handoff.criteria[0].evaluation, 'unverified');
  assert.deepEqual(handoff.criteria[0].priorEvaluationIds, ['V1']);
  assert.equal(handoff.baselineComparison.areas.criteria.state, 'changed');
  assert.equal(handoff.baselineComparison.areas.criteria.changes[0].change, 'revised');
  assert.deepEqual(handoff.baselineComparison.interveningRevisions.map((item) => item.reason), ['First change', 'Restored original wording']);
  assert.equal(handoff.driftAssessments[0].areaBasisState, 'changed');
});

test('historical baseline comparisons do not attribute later evidence to the earlier transition', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original', '--json']), 'add');
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  jsonSuccess(run(dir, ['revise', 'C1', '--text', 'Changed', '--json']), 'revise');
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Later report', '--source', 'Caller', '--subject', 'Changed criterion', '--limitations', 'Recorded after B2', '--json']), 'evidence');
  const historical = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--to', 'B2', '--json']), 'baseline').comparison;
  const current = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--json']), 'baseline').comparison;
  assert.equal(historical.areas.criteria.state, 'changed');
  assert.deepEqual(historical.affectedEvidenceCandidates, []);
  assert.ok(current.affectedEvidenceCandidates.some((item) => item.evidenceId === 'E1'));
});

test('a criterion added and removed between comparisons remains visible as recorded activity', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  jsonSuccess(run(dir, ['baseline', 'assess', 'B1', '--area', 'criteria', '--finding', 'uncertain', '--reason', 'No criterion recorded yet', '--json']), 'baseline');
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Temporary criterion', '--reason', 'Exploration', '--json']), 'add');
  jsonSuccess(run(dir, ['evidence', 'add', '--criterion', 'C1', '--summary', 'Temporary observation', '--source', 'Caller', '--subject', 'Criterion', '--limitations', 'Limited', '--json']), 'evidence');
  jsonSuccess(run(dir, ['revise', 'C1', '--remove', '--reason', 'No longer in scope', '--json']), 'revise');
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  const area = handoff.baselineComparison.areas.criteria;
  assert.equal(area.state, 'changed');
  assert.deepEqual(area.before, []);
  assert.deepEqual(area.after, []);
  assert.equal(area.interveningEntries[0].text, 'Temporary criterion');
  assert.equal(area.interveningEntries[0].reason, 'Exploration');
  assert.deepEqual(area.interveningRevisionIds, ['R1']);
  assert.ok(handoff.baselineComparison.affectedEvidenceCandidates.some((item) => item.evidenceId === 'E1'));
  assert.equal(handoff.driftAssessments[0].areaBasisState, 'changed');
  const human = run(dir, ['baseline', 'compare', 'B1']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /C1 was recorded between snapshots/);
  assert.match(human.stdout, /No longer in scope/);
});

test('a changed file selection does not hide an unavailable snapshot', () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['baseline', 'capture', '--json']), 'baseline');
  jsonSuccess(run(dir, ['baseline', 'capture', '--file', 'missing-input.test.js', '--json']), 'baseline');
  const comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--to', 'B2', '--json']), 'baseline').comparison;
  assert.equal(comparison.areas.verification.state, 'changed');
  assert.equal(comparison.areas.verification.files[0].change, 'selection_added');
  assert.equal(comparison.areas.verification.files[0].after.state, 'missing');
  assert.equal(comparison.areas.verification.unknownFileCount, 1);
  const status = run(dir, ['status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /verification unknown; unknown selected files 1/);
});

test('concurrent baseline capture and revision preserve a consistent snapshot or report a lock', { timeout: 10_000 }, async () => {
  const dir = fixture();
  initialize(dir);
  jsonSuccess(run(dir, ['add', 'criterion', '--text', 'Original', '--json']), 'add');
  const captureArgs = ['baseline', 'capture', '--reason', 'Concurrent capture', '--json'];
  const revisionArgs = ['revise', 'C1', '--text', 'Changed', '--reason', 'Concurrent revision', '--json'];
  const captureChild = spawn(executable(dir), captureArgs, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const revisionChild = spawn(executable(dir), revisionArgs, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const outcomes = await Promise.all([collectChild(captureChild), collectChild(revisionChild)]);
  for (const [index, args] of [captureArgs, revisionArgs].entries()) {
    if (outcomes[index].status === 0) jsonSuccess(outcomes[index]);
    else {
      jsonFailure(outcomes[index], 3, 'RECORD_LOCKED');
      jsonSuccess(run(dir, args));
    }
  }
  const handoff = jsonSuccess(run(dir, ['handoff', '--json']), 'handoff').handoff;
  assert.equal(handoff.baselines.length, 1);
  assert.equal(handoff.revisions.length, 1);
  assert.equal(handoff.criteria[0].text, 'Changed');
  const baselineRevisionCount = handoff.baselines[0].revisionCount;
  assert.ok(baselineRevisionCount === 0 || baselineRevisionCount === 1);
  assert.equal(handoff.baselineComparison.areas.criteria.state, baselineRevisionCount === 0 ? 'changed' : 'unchanged');
  assert.equal(existsSync(`${recordFile(dir)}.lock`), false);
});

test('baseline file paths use the CLI working directory with an explicit record elsewhere', () => {
  const dir = fixture();
  const custom = join(dir, 'records', 'work.json');
  jsonSuccess(run(dir, ['init', '--intent', 'Use a selected record', '--record', custom, '--json']), 'init');
  const baseline = jsonSuccess(run(dir, ['baseline', 'capture', '--record', custom, '--file', 'src/title.js', '--json']), 'baseline').baseline;
  assert.equal(baseline.files[0].path, join(dir, 'src', 'title.js'));
  assert.equal(baseline.files[0].state, 'captured');
  assert.equal(existsSync(join(dir, '.synth')), false);
  const before = snapshotTree(dir);
  const comparison = jsonSuccess(run(dir, ['baseline', 'compare', 'B1', '--record', custom, '--json']), 'baseline').comparison;
  assert.equal(comparison.areas.verification.files[0].change, 'matching');
  jsonSuccess(run(dir, ['handoff', '--record', custom, '--json']), 'handoff');
  assert.deepEqual(snapshotTree(dir), before);
});
