import { spawn, type ChildProcess } from 'node:child_process';
import { OUTPUT_LIMIT_BYTES, type Check, type CheckOutput, type OutputStream } from './verification.js';

type Interrupt = 'SIGINT' | 'SIGTERM';
type StopCause = 'timeout' | Interrupt;

function collector(captured: boolean): { add: (chunk: Buffer) => void; result: () => OutputStream } {
  let bytes = 0;
  let kept = 0;
  const chunks: Buffer[] = [];
  return {
    add(chunk) {
      bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + chunk.length);
      if (!captured || kept >= OUTPUT_LIMIT_BYTES) return;
      const selected = chunk.subarray(0, OUTPUT_LIMIT_BYTES - kept);
      chunks.push(Buffer.from(selected));
      kept += selected.length;
    },
    result() {
      return {
        bytes,
        text: captured ? Buffer.concat(chunks).toString('utf8') : null,
        truncated: captured && bytes > kept,
      };
    },
  };
}

/** Run only the supplied argv. This is not a sandbox and does not invoke a shell. */
export async function runSelectedCheck(check: Check): Promise<{ check: Check; interruptedBy: Interrupt | null }> {
  const capture = check.captureOutput;
  const stdout = collector(capture);
  const stderr = collector(capture);
  let child: ChildProcess | undefined;
  let startedAt: string | null = null;
  let cause: StopCause | null = null;
  let spawnError: unknown;
  let runtimeError: unknown;
  let finished = false;
  let deadline: NodeJS.Timeout | undefined;
  let escalation: NodeJS.Timeout | undefined;
  let forcedFinish: NodeJS.Timeout | undefined;

  return new Promise((resolvePromise) => {
    const signalChild = (signal: NodeJS.Signals): void => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* It may already have exited. */ }
      }
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (finished) return;
      finished = true;
      if (deadline) clearTimeout(deadline);
      if (cause === null) {
        // Normal completion: no stop was requested, so cancel pending timers.
        if (escalation) clearTimeout(escalation);
        if (forcedFinish) clearTimeout(forcedFinish);
      }
      // When a stop was requested (timeout/interrupt), the escalation timer must
      // still fire: the selected leader may close before the escalation window
      // ends while same-group descendants that ignored SIGTERM are still alive,
      // and the scheduled SIGKILL to the process group is what removes them.
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      const output: CheckOutput = {
        captured: capture, limitBytesPerStream: OUTPUT_LIMIT_BYTES, encoding: 'utf8-lossy',
        stdout: stdout.result(), stderr: stderr.result(),
      };
      let status: Check['status'];
      let reason: string | null = null;
      let exitCode = code;
      let exitSignal: string | null = signal;
      if (spawnError !== undefined) {
        status = 'could_not_start';
        const codeText = typeof spawnError === 'object' && spawnError !== null && 'code' in spawnError && typeof spawnError.code === 'string'
          ? ` (${spawnError.code})` : '';
        reason = `Could not start the selected command${codeText}.`;
        startedAt = null;
        exitCode = null;
        exitSignal = null;
      } else if (cause === 'timeout') {
        status = 'timed_out';
        reason = 'Timeout reached; termination was requested. Escaped descendants may still run.';
      } else if (cause !== null || signal !== null) {
        status = 'interrupted';
        reason = cause !== null ? `Interrupted by ${cause}; termination was requested.` : `The selected process ended on ${signal}.`;
      } else if (runtimeError !== undefined) {
        status = 'inconclusive';
        reason = 'An error occurred while monitoring the selected process.';
      } else if (code === 0) {
        status = 'passed';
      } else if (code !== null && code > 0) {
        status = 'failed';
      } else {
        status = 'inconclusive';
        reason = 'The selected process ended without an exit code or signal.';
        exitCode = null;
      }
      resolvePromise({
        check: { ...check, status, startedAt, endedAt: new Date().toISOString(), exitCode, signal: exitSignal, reason, output },
        interruptedBy: cause === 'SIGINT' || cause === 'SIGTERM' ? cause : null,
      });
    };
    const stop = (why: StopCause): void => {
      if (cause !== null || finished) return;
      cause = why;
      signalChild(why === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
      escalation = setTimeout(() => {
        signalChild('SIGKILL');
        child?.stdout?.destroy();
        child?.stderr?.destroy();
      }, 500);
      forcedFinish = setTimeout(() => {
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.unref();
        finish(null, null);
      }, 1_000);
    };
    const onInt = (): void => stop('SIGINT');
    const onTerm = (): void => stop('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    try {
      child = spawn(check.argv[0]!, check.argv.slice(1), {
        cwd: check.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.once('spawn', () => { startedAt = new Date().toISOString(); });
      child.stdout?.on('data', (chunk: Buffer) => stdout.add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.stderr?.on('data', (chunk: Buffer) => stderr.add(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      child.once('error', (error) => {
        if (startedAt === null) spawnError = error;
        else runtimeError = error;
      });
      child.once('close', (code, signal) => finish(code, signal));
      deadline = setTimeout(() => stop('timeout'), check.timeoutMs!);
    } catch (error) {
      spawnError = error;
      finish(null, null);
    }
  });
}
