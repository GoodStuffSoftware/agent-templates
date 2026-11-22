// API review routing (0.31.63): the spawn guard's route for review spawns (hooks/lib/sg-review-route.mjs), decide --peek,
// and the review share lines of `api-credits.mjs status`. No live calls: the governor is stubbed through `deps`.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { briefDeclarations } from '../hooks/lib/brief-directives.mjs';
import { routeReview, apiMarker, diffRangeOf } from '../hooks/lib/sg-review-route.mjs';
import { DEFAULT_SHARES, decide, reviewShareLines } from '../scripts/lib/api-credits.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ac-route-'));
const API = () => ({ decision: 'api', reason: 'review turn 0 on credits' });
const optsOf = (route, high = 'plan') => (k, d) => (k === 'api_review_route' ? route : k === 'api_review_high' ? high : d);
const BRIEF = (extra = '') => `TYPE: code-review\nWRITER: sonnet/high\nROLE: reviewer\nRISK: mid\n${extra}\nBranch fix/zz-demo, diff range main..fix/zz-demo in WORKTREE: ${dir}\n`;
function call(brief, over = {}) {
  const decls = briefDeclarations(brief);
  const input = { subagent_type: 'agent-companion:ac-sonnet-high', description: 'review', prompt: brief };
  return routeReview({
    typeIsParity: true, declaredType: 'code-review', brief, decls, p: { tool_use_id: 'toolu_zz1', cwd: dir }, input,
    subagentCaller: true, model: 'sonnet', isCanary: false, sid: 's1', recursionDeny: false, updatedInput: null,
    ...over, deps: { opt: optsOf('all'), decide: API, stateDir: () => dir, ...(over.deps || {}) },
  });
}

test('a writer review and a lead review are both routed to the API', async () => {
  const w = await call(BRIEF());
  assert.equal(w.route, 'api'); assert.equal(w.route_reason, 'api');
  assert.equal(w.updatedInput.subagent_type, 'agent-companion:ac-haiku');
  assert.match(w.updatedInput.prompt, /api-review\.mjs/);
  assert.match(w.updatedInput.prompt, /--diff-ref "main\.\.fix\/zz-demo"/);
  assert.match(w.updatedInput.prompt, /--writer sonnet\/high --risk mid/);
  const saved = join(dir, 'review-briefs', 'toolu_zz1.md');
  assert.equal(readFileSync(saved, 'utf8'), BRIEF(), 'the original brief is kept verbatim in a state file');
  const l = await call(BRIEF(), { subagentCaller: false });
  assert.equal(l.route, 'api');
  const wOnly = await call(BRIEF(), { subagentCaller: false, deps: { opt: optsOf('writers') } });
  assert.equal(wOnly.route, 'subagent'); assert.equal(wOnly.route_reason, 'off', 'writers mode leaves the lead alone');
});

test('off passes through with reason off; a non-review is not touched', async () => {
  const r = await call(BRIEF(), { deps: { opt: optsOf('off') } });
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'off', null]);
  assert.equal(await call(BRIEF(), { typeIsParity: false, declaredType: 'bounded-feature' }), null);
});

test('plan answers pass through, with the alternation and cap reasons told apart', async () => {
  const alt = await call(BRIEF(), { deps: { decide: () => ({ decision: 'plan', reason: 'alternation: review turn 1 stays on the plan' }) } });
  assert.deepEqual([alt.route, alt.route_reason, alt.updatedInput], ['subagent', 'plan-alternation', null]);
  const cap = await call(BRIEF(), { deps: { decide: () => ({ decision: 'plan', reason: 'pace: review spent $3 >= $2' }) } });
  assert.equal(cap.route_reason, 'plan-cap');
  const nokey = await call(BRIEF(), { deps: { decide: () => ({ decision: 'plan', reason: 'no API key configured' }) } });
  assert.equal(nokey.route_reason, 'fallback');
});

