import type { CriterionView, Entry, Handoff } from './domain.js';
import type { BaselineComparison } from './baseline.js';

export const HELP = `SYNTH — local work continuity for a developer and coding agent

Usage:
  synth init --intent <text> [--record <path>] [--json]
  synth add <kind> --text <text> [--reason <text>] [--record <path>] [--json]
  synth add answer --question <question-id> --text <text> [--reason <text>] [--record <path>] [--json]
  synth add --stdin [--record <path>] [--json]
  synth check run [--criterion <id>] [--cwd <path>] [--timeout-ms <ms>]
    [--revision <text>] [--dirty clean|dirty|unknown]
    (--capture-output | --output-ref <reference>) [--record <path>] [--json] -- <executable> [arguments...]
  synth check record [--criterion <id>] --status skipped|inconclusive --reason <text>
    [--cwd <path>] [--revision <text>] [--dirty clean|dirty|unknown] [--output-ref <reference>]
    [--record <path>] [--json] -- <executable> [arguments...]
  synth evidence add [--criterion <id>] --summary <text> --source <text>
    --subject <text> --limitations <text> [--check <id>] [--revision <text>]
    [--artifact <reference>] [--subject-file <path>] [--record <path>] [--json]
  synth evaluate <criterion-id> --status <status> --reason <text> [--evidence <id>] [--record <path>] [--json]
  synth revise <intention-or-entry-id> (--text <text> | --remove)
    [--reason <text>] [--evidence <id>] [--record <path>] [--json]
  synth baseline capture [--file <path>...] [--no-files] [--reason <text>] [--record <path>] [--json]
  synth baseline compare <baseline-id> [--to <baseline-id>] [--record <path>] [--json]
  synth baseline assess <baseline-id> --area intention|scope|criteria|verification
    --finding intentional|unintended|uncertain|no_concern --reason <text>
    [--evidence <id>] [--record <path>] [--json]
  synth status [--record <path>] [--json]
  synth handoff [--record <path>] [--json]
  synth --help | --version

Entry kinds:
  outcome, scope, constraint, non-goal, criterion, verification, question,
  answer, assumption, plan, update, work-ref, decision, gap, next

--stdin reads a non-empty JSON array of entries; a batch is limited to 100
entries and 1 MiB of UTF-8. An answer requires questionId.

Checks run only the executable and arguments explicitly supplied after --;
there is no implicit shell. Choose --capture-output or --output-ref before a
run. Captured output may contain secrets; an output reference is caller-reported
and not inspected. A successful CLI write is not the same as a passing check.
Revision and dirty state are reported by the caller, or unknown; SYNTH does
not invoke Git. Checks and evidence may be recorded before criteria exist.
Repeat --criterion and --evidence for multiple IDs. An evaluation explicitly
links its cited evidence to its criterion; it is an assessment, not proof of
relevance or acceptance. Evaluations are unverified, supported, contradicted,
inconclusive, or not_applicable; non-unverified evaluations require evidence.

Baselines are optional and explicit. Capture accepts up to 20 selected files;
omitting --file retains the previous selection, while --no-files clears it.
A comparison reports recorded text changes and selected file bytes, not semantic
drift or proof of evidence impact. Drift assessments are caller-reported, with
their assessed area retained. Revising a criterion preserves earlier evaluations
without applying them to the new version.

Only an intention is required to start. Missing context is shown, not treated
as a gate. With no --record, the current directory's .synth/work.json is used;
SYNTH does not search parent directories. See the README for safety limits,
JSON contract, migration, and local storage/recovery limitations.`;

const labels: Record<string, string> = {
  outcomes: 'desired outcome', scope: 'scope', constraints: 'constraints', nonGoals: 'non-goals',
  criteria: 'criteria', verification: 'verification plan', questions: 'questions', assumptions: 'assumptions', plan: 'plan',
  updates: 'work updates', workReferences: 'work references', decisions: 'decisions',
  gaps: 'gaps', nextActions: 'next actions',
};

