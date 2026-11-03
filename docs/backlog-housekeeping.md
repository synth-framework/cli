# Backlog housekeeping — one-time alignment tasks

The backlog was created with a GitHub App token that can **create** issues,
milestones, and labels but cannot **edit, comment, close, link, label, or
delete** (HTTP 403/404). This document is the instruction set for an agent
with a full-access token (`issues: write`, plus repo admin for deletes) to
finish aligning the backlog. Run the script at the bottom, then delete this
document.

State to fix:

- Issues #5–#26 are **not linked to milestones** (the milestone field was
  silently dropped at creation). Organization is currently only the `Sx-` title
  prefixes.
- Delivered issues are still **open**: #5–#8 (S1-01…04, PR #1), #10–#12
  (S2-01…03, PR #2), #13 (S3-01, PR #3/#4 → `main` @ `520b7eb`).
- Issue #9 (S1-05) predates the 2026-11-03 decision: macOS/Windows validation
  moved to the final stage (FV-01, #26, milestone #5).
- Probe issues **#23, #24, #25** (`__probe__`, `__probe2__`, `__probe3__`) must
  be deleted.
- Stray labels **`delivered`** and **`priority`** were created while probing
  permissions; delete them. Keep only the agreed taxonomy: `feature`, `bug`,
  `decision`, `investigation`, `priority:next`.

## Per-issue actions

| Issue | Title | Milestone | Labels | Action |
|---|---|---|---|---|
| #5 | S1-01 | #1 Slice 1 | `decision` | close — delivered in PR #1 |
| #6 | S1-02 | #1 | `feature` | close — PR #1 |
| #7 | S1-03 | #1 | `feature` | close — PR #1 |
| #8 | S1-04 | #1 | `feature` | close — PR #1 |
| #9 | S1-05 | #1 | `investigation` | keep open; note macOS/Windows moved to #26; remaining scope = representative remote workspaces |
| #10 | S2-01 | #2 Slice 2 | `decision` | close — delivered in PR #2 |
| #11 | S2-02 | #2 | `feature` | close — PR #2 |
| #12 | S2-03 | #2 | `feature` | close — PR #2 |
| #13 | S3-01 | #3 Slice 3 | `feature` | close — delivered in PR #3 + #4 (`520b7eb`) |
| #14 | S3-02 | #3 | `feature`, `priority:next` | keep open; next item — detail acceptance criteria when started |
| #15 | S3-03 | #3 | `decision` | keep open |
| #16 | S3-04 | #3 | `feature` | keep open |
| #17 | S3-05 | #3 | `feature` | keep open |
| #18 | S3-06 | #3 | `feature` | keep open |
| #19 | S3-07 | #3 | `feature` | keep open |
| #20 | S4-01 | #4 Slice 4 | `feature` | keep open |
| #21 | S4-02 | #4 | `feature` | keep open |
| #22 | S4-03 | #4 | `feature` | keep open |
| #26 | FV-01 | #5 Final stage | `investigation` | keep open |
| #23–#25 | probes | — | — | **delete** |

Closing rule (from the approved planning instruction): closing an issue means
its stated acceptance criteria were satisfied **with evidence linked** in the
issue or PR — not that the feature was deployed or the outcome achieved.

## Body text to append to each issue

Append this block to each issue body (fetch current body, append, set). For
issues that stay open, the agent may remove the block again after linking and
labeling; for closed issues it remains as the delivery record.

- #5: `Housekeeping: link to milestone #1; label decision; close as delivered in PR #1 (evidence: PR #1 verification, installed-package suite 13/13 on Linux Node 22.22.3).`
- #6–#8: `Housekeeping: link to milestone #1; label feature; close as delivered in PR #1 (same evidence as #5).`
- #9: `Housekeeping: link to milestone #1; label investigation; keep open. By developer decision 2026-11-03 the macOS/Windows validation part moved to the final stage — see FV-01 (#26, milestone #5). Remaining scope here: representative remote-workspace (Linux container) validation, results reported separately.`
- #10: `Housekeeping: link to milestone #2; label decision; close as delivered in PR #2 (evidence: PR #2 verification, 38/38 on Linux Node 22.22.3).`
- #11–#12: `Housekeeping: link to milestone #2; label feature; close as delivered in PR #2 (same evidence as #10).`
- #13: `Housekeeping: link to milestone #3; label feature; close as delivered in PR #3 and PR #4 (merged to main as 520b7eb; 65/65 after review fixes).`
- #14: `Housekeeping: link to milestone #3; labels feature + priority:next; keep open. When work starts, replace the coarse scope with detailed acceptance criteria and a verification approach (next-slice rule: detail the next slice, keep later work coarse).`
- #15: `Housekeeping: link to milestone #3; label decision; keep open.`
- #16–#19: `Housekeeping: link to milestone #3; label feature; keep open. Dependencies are already recorded in the body (S3-04 is independent of freshness; S3-05 depends on S3-04 and S3-01).`
- #20–#22: `Housekeeping: link to milestone #4; label feature; keep open.`
- #26: `Housekeeping: link to milestone #5 (Final stage — platform validation); label investigation; keep open. Runs after Slice 4 per developer decision 2026-11-03.`

## Ready-to-run script

```bash
#!/bin/bash
# One-time backlog housekeeping for synth-framework/cli.
# Needs a token with issues:write; deletes need repo admin (fall back to the UI).
set -euo pipefail
R=synth-framework/cli

link()   { gh issue edit "$1" -R "$R" --milestone "$2"; }          # milestone number; if rejected, use the exact milestone title
labels() { gh issue edit "$1" -R "$R" --add-label "$2"; }
note() { # $1=issue $2=text -> append housekeeping block to body
  gh api "repos/$R/issues/$1" --jq '.body' > "/tmp/b$1.md"
  printf '\n\n---\n**Housekeeping:** %s\n' "$2" >> "/tmp/b$1.md"
  gh issue edit "$1" -R "$R" --body-file "/tmp/b$1.md"
}
closepr() { gh issue close "$1" -R "$R" -c "$2"; }

# 1) link every issue to its milestone
for spec in 5:1 6:1 7:1 8:1 9:1 10:2 11:2 12:2 13:3 14:3 15:3 16:3 17:3 18:3 19:3 20:4 21:4 22:4 26:5; do
  link "${spec%%:*}" "${spec##*:}"
done

# 2) labels
labels 5 decision
for n in 6 7 8 11 12 13 16 17 18 19 20 21 22; do labels "$n" feature; done
labels 9 investigation
labels 10 decision
labels 14 feature,priority:next
labels 15 decision
labels 26 investigation

# 3) append housekeeping note to each body (do before closing)
note 5  'Link to milestone #1; label `decision`; close as delivered in PR #1 (evidence: PR #1 verification, installed-package suite 13/13 on Linux Node 22.22.3).'
note 6  'Link to milestone #1; label `feature`; close as delivered in PR #1 (same evidence as #5).'
note 7  'Link to milestone #1; label `feature`; close as delivered in PR #1 (same evidence as #5).'
note 8  'Link to milestone #1; label `feature`; close as delivered in PR #1 (same evidence as #5).'
note 9  'Link to milestone #1; label `investigation`; keep open. By developer decision 2026-11-03 the macOS/Windows validation part moved to the final stage — see FV-01 (#26, milestone #5). Remaining scope here: representative remote-workspace (Linux container) validation, results reported separately.'
note 10 'Link to milestone #2; label `decision`; close as delivered in PR #2 (evidence: PR #2 verification, 38/38 on Linux Node 22.22.3).'
note 11 'Link to milestone #2; label `feature`; close as delivered in PR #2 (same evidence as #10).'
note 12 'Link to milestone #2; label `feature`; close as delivered in PR #2 (same evidence as #10).'
note 13 'Link to milestone #3; label `feature`; close as delivered in PR #3 and PR #4 (merged to main as 520b7eb; 65/65 after review fixes).'
note 14 'Link to milestone #3; labels `feature`, `priority:next`; keep open. When work starts, replace the coarse scope with detailed acceptance criteria and a verification approach (next-slice rule).'
note 15 'Link to milestone #3; label `decision`; keep open.'
note 16 'Link to milestone #3; label `feature`; keep open. S3-04 is independent of freshness (one-way dependency rule).'
note 17 'Link to milestone #3; label `feature`; keep open. S3-05 depends on both S3-04 (acceptance recording) and S3-01 (freshness).'
note 18 'Link to milestone #3; label `feature`; keep open.'
note 19 'Link to milestone #3; label `feature`; keep open.'
note 20 'Link to milestone #4; label `feature`; keep open.'
note 21 'Link to milestone #4; label `feature`; keep open.'
note 22 'Link to milestone #4; label `feature`; keep open.'
note 26 'Link to milestone #5 (Final stage — platform validation); label `investigation`; keep open. Runs after Slice 4 per developer decision 2026-11-03.'

# 4) close delivered issues with evidence-linked comments
closepr 5  'Delivered in PR #1 (merged to main). Acceptance evidence: PR #1 verification — installed-package suite 13/13 on Linux Node 22.22.3. Closing means criteria satisfied with linked evidence, not deployment.'
for n in 6 7 8; do closepr "$n" 'Delivered in PR #1 (merged to main). Evidence: PR #1 verification section.'; done
closepr 10 'Delivered in PR #2 (merged to main). Acceptance evidence: PR #2 verification — 38/38 on Linux Node 22.22.3.'
for n in 11 12; do closepr "$n" 'Delivered in PR #2 (merged to main). Evidence: PR #2 verification section.'; done
closepr 13 'Delivered in PR #3 and PR #4 (merged to main as 520b7eb). Evidence: PR #4 verification — 65/65 tests, CI green on the merged head.'

# 5) delete probe issues (needs admin; otherwise do #23 #24 #25 in the UI)
for n in 23 24 25; do gh issue delete "$n" -R "$R" --yes || echo "delete #$n manually in the UI"; done

# 6) remove stray labels created while probing permissions
gh api -X DELETE "repos/$R/labels/delivered" 2>/dev/null || echo 'delete label "delivered" in the UI'
gh api -X DELETE "repos/$R/labels/priority"  2>/dev/null || echo 'delete label "priority" in the UI'

# 7) verify
gh api "repos/$R/issues?state=all&per_page=100" --jq '[.[] | select(.pull_request==null)] | .[] | [.number, .state, (.milestone.number // 0), ((.labels|map(.name)|join(",")) // "")] | @tsv'
```

## Verification checklist

- `gh api repos/synth-framework/cli/milestones --jq '.[] | [.number,.title,.open_issues,.closed_issues]'`
  shows open counts: #1 → 1 open (#9), #2 → 0, #3 → 6 open (#14–#19), #4 → 3 open, #5 → 1 open (#26).
- Issues #5–#8, #10–#13 are closed with evidence comments; #23–#25 are gone.
- Labels are exactly the agreed set plus GitHub defaults (`feature`, `bug`,
  `decision`, `investigation`, `priority:next` added; `delivered`/`priority` removed).
- `BACKLOG.md` stays a pure link index; this document is deleted after the run.
