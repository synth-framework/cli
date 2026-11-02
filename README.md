# SYNTH

SYNTH is an agent-first CLI for keeping a bounded work intention and its
context available to a developer and coding agent. It captures and resumes
work, runs explicitly selected checks, and records attributed evidence and
criterion evaluations. It does **not** record review or acceptance. A check,
evidence item, evaluation, and acceptance are different things.

The CLI targets Node.js 22+ on macOS and Linux, including agent workspaces.
Platform targets are not a claim that a particular environment was tested.
Native Windows is deferred and WSL2 is provisional. Core CLI operations use no
network. The agent itself may be online.

## Agent-facing quick start

These examples assume the locally installed `synth` executable is on `PATH`
and run inside the project whose work is being recorded. Only an intention is
required; every other entry is optional and can be added later.

```sh
synth init --intent 'Make note titles predictable' --json
synth add criterion --text 'Whitespace-only titles remain empty' --json
synth add question --text 'Should internal whitespace be collapsed?' --json
synth add decision --text 'Limit this work to title behavior' --reason 'Keep the change bounded' --json
synth add gap --text 'Behavior has not been verified' --json
synth add next --text 'Inspect the current title implementation' --json
synth add answer --question Q1 --text 'Keep internal whitespace unchanged' --reason 'Example answer, not independently verified' --json
synth handoff --json
```

Use `synth status` or `synth handoff` without `--json` for human-readable
output. `synth --help` lists all entry kinds, including outcome, scope,
constraint, non-goal, assumption, plan, work update, and work reference. Answers
are recorded responses, not proof they are correct or that a question is
resolved; additional answers are retained. A missing entry is shown as
**not recorded**, not as proof that it is unnecessary.

Context entries are append-only: plans and decisions are not automatically
superseded, and gaps and next actions are not automatically marked resolved or
complete. To communicate a change, add a work `update` that explicitly refers to
the relevant IDs. These updates are recorded statements, not verification; a
reader must interpret them alongside the earlier entries.

Agents can add several entries in one atomic operation instead of invoking the
CLI for each fact:

```sh
printf '%s' '[{"kind":"outcome","text":"Titles behave predictably"},{"kind":"plan","text":"Inspect existing behavior"}]' | synth add --stdin --json
```

`--stdin` accepts a non-empty JSON array of up to 100 objects and 1 MiB of
UTF-8. Each has `kind` and `text`, with optional `reason`; an `answer` also
requires `questionId`. If an entry is invalid, none of that batch is written.

## Selected checks, evidence, and evaluations

Only run a command after inspecting and explicitly selecting it. In the Tiny
Notes fixture, after the quick start above:

```sh
synth check run --criterion C1 --cwd . --timeout-ms 30000 --capture-output --json -- node --test test/title.test.js
synth evidence add --criterion C1 --summary 'Outcome recorded in CHK1' --source 'Check CHK1' --subject 'Tiny Notes title test' --limitations 'This test does not cover whitespace-only titles' --check CHK1 --subject-file src/title.js --json
synth evaluate C1 --status inconclusive --reason 'The recorded test does not cover the stated criterion' --evidence E1 --json
synth handoff --json
```

`check run` executes only the executable and arguments after `--`, without an
implicit shell. Repeat `--criterion` for several criteria. `--cwd` defaults to
the current directory. The default timeout is 30 seconds; `--timeout-ms` accepts
1–300000 milliseconds. The command inherits the environment, receives closed
stdin, and is **not sandboxed**: it can read or change files, access a network,
or launch other programs. Review its arguments and repository scripts first.
Arguments and the working directory are stored in the record; do not put
secrets there. Environment variables are not recorded.

Before running, choose `--capture-output` or `--output-ref <reference>` (or
both). Capture stores at most 16 KiB per stream, decoded as potentially lossy
UTF-8 with truncation flags; it can contain secrets and is stored in the local
record. Without capture, output is discarded and only byte counts are recorded.
An output reference is caller-provided; SYNTH does not inspect or create the
artifact or redact sensitive data. Check `status`, not just the CLI exit code:
a successfully recorded failed or timed-out check still returns CLI exit 0 and
`ok: true`. That says the result was recorded, **not** that the check passed.

Use `check record` with `--status skipped` or `--status inconclusive`, a
`--reason`, and the command after `--` to record a caller-reported check without
running it. A run can also end as failed, timed out, interrupted, or unable to
start. Before launching a process, SYNTH records a pending request, then
releases the record lock while it runs and records the outcome afterward. A
pending entry means the command may or may not have started. SIGINT and SIGTERM
request termination of the process group on POSIX; termination is best effort,
not a sandbox. SIGKILL, a crash, escaped descendants, or a failed final write can
leave a pending entry or a running process. Inspect both before retrying; SYNTH
does not automatically retry.

`--revision` and `--dirty clean|dirty|unknown` on checks are caller-reported;
if absent they are unknown. SYNTH does not run Git or infer a clean tree.
Evidence requires a source, subject, and limitations. Checks and evidence can
be recorded before criteria exist; omitted links remain visible as unlinked.
Recording a passing check or adding evidence does not automatically evaluate a
criterion. An evaluation explicitly links its cited evidence to its criterion,
but that link is a caller's assessment of relevance, not verified coverage. An
evaluation is a reasoned, recorded assessment: `unverified`, `supported`,
`contradicted`, `inconclusive`, or `not_applicable`. Every non-unverified
evaluation requires cited evidence. The latest assessment is displayed and the
history is retained; none is an acceptance decision.

