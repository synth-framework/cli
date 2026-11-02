#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { appendEntries, makeHandoff, newRecord, parseEntryBatch, parseEntryInput } from './domain.js';
import { SynthError, usageError } from './errors.js';
import { HELP, renderAdded, renderHandoff, renderStatus } from './presentation.js';
import { initializeRecord, readRecord, recordPath, updateRecord } from './storage.js';

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
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    throw usageError('Standard input must be a JSON array of entries.');
  }
  return parseEntryBatch(parsed);
}

async function main(argv: string[]): Promise<void> {
  // Preserve structured errors even if argument parsing itself fails.
  const jsonRequested = argv.includes('--json');
  let command: string | null = null;
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        tokens: true,
        options: {
          record: { type: 'string' },
          intent: { type: 'string' },
          text: { type: 'string' },
          reason: { type: 'string' },
          question: { type: 'string' },
          stdin: { type: 'boolean' },
          json: { type: 'boolean' },
          help: { type: 'boolean' },
          version: { type: 'boolean' },
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
      if (usedOptions.has(token.name)) throw usageError(`Option --${token.name} was supplied more than once.`);
      usedOptions.add(token.name);
    }
    const outputJson = values.json === true;
    const writeSuccess = (name: string, data: unknown, human: string): void => {
      if (outputJson) {
        process.stdout.write(`${JSON.stringify({ outputVersion: OUTPUT_VERSION, ok: true, command: name, data })}\n`);
      } else {
        process.stdout.write(`${human}\n`);
      }
    };

    if (values.help === true) {
      writeSuccess('help', { usage: HELP }, HELP);
      return;
    }
    if (values.version === true) {
      if (positionals.length !== 0) throw usageError('--version cannot be combined with a command.');
      writeSuccess('version', { version: CLI_VERSION }, CLI_VERSION);
      return;
    }
    if (command === null) throw usageError('Choose a command. Run synth --help for usage.');
    const allowed: Record<string, readonly string[]> = {
      init: ['intent', 'record', 'json'],
      add: ['text', 'reason', 'question', 'stdin', 'record', 'json'],
      status: ['record', 'json'],
      handoff: ['record', 'json'],
    };
    const commandOptions = Object.hasOwn(allowed, command) ? allowed[command] : undefined;
    if (commandOptions === undefined) throw usageError(`Unknown command "${command}". Run synth --help for usage.`);
    for (const option of usedOptions) {
      if (!commandOptions.includes(option)) throw usageError(`Option --${option} is not valid for ${command}.`);
    }
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

    if (positionals.length !== 1) throw usageError(`${command} does not accept positional arguments.`);
    const handoff = makeHandoff(readRecord(location));
    const human = command === 'status' ? renderStatus(location, handoff) : renderHandoff(location, handoff);
    writeSuccess(command, { recordPath: location, handoff }, human);
  } catch (error) {
    const failure = error instanceof SynthError
      ? error
      : new SynthError('INTERNAL_ERROR', 'Unexpected error. Inspect the work record before retrying.', 1);
    if (jsonRequested) {
      process.stderr.write(`${JSON.stringify({
        outputVersion: OUTPUT_VERSION,
        ok: false,
        command,
        error: { code: failure.code, message: failure.message },
      })}\n`);
    } else {
      process.stderr.write(`${failure.code}: ${failure.message}\n`);
    }
    process.exitCode = failure.exitCode;
  }
}

await main(process.argv.slice(2));
