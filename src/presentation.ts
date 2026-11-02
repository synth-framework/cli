import type { Entry, Handoff } from './domain.js';

export const HELP = `SYNTH — local work continuity for a developer and coding agent

Usage:
  synth init --intent <text> [--record <path>] [--json]
  synth add <kind> --text <text> [--reason <text>] [--record <path>] [--json]
  synth add answer --question <question-id> --text <text> [--reason <text>] [--json]
  synth add --stdin [--record <path>] [--json]
  synth status [--record <path>] [--json]
  synth handoff [--record <path>] [--json]
  synth --help | --version

Entry kinds:
  outcome, scope, constraint, non-goal, criterion, question, answer,
  assumption, plan, update, work-ref, decision, gap, next

--stdin reads a non-empty JSON array of entries, for example:
  [{"kind":"criterion","text":"A useful criterion"},
   {"kind":"question","text":"What is unknown?"}]
An answer requires questionId; --question supplies it for a single entry.
A batch is limited to 100 entries and 1 MiB of input.

Only an intention is required to start. Missing context is shown, not treated
as a gate. With no --record, the current directory's .synth/work.json is used;
SYNTH does not search parent directories. --json can appear anywhere.

This slice does not run checks or record evidence, evaluations, or acceptance.
All recorded criteria are unverified. See the README for the JSON contract and
local storage/recovery limitations.`;

const labels: Record<string, string> = {
  outcomes: 'desired outcome',
  scope: 'scope',
  constraints: 'constraints',
  nonGoals: 'non-goals',
  criteria: 'criteria',
  questions: 'questions',
  assumptions: 'assumptions',
  plan: 'plan',
  updates: 'work updates',
  workReferences: 'work references',
  decisions: 'decisions',
  gaps: 'gaps',
  nextActions: 'next actions',
};

function indented(text: string, indentation = '    '): string {
  return text.replace(/\r?\n/g, `\n${indentation}`);
}

function renderEntries(title: string, entries: readonly Entry[], options: { decisions?: boolean; criteria?: boolean } = {}): string {
  if (entries.length === 0) return `${title}: not recorded.`;
  const lines = [`${title}:`];
  for (const entry of entries) {
    lines.push(`  ${entry.id}${options.criteria ? ' [unverified]' : ''}: ${indented(entry.text)}`);
    if (entry.reason !== null) lines.push(`    Reason: ${indented(entry.reason, '      ')}`);
    else if (options.decisions) lines.push('    Reason: not recorded.');
  }
  return lines.join('\n');
}

export function renderHandoff(location: string, handoff: Handoff): string {
  const questions = handoff.questions.length === 0
    ? ['Questions and unknowns: not recorded.']
    : ['Questions and unknowns:'];
  for (const question of handoff.questions) {
    const state = question.state === 'unanswered' ? 'no response recorded' : 'response recorded';
    questions.push(`  ${question.id} [${state}]: ${indented(question.text)}`);
    if (question.reason !== null) questions.push(`    Reason: ${indented(question.reason, '      ')}`);
    for (const answer of question.answers) {
      questions.push(`    ${answer.id} (recorded answer): ${indented(answer.text, '      ')}`);
      if (answer.reason !== null) questions.push(`      Reason: ${indented(answer.reason, '        ')}`);
    }
  }
  return [
    'SYNTH handoff',
    `Record: ${location}`,
    `Original intention: ${indented(handoff.originalIntention, '  ')}`,
    'Entries are recorded statements; later entries do not automatically supersede earlier ones.',
    renderEntries('Desired outcome', handoff.outcomes),
    renderEntries('Scope', handoff.scope),
    renderEntries('Constraints', handoff.constraints),
    renderEntries('Non-goals', handoff.nonGoals),
    renderEntries('Acceptance criteria', handoff.criteria, { criteria: true }),
    questions.join('\n'),
    renderEntries('Assumptions', handoff.assumptions),
    renderEntries('Plan notes (not automatically superseded)', handoff.plan),
    renderEntries('Work updates (recorded statements, not verified)', handoff.updates),
    renderEntries('Work references (not inspected)', handoff.workReferences),
    renderEntries('Decision notes (not automatically superseded)', handoff.decisions, { decisions: true }),
    renderEntries('Gap notes (not automatically resolved)', handoff.gaps),
    renderEntries('Next-action notes (not automatically completed)', handoff.nextActions),
    'Verification: unverified. Recording evidence and evaluations is not available in this slice.',
    'Acceptance: recording acceptance is not available in this slice.',
  ].join('\n');
}

export function renderStatus(location: string, handoff: Handoff): string {
  const unansweredQuestions = handoff.questions.filter((question) => question.state === 'unanswered').length;
  const missing = handoff.missingContext.map((key) => labels[key] ?? key);
  return [
    'SYNTH status',
    `Record: ${location}`,
    `Original intention: ${indented(handoff.originalIntention, '  ')}`,
    `Criteria: ${handoff.criteria.length} recorded; all are unverified.`,
    `Questions: ${unansweredQuestions} without a recorded response of ${handoff.questions.length} recorded.`,
    'A recorded response does not establish that a question is resolved.',
    `Gaps: ${handoff.gaps.length} recorded (absence of a recorded gap does not prove there are none).`,
    `Missing context: ${missing.length === 0 ? 'none of the listed categories are empty' : missing.join(', ')}.`,
    renderEntries('Next-action notes (not automatically completed)', handoff.nextActions),
    'Evidence, evaluation, and acceptance recording are not available in this slice.',
    'Run synth handoff for the full recorded context.',
  ].join('\n');
}

export function renderAdded(entries: readonly Entry[]): string {
  return entries.map((entry) => `Recorded ${entry.kind} ${entry.id}: ${indented(entry.text, '  ')}`).join('\n');
}