test('RISK high stays on a subagent unless api_review_high is api; an Opus review needs API: opus', async () => {
  const hi = BRIEF().replace('RISK: mid', 'RISK: high');
  assert.equal((await call(hi)).route_reason, 'high-risk');
  assert.equal((await call(hi, { deps: { opt: optsOf('all', 'api') } })).route, 'api');
  assert.equal((await call(BRIEF(), { model: 'opus' })).route_reason, 'high-risk');
  const o = await call(BRIEF('API: opus'), { model: 'opus' });
  assert.equal(o.route, 'api'); assert.match(o.updatedInput.prompt, /--model opus/);
});

test('API: no passes through and the retry does not loop', async () => {
  let calls = 0;
  const r = await call(BRIEF('API: no'), { deps: { decide: () => { calls++; return API(); } } });
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'fallback', null]);
  assert.equal(calls, 0, 'the governor is not asked, so the counter does not move');
  assert.equal(apiMarker('x\n- **API:** no\n'), 'no'); assert.equal(apiMarker('API: opus'), 'opus'); assert.equal(apiMarker('no api here'), null);
});

test('a reviewer spawning a reviewer, a canary and a recursion deny are never routed', async () => {
  assert.equal(await call(BRIEF(), { callerDeclaredType: 'code-review' }), null);
  assert.equal(await call(BRIEF(), { recursionDeny: true }), null);
  assert.equal(await call(BRIEF(), { isCanary: true }), null);
});

test('no diff range passes through with no-range', async () => {
  const r = await call('TYPE: code-review\nWRITER: sonnet/high\nRISK: mid\nReview the change on fix/zz-demo.\n');
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'no-range', null]);
  assert.equal(diffRangeOf('see v1.2.3 and a...b'), 'a...b'); assert.equal(diffRangeOf('no range, only ... dots'), null);
});

test('fail open: a thrown error passes the spawn through', async () => {
  const r = await call(BRIEF(), { deps: { decide: () => { throw new Error('boom'); } } });
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'fallback', null]);
  const bad = await routeReview({ typeIsParity: true, brief: BRIEF(), decls: null, deps: { opt: () => { throw new Error('x'); } } });
  assert.equal(bad.updatedInput, null);
});

test('decide --peek does not advance the review counter', () => {
  const ledger = join(dir, 'ledger.json');
  const cfg = { budget: 200, cycleDay: 1, shares: { ...DEFAULT_SHARES }, keySource: 'env:ZZ_KEY', reviewRatio: 0.5, itemEstimate: 2, workspaceLimits: {}, categoryWorkspaces: {} };
  const env = { ZZ_KEY: 'present' };
  const now = Date.parse('2026-11-15T12:00:00Z');
  const first = decide('review', { now, cfg, path: ledger, env, peek: true });
  const second = decide('review', { now, cfg, path: ledger, env, peek: true });
  assert.equal(first.decision, second.decision, 'two peeks answer the same');
  const turn = () => { // the ledger may not exist until something is written
    if (!existsSync(ledger)) return 0;
    return Object.values(JSON.parse(readFileSync(ledger, 'utf8')).cycles || {}).reduce((a, c) => a + ((c.turn && c.turn.review) || 0), 0);
  };
  assert.equal(turn(), 0);
  decide('review', { now, cfg, path: ledger, env });
  assert.equal(turn(), 1, 'a real decide advances it');
});

test('status share lines count API reviews once and subagent rows by route', () => {
  const file = join(dir, 'review-verdicts.jsonl');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const rows = [
    { at: '2026-11-22T09:00:00Z', source: 'api-review', route: 'api', route_reason: 'api' },
    { at: '2026-11-22T09:30:00Z', route: 'api', route_reason: 'api' }, // the guard-routed review's own verdict row: not counted again
    { at: '2026-11-22T10:00:00Z', route: 'subagent', route_reason: 'high-risk' },
    { at: '2026-11-22T11:00:00Z' }, // an older row without route: a subagent review
    { at: '2026-11-18T11:00:00Z', source: 'api-review', route: 'api' },
    { at: '2026-11-10T11:00:00Z', route: 'subagent' }, // outside the 7 days
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const lines = reviewShareLines({ now, file });
  assert.equal(lines[0], 'review share today: 1 of 3 (33%) on the API');
  assert.equal(lines[1], 'review share last 7 days: 2 of 4 (50%) on the API');
  assert.ok(!existsSync(join(dir, 'nope')));
});
