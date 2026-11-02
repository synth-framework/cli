#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appendEntries, makeHandoff, newRecord, parseEntryBatch, parseEntryInput } from './domain.js';
import { addDriftAssessment, addRevision, captureBaseline, compareBaselines, type BaselineArea, type DriftFinding } from './baseline.js';
import { upgradeRecord } from './evolution.js';
import { SynthError, usageError } from './errors.js';
import { snapshotFile } from './fingerprint.js';
import { HELP, renderAdded, renderComparison, renderHandoff, renderStatus } from './presentation.js';
import { runSelectedCheck } from './runner.js';
import { initializeRecord, readRecord, recordPath, updateRecord } from './storage.js';
import { addCheck, addEvidence, addEvaluation, completeCheck, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type DirtyState, type Verdict } from './verification.js';

const CLI_VERSION = '0.1.0';
const OUTPUT_VERSION = 1;
const MAX_STDIN_BYTES = 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_STDIN_BYTES) throw usageError('Standard input exceeds the 1 MiB limit.');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof SynthError) throw error;
    throw usageError('Could not read standard input.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw usageError('Standard input must be valid UTF-8.');
  }
}

async function readBatch(): Promise<ReturnType<typeof parseEntryBatch>> {
  const input = await readStdin();
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; }
  catch { throw usageError('Standard input must be a JSON array of entries.'); }
  return parseEntryBatch(parsed);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) throw usageError(`Provide non-empty ${name}.`);
  return value;
}
function optionalText(value: unknown, name: string): string | null {
  return value === undefined ? null : requiredText(value, name);
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value as string[] : [];
}

