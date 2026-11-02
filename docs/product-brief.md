# SYNTH product baseline

## Purpose

SYNTH is an agent-first CLI coordination and evidence layer for a developer
working with a coding agent. It keeps a bounded intention connected to the
work, acceptance criteria, observations, decisions, and remaining gaps. The
agent performs engineering work; SYNTH does not implement or orchestrate it.

Activities such as clarification, planning, execution, verification, review,
and handoff are revisitable, not mandatory sequential gates. A minimal
intention can be recorded and enriched later; missing context stays visible.

## Prototype requirements

- Maintain one bounded work record with stable references and a useful handoff.
- Preserve intention and decision changes, surface scope and verification
  drift, and retain corrections to consequential claims. Detecting a change is
  not the same as judging its meaning.
- Keep evidence, criterion evaluations, and acceptance distinct. Record source,
  subject, limitations, and freshness without inventing proof or confidence.
- Show coverage, checks, negative and boundary cases, findings, and risks.
- Offer optional TDD and BDD practices using the same evidence model; both must
  be demonstrated, but neither is a mandatory process or separate engine.
- Run verification commands only when explicitly selected, with bounded output,
  timeouts, provenance, and disclosure of security limitations.
- Support code, PR handoff, artifact, documentation, deployment, or observed
  outcome as different delivery goals; do not infer one from another.
- Provide human-readable output and stable JSON, safe local storage, actionable
  errors, read-only commands without writes, package tests, and an independent
  adoption fixture. The CLI itself must not require a network for core work.

## Platforms and constraints

macOS is the developer's personal platform; macOS and Linux are initial runtime
targets. Use the same CLI whether an agent runs commands locally or in a remote
workspace or Linux container. That does not require a hosted SYNTH service,
remote orchestration, cross-machine synchronization, or a new networking layer.
The coding agent itself may use online services. Actual platform results must
be reported separately from these targets. Native Windows is deferred; WSL2 is
provisional until tested.

## Non-goals

No browser UI, account system, hosted service, required paid API, autonomous
coding, automatic branch/commit/push/release/deployment, or mandatory
integration. MCP, an SDK, plugins, comprehensive discovery, enterprise
identity, and elaborate governance or event-sourcing infrastructure are
deferred. A claim, a diff, a passing command, an artifact, a deployment, or an
agent saying “done” does not by itself establish the intended outcome.