function indented(text: string, indentation = '    '): string {
  return text.replace(/\r?\n/g, `\n${indentation}`);
}

function renderEntries(title: string, entries: readonly Entry[], options: { decisions?: boolean } = {}): string {
  if (entries.length === 0) return `${title}: not recorded.`;
  const lines = [`${title}:`];
  for (const entry of entries) {
    const revised = 'active' in entry && 'revisionId' in entry && 'originalText' in entry ? entry as Entry & { active: boolean; revisionId: string | null; originalText: string } : null;
    lines.push(`  ${entry.id}${revised && !revised.active ? ' [removed]' : ''}: ${indented(entry.text)}`);
    if (revised?.revisionId) lines.push(`    Current revision: ${revised.revisionId}; original: ${indented(revised.originalText, '      ')}`);
    if (entry.reason !== null) lines.push(`    Reason: ${indented(entry.reason, '      ')}`);
    else if (options.decisions) lines.push('    Reason: not recorded.');
  }
  return lines.join('\n');
}

function renderCriteria(criteria: readonly CriterionView[]): string {
  if (criteria.length === 0) return 'Acceptance criteria: not recorded.';
  const lines = ['Acceptance criteria (evaluations are recorded assessments):'];
  for (const item of criteria) {
    lines.push(`  ${item.id} [${item.active ? '' : 'removed; '}${item.evaluation}] (evidence freshness: ${item.freshness}): ${indented(item.text)}`);
    if (item.revisionId !== null) lines.push(`    Current revision: ${item.revisionId}; original: ${indented(item.originalText, '      ')}`);
    if (item.reason !== null) lines.push(`    Criterion reason: ${indented(item.reason, '      ')}`);
    if (item.evaluationId !== null) lines.push(`    ${item.evaluationId}: ${indented(item.evaluationReason ?? '', '      ')}; evidence: ${item.evidenceIds.join(', ') || 'none'}`);
    if (item.priorEvaluationIds.length > 0) lines.push(`    Earlier-version evaluations (not applied to the current version): ${item.priorEvaluationIds.join(', ')}.`);
  }
  return lines.join('\n');
}

function renderChecks(handoff: Handoff): string {
  if (handoff.checks.length === 0) return 'Checks: not recorded.';
  const lines = ['Checks (a result is not a criterion evaluation):'];
  for (const check of handoff.checks) {
    lines.push(`  ${check.id} [${check.status}; ${check.invocation}]: ${JSON.stringify(check.argv)} in ${check.cwd}`);
    lines.push(`    Criteria: ${check.criterionIds.join(', ') || 'not linked'}; requested: ${check.requestedAt}; started: ${check.startedAt ?? 'unknown'}; ended: ${check.endedAt ?? 'unknown'}`);
    if (check.criterionContexts.length > 0) lines.push(`    Criterion versions at request: ${check.criterionContexts.map((context) => `${context.criterionId} ${context.state}`).join(', ')}.`);
    lines.push(`    Revision: ${check.revision ?? 'unknown'}; dirty: ${check.dirty}; provenance: ${check.provenance}`);
    lines.push(`    Exit: ${check.exitCode ?? 'unknown'}; signal: ${check.signal ?? 'none recorded'}; timeout: ${check.timeoutMs === null ? 'not run by SYNTH' : `${check.timeoutMs} ms`}`);
    if (check.reason !== null) lines.push(`    Reason: ${indented(check.reason, '      ')}`);
    if (check.outputRef !== null) lines.push(`    Output reference (not inspected): ${indented(check.outputRef, '      ')}`);
    if (check.output !== null) lines.push(`    Output: ${check.output.captured ? 'captured (may contain sensitive data)' : 'not captured'}; stdout ${check.output.stdout.bytes} bytes${check.output.stdout.truncated ? ' (truncated)' : ''}, stderr ${check.output.stderr.bytes} bytes${check.output.stderr.truncated ? ' (truncated)' : ''}.`);
    if (check.status === 'pending') lines.push('    Outcome not recorded; the command may or may not have started. Inspect before retrying.');
  }
  return lines.join('\n');
}

