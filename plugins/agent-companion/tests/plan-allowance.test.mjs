// Percent allowance (0.31.47): a brief line `BUDGET: N%` gives a helper N% of the weekly plan limit.
// Library: hooks/lib/plan-allowance.mjs and the splitBudget / briefAllowancePct helpers in
// hooks/lib/brief-directives.mjs; data: config/plan-weights.json; delivery: hooks/subagent-context.mjs;
// the self-check: scripts/allowance.mjs. No soft budget: nothing here stops or denies; the 80% / 100% notices are advice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { briefAllowancePct, splitBudget } from '../hooks/lib/brief-directives.mjs';
import { briefStepInfo, briefAllowanceOnly, capsFor } from '../hooks/lib/step-budget.mjs';
import {
  allowanceNoteText, allowanceNoticeText, allowanceWatch, perCallPct, perCallTokens, allowanceTokens, fmtTokens, requestUnits, rungOf,
  unitsPerPercent, planWeights, modelWeight, agentSpend, allowanceFile, NOTE_MAX_CHARS, _resetPlanWeightsForTests,
} from '../hooks/lib/plan-allowance.mjs';

const SID = 'sess-allow';
const OFF_CTX = { CLAUDE_PLUGIN_OPTION_SUBAGENT_CONTEXT_NOTICE_TOKENS: '0', CLAUDE_PLUGIN_OPTION_SUBAGENT_CEILING_TOKENS: '0' };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// --- parsing -------------------------------------------------------------------------------------------------------

test('parsing: the percent form, the number form, and a line with both', () => {
  assert.equal(briefAllowancePct('TYPE: integration\nBUDGET: 3%\nx'), 3);
  assert.equal(briefAllowancePct('BUDGET: 0.5%'), 0.5);
  assert.equal(briefAllowancePct('BUDGET: 3 %'), 3);
  assert.equal(briefAllowancePct('**BUDGET:** 12.5%'), 12.5);
  assert.equal(briefAllowancePct('- BUDGET: 3% of the weekly limit'), 3);
  assert.equal(briefAllowancePct('BUDGET: 3%, 60 calls'), 3);
  assert.equal(briefAllowancePct('BUDGET: 60 steps / 3%'), 3);
  // the number form is not an allowance
  assert.equal(briefAllowancePct('BUDGET: 60'), null);
  assert.equal(briefAllowancePct('BUDGET: 200 tool calls'), null);
  // out of range, junk on the line, a fenced line, no BUDGET at all: declares nothing
  assert.equal(briefAllowancePct('BUDGET: 0%'), null);
  assert.equal(briefAllowancePct('BUDGET: 150%'), null);
  assert.equal(briefAllowancePct('BUDGET: 3% of my context'), null);
  assert.equal(briefAllowancePct('BUDGET: 3% and some words'), null);
  assert.equal(briefAllowancePct('```\nBUDGET: 3%\n```'), null);
  assert.equal(briefAllowancePct('TYPE: lookup\nfind it'), null);
  assert.equal(briefAllowancePct(''), null);
  assert.deepEqual(splitBudget(' 3%'), { pct: 3, stepRest: '' });
  assert.deepEqual(splitBudget(' 60 calls'), { pct: null, stepRest: ' 60 calls' });
});

test('the percent form never becomes a step budget; the number form is unchanged', () => {
  // percent alone, however large the number: no step budget
  for (const b of ['BUDGET: 3%', 'BUDGET: 30%', 'BUDGET: 50%', 'BUDGET: 100%', 'BUDGET: 0.5%', 'BUDGET: 3% of the weekly limit']) {
    const info = briefStepInfo(`TYPE: integration\n${b}\nbuild it`);
    assert.equal(info.budget, null, b);
    assert.equal(capsFor(info).kind, 'writer', b);
  }
  // both on one line: the step value is read as before
  assert.deepEqual(briefStepInfo('BUDGET: 3%, 60 calls'), { type: null, budget: 60 });
  assert.deepEqual(briefStepInfo('BUDGET: 60 steps; 3%'), { type: null, budget: 60 });
  // a small number beside a percent is still a step budget (it is under the minimum of 10 only when it stands alone)
  assert.deepEqual(briefStepInfo('BUDGET: 3%, 5 calls'), { type: null, budget: 5 });
  assert.deepEqual(briefStepInfo('BUDGET: 3%, 5'), { type: null, budget: 5 });
  assert.deepEqual(briefStepInfo('BUDGET: 5 steps / 3%'), { type: null, budget: 5 });
  assert.deepEqual(capsFor(briefStepInfo('BUDGET: 3%, 5 calls')), { warn: 4, stop: 5, kind: 'brief' });
  assert.equal(briefAllowanceOnly('BUDGET: 3%, 5 calls'), false);
  assert.equal(briefAllowancePct('BUDGET: 3%, 5 calls'), 3);
  assert.equal(briefAllowanceOnly('BUDGET: 3%, 0 calls'), true); // zero is no budget
  assert.equal(briefAllowanceOnly('BUDGET: 3%'), true);
  assert.equal(briefAllowanceOnly('BUDGET: 3%, 60 calls'), false);
  assert.equal(briefAllowanceOnly('BUDGET: 60'), false);
  assert.equal(briefAllowanceOnly('no directives'), false);
  // the number form, exactly as before
  assert.deepEqual(briefStepInfo('TYPE: research\nBUDGET: 150\nx'), { type: 'research', budget: 150 });
  assert.deepEqual(briefStepInfo('BUDGET: 200 tool calls'), { type: null, budget: 200 });
  assert.deepEqual(briefStepInfo('BUDGET: 5'), { type: null, budget: null }); // under the minimum
  assert.deepEqual(briefStepInfo('BUDGET: 1,000 tool calls'), { type: null, budget: null });
  assert.deepEqual(briefStepInfo('BUDGET: 2.5 hours'), { type: null, budget: null });
  assert.deepEqual(capsFor({ type: 'research', budget: 150 }), { warn: 120, stop: 150, kind: 'brief' });
});

