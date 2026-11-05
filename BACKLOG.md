# Backlog index

The authoritative development backlog is **GitHub Issues**; the agreed delivery
slices are **GitHub Milestones**. This file is only an index of links — issue
status, acceptance criteria, verification evidence, and progress live on
GitHub and are not duplicated here. There is no automatic or bidirectional
synchronization.

- Repository: <https://github.com/synth-framework/cli>

## Milestones (delivery slices)

- [Milestone #1 — Slice 1 — Capture and resume](https://github.com/synth-framework/cli/milestone/1)
- [Milestone #2 — Slice 2 — Observe and evaluate](https://github.com/synth-framework/cli/milestone/2)
- [Milestone #3 — Slice 3 — Review, correct, and reassess](https://github.com/synth-framework/cli/milestone/3)
- [Milestone #4 — Slice 4 — Exercise quality practices](https://github.com/synth-framework/cli/milestone/4)
- [Milestone #5 — Final stage — platform validation (macOS, Windows/WSL2)](https://github.com/synth-framework/cli/milestone/5)
- [Milestone #6 — Slice 5 — audit hardening + npm distribution prep](https://github.com/synth-framework/cli/milestone/6)
- [Milestone #7 — Final stage — independent adoption audit (gated on Slice 5 #32-#40)](https://github.com/synth-framework/cli/milestone/7)

## Issues

### Slice 1 — Capture and resume

- [#5 S1-01: Decide local record safety and recovery](https://github.com/synth-framework/cli/issues/5)
- [#6 S1-02: Capture and resume an incrementally enriched work item](https://github.com/synth-framework/cli/issues/6)
- [#7 S1-03: Protect record integrity and preserve read-only behavior](https://github.com/synth-framework/cli/issues/7)
- [#8 S1-04: Package the CLI and exercise an independent fixture](https://github.com/synth-framework/cli/issues/8)
- [#9 S1-05: Validate the installed CLI on macOS and representative remote workspaces](https://github.com/synth-framework/cli/issues/9)

### Slice 2 — Observe and evaluate

- [#10 S2-01: Decide evidence-subject and freshness boundaries](https://github.com/synth-framework/cli/issues/10)
- [#11 S2-02: Capture explicitly invoked verification checks](https://github.com/synth-framework/cli/issues/11)
- [#12 S2-03: Record and evaluate attributed evidence](https://github.com/synth-framework/cli/issues/12)

### Slice 3 — Review, correct, and reassess

- [#13 S3-01: Track baseline changes and evidence freshness](https://github.com/synth-framework/cli/issues/13)
- [#14 S3-02: Surface and correct consequential claims](https://github.com/synth-framework/cli/issues/14)
- [#15 S3-03: Decide acceptance self-attestation and delegation](https://github.com/synth-framework/cli/issues/15)
- [#16 S3-04: Record review and acceptance with known gaps](https://github.com/synth-framework/cli/issues/16)
- [#17 S3-05: Reassess acceptance after relevant changes](https://github.com/synth-framework/cli/issues/17)
- [#18 S3-06: Show QA coverage, findings, and residual risks](https://github.com/synth-framework/cli/issues/18)
- [#19 S3-07: Distinguish delivery targets and recorded activities](https://github.com/synth-framework/cli/issues/19)

### Slice 4 — Exercise quality practices

- [#20 S4-01: Support and demonstrate optional TDD](https://github.com/synth-framework/cli/issues/20)
- [#21 S4-02: Support and demonstrate optional BDD](https://github.com/synth-framework/cli/issues/21)
- [#22 S4-03: Exercise greenfield, brownfield, and documentation fixture journeys](https://github.com/synth-framework/cli/issues/22)

### Final stage

- [#26 FV-01: Final-stage platform validation on macOS and Windows/WSL2](https://github.com/synth-framework/cli/issues/26)

### Slice 5 — audit hardening + npm distribution prep

- [#32 AUD-01: timeout escalation must cover same-group descendants that ignore SIGTERM](https://github.com/synth-framework/cli/issues/32)
- [#33 AUD-06: explicit resolution/reopening of gaps and next actions](https://github.com/synth-framework/cli/issues/33)
- [#34 AUD-03: qualify count-only acceptance state in status/JSON/help](https://github.com/synth-framework/cli/issues/34)
- [#35 AUD-02: prepare npm distribution (MIT license, prepack safeguard, package-content test)](https://github.com/synth-framework/cli/issues/35)
- [#36 AUD-08: open work record without following a final symlink (TOCTOU)](https://github.com/synth-framework/cli/issues/36)
- [#37 AUD-09: escape terminal control sequences in human-rendered record text](https://github.com/synth-framework/cli/issues/37)
- [#38 AUD-10: malformed enum/object fields must be RECORD_CORRUPT not INTERNAL_ERROR](https://github.com/synth-framework/cli/issues/38)
- [#39 AUD-07: explicit reconciliation for pending checks](https://github.com/synth-framework/cli/issues/39)
- [#40 AUD-11: reconcile docs and issue-evidence leftovers](https://github.com/synth-framework/cli/issues/40)

### Final stage — independent adoption audit (gated on #32-#40)

- [#41 ADOPT-01: independent adoption-fixture audit (installed-package, E2E, platform, dev+agent)](https://github.com/synth-framework/cli/issues/41)
- [#42 AUDIT-02: re-run internal audit (product/architecture/security/distribution) after #32-#40 are fixed](https://github.com/synth-framework/cli/issues/42)

## Housekeeping notes

- Closing an issue means its stated acceptance criteria were satisfied with
  evidence linked in the issue or PR — not that the feature was deployed or the
  broader product outcome was achieved.
- Labels in use: `feature`, `bug`, `decision`, `investigation`, `priority:next`.
- Product requirements and architecture/platform decisions stay in
  `docs/product-brief.md` and `docs/decisions.md`, not here.