function renderEvidence(handoff: Handoff): string {
  if (handoff.evidence.length === 0) return 'Evidence: not recorded.';
  const lines = ['Evidence (freshness compares only the selected file, if any):'];
  for (const item of handoff.evidence) {
    lines.push(`  ${item.id} [freshness: ${item.freshness}]: ${indented(item.summary)}`);
    lines.push(`    Source: ${indented(item.source, '      ')}; subject: ${indented(item.subject, '      ')}; revision: ${item.revision ?? 'unknown'}`);
    lines.push(`    Declared criteria: ${item.criterionIds.join(', ') || 'not linked'}; cited in evaluations for: ${item.evaluatedFor.join(', ') || 'none'}`);
    if (item.criterionContexts.length > 0) lines.push(`    Criterion versions at recording: ${item.criterionContexts.map((context) => `${context.criterionId} ${context.state}`).join(', ')}.`);
    lines.push(`    Check: ${item.checkId ?? 'not linked'}; artifact: ${item.artifact ?? 'not recorded'}`);
    lines.push(`    Limitations: ${indented(item.limitations, '      ')}`);
    if (item.subjectFile !== null) lines.push(`    Subject file: ${item.subjectFile.path}; snapshot: ${item.subjectFile.state}${item.subjectFile.reason ? ` (${item.subjectFile.reason})` : ''}`);
  }
  return lines.join('\n');
}

export function renderComparison(comparison: BaselineComparison): string {
  const lines = [`Baseline ${comparison.baselineId} -> ${comparison.comparedTo} (${comparison.direction}; recorded changes, not a semantic drift judgment):`];
  for (const area of ['intention', 'scope', 'criteria', 'verification'] as const) {
    const result = comparison.areas[area];
    lines.push(`  ${area}: ${result.state}${result.unknownFileCount > 0 ? `; unknown selected files ${result.unknownFileCount}` : ''}.`);
    for (const change of result.changes) {
      lines.push(`    ${change.id} ${change.change}: ${JSON.stringify(change.before?.text ?? null)} -> ${JSON.stringify(change.after?.text ?? null)}`);
      if (change.entryReason !== null) lines.push(`      Entry reason: ${indented(change.entryReason, '        ')}`);
    }
    for (const entry of result.interveningEntries.filter((item) => !result.changes.some((change) => change.id === item.id))) {
      lines.push(`    ${entry.id} was recorded between snapshots: ${indented(entry.text, '      ')}; reason: ${entry.reason === null ? 'not recorded' : indented(entry.reason, '      ')}`);
    }
    for (const file of result.files) {
      const label = file.change === 'selection_added' ? 'added to file selection'
        : file.change === 'selection_removed' ? 'removed from file selection' : file.change;
      lines.push(`    File ${file.path}: ${label}.`);
    }
  }
  if (comparison.interveningRevisions.length > 0) {
    lines.push('  Intervening revisions (listed in record order; history is retained):');
    for (const revision of comparison.interveningRevisions) {
      lines.push(`    ${revision.id} ${revision.target}: ${revision.text === null ? 'removed' : JSON.stringify(revision.text)}; reason: ${revision.reason === null ? 'not recorded' : indented(revision.reason, '      ')}; cited evidence: ${revision.evidenceIds.join(', ') || 'none recorded'}`);
    }
  }
  lines.push(`  Evidence impact: not inferred; candidates for review: ${comparison.affectedEvidenceCandidates.length === 0 ? 'none identified, impact unknown' : comparison.affectedEvidenceCandidates.map((item) => `${item.evidenceId} (${item.basis.join(', ')})`).join('; ')}.`);
  return lines.join('\n');
}

