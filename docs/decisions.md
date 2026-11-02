# Prototype decisions

## Current decisions

- **Agent-first, local core.** The same CLI is intended for a developer or an
  agent in a local or remote workspace. Core operations do not require network
  access. There is no implied cross-machine state synchronization.
- **Small implementation.** TypeScript and Node.js 22+; no runtime packages.
  Separate domain rules, storage, CLI/presentation, and (in a later slice)
  explicitly invoked command execution.
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
- **Honest state.** Evidence, evaluations, and acceptance are separate concepts.
  Slice 1 cannot record them and reports criteria as unverified. Later acceptance
  will be a self-attestation, not proof that a human was present; the exact
  delegation and reassessment design remains open.
- **Independent adoption.** The small fixture has its own project configuration
  and no SYNTH-internal imports. Installed-package tests copy it outside this
  checkout. A separate remote repository is not created by the prototype.
- **Development tracking.** GitHub Issues are the authoritative work backlog;
  agreed slices map to milestones. Repository documents hold the product
  baseline, decisions, and instructions, not a synchronized copy of issue
  status. No automatic synchronization is planned.

## Open decisions

Evidence subject/freshness boundaries, scope comparison, the acceptance and
delegation interface, and how to obtain actual macOS and representative remote
workspace results remain to be decided or investigated in their respective
slices. Platform targets are not evidence of platform validation.
