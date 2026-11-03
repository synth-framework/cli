## PR Review

Before creating a PR, and when reviewing any PR, apply this checklist.
Report findings by severity: **Blocker** (do not merge), **High**
(merge only with explicit justification), **Medium** (flag for follow-up).

### Blockers
- [ ] One path. Traced end to end, including failure steps. (SEC-01)
- [ ] Boundaries. Auth, tenancy, input validation, untrusted input unchanged or changed on purpose. (SEC-02)
- [ ] CI. Every diff under .github/ read in full. No skipped tests, no lowered thresholds, no moved triggers. (SEC-03)
- [ ] Evidence. A test, CI run, or screenshot proves this ran. (SEC-04)
- [ ] APIs and imports. Every symbol exists in the version this repo runs. (SEC-05)

### High
- [ ] Shape. One sentence describes the change; matches the title.
- [ ] Blast radius. Nothing outside stated scope moved.
- [ ] Deletions. No live callers; removals are intentional.
- [ ] Config and permissions. New env vars, scopes, timeouts named in the description and are ones we want.

### Medium
- [ ] Duplication. New helper/client/type doesn't already exist under another name. (SEC-06)
- [ ] Test quality. Tests would fail if the code were broken. (SEC-07)
- [ ] Performance. No N+1 queries, unbounded loops, missing pagination on production paths.   