export function renderHandoff(location: string, handoff: Handoff): string {
  const questions = handoff.questions.length === 0 ? ['Questions and unknowns: not recorded.'] : ['Questions and unknowns:'];
  for (const question of handoff.questions) {
    const state = question.state === 'unanswered' ? 'no response recorded' : 'response recorded';
    questions.push(`  ${question.id} [${state}]: ${indented(question.text)}`);
    if (question.reason !== null) questions.push(`    Reason: ${indented(question.reason, '      ')}`);
    for (const answer of question.answers) {
      questions.push(`    ${answer.id} (recorded answer): ${indented(answer.text, '      ')}`);
      if (answer.reason !== null) questions.push(`      Reason: ${indented(answer.reason, '        ')}`);
    }
  }
  const evaluationHistory = handoff.evaluations.length === 0 ? 'Evaluation history: not recorded.' : [
    'Evaluation history (later assessments do not erase earlier ones):',
    ...handoff.evaluations.map((item) => `  ${item.id}: ${item.criterionId} [${item.verdict}]; criterion context: ${item.criterionContext.state}; evidence: ${item.evidenceIds.join(', ') || 'none'}; reason: ${indented(item.rationale, '    ')}`),
  ].join('\n');
  const noEvaluations = handoff.evaluations.length === 0;
  const revisions = handoff.revisions.length === 0 ? 'Revisions: not recorded.' : [
    'Revision history (explicit changes, including missing reasons):',
    ...handoff.revisions.map((item) => `  ${item.id} ${item.target}: ${item.text === null ? 'removed' : JSON.stringify(item.text)}; reason: ${item.reason === null ? 'not recorded' : indented(item.reason, '    ')}; cited evidence: ${item.evidenceIds.join(', ') || 'none recorded'}`),
  ].join('\n');
  const baselines = handoff.baselines.length === 0 ? 'Baselines: not recorded.' : [
    'Baselines (explicit snapshots, not acceptance):',
    ...handoff.baselines.map((item) => `  ${item.id}; reason: ${item.reason === null ? 'not recorded' : indented(item.reason, '    ')}; selected files: ${item.files.map((file) => file.path).join(', ') || 'none'}`),
  ].join('\n');
  const assessments = handoff.driftAssessments.length === 0 ? 'Drift assessments: not recorded.' : [
    'Drift assessments (caller-reported, not independently verified):',
    ...handoff.driftAssessments.map((item) => `  ${item.id}: ${item.baselineId} ${item.area} [${item.finding}]; compared area since assessment: ${item.areaBasisState}; unknown selected files: ${item.areaUnknownFileCount}; cited evidence: ${item.evidenceIds.join(', ') || 'none recorded'}; later evidence: ${item.evidenceAddedSince.join(', ') || 'none recorded'}; reason: ${indented(item.reason, '    ')}`),
  ].join('\n');
  const removed = handoff.removedEntries.length === 0 ? [] : [
    'Removed entries (retained in history, not current):',
    ...handoff.removedEntries.map((item) => `  ${item.id} [removed${item.revisionId ? ` by ${item.revisionId}` : ''}]: ${indented(item.text)}`),
  ];
  return [
    'SYNTH handoff', `Record: ${location}`, `Original intention: ${indented(handoff.originalIntention, '  ')}`,
    `Current intention${handoff.intentionRevisionId ? ` (${handoff.intentionRevisionId})` : ''}: ${indented(handoff.currentIntention, '  ')}`,
    'Entries are recorded statements; only explicit revisions change current text, and history is retained.',
    renderEntries('Desired outcome', handoff.outcomes), renderEntries('Scope', handoff.scope),
    renderEntries('Constraints', handoff.constraints), renderEntries('Non-goals', handoff.nonGoals),
    renderCriteria(handoff.criteria), renderEntries('Verification plan', handoff.verification), questions.join('\n'), renderEntries('Assumptions', handoff.assumptions),
    renderEntries('Plan notes (not automatically superseded)', handoff.plan),
    renderEntries('Work updates (recorded statements, not verified)', handoff.updates),
    renderEntries('Work references (not inspected)', handoff.workReferences),
    renderEntries('Decision notes (not automatically superseded)', handoff.decisions, { decisions: true }),
    renderEntries('Gap notes (not automatically resolved)', handoff.gaps),
    renderEntries('Next-action notes (not automatically completed)', handoff.nextActions),
    ...removed,
    renderChecks(handoff), renderEvidence(handoff), evaluationHistory,
    revisions, baselines,
    ...(handoff.previousBaselineComparison ? [renderComparison(handoff.previousBaselineComparison)] : []),
    ...(handoff.baselineComparison ? [renderComparison(handoff.baselineComparison)] : []),
    assessments,
    noEvaluations ? 'Verification: unverified. Checks and evidence do not automatically evaluate criteria.' : 'Verification: evaluations are recorded assessments, separate from freshness and acceptance.',
    'Acceptance: recording acceptance is not available in this slice.',
  ].join('\n');
}

