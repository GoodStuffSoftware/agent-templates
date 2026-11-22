// API review routing (0.31.63): the spawn guard's route for review spawns (hooks/lib/sg-review-route.mjs), decide --peek,
// and the review share lines of `api-credits.mjs status`. No live calls: the governor is stubbed through `deps`.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { briefDeclarations } from '../hooks/lib/brief-directives.mjs';
import { routeReview, apiMarker, diffRangeOf, diffRangeInfo, briefHash, notePendingRouted } from '../hooks/lib/sg-review-route.mjs';
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
  assert.equal(nokey.route_reason, 'governor-fallback');
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
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'caller-no', null]);
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
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'error', null]);
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

test('S3: a failed API run is not counted; its subagent retry is, once', () => {
  const file = join(dir, 'review-verdicts-s3.jsonl');
  const now = Date.parse('2026-11-22T12:00:00Z');
  const rows = [
    { at: '2026-11-22T09:00:00Z', source: 'api-review', route: 'api', ok: false }, // failed: the retry below is the review that happened
    { at: '2026-11-22T09:10:00Z', route: 'subagent', route_reason: 'caller-no' }, // the subagent retry's verdict row
    { at: '2026-11-22T10:00:00Z', source: 'api-review', route: 'api', ok: true },
  ];
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(reviewShareLines({ now, file })[0], 'review share today: 1 of 2 (50%) on the API');
});

test('S7: a labelled range beats a tag range in prose; two unlabelled ranges are ambiguous', async () => {
  assert.equal(diffRangeOf('Compared with v1.2..v1.3 in the changelog.\nDiff range: main..fix/zz-demo\n'), 'main..fix/zz-demo');
  assert.deepEqual(diffRangeInfo('see v1.2..v1.3 and main..fix/zz-demo'), { range: null, ambiguous: true });
  const prose = await call(BRIEF('The release notes mention v1.2..v1.3.'));
  assert.equal(prose.route, 'api'); assert.match(prose.updatedInput.prompt, /--diff-ref "main\.\.fix\/zz-demo"/);
  const amb = await call('TYPE: code-review\nWRITER: sonnet/high\nRISK: mid\nCompare v1.2..v1.3 with main..fix/zz-demo.\n');
  assert.deepEqual([amb.route, amb.route_reason, amb.updatedInput], ['subagent', 'ambiguous-range', null]);
  assert.equal(diffRangeOf('Diff: a...b.'), 'a...b', 'a sentence-ending period is not part of the ref');
});

test('repeat guard: a brief whose API run failed in the last 30 minutes is not routed again; an old or other failure does not block', async () => {
  const tdir = mkdtempSync(join(tmpdir(), 'ac-route-tel-'));
  const file = join(tdir, 'review-verdicts.jsonl');
  const row = (over) => JSON.stringify({ source: 'api-review', ok: false, brief_hash: briefHash(BRIEF()), at: new Date().toISOString(), ...over });
  const deps = (extra = {}) => ({ telemetryDir: () => tdir, ...extra });
  assert.equal((await call(BRIEF(), { deps: deps() })).route, 'api', 'no log yet');
  writeFileSync(file, `${row({ at: new Date(Date.now() - 40 * 60000).toISOString() })}\n${row({ brief_hash: 'other-brief' })}\n${row({ ok: true })}\n`);
  assert.equal((await call(BRIEF(), { deps: deps() })).route, 'api', 'old, other-brief and successful rows do not count');
  writeFileSync(file, `${row({})}\n`);
  let calls = 0;
  const r = await call(BRIEF(), { deps: deps({ decide: () => { calls++; return API(); } }) });
  assert.deepEqual([r.route, r.route_reason, r.updatedInput], ['subagent', 'repeat', null]);
  assert.equal(calls, 0, 'the governor is not asked: the counter does not move');
});

test('the rewritten spawn drops isolation and team_name; old brief files are pruned', async () => {
  const sd = mkdtempSync(join(tmpdir(), 'ac-route-state-'));
  const briefs = join(sd, 'review-briefs');
  mkdirSync(briefs, { recursive: true });
  const old = join(briefs, 'old-toolu.md'); const fresh = join(briefs, 'fresh-toolu.md');
  writeFileSync(old, 'x'); writeFileSync(fresh, 'y');
  const longAgo = new Date(Date.now() - 8 * 86400000);
  utimesSync(old, longAgo, longAgo);
  const input = { subagent_type: 'agent-companion:ac-sonnet-high', description: 'review', prompt: BRIEF(), isolation: 'worktree', team_name: 'zz-team', effort: 'high' };
  const r = await call(BRIEF(), { input, deps: { stateDir: () => sd } });
  assert.equal(r.route, 'api');
  assert.ok(!('isolation' in r.updatedInput) && !('team_name' in r.updatedInput) && !('effort' in r.updatedInput));
  assert.equal(r.updatedInput.description, 'review', 'the rest of the spawn is kept');
  assert.ok(!existsSync(old), 'a week-old brief is removed'); assert.ok(existsSync(fresh));
  assert.match(r.updatedInput.prompt, /--session-id "s1" --tool-use-id "toolu_zz1"/, 'the runner is told the original spawn ids');
  assert.match(r.updatedInput.prompt, /full review file: /);
});

test('S6: a routed spawn joins the pending list as the ac-haiku run it now is', async () => {
  const seen = [];
  const rewriteModule = async () => ({ notePendingSpawn: (sid, e) => seen.push([sid, e]) });
  const state = { pending: [], armedAt: 1 };
  await notePendingRouted({ input: { subagent_type: 'agent-companion:ac-sonnet-high' }, sid: 's1', isCanary: false, rewriteState: state, rewriteModule });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 's1'); assert.equal(seen[0][1].type, 'agent-companion:ac-haiku'); assert.equal(seen[0][1].from, 'agent-companion:ac-sonnet-high');
  await notePendingRouted({ input: {}, sid: 's1', isCanary: true, rewriteState: state, rewriteModule });
  await notePendingRouted({ input: { team_name: 't' }, sid: 's1', isCanary: false, rewriteState: state, rewriteModule });
  await notePendingRouted({ input: {}, sid: 's1', isCanary: false, rewriteState: { pending: [] }, rewriteModule });
  assert.equal(seen.length, 1, 'canary, team spawn and an unarmed state record nothing');
});

test('S1: a spawn that carries API: no (a writer that decided for itself) never reaches the governor; a lead review is decided once', async () => {
  let calls = 0;
  const r = await call(BRIEF('API: no'), { deps: { decide: () => { calls++; return API(); } } });
  assert.equal(r.route_reason, 'caller-no'); assert.equal(calls, 0);
  const lead = await call(BRIEF(), { subagentCaller: false, deps: { decide: () => { calls++; return API(); } } });
  assert.equal(lead.route, 'api'); assert.equal(calls, 1, 'a lead review without the marker is decided once, by the guard');
});