// --- data and conversion -------------------------------------------------------------------------------------------

test('the shipped weights file carries every figure with its date, source and status', () => {
  _resetPlanWeightsForTests();
  const w = planWeights();
  assert.equal(unitsPerPercent(), 28.6);
  for (const [name, v] of [['unitsPerPercent', w.unitsPerPercent], ['cacheReadFactor', w.cacheReadFactor], ...Object.entries(w.models).map(([a, m]) => [a, m])]) {
    assert.ok(v.date && v.source && v.status, `${name} has date, source and status`);
  }
  assert.equal(w.models.opus.weight, 1.38);
  assert.deepEqual(w.models.opus.interval, [1.26, 1.51]);
  assert.equal(w.models.opus.status, 'measured');
  assert.equal(w.models.haiku.weight, 0.5);
  assert.equal(w.models.haiku.status, 'assumed');
  assert.equal(w.models.fable.weight, 2.75);
  // median tokens per call: the same cells as the median percent per call, with their source
  const pc = w.perCall;
  assert.ok(typeof pc.medianTokensSource === 'string' && /502,767-request scan of 2026-11-03/.test(pc.medianTokensSource));
  assert.deepEqual(Object.fromEntries(Object.entries(pc.medianTokens).map(([m, c]) => [m, Object.keys(c)])),
    Object.fromEntries(Object.entries(pc.medianPct).map(([m, c]) => [m, Object.keys(c)])));
  assert.equal(pc.medianTokens.sonnet.high, 104728);
  assert.equal(pc.medianTokens.opus.xhigh, 139358);
  assert.equal(pc.medianTokens.haiku.medium, 62357);
  assert.equal(pc.medianTokens.fable.high, 239696);
  assert.equal(w.cacheReadFactor.value, 1.0);
  assert.equal(w.cacheReadFactor.status, 'assumed');
});

test('conversion: tokens to plan units, weighted per model', () => {
  _resetPlanWeightsForTests();
  // (1000 in + 10000 cw5 x 1.25 + 100000 cr x 0.1 + 100 out x 5) = 24000 token-equivalents x $2/M = 0.048 units
  const u = { input: 1000, output: 100, cacheRead: 100000, cacheWrite: 10000, cacheWrite5m: 10000, cacheWrite1h: 0 };
  near(requestUnits(u, 'claude-sonnet-5-5'), 0.048);
  near(requestUnits(u, 'claude-opus-5-5'), 0.048 * 1.38);
  near(requestUnits(u, 'claude-haiku-5-5'), 0.048 * 0.5);
  near(requestUnits(u, 'claude-fable-5-1'), 0.048 * 2.75);
  // a 1-hour cache write counts 2x, not 1.25x
  near(requestUnits({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000 }, 'claude-sonnet-5-5'), 1000 * 2 * 2e-6);
  // an unrecognised model counts at the Sonnet weight
  near(requestUnits(u, 'claude-nova-9'), 0.048);
  assert.equal(modelWeight('').known, false);
  // 1% of the weekly limit is 28.6 units
  near(0.048 / unitsPerPercent(), 0.048 / 28.6);
});

