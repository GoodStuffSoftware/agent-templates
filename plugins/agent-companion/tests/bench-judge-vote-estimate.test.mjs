// Judge-vote cost in the pre-run estimate (operator direction, 2026-09-24):
// scripts/benchmark.mjs's buildJudgeVotePlan() turns a judgePreflight()
// result into the { model, effort, votes, history } shape bench/estimate.mjs's
// estimateRun() takes -- only cells actually ELIGIBLE for the configured
// judge (bench/judge.mjs's checkJudgeEligibility()) ever contribute judged
// answers, matching what a live run would actually judge. No model is ever
// called here; this is pure plan-building math.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgeVotePlan } from '../scripts/benchmark.mjs';
import { CELLS } from '../bench/runner.mjs';
import { JUDGE_VOTES } from '../bench/judge.mjs';

function fakeJudge({ model, effort = 'high', judgedTasks = ['task-a'] }) {
  return { config: { model, effort }, judgedTasks, problems: [] };
}

test('buildJudgeVotePlan: null when no judge is configured', () => {
  assert.equal(buildJudgeVotePlan({ judge: null, cellIds: ['sonnet-medium'], reps: 1 }), null);
  assert.equal(buildJudgeVotePlan({ judge: { config: null }, cellIds: ['sonnet-medium'], reps: 1 }), null);
});

test('buildJudgeVotePlan: votes = eligible cells x judged tasks x reps x JUDGE_VOTES', () => {
  // fable/high is eligible to judge a sonnet cell (stronger tier, different model).
  const judge = fakeJudge({ model: CELLS['fable51-high'].model, judgedTasks: ['task-a', 'task-b'] });
  const plan = buildJudgeVotePlan({ judge, cellIds: ['sonnet-medium'], reps: 3 });
  assert.equal(plan.model, CELLS['fable51-high'].model);
  assert.equal(plan.effort, 'high');
  // 1 eligible cell x 2 judged tasks x 3 reps x JUDGE_VOTES votes/answer.
  assert.equal(plan.votes, 1 * 2 * 3 * JUDGE_VOTES);
  assert.ok(plan.history, 'must attach a (possibly empty) local judge-vote history object');
});

test('buildJudgeVotePlan: an INELIGIBLE cell (the judge grading itself) contributes zero judged answers', () => {
  // The judge's own model as the "cell" -- checkJudgeEligibility refuses a
  // model grading itself, so this cell must never count toward judge votes.
  const selfModel = CELLS['sonnet-medium'].model;
  const judge = fakeJudge({ model: selfModel, judgedTasks: ['task-a'] });
  const plan = buildJudgeVotePlan({ judge, cellIds: ['sonnet-medium'], reps: 1 });
  assert.equal(plan.votes, 0);
});

test('buildJudgeVotePlan: a mix of eligible and ineligible cells counts only the eligible ones', () => {
  const judge = fakeJudge({ model: CELLS['fable51-high'].model, judgedTasks: ['task-a'] });
  // sonnet-medium is eligible (weaker tier than fable); the judge's own cell
  // ("fable51-high", same model) is not -- a judge may not grade itself.
  const plan = buildJudgeVotePlan({ judge, cellIds: ['sonnet-medium', 'fable51-high'], reps: 2 });
  assert.equal(plan.votes, 1 * 1 * 2 * JUDGE_VOTES, 'only the eligible cell contributes');
});

test('buildJudgeVotePlan: no judged tasks at all -> zero votes, not a crash', () => {
  const judge = fakeJudge({ model: CELLS['fable51-high'].model, judgedTasks: [] });
  const plan = buildJudgeVotePlan({ judge, cellIds: ['sonnet-medium'], reps: 1 });
  assert.equal(plan.votes, 0);
});
