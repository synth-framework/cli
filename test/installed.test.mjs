import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'synth-installed-test-')));
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

test('minimal intention works in the independent, non-Git fixture and shows missing context', () => {
  const dir = fixture();
  assert.equal(existsSync(join(dir, '.git')), false);
  const created = initialize(dir, 'Explore title behavior');
  assert.equal(created.record.schemaVersion, 1);
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
    evidence: 'not_available',
    evaluation: 'not_available',
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
  assert.deepEqual(first.missingContext, []);

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
    [JSON.stringify({ ...valid, schemaVersion: 2 }), 'UNSUPPORTED_SCHEMA'],
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

test('interruption immediately before and after replacement leaves a readable record and a recoverable lock', () => {
  for (const phase of ['before', 'after']) {
    const dir = fixture();
    initialize(dir);
    const file = recordFile(dir);
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
});