test('calls per allowance: the median call per model and effort', () => {
  _resetPlanWeightsForTests();
  near(perCallPct('sonnet', 'low').pct, 0.00076);
  near(perCallPct('sonnet', 'medium').pct, 0.00090);
  near(perCallPct('sonnet', 'high').pct, 0.00115);
  near(perCallPct('sonnet', 'xhigh').pct, 0.00129);
  // opus cells were computed at weight 1.5 and rescale to the current 1.38
  near(perCallPct('opus', 'medium').pct, 0.00169 * 1.38 / 1.5);
  near(perCallPct('opus', 'high').pct, 0.00181 * 1.38 / 1.5);
  near(perCallPct('opus', 'xhigh').pct, 0.00228 * 1.38 / 1.5);
  near(perCallPct('haiku', 'medium').pct, 0.00054);
  near(perCallPct('fable', 'high').pct, 0.01107 * 2.75 / 5);
  // measured cells are not flagged; a missing cell falls back to the nearest effort and says estimated
  assert.equal(perCallPct('sonnet', 'high').estimated, false);
  assert.equal(perCallPct('sonnet', 'max').estimated, true);
  near(perCallPct('sonnet', 'max').pct, 0.00129);
  assert.equal(perCallPct('fable', 'xhigh').estimated, true);
  // 3% at sonnet/high buys 3 / 0.00115 = 2,609 calls of a median 104,728 tokens = 273 million tokens
  const note = allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' });
  assert.match(note, /about 270 million tokens at sonnet\/high's usual mix/);
  assert.match(note, /3% of the weekly limit \(85\.8 units\)/);
  near(allowanceTokens(3, 'sonnet', 'high'), (3 / 0.00115) * 104728, 1);
  // opus/xhigh: 3% / 0.0020976 = 1430 calls x 139,358 = 199 million -> about 200 million
  assert.match(allowanceNoteText({ pct: 3, alias: 'opus', effort: 'xhigh', root: 'R', agentId: 'a1' }), /about 200 million tokens at opus\/xhigh/);
  // decimals; a small allowance is in millions, a large one in billions
  assert.match(allowanceNoteText({ pct: 0.5, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' }), /0\.5% of the weekly limit \(14\.3 units\), about 46 million tokens/);
  assert.match(allowanceNoteText({ pct: 12.5, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' }), /about 1\.1 billion tokens/);
  // an assumed or estimated rung is marked
  assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', assumed: true, root: 'R', agentId: 'a1' }), /tokens at sonnet\/high's usual mix \(est\.\)/);
  assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'max', root: 'R', agentId: 'a1' }), /\(est\.\)/);
  // the nearest effort's median stands in for a missing cell
  assert.equal(perCallTokens('sonnet', 'max'), 110815);
  assert.equal(perCallTokens('opus', 'low'), 68782);
  // the note says what it will do
  assert.match(note, /You get a notice at 80% and 100%; nothing stops you\./);
  assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1', noticePct: 50 }), /You get a notice at 50% and 100%; nothing stops you\./);
  assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1', noticePct: 100 }), /You get a notice at 100%; nothing stops you\./);
  assert.match(allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1', noticePct: 0 }), /Nothing will warn or stop you\./);
});

test('token formatting: millions and billions to two figures, a count to three', () => {
  assert.equal(fmtTokens(273_200_000), '270 million');
  assert.equal(fmtTokens(45_530_000), '46 million');
  assert.equal(fmtTokens(1_090_000_000), '1.1 billion');
  assert.equal(fmtTokens(2_700_000), '2.7 million');
  assert.equal(fmtTokens(570_400), '570 thousand');
  assert.equal(fmtTokens(4_123_456, 3), '4.12 million');
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(812), '812');
});

test('without median tokens the note falls back to the calls it buys', () => {
  const fx = makeFixture();
  try {
    _resetPlanWeightsForTests();
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'plan-weights.json'), JSON.stringify({ perCall: { medianTokens: {} } }));
    const t = allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' });
    assert.match(t, /about 2,600 calls at sonnet\/high\./);
    assert.doesNotMatch(t, /tokens/);
  } finally { _resetPlanWeightsForTests(); fx.cleanup(); }
});

test('the rung comes from the agent type; anything else is assumed', () => {
  assert.deepEqual(rungOf('agent-companion:ac-sonnet-high'), { alias: 'sonnet', effort: 'high', assumed: false });
  assert.deepEqual(rungOf('agent-companion:ac-opus-xhigh'), { alias: 'opus', effort: 'xhigh', assumed: false });
  assert.deepEqual(rungOf('ac-haiku'), { alias: 'haiku', effort: 'medium', assumed: false });
  assert.deepEqual(rungOf('agent-companion:ac-browser-opus'), { alias: 'opus', effort: 'medium', assumed: false });
  assert.deepEqual(rungOf('general-purpose', { model: 'claude-opus-5-5', effort: 'high' }), { alias: 'opus', effort: 'high', assumed: false });
  assert.deepEqual(rungOf('general-purpose'), { alias: 'sonnet', effort: 'high', assumed: true });
});

test('the note stays within about 300 characters, even with a long plugin path', () => {
  const root = 'C:/Users/someone/.claude/plugins/cache/agent-templates/agent-companion/0.31.47';
  for (const [alias, effort, assumed] of [['sonnet', 'high', false], ['opus', 'xhigh', false], ['fable', 'high', true], ['haiku', 'medium', false]]) {
    const t = allowanceNoteText({ pct: 12.5, alias, effort, assumed, root, agentId: 'agent-xyz-1' });
    assert.ok(t.length <= NOTE_MAX_CHARS, `${alias}/${effort}: ${t.length} chars`);
    assert.doesNotMatch(t, /\n/);
    assert.match(t, /You get a notice at 80% and 100%; nothing stops you/);
    assert.match(t, /allowance\.mjs" agent-xyz-1$/);
  }
});

test('a state-dir override of the weights is merged one level deep', () => {
  const fx = makeFixture();
  try {
    _resetPlanWeightsForTests();
    mkdirSync(fx.stateDir, { recursive: true });
    writeFileSync(join(fx.stateDir, 'plan-weights.json'), JSON.stringify({ unitsPerPercent: { value: 30 }, models: { opus: { weight: 1.5 } } }));
    const w = planWeights();
    assert.equal(unitsPerPercent(), 30);
    assert.equal(w.unitsPerPercent.status, 'measured'); // kept from the shipped file
    assert.equal(w.models.opus.weight, 1.5);
    assert.equal(w.models.opus.status, 'measured');
    assert.equal(w.models.haiku.weight, 0.5);
    // the calls estimate follows the new weight
    near(perCallPct('opus', 'high').pct, 0.00181);
  } finally { _resetPlanWeightsForTests(); fx.cleanup(); }
});

// --- the hook ------------------------------------------------------------------------------------------------------

const user = (t) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: t } })}\n`;
const turn = (id, model, usage) => `${JSON.stringify({
  type: 'assistant', requestId: id,
  message: { id: `m_${id}`, model, usage: usage || { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 50000, cache_creation_input_tokens: 2000 } },
})}\n`;

function layout(fx, agents) {
  const proj = join(fx.dir, '.claude', 'projects', 'proj-allow');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  const lead = join(proj, `${SID}.jsonl`);
  writeFileSync(lead, '');
  for (const a of agents) {
    writeFileSync(join(sub, `agent-${a.id}.jsonl`), a.text);
    if (a.parent) writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'x', parentAgentId: a.parent, spawnDepth: 2 }));
    else writeFileSync(join(sub, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'x', spawnDepth: 1 }));
  }
  return { lead, sub };
}

const pre = (lead, id, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: SID, transcript_path: lead, cwd: 'x', permission_mode: 'default',
  agent_id: id, agent_type: 'agent-companion:ac-sonnet-high', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_1', ...extra,
});
const run = (lead, id, env = {}, extra = {}) => runHook('hooks/subagent-context.mjs', pre(lead, id, extra), { env: { ...OFF_CTX, ...env } });
const ctxText = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';

test('hook: BUDGET: 3% gives ONE note at the first call, with the agent id and the command', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'allow-1', text: user('TYPE: integration\nBUDGET: 3%\nbuild it') + turn('r1', 'claude-sonnet-5-5') }]);
    const r1 = run(lead, 'allow-1');
    const t = ctxText(r1);
    assert.match(t, /^Allowance: 3% of the weekly limit \(85\.8 units\), about 270 million tokens at sonnet\/high's usual mix\. Plan your work to fit\. You get a notice at 80% and 100%; nothing stops you\. Spend: node ".*\/scripts\/allowance\.mjs" allow-1$/);
    assert.ok(t.length <= NOTE_MAX_CHARS + 60, `${t.length} chars`); // a test checkout path is longer than an install path
    assert.equal(denied(r1), false);
    const rec = JSON.parse(readFileSync(join(stateDir(), 'allowance', 'allow-1.json'), 'utf8'));
    assert.equal(rec.agent_id, 'allow-1');
    assert.equal(rec.pct, 3);
    // the second call: no note
    assert.equal(run(lead, 'allow-1').stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('hook: no note without a percent line; the number form gets no note and keeps its step budget', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [
      { id: 'allow-none', text: user('TYPE: integration\nbuild it') + turn('r1', 'claude-sonnet-5-5') },
      { id: 'allow-num', text: user('TYPE: integration\nBUDGET: 60\nbuild it') + turn('r1', 'claude-sonnet-5-5') },
    ]);
    assert.equal(run(lead, 'allow-none').stdout.trim(), '');
    assert.equal(run(lead, 'allow-num').stdout.trim(), '');
    // the record is written once either way (the brief is read once) and holds no allowance
    assert.equal(JSON.parse(readFileSync(join(stateDir(), 'allowance', 'allow-none.json'), 'utf8')).pct, null);
    // the step budget of BUDGET: 60 still works: the warning at 80% of 60
    mkdirSync(join(stateDir(), 'step-budget'), { recursive: true });
    writeFileSync(join(stateDir(), 'step-budget', 'allow-num.cnt'), '.'.repeat(47));
    assert.match(ctxText(run(lead, 'allow-num')), /48 of 60 steps used/);
  } finally { fx.cleanup(); }
});

test('hook: the percent form never denies, warns or nags, however many calls, even with the step deny on (empty output at calls 80, 121, 150 and 500)', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'allow-big', text: user('TYPE: integration\nBUDGET: 90%\nbuild it') + turn('r1', 'claude-sonnet-5-5') }]);
    const first = run(lead, 'allow-big'); // the one allowance note
    assert.match(ctxText(first), /Allowance/);
    const dir = (d) => { mkdirSync(join(stateDir(), d), { recursive: true }); return join(stateDir(), d, 'allow-big.cnt'); };
    const setCalls = (n) => { writeFileSync(dir('step-budget'), '.'.repeat(n - 1)); writeFileSync(dir('long-runs'), '.'.repeat(n - 1)); };
    for (const n of [80, 121, 150, 500]) {
      setCalls(n);
      for (const env of [{}, { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_DENY: 'true' }]) {
        const r = run(lead, 'allow-big', env);
        assert.equal(r.stdout.trim(), '', `call ${n} ${JSON.stringify(env)}: nothing is said`);
        assert.equal(denied(r), false);
      }
    }
  } finally { fx.cleanup(); }
});

test('hook: BUDGET: 3%, 60 calls keeps its step budget (the number part is a budget as before)', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'allow-both', text: user('TYPE: integration\nBUDGET: 3%, 60 calls\nbuild it') + turn('r1', 'claude-sonnet-5-5') }]);
    run(lead, 'allow-both');
    mkdirSync(join(stateDir(), 'step-budget'), { recursive: true });
    writeFileSync(join(stateDir(), 'step-budget', 'allow-both.cnt'), '.'.repeat(47));
    assert.match(ctxText(run(lead, 'allow-both')), /48 of 60 steps used/);
  } finally { fx.cleanup(); }
});

test('hook: plan_allowance off sends no note; the lead is never noted', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'allow-off', text: user('BUDGET: 3%\nx') + turn('r1', 'claude-sonnet-5-5') }]);
    assert.equal(run(lead, 'allow-off', { CLAUDE_PLUGIN_OPTION_PLAN_ALLOWANCE: 'false' }).stdout.trim(), '');
    const p = pre(lead, 'allow-off');
    delete p.agent_id;
    delete p.agent_type;
    assert.equal(runHook('hooks/subagent-context.mjs', p, { env: OFF_CTX }).stdout.trim(), '');
    assert.equal(existsSync(join(stateDir(), 'allowance', 'allow-off.json')), false);
  } finally { fx.cleanup(); }
});

// --- the self-check ------------------------------------------------------------------------------------------------

const check = (fx, id) => runHook('scripts/allowance.mjs', undefined, { args: [id], env: { CLAUDE_CONFIG_DIR: join(fx.dir, '.claude') } });
const ONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0 };
// one Sonnet request of 1M cache-read tokens = 1e6 x 0.1 x $2/M = 0.2 units
const UNITS_ONE_SONNET = 0.2;
// the script's number format
const f = (n) => (n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(3));

test('self-check: counts only its own transcript and its own subagents, not a parallel agent', () => {
  const fx = makeFixture();
  try {
    layout(fx, [
      // A: the asker, 2 Sonnet requests (one written as two lines: counted once) and a 3% allowance
      { id: 'agent-A', text: user('BUDGET: 3%\nwork') + turn('a1', 'claude-sonnet-5-5', ONE) + turn('a1', 'claude-sonnet-5-5', ONE) + turn('a2', 'claude-sonnet-5-5', ONE) },
      // C: a subagent A spawned (parentAgentId A), 1 Opus request: 0.2 x 1.38 units
      { id: 'agent-C', parent: 'agent-A', text: user('sub') + turn('c1', 'claude-opus-5-5', ONE) },
      // D: a grandchild (C spawned it), 1 Sonnet request
      { id: 'agent-D', parent: 'agent-C', text: user('subsub') + turn('d1', 'claude-sonnet-5-5', ONE) },
      // B: another agent running at the same time, 50 requests: must not count
      { id: 'agent-B', text: user('BUDGET: 9%\nother') + Array.from({ length: 50 }, (_, i) => turn(`b${i}`, 'claude-opus-5-5', ONE)).join('') },
      // E: a child of B: must not count
      { id: 'agent-E', parent: 'agent-B', text: user('sub of b') + turn('e1', 'claude-sonnet-5-5', ONE) },
    ]);
    const r = check(fx, 'agent-A');
    assert.equal(r.status, 0, r.stderr);
    const units = 2 * UNITS_ONE_SONNET + UNITS_ONE_SONNET * 1.38 + UNITS_ONE_SONNET; // A (2) + C (opus) + D
    const pct = units / 28.6;
    assert.match(r.stdout, new RegExp(`^Spent ${f(pct)}% of the weekly limit \\(${f(units)} units\\) = ${f(pct / 3 * 100)}% of your 3% allowance\\.`));
    assert.match(r.stdout, /Own: 2 calls, 0\.014%\. Subagents \(2\): 2 calls, 0\.017%\./);
    assert.match(r.stdout, /opus 1\.38 \(measured\)/);
    // B alone: 50 Opus requests + its child E, and its own 9% allowance
    const rb = check(fx, 'agent-B');
    const ub = 50 * UNITS_ONE_SONNET * 1.38 + UNITS_ONE_SONNET;
    assert.match(rb.stdout, new RegExp(`of your 9% allowance`));
    assert.match(rb.stdout, new RegExp(`\\(${f(ub)} units\\)`));
  } finally { fx.cleanup(); }
});

test('self-check: prints no path, a missing agent is reported, junk input is refused', () => {
  const fx = makeFixture();
  try {
    layout(fx, [{ id: 'agent-P', text: user('work') + turn('p1', 'claude-sonnet-5-5', ONE) }]);
    const ok = check(fx, 'agent-P');
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /No % allowance in your brief/);
    assert.doesNotMatch(ok.stdout + ok.stderr, /projects|\.jsonl|[A-Za-z]:[\\/]|ac-test-/);
    const miss = check(fx, 'agent-nobody');
    assert.equal(miss.status, 1);
    assert.match(miss.stdout, /unavailable: no transcript found/);
    const junk = check(fx, '../../etc');
    assert.equal(junk.status, 2);
    const none = runHook('scripts/allowance.mjs', undefined, { args: [] });
    assert.equal(none.status, 2);
  } finally { fx.cleanup(); }
});

test('self-check is a read: it creates nothing under a fresh state root', () => {
  const fx = makeFixture();
  try {
    const fresh = join(fx.dir, 'fresh-state-root');
    runHook('scripts/allowance.mjs', undefined, { args: ['agent-nobody'], env: { CLAUDE_CONFIG_DIR: join(fx.dir, '.claude'), AGENT_COMPANION_STATE_DIR: fresh } });
    assert.equal(existsSync(fresh), false, 'no state root, README or state dir created by a read');
  } finally { fx.cleanup(); }
});

test('self-check: uses the allowance the hook recorded, and finds the transcript from it', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'agent-R', text: user('TYPE: integration\nBUDGET: 2%\nwork') + turn('r1', 'claude-sonnet-5-5', ONE) }]);
    run(lead, 'agent-R'); // writes the record
    const r = check(fx, 'agent-R');
    assert.match(r.stdout, /of your 2% allowance/);
  } finally { fx.cleanup(); }
});

// --- the 80% and 100% notices ------------------------------------------------------------------------------------

// A request of 10M cache-read tokens on Sonnet = 10e6 x 0.1 x $2/M = 2 units; a 1% allowance is 28.6 units, so
// 11 requests = 76.9%, 12 = 83.9%, 14 = 97.9%, 15 = 104.9%.
const BIG = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000_000, cache_creation_input_tokens: 0 };
const turns = (prefix, n, model = 'claude-sonnet-5-5', usage = BIG) => Array.from({ length: n }, (_, i) => turn(`${prefix}${i}`, model, usage)).join('');
const addTurns = (fx, id, prefix, n, model, usage) => appendFileSync(join(fx.dir, '.claude', 'projects', 'proj-allow', SID, 'subagents', `agent-${id}.jsonl`), turns(prefix, n, model, usage));
const NOTICE_80 = /You have used 80% of your 1% allowance\. Send whoever briefed you ONE short status \(what is done, what is left, how much more you need\), a subagent by SendMessage to "main", then keep going\. Nothing stops you\./;
const NOTICE_100 = /You have used your whole 1% allowance\. Send whoever briefed you ONE short status/;

test('notices: 80% once, 100% once, then nothing; they never deny, even with the step deny on', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'n-1', text: user('TYPE: integration\nBUDGET: 1%\nbuild it') + turn('first', 'claude-sonnet-5-5') }]);
    const calls = [];
    const go = (label, env = {}) => {
      const r = run(lead, 'n-1', { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_DENY: 'true', ...env });
      calls.push(label);
      assert.equal(denied(r), false, `${label}: never a deny`);
      assert.equal(r.status, 0);
      return ctxText(r);
    };
    assert.match(go('first call'), /Allowance: 1% .* You get a notice at 80% and 100%; nothing stops you\./);
    addTurns(fx, 'n-1', 'x', 11); // 22 units: 76.9%
    assert.equal(go('76.9%'), '');
    addTurns(fx, 'n-1', 'y', 1); // 24 units: 83.9%
    const at80 = go('83.9%');
    assert.match(at80, NOTICE_80);
    assert.doesNotMatch(at80, NOTICE_100);
    assert.ok(at80.length < 400, `${at80.length} chars: well under 300 tokens`);
    assert.equal(go('83.9% again'), '', 'the 80% notice is not repeated');
    addTurns(fx, 'n-1', 'z', 2); // 28 units: 97.9%
    assert.equal(go('97.9%'), '');
    addTurns(fx, 'n-1', 'w', 1); // 30 units: 104.9%
    const at100 = go('104.9%');
    assert.match(at100, NOTICE_100);
    assert.doesNotMatch(at100, /80%/);
    assert.equal(go('104.9% again'), '', 'the 100% notice is not repeated');
    addTurns(fx, 'n-1', 'v', 40);
    assert.equal(go('way over'), '', 'nothing more, however far over');
    assert.equal(calls.length, 8);
  } finally { fx.cleanup(); }
});

test('notices: a jump past both lines in one call sends one notice (the 100% one) and the 80% one is spent', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'n-jump', text: user('BUDGET: 1%\nwork') + turn('first', 'claude-sonnet-5-5') }]);
    assert.match(ctxText(run(lead, 'n-jump')), /Allowance/);
    addTurns(fx, 'n-jump', 'x', 16);
    const t = ctxText(run(lead, 'n-jump'));
    assert.match(t, NOTICE_100);
    assert.equal((t.match(/\[agent-companion\]/g) || []).length, 1);
    assert.equal(ctxText(run(lead, 'n-jump')), '');
  } finally { fx.cleanup(); }
});

test('notices: allowance_notice_pct 0 is silent at any spend, and the note then says nothing will warn', () => {
  const fx = makeFixture();
  try {
    const OFF = { CLAUDE_PLUGIN_OPTION_ALLOWANCE_NOTICE_PCT: '0' };
    const { lead } = layout(fx, [{ id: 'n-off', text: user('BUDGET: 1%\nwork') + turn('first', 'claude-sonnet-5-5') }]);
    assert.match(ctxText(run(lead, 'n-off', OFF)), /Plan your work to fit\. Nothing will warn or stop you\. Spend: node/);
    addTurns(fx, 'n-off', 'x', 13); // 90%
    assert.equal(run(lead, 'n-off', OFF).stdout.trim(), '');
    addTurns(fx, 'n-off', 'y', 10); // 140%
    assert.equal(run(lead, 'n-off', OFF).stdout.trim(), '');
    assert.equal(existsSync(join(stateDir(), 'allowance', 'n-off.meter.json')), false, 'nothing is read or kept when the notices are off');
    // the option is read on each call: set back to the default, the notice comes (100%, the 80% one is spent with it)
    assert.match(ctxText(run(lead, 'n-off')), NOTICE_100);
  } finally { fx.cleanup(); }
});

test('notices: allowance_notice_pct moves the first line; 100 or more sends the 100% notice only; plan_allowance off sends none', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [
      { id: 'n-50', text: user('BUDGET: 1%\nwork') + turn('first', 'claude-sonnet-5-5') },
      { id: 'n-100', text: user('BUDGET: 1%\nwork') + turn('first', 'claude-sonnet-5-5') },
      { id: 'n-no', text: user('BUDGET: 1%\nwork') + turn('first', 'claude-sonnet-5-5') },
    ]);
    const o50 = { CLAUDE_PLUGIN_OPTION_ALLOWANCE_NOTICE_PCT: '50' };
    const o100 = { CLAUDE_PLUGIN_OPTION_ALLOWANCE_NOTICE_PCT: '100' };
    const noPlan = { CLAUDE_PLUGIN_OPTION_PLAN_ALLOWANCE: 'false' };
    assert.match(ctxText(run(lead, 'n-50', o50)), /notice at 50% and 100%/);
    assert.match(ctxText(run(lead, 'n-100', o100)), /notice at 100%; nothing stops you/);
    run(lead, 'n-no', noPlan);
    for (const id of ['n-50', 'n-100', 'n-no']) addTurns(fx, id, 'x', 8); // 16 units: 55.9%
    assert.match(ctxText(run(lead, 'n-50', o50)), /used 50% of your 1% allowance/);
    assert.equal(run(lead, 'n-100', o100).stdout.trim(), '');
    for (const id of ['n-100', 'n-no']) addTurns(fx, id, 'y', 8); // 32 units: 111.9%
    assert.match(ctxText(run(lead, 'n-100', o100)), NOTICE_100);
    assert.equal(run(lead, 'n-no', noPlan).stdout.trim(), '');
  } finally { fx.cleanup(); }
});

test('notices: only this agent and the agents it spawned count; a busy agent next to it never triggers, delays or spends its notices', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [
      { id: 'iso-A', text: user('BUDGET: 1%\nwork') + turn('a-first', 'claude-sonnet-5-5') },
      { id: 'iso-B', text: user('BUDGET: 1%\nother') + turn('b-first', 'claude-sonnet-5-5') },
      { id: 'iso-C', parent: 'iso-A', text: user('child of A') + turn('c-first', 'claude-sonnet-5-5') },
      { id: 'iso-D', parent: 'iso-C', text: user('grandchild of A') + turn('d-first', 'claude-sonnet-5-5') },
      { id: 'iso-E', parent: 'iso-B', text: user('child of B') + turn('e-first', 'claude-sonnet-5-5') },
    ]);
    assert.match(ctxText(run(lead, 'iso-A')), /Allowance/);
    assert.match(ctxText(run(lead, 'iso-B')), /Allowance/);
    // B and its child spend 300%: B is told at once, A hears nothing
    addTurns(fx, 'iso-B', 'b', 30);
    addTurns(fx, 'iso-E', 'e', 15);
    assert.match(ctxText(run(lead, 'iso-B')), NOTICE_100);
    assert.equal(run(lead, 'iso-A').stdout.trim(), '', "B's and E's spend is not A's");
    // A's own spend 6 requests = 12 units, its child C 4 = 8 units, its grandchild D 2 = 4 units: 24 units = 83.9% only with all three
    addTurns(fx, 'iso-A', 'a', 6);
    addTurns(fx, 'iso-C', 'c', 4);
    assert.equal(run(lead, 'iso-A').stdout.trim(), '', '20 units = 69.9%: no notice yet');
    addTurns(fx, 'iso-D', 'd', 2);
    assert.match(ctxText(run(lead, 'iso-A')), NOTICE_80, "the grandchild's spend counts");
    // B's notices were already spent and A's are its own: A still gets its 100% later, and B is not told twice
    addTurns(fx, 'iso-A', 'a2', 4);
    assert.match(ctxText(run(lead, 'iso-A')), NOTICE_100);
    assert.equal(run(lead, 'iso-B').stdout.trim(), '');
    // the meter files are separate per agent
    assert.ok(existsSync(join(stateDir(), 'allowance', 'iso-A.meter.json')) && existsSync(join(stateDir(), 'allowance', 'iso-B.meter.json')));
    const mA = JSON.parse(readFileSync(join(stateDir(), 'allowance', 'iso-A.meter.json'), 'utf8'));
    assert.deepEqual(Object.keys(mA.kids).sort(), ['iso-C', 'iso-D']);
  } finally { fx.cleanup(); }
});

test('notices: the incremental meter equals the full read (split request lines, a half-written last line, a child that appears later)', () => {
  const fx = makeFixture();
  try {
    const { lead, sub } = layout(fx, [{ id: 'inc-A', text: user('BUDGET: 50%\nwork') + turn('r0', 'claude-sonnet-5-5', BIG) }]);
    run(lead, 'inc-A');
    const metered = () => {
      const m = JSON.parse(readFileSync(join(stateDir(), 'allowance', 'inc-A.meter.json'), 'utf8'));
      return [m.own, ...Object.values(m.kids)].reduce((a, k) => a + k.units + (k.open ? requestUnits(k.open.usage, k.open.model) : 0), 0);
    };
    const file = join(sub, 'agent-inc-A.jsonl');
    const step = () => allowanceWatch(pre(lead, 'inc-A'), { noticePct: 80 });
    step();
    // one request written as two lines (the second with the final output): counted once, at the larger usage
    const split = (id, out) => turn(id, 'claude-opus-5-5', { input_tokens: 5, output_tokens: out, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 3000 });
    appendFileSync(file, split('s1', 10) + split('s1', 4000) + split('s2', 50));
    step();
    // a half-written last line is left for the next time, not counted twice
    const line = split('s3', 70);
    appendFileSync(file, line.slice(0, 90));
    step();
    appendFileSync(file, line.slice(90) + split('s3', 900));
    // a child that shows up later is found by the next look
    writeFileSync(join(sub, 'agent-inc-K.meta.json'), JSON.stringify({ agentType: 'x', parentAgentId: 'inc-A' }));
    writeFileSync(join(sub, 'agent-inc-K.jsonl'), user('kid') + turns('k', 3, 'claude-haiku-5-5', BIG));
    step();
    appendFileSync(join(sub, 'agent-inc-K.jsonl'), turns('k2', 2, 'claude-haiku-5-5', BIG));
    step();
    near(metered(), agentSpend('inc-A', join(fx.dir, '.claude')).totalUnits, 1e-9);
    assert.ok(metered() > 0.8, 'something was counted');
  } finally { fx.cleanup(); }
});

test('notices: a failing read, no allowance and an unrelated agent are all silent and never throw', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'q-1', text: user('work') + turn('r', 'claude-sonnet-5-5') }]);
    assert.equal(allowanceWatch({ agent_id: 'q-1' }, { noticePct: 80 }), null); // no record
    assert.equal(allowanceWatch({}, { noticePct: 80 }), null);
    assert.equal(allowanceWatch(null, { noticePct: 80 }), null);
    assert.equal(allowanceWatch({ agent_id: 'q-1' }, { noticePct: 0 }), null);
    run(lead, 'q-1'); // record with no allowance
    assert.equal(allowanceWatch({ agent_id: 'q-1' }, { noticePct: 80 }), null);
    // a record whose transcript is gone, and a corrupt meter file
    mkdirSync(join(stateDir(), 'allowance'), { recursive: true });
    writeFileSync(allowanceFile('q-2'), JSON.stringify({ agent_id: 'q-2', pct: 1, transcript: join(fx.dir, 'nope.jsonl') }));
    assert.equal(allowanceWatch({ agent_id: 'q-2' }, { noticePct: 80 }), null);
    writeFileSync(join(stateDir(), 'allowance', 'q-2.meter.json'), '{broken');
    assert.equal(allowanceWatch({ agent_id: 'q-2' }, { noticePct: 80 }), null);
    assert.match(allowanceNoticeText(80, 1), /80% of your 1% allowance/);
  } finally { fx.cleanup(); }
});

test('notices: cost. A long transcript and many other agents: the first look is bounded, the next ones read only what is new', () => {
  const fx = makeFixture();
  try {
    const small = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
    const agents = [{ id: 'cost-A', text: user('BUDGET: 90%\nwork') + turns('a', 3000, 'claude-sonnet-5-5', small) }];
    for (let i = 0; i < 25; i += 1) agents.push({ id: `cost-k${i}`, parent: 'cost-A', text: user('kid') + turns(`k${i}-`, 200, 'claude-sonnet-5-5', small) });
    for (let i = 0; i < 300; i += 1) agents.push({ id: `cost-o${i}`, text: user('other') + turns(`o${i}-`, 5, 'claude-sonnet-5-5', small) });
    const { lead } = layout(fx, agents);
    run(lead, 'cost-A'); // the record
    const p = pre(lead, 'cost-A');
    let t0 = performance.now();
    allowanceWatch(p, { noticePct: 80 });
    const cold = performance.now() - t0;
    // appended since: one request, in its own transcript
    addTurns(fx, 'cost-A', 'new', 1, 'claude-sonnet-5-5', small);
    t0 = performance.now();
    allowanceWatch(p, { noticePct: 80 });
    const warm = performance.now() - t0;
    // nothing new at all
    t0 = performance.now();
    allowanceWatch(p, { noticePct: 80 });
    const idle = performance.now() - t0;
    const m = JSON.parse(readFileSync(join(stateDir(), 'allowance', 'cost-A.meter.json'), 'utf8'));
    assert.equal(Object.keys(m.kids).length, 25);
    assert.ok(m.skip.length >= 300, 'unrelated agents are remembered, not read again');
    assert.ok(cold < 4000, `first look ${cold.toFixed(0)} ms (the hook limit is 5000)`);
    assert.ok(warm < 200, `a call with one new request ${warm.toFixed(0)} ms`);
    assert.ok(idle < 200, `a call with nothing new ${idle.toFixed(0)} ms`);
    // the whole hook process, node start included, on the warm path
    addTurns(fx, 'cost-A', 'new2', 1, 'claude-sonnet-5-5', small);
    const t1 = performance.now();
    const r = run(lead, 'cost-A');
    const wall = performance.now() - t1;
    assert.equal(r.status, 0);
    assert.ok(wall < 4000, `hook process ${wall.toFixed(0)} ms (limit 5000)`);
  } finally { fx.cleanup(); }
});

test('notices: once the last notice has gone a call reads only the state file (nothing else is touched)', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'done-A', text: user('BUDGET: 1%\nwork') + turn('f', 'claude-sonnet-5-5') }]);
    run(lead, 'done-A');
    addTurns(fx, 'done-A', 'x', 16);
    assert.match(ctxText(run(lead, 'done-A')), NOTICE_100);
    const mf = join(stateDir(), 'allowance', 'done-A.meter.json');
    assert.deepEqual(JSON.parse(readFileSync(mf, 'utf8')).fired.sort((a, b) => a - b), [80, 100]);
    // more is written to the transcript: a call that read it would change the state; this one must not
    const before = readFileSync(mf, 'utf8');
    addTurns(fx, 'done-A', 'late', 5);
    assert.equal(run(lead, 'done-A').stdout.trim(), '');
    assert.equal(readFileSync(mf, 'utf8'), before, 'the state is unchanged: no read, no write');
  } finally { fx.cleanup(); }
});

// --- the hook with a small step value beside a percent --------------------------------------------------------------

test('hook: BUDGET: 3%, 5 calls keeps a 5-call step budget (warning at 4, soft stop at 5), and the allowance note too', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'five', text: user('TYPE: integration\nBUDGET: 3%, 5 calls\nbuild it') + turn('r1', 'claude-sonnet-5-5') }]);
    assert.match(ctxText(run(lead, 'five')), /^Allowance: 3%/); // call 1: the allowance note
    for (const n of [2, 3]) assert.equal(run(lead, 'five').stdout.trim(), '', `call ${n}`);
    assert.match(ctxText(run(lead, 'five')), /4 of 5 steps used/);
    const fifth = run(lead, 'five');
    assert.match(ctxText(fifth), /./, 'call 5: the soft-stop note');
    assert.equal(denied(fifth), false, 'soft by default');
  } finally { fx.cleanup(); }
});

// --- the self-check shows tokens ------------------------------------------------------------------------------------

test('self-check: tokens used, the allowance in tokens at the usual mix, and what is left', () => {
  const fx = makeFixture();
  try {
    layout(fx, [
      { id: 'tok-A', text: user('BUDGET: 3%\nwork') + turn('t1', 'claude-sonnet-5-5', ONE) + turn('t2', 'claude-sonnet-5-5', { input_tokens: 500, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 800 }) },
      { id: 'tok-B', text: user('work') + turn('b1', 'claude-sonnet-5-5', ONE) },
    ]);
    const r = check(fx, 'tok-A');
    assert.equal(r.status, 0, r.stderr);
    // 1,000,000 + 500 + 700 + 800 = 1,002,000 tokens
    assert.match(r.stdout, /^Tokens: 1 million used\. The allowance is about 270 million at sonnet\/high's usual mix; about 270 million left\.$/m);
    const s = agentSpend('tok-A', join(fx.dir, '.claude'));
    assert.equal(s.totalTokens, 1_002_000);
    near(s.allowanceTokens, (3 / 0.00115) * 104728, 1);
    near(s.tokensLeft, s.allowanceTokens * (1 - s.totalUnits / (3 * 28.6)), 1);
    // no allowance in the brief: tokens used only
    assert.match(check(fx, 'tok-B').stdout, /^Tokens: 1 million used\.$/m);
  } finally { fx.cleanup(); }
});

test('notices: a listing pass cut short (an unreadable meta) never writes off an agent that only sorts before its parent', () => {
  const fx = makeFixture();
  try {
    const { lead, sub } = layout(fx, [{ id: 'cut-A', text: user('BUDGET: 50%\nwork') + turn('r0', 'claude-sonnet-5-5', BIG) }]);
    run(lead, 'cut-A');
    // the grandchild's meta sorts before its parent's, and the parent's meta is half-written on the first look
    writeFileSync(join(sub, 'agent-cut-a-grand.meta.json'), JSON.stringify({ agentType: 'x', parentAgentId: 'cut-z-kid' }));
    writeFileSync(join(sub, 'agent-cut-a-grand.jsonl'), user('grandchild') + turns('g', 3, 'claude-sonnet-5-5', BIG));
    writeFileSync(join(sub, 'agent-cut-z-kid.meta.json'), '{"agentType":');
    writeFileSync(join(sub, 'agent-cut-z-kid.jsonl'), user('kid') + turns('k', 2, 'claude-sonnet-5-5', BIG));
    allowanceWatch(pre(lead, 'cut-A'), { noticePct: 80 });
    writeFileSync(join(sub, 'agent-cut-z-kid.meta.json'), JSON.stringify({ agentType: 'x', parentAgentId: 'cut-A' }));
    allowanceWatch(pre(lead, 'cut-A'), { noticePct: 80 });
    const m = JSON.parse(readFileSync(join(stateDir(), 'allowance', 'cut-A.meter.json'), 'utf8'));
    assert.deepEqual(Object.keys(m.kids).sort(), ['cut-a-grand', 'cut-z-kid']);
    const metered = [m.own, ...Object.values(m.kids)].reduce((a, k) => a + k.units + (k.open ? requestUnits(k.open.usage, k.open.model) : 0), 0);
    near(metered, agentSpend('cut-A', join(fx.dir, '.claude')).totalUnits, 1e-9);
  } finally { fx.cleanup(); }
});

test('token formatting: a rounding boundary moves up a unit instead of printing 1000 thousand', () => {
  assert.equal(fmtTokens(999_700), '1 million');
  assert.equal(fmtTokens(999_700_000), '1 billion');
  assert.equal(fmtTokens(994_000), '990 thousand');
});
