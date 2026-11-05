# SYNTH

SYNTH is an agent-first CLI for keeping a bounded work intention and its
context available to a developer and coding agent. It captures and resumes
work, runs explicitly selected checks, records attributed evidence and criterion
evaluations, and compares optional baselines. It does **not** record formal
review findings or acceptance. A check, evidence item, evaluation, drift
assessment, and acceptance are different things.

The CLI targets Node.js 22+ on macOS and Linux, including agent workspaces.
Platform targets are not a claim that a particular environment was tested.
Native Windows is deferred; WSL2 is validated (see *Recorded validation
results* below). Core CLI operations use no network. The agent itself may be online.

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

Context entries and revisions are append-only. An explicit revision can change
the current intention, outcome, scope, constraint, non-goal, criterion, or
verification note while retaining the original and revision history. Plans and
decisions are not automatically superseded, and gaps and next actions are not
automatically marked resolved or complete. A work `update` can refer to earlier
IDs; it is a recorded statement, not verification.

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

## Baselines and review of change

A baseline is optional: work, checks, evidence, evaluations, and revisions do
not require one. These commands continue the Tiny Notes example above:

```sh
synth add scope --text 'Title normalization' --json
synth add verification --text 'Review the title tests' --json
synth baseline capture --file test/title.test.js --reason 'Record the current working context' --json
synth revise C1 --text 'Title output is a string' --reason 'Example scope change' --evidence E1 --json
synth baseline compare B1 --json
synth baseline assess B1 --area criteria --finding uncertain --reason 'Check whether the revised criterion meets intent' --evidence E1 --json
synth baseline capture --reason 'Record the changed working context' --json
synth baseline compare B1 --to B2 --json
synth handoff --json
```

`revise` changes `intention` or a recorded outcome, scope, constraint,
non-goal, criterion, or verification ID. Use `--remove` instead of `--text` to
remove a recorded entry from the current baseline; the intention cannot be
removed. A later `--text` restores an entry. `--reason` and `--evidence` are
optional, and missing reasons are shown. If a reason becomes known later, add a
work `update` that names the revision ID: that is a plain note, not an automatic
structured link. A revision is a caller-reported change, not an authorization.

In the JSON handoff, the version-1 arrays (`outcomes`, `scope`, `constraints`,
`nonGoals`, `criteria`, `verification`) contain active entries only, so
consumers that do not know the newer `active` field never read removed work as
current; removed entries are listed separately under `removedEntries`.

Checks retain the criterion versions linked at **request** time, evidence at
recording time, and evaluations at assessment time. When a criterion is
revised, an evaluation of an earlier version remains in history but is not
applied to the new version; the new version remains unverified until explicitly
evaluated. This also applies when an entry is removed or restored. Earlier
checks and evidence are retained, and their version context is separate from
file freshness and from any assessment of relevance or adequacy.

`baseline capture` snapshots the recorded current intention, scope (including
outcomes, constraints, and non-goals), criteria, verification notes, and up to
20 explicitly selected files. Each file is fingerprinted with the same 8 MiB
regular-file limit used for evidence; its absolute path and hash are stored.
Relative file paths are resolved from the CLI's working directory, even when
`--record` selects a record elsewhere. Omitting `--file` on a later capture
retains the previous selected paths and captures them again. Supplying one or
more `--file` options replaces the selection; `--no-files` explicitly clears it.
Missing or unreadable snapshots remain unknown. Files are read one at a time, not as an atomic project snapshot;
other processes can change them during or between captures. The baseline is not
a whole-project snapshot: unselected files, check inputs, unrecorded work, and
semantic meaning are not inferred.

`baseline compare B1` compares B1 with the current recorded state and current
bytes of B1's selected files; `--to B2` compares the two saved snapshots,
including added or removed file selections. The handoff shows the latest
baseline's current comparison and the last baseline-to-baseline transition;
earlier comparisons remain available explicitly. Comparisons show recorded
text, additions, removals, revisions and reasons, and selected file changes.
An area can contain both known changes and unknown files; the unknown count
remains visible. An unchanged result is not evidence that the work or
verification is adequate. Evidence IDs shown as candidates are based on
recorded links or unknown check inputs; SYNTH does **not** determine which
evidence is actually affected.

`baseline assess` records a caller's reasoned assessment for one area against
a chosen baseline; it is not a formal review finding or acceptance, and the
caller is not authenticated. The handoff reports whether that **area's recorded
text and selected files** have changed since the assessment and lists evidence
added since then. This is not a freshness guarantee for the assessment as a
whole: other areas, evidence relevance, and untracked inputs may also matter.
Capturing a new baseline does not erase earlier changes or assessments.

## Claims, acceptance, QA coverage, and delivery targets

`synth add claim --text '...'` records a consequential statement. Correct it with
`synth revise CL1 --text '...' [--reason ...]`; the original text stays in the
revision history and the handoff shows the current revision and original.
Detecting a change is not the same as judging its meaning: SYNTH records the
correction, it does not declare the claim true or false.

