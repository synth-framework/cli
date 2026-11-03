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
  evaluate criteria, and an assessment is not acceptance. Acceptance remains
  unavailable; its eventual self-attestation is not proof a human was present.
  Delegation and reassessment remain open.
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
- **Record evolution.** Schemas 1 and 2 are read without writes and upgraded
  atomically to schema 3 on the next successful mutation. Schema 3 adds explicit
  baseline/revision history and version context; older binaries reject it
  rather than silently dropping fields. Historical prefixes are not tamper-proof
  against direct edits.
- **Independent adoption.** The small fixture has its own project configuration
  and no SYNTH-internal imports. Installed-package tests copy it outside this
  checkout. A separate remote repository is not created by the prototype.
- **Development tracking.** GitHub Issues are the authoritative work backlog;
  agreed slices map to milestones. Repository documents hold the product
  baseline, decisions, and instructions, not a synchronized copy of issue
  status. No automatic synchronization is planned.

## Open decisions

Broader project-wide and automated semantic drift assessment, the acceptance
and delegation interface, and actual macOS and representative remote workspace
results remain open. By developer decision (2026-11-03), macOS and Windows/WSL2
validation is pushed to the final stage (after Slice 4), tracked as backlog
issue FV-01 under the final-stage milestone; representative remote-workspace
results stay with S1-05. Platform targets are not evidence of platform
validation.
