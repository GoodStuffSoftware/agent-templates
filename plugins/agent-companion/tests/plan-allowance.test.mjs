// Percent allowance (0.31.47): a brief line `BUDGET: N%` gives a helper N% of the weekly plan limit.
// Library: hooks/lib/plan-allowance.mjs and the splitBudget / briefAllowancePct helpers in
// hooks/lib/brief-directives.mjs; data: config/plan-weights.json; delivery: hooks/subagent-context.mjs;
// the self-check: scripts/allowance.mjs. No soft budget: nothing here warns, stops or denies.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { stateDir } from '../hooks/lib/context.mjs';
import { briefAllowancePct, splitBudget } from '../hooks/lib/brief-directives.mjs';
import { briefStepInfo, capsFor } from '../hooks/lib/step-budget.mjs';
import {
  allowanceNoteText, perCallPct, requestUnits, rungOf, unitsPerPercent, planWeights, modelWeight, NOTE_MAX_CHARS,
  _resetPlanWeightsForTests,
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
  // 3% at sonnet/high buys about 2,600 calls
  const note = allowanceNoteText({ pct: 3, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' });
  assert.match(note, /about 2,600 calls at sonnet\/high/);
  assert.match(note, /3% of the weekly plan limit \(85\.8 units\)/);
  // opus/xhigh: 3% / 0.0020976 = 1430 -> about 1,400
  assert.match(allowanceNoteText({ pct: 3, alias: 'opus', effort: 'xhigh', root: 'R', agentId: 'a1' }), /about 1,400 calls at opus\/xhigh/);
  // decimals
  assert.match(allowanceNoteText({ pct: 0.5, alias: 'sonnet', effort: 'high', root: 'R', agentId: 'a1' }), /0\.5% of the weekly plan limit \(14\.3 units\), about 430 calls/);
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
    assert.match(t, /nothing will warn or stop you/);
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
    assert.match(t, /^Allowance: 3% of the weekly plan limit \(85\.8 units\), about 2,600 calls at sonnet\/high\. Plan your work to fit; nothing will warn or stop you\. Your spend so far: node ".*\/scripts\/allowance\.mjs" allow-1$/);
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

test('hook: the percent form never denies or warns, however many calls, even with the step deny on', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'allow-big', text: user('TYPE: integration\nBUDGET: 90%\nbuild it') + turn('r1', 'claude-sonnet-5-5') }]);
    run(lead, 'allow-big'); // the note
    // A step budget read from "90" would warn at 72 and deny past 90; none exists. The default writer lines (80/120)
    // are far off at call 50, so with the step deny on nothing happens.
    mkdirSync(join(stateDir(), 'step-budget'), { recursive: true });
    writeFileSync(join(stateDir(), 'step-budget', 'allow-big.cnt'), '.'.repeat(49));
    const r = run(lead, 'allow-big', { CLAUDE_PLUGIN_OPTION_STEP_BUDGET_DENY: 'true' });
    assert.equal(r.stdout.trim(), '');
    assert.equal(denied(r), false);
    // default (soft) options at 500 calls: no deny either, and no allowance warning text
    writeFileSync(join(stateDir(), 'step-budget', 'allow-big.cnt'), '.'.repeat(499));
    const r2 = run(lead, 'allow-big');
    assert.equal(denied(r2), false);
    assert.doesNotMatch(ctxText(r2), /Allowance|allowance/);
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

test('self-check: uses the allowance the hook recorded, and finds the transcript from it', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx, [{ id: 'agent-R', text: user('TYPE: integration\nBUDGET: 2%\nwork') + turn('r1', 'claude-sonnet-5-5', ONE) }]);
    run(lead, 'agent-R'); // writes the record
    const r = check(fx, 'agent-R');
    assert.match(r.stdout, /of your 2% allowance/);
  } finally { fx.cleanup(); }
});