async function main(argv: string[]): Promise<void> {
  // Arguments after -- belong exclusively to an explicitly selected check.
  const separator = argv.indexOf('--');
  const cliArgs = separator < 0 ? argv : argv.slice(0, separator);
  const selectedArgv = separator < 0 ? null : argv.slice(separator + 1);
  const jsonRequested = cliArgs.includes('--json');
  let command: string | null = null;
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: cliArgs,
        allowPositionals: true,
        strict: true,
        tokens: true,
        options: {
          record: { type: 'string' }, intent: { type: 'string' }, text: { type: 'string' },
          reason: { type: 'string' }, question: { type: 'string' }, stdin: { type: 'boolean' },
          json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' },
          criterion: { type: 'string', multiple: true }, evidence: { type: 'string', multiple: true },
          cwd: { type: 'string' }, revision: { type: 'string' }, dirty: { type: 'string' },
          'timeout-ms': { type: 'string' }, 'capture-output': { type: 'boolean' }, 'output-ref': { type: 'string' },
          status: { type: 'string' }, summary: { type: 'string' }, source: { type: 'string' },
          subject: { type: 'string' }, limitations: { type: 'string' }, artifact: { type: 'string' },
          check: { type: 'string' }, 'subject-file': { type: 'string' },
          remove: { type: 'boolean' }, file: { type: 'string', multiple: true }, 'no-files': { type: 'boolean' },
          to: { type: 'string' }, area: { type: 'string' }, finding: { type: 'string' },
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Invalid arguments.';
      throw usageError(`${detail} Run synth --help for usage.`);
    }
    const { values, positionals, tokens } = parsed;
    command = positionals[0] ?? null;
    const usedOptions = new Set<string>();
    for (const token of tokens ?? []) {
      if (token.kind !== 'option') continue;
      if (usedOptions.has(token.name) && token.name !== 'criterion' && token.name !== 'evidence' && token.name !== 'file') {
        throw usageError(`Option --${token.name} was supplied more than once.`);
      }
      usedOptions.add(token.name);
    }
    const outputJson = values.json === true;
    const writeSuccess = (name: string, data: unknown, human: string): void => {
      if (outputJson) process.stdout.write(`${JSON.stringify({ outputVersion: OUTPUT_VERSION, ok: true, command: name, data })}\n`);
      else process.stdout.write(`${human}\n`);
    };

    if (values.help === true) {
      writeSuccess('help', { usage: HELP }, HELP);
      return;
    }
    if (values.version === true) {
      if (positionals.length !== 0 || selectedArgv !== null) throw usageError('--version cannot be combined with a command.');
      writeSuccess('version', { version: CLI_VERSION }, CLI_VERSION);
      return;
    }
    if (command === null) throw usageError('Choose a command. Run synth --help for usage.');
    const allowed: Record<string, readonly string[]> = {
      init: ['intent', 'record', 'json'],
      add: ['text', 'reason', 'question', 'stdin', 'record', 'json'],
      status: ['record', 'json'], handoff: ['record', 'json'],
      check: ['record', 'json', 'criterion', 'cwd', 'revision', 'dirty', 'timeout-ms', 'capture-output', 'output-ref', 'status', 'reason'],
      evidence: ['record', 'json', 'criterion', 'summary', 'source', 'subject', 'revision', 'artifact', 'limitations', 'check', 'subject-file'],
      evaluate: ['record', 'json', 'status', 'reason', 'evidence'],
      revise: ['record', 'json', 'text', 'remove', 'reason', 'evidence'],
      baseline: ['record', 'json', 'reason', 'file', 'no-files', 'to', 'area', 'finding', 'evidence'],
    };
    const commandOptions = Object.hasOwn(allowed, command) ? allowed[command] : undefined;
    if (commandOptions === undefined) throw usageError(`Unknown command "${command}". Run synth --help for usage.`);
    for (const option of usedOptions) {
      if (!commandOptions.includes(option)) throw usageError(`Option --${option} is not valid for ${command}.`);
    }
    if (command !== 'check' && selectedArgv !== null) throw usageError('The -- command separator is only valid for check.');
    const explicitRecord = typeof values.record === 'string' ? values.record : undefined;
    const location = recordPath(explicitRecord);

    if (command === 'init') {
      if (positionals.length !== 1) throw usageError('init does not accept positional arguments.');
      const record = newRecord(values.intent);
      initializeRecord(location, record);
      writeSuccess(command, { recordPath: location, record }, `Created work record at ${location}.`);
      return;
    }
    if (command === 'add') {
      let inputs: ReturnType<typeof parseEntryBatch>;
      if (values.stdin === true) {
        if (positionals.length !== 1 || values.text !== undefined || values.reason !== undefined || values.question !== undefined) {
          throw usageError('Use add --stdin alone for input, without a kind, --text, --reason, or --question.');
        }
        inputs = await readBatch();
      } else {
        if (positionals.length !== 2) throw usageError('Use add <kind> --text <text>, or add --stdin.');
        const input: Record<string, unknown> = { kind: positionals[1], text: values.text };
        if (values.reason !== undefined) input.reason = values.reason;
        if (values.question !== undefined) input.questionId = values.question;
        inputs = [parseEntryInput(input)];
      }
      const added = updateRecord(location, (record) => {
        const next = appendEntries(record, inputs);
        return { record: next.record, result: next.added };
      });
      writeSuccess(command, { recordPath: location, entries: added }, renderAdded(added));
      return;
    }
    if (command === 'revise') {
      if (positionals.length !== 2) throw usageError('Use revise <intention-or-entry-id> with --text or --remove.');
      const remove = values.remove === true;
      if ((values.text === undefined) === !remove) throw usageError('Choose exactly one of --text or --remove.');
      const input = {
        target: positionals[1]!, text: remove ? null : requiredText(values.text, '--text'),
        reason: optionalText(values.reason, '--reason'), evidenceIds: stringList(values.evidence),
      };
      const revision = updateRecord(location, (record) => {
        const next = addRevision(record, input);
        return { record: next.record, result: next.revision };
      });
      writeSuccess(command, { recordPath: location, revision }, `Recorded revision ${revision.id} for ${revision.target}; earlier versions remain in history.`);
      return;
    }
    if (command === 'baseline') {
      const mode = positionals[1];
      if (!mode || !['capture', 'compare', 'assess'].includes(mode)) throw usageError('Use baseline capture, baseline compare, or baseline assess.');
      const modeOptions = mode === 'capture' ? ['record', 'json', 'reason', 'file', 'no-files']
        : mode === 'compare' ? ['record', 'json', 'to'] : ['record', 'json', 'area', 'finding', 'reason', 'evidence'];
      for (const option of usedOptions) if (!modeOptions.includes(option)) throw usageError(`Option --${option} is not valid for baseline ${mode}.`);
      if (mode === 'capture') {
        if (positionals.length !== 2) throw usageError('Use baseline capture with optional selected files and reason.');
        if (values['no-files'] === true && usedOptions.has('file')) throw usageError('Use --file or --no-files, not both.');
        const files = values['no-files'] === true ? [] : usedOptions.has('file')
          ? stringList(values.file).map((file) => resolve(requiredText(file, '--file'))) : null;
        const baseline = updateRecord(location, (record) => {
          const next = captureBaseline(record, { reason: optionalText(values.reason, '--reason'), files });
          return { record: next.record, result: next.baseline };
        });
        writeSuccess(command, { recordPath: location, baseline }, `Captured baseline ${baseline.id}; it is not an acceptance or a semantic drift judgment.`);
        return;
      }
      if (positionals.length !== 3) throw usageError(`Use baseline ${mode} <baseline-id>.`);
      const baselineId = positionals[2]!;
      if (mode === 'compare') {
        const comparison = compareBaselines(upgradeRecord(readRecord(location)), baselineId, optionalText(values.to, '--to') ?? undefined);
        writeSuccess(command, { recordPath: location, comparison }, renderComparison(comparison));
        return;
      }
      if (typeof values.area !== 'string' || !['intention', 'scope', 'criteria', 'verification'].includes(values.area)) throw usageError('--area must be intention, scope, criteria, or verification.');
      if (typeof values.finding !== 'string' || !['intentional', 'unintended', 'uncertain', 'no_concern'].includes(values.finding)) throw usageError('--finding must be intentional, unintended, uncertain, or no_concern.');
      const input = {
        baselineId, area: values.area as BaselineArea, finding: values.finding as DriftFinding,
        reason: requiredText(values.reason, '--reason'), evidenceIds: stringList(values.evidence),
      };
      const assessment = updateRecord(location, (record) => {
        const next = addDriftAssessment(record, input);
        return { record: next.record, result: next.assessment };
      });
      writeSuccess(command, { recordPath: location, assessment }, `Recorded drift assessment ${assessment.id}; it is a caller's assessment, not acceptance.`);
      return;
    }
    if (command === 'check') {
      const mode = positionals[1];
      if (positionals.length !== 2 || (mode !== 'run' && mode !== 'record')) throw usageError('Use check run or check record.');
      if (selectedArgv === null || selectedArgv.length === 0 || selectedArgv.length > 100 || !selectedArgv[0]?.trim() || selectedArgv.some((arg) => arg.includes('\0'))) {
        throw usageError('Provide the selected executable and up to 99 arguments after --.');
      }
      const modeOptions = mode === 'run'
        ? ['record', 'json', 'criterion', 'cwd', 'revision', 'dirty', 'timeout-ms', 'capture-output', 'output-ref']
        : ['record', 'json', 'criterion', 'cwd', 'revision', 'dirty', 'status', 'reason', 'output-ref'];
      for (const option of usedOptions) if (!modeOptions.includes(option)) throw usageError(`Option --${option} is not valid for check ${mode}.`);
      const revision = optionalText(values.revision, '--revision');
      const dirtyValue = values.dirty ?? 'unknown';
      if (dirtyValue !== 'clean' && dirtyValue !== 'dirty' && dirtyValue !== 'unknown') throw usageError('--dirty must be clean, dirty, or unknown.');
      const cwd = resolve(requiredText(values.cwd ?? '.', '--cwd'));
      const timeoutText = values['timeout-ms'];
      let timeoutMs: number | null = mode === 'run' ? DEFAULT_TIMEOUT_MS : null;
      if (timeoutText !== undefined) {
        if (typeof timeoutText !== 'string' || !/^[0-9]+$/.test(timeoutText)) throw usageError('--timeout-ms must be a whole number of milliseconds.');
        timeoutMs = Number(timeoutText);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw usageError(`--timeout-ms must be between 1 and ${MAX_TIMEOUT_MS}.`);
      }
      const captureOutput = values['capture-output'] === true;
      const outputRef = optionalText(values['output-ref'], '--output-ref');
      if (mode === 'run' && !captureOutput && outputRef === null) {
        throw usageError('Choose --capture-output or provide --output-ref before running a check.');
      }
      const input = {
        argv: selectedArgv, cwd, criterionIds: stringList(values.criterion), revision,
        dirty: dirtyValue as DirtyState,
        provenance: (values.revision !== undefined || values.dirty !== undefined ? 'reported' : 'unknown') as 'reported' | 'unknown',
        timeoutMs, captureOutput, outputRef,
      };
      if (mode === 'record') {
        if (values.status !== 'skipped' && values.status !== 'inconclusive') throw usageError('A reported check must have --status skipped or inconclusive.');
        const reason = requiredText(values.reason, '--reason');
        const check = updateRecord(location, (record) => {
          const next = addCheck(record, input, { status: values.status as 'skipped' | 'inconclusive', reason });
          return { record: next.record, result: next.check };
        });
        writeSuccess(command, { recordPath: location, check }, `Recorded check ${check.id} [${check.status}]; it was not run by SYNTH.`);
        return;
      }
      const pending = updateRecord(location, (record) => {
        const next = addCheck(record, input);
        return { record: next.record, result: next.check };
      });
      let result: Awaited<ReturnType<typeof runSelectedCheck>>;
      try { result = await runSelectedCheck(pending); }
      catch { throw new SynthError('INTERNAL_ERROR', `Check ${pending.id} may have run but its outcome was not recorded. Inspect the pending check and process before retrying.`, 1); }
      try {
        updateRecord(location, (record) => ({ record: completeCheck(record, result.check), result: undefined }));
      } catch {
        throw new SynthError('IO_ERROR', `Check ${pending.id} was invoked but its final outcome could not be saved. Inspect the pending check and process before retrying.`, 3);
      }
      writeSuccess(command, { recordPath: location, check: result.check }, `Recorded check ${result.check.id} [${result.check.status}]. A recorded check is not a criterion evaluation.`);
      if (result.interruptedBy !== null) process.exitCode = result.interruptedBy === 'SIGINT' ? 130 : 143;
      return;
    }
    if (command === 'evidence') {
      if (positionals.length !== 2 || positionals[1] !== 'add') throw usageError('Use evidence add with attributed evidence details.');
      const file = optionalText(values['subject-file'], '--subject-file');
      const input = {
        summary: requiredText(values.summary, '--summary'), source: requiredText(values.source, '--source'),
        subject: requiredText(values.subject, '--subject'), revision: optionalText(values.revision, '--revision'),
        artifact: optionalText(values.artifact, '--artifact'), limitations: requiredText(values.limitations, '--limitations'),
        criterionIds: stringList(values.criterion), checkId: optionalText(values.check, '--check'),
        subjectFile: file === null ? null : snapshotFile(file),
      };
      const evidence = updateRecord(location, (record) => {
        const next = addEvidence(record, input);
        return { record: next.record, result: next.evidence };
      });
      writeSuccess(command, { recordPath: location, evidence }, `Recorded evidence ${evidence.id}; it is not automatically an evaluation.`);
      return;
    }
    if (command === 'evaluate') {
      if (positionals.length !== 2) throw usageError('Use evaluate <criterion-id> --status <status> --reason <text>.');
      const verdict = values.status;
      if (typeof verdict !== 'string' || !['unverified', 'supported', 'contradicted', 'inconclusive', 'not_applicable'].includes(verdict)) throw usageError('--status must be unverified, supported, contradicted, inconclusive, or not_applicable.');
      const input = { criterionId: positionals[1]!, verdict: verdict as Verdict, rationale: requiredText(values.reason, '--reason'), evidenceIds: stringList(values.evidence) };
      const evaluation = updateRecord(location, (record) => {
        const next = addEvaluation(record, input);
        return { record: next.record, result: next.evaluation };
      });
      writeSuccess(command, { recordPath: location, evaluation }, `Recorded evaluation ${evaluation.id} for ${evaluation.criterionId} [${evaluation.verdict}]; this is not acceptance.`);
      return;
    }
    if (positionals.length !== 1) throw usageError(`${command} does not accept positional arguments.`);
    const handoff = makeHandoff(readRecord(location));
    const human = command === 'status' ? renderStatus(location, handoff) : renderHandoff(location, handoff);
    writeSuccess(command, { recordPath: location, handoff }, human);
  } catch (error) {
    const failure = error instanceof SynthError ? error : new SynthError('INTERNAL_ERROR', 'Unexpected error. Inspect the work record before retrying.', 1);
    if (jsonRequested) {
      process.stderr.write(`${JSON.stringify({ outputVersion: OUTPUT_VERSION, ok: false, command, error: { code: failure.code, message: failure.message } })}\n`);
    } else process.stderr.write(`${failure.code}: ${failure.message}\n`);
    process.exitCode = failure.exitCode;
  }
}

await main(process.argv.slice(2));