export function renderStatus(location: string, handoff: Handoff): string {
  const unansweredQuestions = handoff.questions.filter((question) => question.state === 'unanswered').length;
  const activeCriteria = handoff.criteria.filter((criterion) => criterion.active);
  const removedCriteria = handoff.removedEntries.filter((item) => item.kind === 'criterion');
  const unverified = activeCriteria.filter((criterion) => criterion.evaluation === 'unverified').length;
  const missing = handoff.missingContext.map((key) => labels[key] ?? key);
  const baseline = handoff.baselineComparison;
  return [
    'SYNTH status', `Record: ${location}`, `Original intention: ${indented(handoff.originalIntention, '  ')}`,
    `Current intention${handoff.intentionRevisionId ? ` (${handoff.intentionRevisionId})` : ''}: ${indented(handoff.currentIntention, '  ')}`,
    `Criteria: ${activeCriteria.length} active of ${handoff.criteria.length + removedCriteria.length} recorded; ${unverified} unverified.`,
    ...(removedCriteria.length > 0 ? [`  Removed criteria (not current): ${removedCriteria.map((item) => item.id).join(', ')}.`] : []),
    ...handoff.criteria.map((item) => `  ${item.id} [${item.active ? '' : 'removed; '}${item.evaluation}]; evidence freshness: ${item.freshness}${item.priorEvaluationIds.length ? '; earlier-version evaluations retained' : ''}.`),
    baseline ? `Baseline ${baseline.baselineId}: intention ${baseline.areas.intention.state}; scope ${baseline.areas.scope.state}; criteria ${baseline.areas.criteria.state}; verification ${baseline.areas.verification.state}; unknown selected files ${baseline.areas.verification.unknownFileCount} (changes are not semantic judgments).` : 'Baseline: not recorded.',
    `Recorded drift assessments: ${handoff.driftAssessments.length} (caller-reported).`,
    `Checks: ${handoff.checks.length}; evidence: ${handoff.evidence.length}; evaluations: ${handoff.evaluations.length}.`,
    ...handoff.checks.map((check) => `  ${check.id} [${check.status}].`),
    `Questions: ${unansweredQuestions} without a recorded response of ${handoff.questions.length} recorded.`,
    'A recorded response does not establish that a question is resolved.',
    `Gaps: ${handoff.gaps.length} recorded (absence of a recorded gap does not prove there are none).`,
    `Missing context: ${missing.length === 0 ? 'none of the listed categories are empty' : missing.join(', ')}.`,
    renderEntries('Next-action notes (not automatically completed)', handoff.nextActions),
    'Checks, evidence, evaluations, freshness, and acceptance are distinct; acceptance recording is not available.',
    'Run synth handoff for the full recorded context.',
  ].join('\n');
}

export function renderAdded(entries: readonly Entry[]): string {
  return entries.map((entry) => `Recorded ${entry.kind} ${entry.id}: ${indented(entry.text, '  ')}`).join('\n');
}