Optional `--subject-file` fingerprints one explicitly selected regular file
with SHA-256 at **evidence-recording time** (maximum 8 MiB, no final symlink).
A later handoff reports `matching`, `changed`, or `unknown` separately from the
evaluation. `matching` means only those file bytes match that snapshot: it does
not prove the check examined that version, cover other inputs, establish
adequacy, or assess semantic drift. Missing/unreadable/oversized files or no
snapshot can leave freshness unknown. A missing file after a captured snapshot
is shown as changed. Revision labels and artifact references are not verified.

## JSON and errors

With `--json`, a successful command writes one JSON object to stdout:
`{ "outputVersion": 1, "ok": true, "command": "...", "data": {...} }`.
An error writes `{ "outputVersion": 1, "ok": false, "command": null,
"error": { "code": "...", "message": "..." } }` to stderr. `command` is the
parsed command name when available, otherwise null. The record has its own
`schemaVersion`. Exit codes are 0 for success, 2 for invalid usage or
input, 3 for state/storage errors, and 1 for an unexpected internal error.
Unverified criteria do not make a read-only command fail. For an interrupted
check, SYNTH records the result when possible and exits 130 for SIGINT or 143
for SIGTERM. Arguments after `--` belong to the selected command, including any
`--json` argument there.

The envelope remains output version 1; Slice 2 adds fields and expands criterion
evaluation values. Consumers should inspect `outputVersion` and tolerate added
fields. Record schema 1 is read without modification; the first successful
write upgrades it atomically to schema 2, retaining existing entries and adding
the previously absent check/evidence/evaluation collections. Older Slice 1
binaries cannot read schema 2. Unsupported schemas and corrupt records remain
untouched; keep a backup if backward compatibility is needed.

## Local storage and recovery

The default record is `.synth/work.json` in the **current** directory. Use
`--record <path>` to select another record; the CLI does not search parent
directories or change `.gitignore`. Record contents may be sensitive. New
record, temporary, and lock files use owner-only permissions on supported
POSIX filesystems, but this is not encryption or identity verification.

Reads never create the record, directory, or lock. Cooperative writers using
the same path take an exclusive `.lock`, fsync a temporary file in the same
directory, and atomically create or replace the record on a local filesystem.
A second writer receives an actionable error rather than overwriting silently.
A corrupt or unsupported record is never treated as empty.

After an interrupted writer, a lock and a `.<record-name>.<uuid>.tmp` file may
remain. First verify independently that **no writer is active**, inspect the
record and any temporary file, and keep copies if unsure. Only then remove the
stale lock and any unneeded temporary file manually. A PID or hostname in the
lock is a hint, not proof that it is stale. If an error occurs after replacement,
the record may already have been saved: inspect it before retrying.

This scheme does not coordinate direct edits, different aliases to the same
path, or uncooperative writers; it is not a distributed lock. Record-file
symlinks are rejected. Network filesystems are not validated. File contents
are fsynced, but directory metadata is not, so atomic replacement is not a
backup or a guarantee against power loss.

## Development and installed-package tests

Development dependencies are TypeScript and Node type definitions. Installing
them may use the npm registry; the resulting CLI has no runtime package
dependencies. From this checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
(unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY && npm test)
```

The test builds the CLI, packs it locally, copies `fixtures/adoption-project`
to a temporary directory **outside this checkout**, installs the tarball there
with npm's offline mode and lifecycle scripts disabled, and invokes the
installed executable. No package is published. The fixture has its own project
configuration and does not import SYNTH internals.

The resolved temporary directory must be outside the checkout and have no
`.git` marker or likely Git-directory layout (`HEAD` with `objects` and `refs`,
or with `commondir`) in its ancestors; otherwise setup fails before packaging.
This conservative filesystem check is not a general Git repository detector.
The test also requires `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and
`GIT_OBJECT_DIRECTORY` to be unset, including empty values, because they can
alter Git discovery. The subshell above unsets them for the test without
changing your shell. If necessary, choose a safe `TMPDIR` and rerun the tests.
On macOS and Linux, the nonblocking-input regression uses the POSIX `mkfifo`
utility and reports a skip when it is unavailable; a skipped regression is not
a verified result.

### Exact macOS validation procedure

On a macOS machine with this checkout and Node.js 22 or newer, run:

```sh
uname -s                # Must print Darwin for a macOS result.
node --version          # Must be v22 or newer.
npm ci --ignore-scripts --no-audit --no-fund
(unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY && npm test)
```

`npm ci` may need network access to obtain the development dependencies. The
installed-package portion of `npm test` uses the local tarball in offline mode.
Record the OS, Node version, and actual test output; a Linux result or the
macOS design target is not a substitute for running this procedure on macOS.
A separate remote workspace/container should likewise be reported as tested
only after the procedure is run there.

For an interactive fixture walkthrough from the repository root, first choose a
`TMPDIR` outside the checkout and outside Git repository ancestors, and run in a
shell where `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, and
`GIT_OBJECT_DIRECTORY` are unset. Unlike the test setup, these manual commands
do not enforce those conditions:

```sh
npm run build
fixture="$(mktemp -d "${TMPDIR:-/tmp}/synth-fixture.XXXXXX")"
cp -R fixtures/adoption-project/. "$fixture/"
package_file="$(npm pack --ignore-scripts --pack-destination "$fixture")"
(cd "$fixture" && npm install --offline --ignore-scripts --no-audit --no-fund --no-save --no-package-lock "./$package_file")
cd "$fixture"
export PATH="$PWD/node_modules/.bin:$PATH"
# Run the quick-start commands above here.
```

The fixture is disposable and independent of the source checkout. Remove the
chosen temporary directory yourself when finished.