`synth accept --statement '...' [--gap G1]...` records a **self-attestation of
acceptance with known gaps** (repeat `--gap` for existing gap IDs). It is not
proof a human was present, not a verification, and not delegation; recording it
deliberately does **not** depend on freshness. `synth accept --reassess ...`
records a new acceptance after relevant changes. The handoff and status report
whether the latest acceptance is `current` or `reassessment_needed`, listing
what changed since (entries, revisions, baselines, checks — including a check
that only just completed, since `completeCheck` rewrites in place — evidence,
evaluations) by comparing recorded counts — not timestamps.

`synth deliver --target code|pr-handoff|artifact|documentation|deployment|observed-outcome --text '...'`
records a delivery **goal**. Delivery targets are kept separate from recorded
activities: an update saying "implemented" is not a delivery outcome, and no
goal is inferred from another.

`synth check run|record --case positive|negative|boundary|regression ...`
labels a check's case type so coverage of negative and boundary cases stays
visible. The handoff's **QA coverage** section summarizes criteria
(evaluated/unverified), checks by status and case, evidence and evaluation
counts, drift-assessment findings, and residual risks (recorded gaps, unknown
selected files). Coverage is recorded coverage, not proof of adequacy.

## Optional TDD and BDD practices

TDD and BDD are optional recorded practices, not mandatory processes, and SYNTH
has no separate engine for them; both reuse the same evidence model (criteria,
checks, evidence, evaluations, acceptance).

- `synth add practice --text tdd|bdd [--reason ...]` records the chosen optional
  practice for the work item (PRn). Any other text is a usage error.
- `synth add scenario --text 'Given … When … Then …' [--criterion C1]` records a
  BDD-style statement (SCn), optionally linked to one existing criterion; the
  link must reference a recorded criterion. The same fields are accepted in
  `add --stdin` batches (`criterionId` is valid only on a scenario).
- `synth check run|record ... --expect pass|fail` records the caller's expected
  outcome for a check — for example, the red step of a TDD cycle expects `fail`
  before the implementation exists. The handoff reports `expectationMet` per
  check: whether the recorded outcome matched the recorded expectation. That is
  a recorded comparison, not a judgment that the expectation was correct, and it
  is null when no expectation was recorded or the check has no pass/fail outcome.

The handoff lists practices and scenarios (with their criterion link), and the QA
coverage summary counts them. Neither practice is required: a record without them
is normal, and `practices`/`scenarios` then appear under missing context.

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

The envelope is normally output version 1; newer slices add fields. Consumers
should inspect `outputVersion` and tolerate added fields. One exception:
`status` and `handoff` emit output version 2 once the intention has been
revised (`intentionRevisionId` is set), because the v1 handoff field
`originalIntention` then no longer describes the current objective. In an
output version 2 envelope, v1 consumers that ignore added fields must read
`currentIntention` as the objective; `originalIntention` keeps the original
text for history. Record schemas 1, 2, 3, and 4
are read without modification; the first successful mutation upgrades them
atomically to schema 5, retaining existing context, checks, evidence,
evaluations, revisions, baselines, acceptances, and delivery targets, and adding
a `criterionId` field to each entry plus an `expect` label on each check.
Because schema 2 did
not support criterion revisions, its existing checks, evidence, and evaluations
are associated with the original criterion versions on upgrade; no check inputs
are inferred. Older binaries reject schemas newer than their own rather than
dropping fields: Slice 3 binaries reject schema 5 (including `practice`/`scenario`
entries and check expectations), just as they reject schema 4 (including `claim`
entries, which only schema 4 and later records may contain). Unsupported schemas
and corrupt records remain untouched; keep a backup if backward compatibility is
needed.

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
path, or uncooperative writers; it is not a distributed lock. Baselines refer
to append-only entry and revision prefixes, so directly editing historical data
can also alter what a baseline represents. This is not tamper-proof history.
Record-file symlinks are rejected. Network filesystems are not validated. File
contents are fsynced, but directory metadata is not, so atomic replacement is
not a backup or a guarantee against power loss.

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
a verified result. On POSIX the CLI reads stdin through the `read(2)` syscall
path (polling on `EAGAIN`), because some Darwin kernels never report `EV_EOF`
to kqueue/libuv for an inherited nonblocking FIFO — the syscall path reports
EOF correctly, so the full producer-to-EOF path is exercised on macOS too.

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

### Recorded validation results

These procedures have been run on real machines and containers, each passing
the full suite (80/80 tests, 0 skipped) on the tree merged as `ef802f9`:

- macOS 15.7.4 (x86_64, Darwin 24.6.0), Node v22 — issue #26, comment 6660008615
- Windows/WSL2 (Ubuntu 26.04, WSL 3.0.3.0, kernel 6.18.54.1-microsoft-standard-WSL2),
  Node v22.22.1 — issue #26, comment 6662110107
- remote Linux container: `node:22-bookworm` (digest sha256:f6f56d63…), OrbStack
  LinuxVM kernel 6.7.11, Node v22.23.4 — issue #9, comment 6660791107
- remote CI runner: ubuntu-latest, run 42041576167 on `ef802f9`

Native Windows remains deferred and unverified. Report new platform results in
the backlog issues rather than by editing this list.

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
