# Prototype decisions

## Current decisions

- **Agent-first, local core.** The same CLI is intended for a developer or an
  agent in a local or remote workspace. Core operations do not require network
  access. There is no implied cross-machine state synchronization.
- **Small implementation.** TypeScript and Node.js 22+; no runtime packages.
  Separate domain rules, storage, CLI/presentation, and explicitly invoked
  command execution.
- **One local record.** Schema-versioned JSON is authoritative for one bounded
  work item. The default is `.synth/work.json` relative to the current working
  directory; another path can be selected explicitly. No parent-directory
  discovery or nested work hierarchy is required.
- **Storage boundary.** Cooperative writers using the same path take an
  exclusive lock, write and fsync a same-directory temporary file, and atomically
  create or replace the record on supported local filesystems. Readers do not
  take locks or write. Locks are not automatically stolen. A crash can leave a
  lock or temporary file; inspect and recover manually as described in the
  README. Direct edits, path aliases, and uncooperative writers are not
  coordinated. This is not a distributed lock, backup system, tamper-proof
  history, or a guarantee against power loss; directory metadata is not fsynced.
- **Honest state.** Checks, evidence, criterion evaluations, freshness, and
  acceptance are separate concepts. Checks and evidence do not automatically
  evaluate criteria, and an assessment is not acceptance. Acceptance is a
  recorded self-attestation with known gaps (`accept`); it is not proof a human
  was present, not a verification, and recording it does not depend on
  freshness. The handoff reports whether the latest acceptance is current or
  needs reassessment by comparing recorded counts, and qualifies that state as
  a count comparison only. Selected-input changes and drift assessments or
  delivery targets recorded after the acceptance are reported as separate
  reassessment signals; they never change the state. All recorded acceptances
  are exposed as history. Delegation remains unavailable.
- **Claims and corrections.** Consequential claims are entries (`claim` kind).
  Corrections are explicit revisions that retain the original text; detecting
  a change is not judging its meaning, and SYNTH does not declare claims true.
- **QA coverage.** Checks carry an optional case label (positive, negative,
  boundary, regression). The handoff summarizes criteria, checks by status and
  case, evidence, evaluations, drift findings, and residual risks (gaps,
  unknown selected files). Coverage is recorded coverage, not proof of
  adequacy.
- **Delivery targets.** Delivery goals (code, PR handoff, artifact,
  documentation, deployment, observed outcome) are recorded separately from
  activities; one goal is never inferred from another or from a recorded
  statement.
- **Optional practices (TDD/BDD).** TDD and BDD are optional recorded practices
  over the same evidence model — no separate engine and no mandatory process.
  `practice` entries record the chosen practice (exactly `tdd` or `bdd`);
  `scenario` entries record BDD-style statements with an optional link to one
  existing criterion; checks carry an optional caller expectation (`expect:
  pass|fail`) whose match with the recorded outcome is reported as
  `expectationMet` — a recorded comparison, not a judgment that the expectation
  was correct.
- **Verification provenance and freshness.** Revision and dirty state are
  caller-reported or unknown; the CLI does not run Git implicitly. An optional
  SHA-256 snapshot covers one explicitly selected regular file at evidence
  recording time, not all inputs or the earlier check execution. A matching
  digest is not proof of semantic relevance or adequate coverage.
- **Explicit command boundary.** A check runs only the selected argv without an
  implicit shell, with a finite timeout and output discarded unless the caller
  opts into bounded capture. The process inherits the environment and is not
  sandboxed. A persisted pending request can outlive an interrupted runner;
  recovery requires inspection, not an automatic retry.
- **Baselines and revisions.** Baselines are explicit and optional. They refer
  to append-only intention/context revision prefixes and snapshot up to 20
  selected regular files independently, not atomically across the project. Later
  captures inherit the last file selection unless explicitly replaced or
  cleared. Comparison reports recorded text and selected
  file changes, not semantic drift or proven evidence impact. A caller can record
  an area-specific drift assessment; its assessed area and later evidence are
  visible, without claiming independent review or authenticated authority.
- **Criterion-version context.** Checks retain linked criterion versions at
  request time, evidence at recording time, and evaluations at assessment time.
  A revised criterion is unverified for its new version until explicitly
  evaluated; earlier assessments remain available. These links do not establish
  file inputs, relevance, or adequacy, and are separate from acceptance.
- **Record evolution.** Schemas 1, 2, 3, and 4 are read without writes and
  upgraded atomically to schema 5 on the next successful mutation. Schema 3 added
  explicit baseline/revision history and version context; schema 4 adds claims,
  check case labels, recorded acceptances, and delivery targets; schema 5 adds
  optional practice and scenario entries (entries gain a `criterionId` field)
  and a per-check caller expectation (`expect`). Older binaries reject newer
  schemas rather than silently dropping their fields. Historical prefixes are
  not tamper-proof against direct edits.
- **Independent adoption.** The small fixture has its own project configuration
  and no SYNTH-internal imports. Installed-package tests copy it outside this
  checkout. A separate remote repository is not created by the prototype.
- **Development tracking.** GitHub Issues are the authoritative work backlog;
  agreed slices map to milestones. Repository documents hold the product
  baseline, decisions, and instructions, not a synchronized copy of issue
  status. No automatic synchronization is planned.

- **POSIX stdin is read via `read(2)`, not libuv's poller.** Validation on
  macOS 15.7.4 x86_64 (Darwin kernel 24.6.0, observed during FV-01) showed that
  kqueue never reports `EV_EOF` for an inherited `O_NONBLOCK` FIFO after the
  last writer closes, so a stream-based `for await (process.stdin)` hung
  forever while a raw `read(2)` returned EOF (0) correctly. The CLI therefore
  polls `fs.readSync(0, …)` (10 ms on `EAGAIN`) on Linux/macOS and keeps the
  stream path on Windows, which remains a deferred platform.

- **FV-01 platform validation is recorded, not open.** By developer decision
  (2026-11-03), macOS and Windows/WSL2 validation was pushed to the final stage
  (FV-01, issue #26; representative remote-workspace results stayed with S1-05,
  issue #9). Those runs have since been executed and each passed the full suite
  (80/80, 0 skipped) on the tree merged as `ef802f9`: macOS 15.7.4 x86_64 (#26,
  comment 6660008615), Windows/WSL2 (#26, comment 6662110107), a remote `node:22-bookworm` Linux
  container (#9, comment 6660791107), and the ubuntu-latest CI runner (run
  42041576167). Native Windows remains deferred and unverified. Platform targets
  are not evidence of platform validation; only the recorded runs above count.

## Open decisions

Broader project-wide and automated semantic drift assessment and delegation of
acceptance remain open.
