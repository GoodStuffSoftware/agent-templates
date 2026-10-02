// Session budget advisory: hooks/lib/session-budget.mjs adds up the plan units
// of a WHOLE session (the lead plus every subagent) and hooks/runaway-notice.mjs
// delivers one notice per crossed multiple of session_budget_units, on the
// runaway-notice path (UserPromptSubmit, PostToolUse ^Agent$). Advice only.
//
// Unit arithmetic used below: a plan unit is a token count priced at Sonnet 5
// rates times the model's tier multiplier (Opus 1.5). Sonnet 5 output is
// $10/MTok, so 1M sonnet output tokens = 10 units and 1M opus output tokens = 15.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl, PLUGIN_ROOT } from './helpers.mjs';
import { telemetryDir, stateDir } from '../hooks/lib/context.mjs';
import {
  planUnitsOf, checkSessionBudget, scanSession, budgetNoticeText, weeklyPlanUnits, SESSION_BUDGET_DEFAULT_UNITS,
} from '../hooks/lib/session-budget.mjs';
import { usageOf } from '../hooks/lib/runaway.mjs';
import { planPriceSpecFor } from '../scripts/lib/pricing.mjs';

const SID = 'sess-budget';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';

// One assistant request, written the streaming way: two lines sharing a requestId.
function req(id, model, output, extra = {}) {
  const base = { type: 'assistant', requestId: id, message: { id: `msg_${id}`, model, usage: { input_tokens: 0, output_tokens: 1, ...extra } } };
  return [base, { ...base, message: { ...base.message, usage: { ...base.message.usage, output_tokens: output } } }]
    .map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function layout(fx) {
  const proj = join(fx.dir, 'projects', 'proj-b');
  const sub = join(proj, SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  return { lead: join(proj, `${SID}.jsonl`), sub };
}

const prompt = (lead, extra = {}) => ({
  hook_event_name: 'UserPromptSubmit', session_id: SID, transcript_path: lead, prompt: 'go', ...extra,
});
const notice = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('plan units use the plugin plan-usage pricing: Sonnet 5 rates x tier multiplier', () => {
  // The first row of the 2026-10-02 usage ledger: opus, 266 output, 69966 1h cache write -> 0.4238 units.
  const u = usageOf({ input_tokens: 2, output_tokens: 266, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 69966 } });
  const r = planUnitsOf(u, 'claude-opus-5');
  assert.ok(Math.abs(r.units - 0.4238) < 0.0005, `got ${r.units}`);
  assert.equal(r.estimated, false);
  const s = planUnitsOf(u, SONNET);
  assert.ok(Math.abs(r.units / s.units - planPriceSpecFor('claude-opus-5').multiplier) < 1e-9, 'opus = sonnet x the table multiplier');
  assert.ok(Math.abs(planUnitsOf({ output: 1e6 }, SONNET).units - 10) < 1e-9);
  assert.ok(Math.abs(planUnitsOf({ output: 1e6 }, OPUS).units - 15) < 1e-9);
});

test('a tier with no plan multiplier is counted at its own API price and flagged estimated; an unpriced model is null', () => {
  const haiku = planUnitsOf({ output: 1e6 }, 'claude-haiku-4-5');
  assert.equal(haiku.estimated, true);
  assert.ok(Math.abs(haiku.units - 5) < 1e-9, 'haiku output is $5/MTok');
  assert.equal(planUnitsOf({ output: 1e6 }, 'claude-mystery-1'), null);
});

test('the notice text carries the units, the share of the week and the hand-off advice', () => {
  const t = budgetNoticeText(700);
  assert.match(t, /This session, including its subagents, has used about 700 plan units \(~37% of a ~1,900-unit week\)\./);
  assert.ok(t.includes('At the next phase boundary, finish the phase, update SESSION-STATE.md, and offer the operator a hand-off to a fresh session.'));
  assert.match(t, /Do not hand off mid-release or while agents are running\./);
  assert.equal(weeklyPlanUnits(), 1900);
  assert.equal(SESSION_BUDGET_DEFAULT_UNITS, 350);
});

test('lead plus subagents are summed; one notice per crossed multiple, delivered once on UserPromptSubmit', () => {
  const fx = makeFixture();
  try {
    const { lead, sub } = layout(fx);
    const env = { CLAUDE_PLUGIN_OPTION_SESSION_BUDGET_UNITS: '10' };
    writeFileSync(lead, req('l1', OPUS, 400000)); // 6 units: under the threshold
    assert.equal(notice(runHook('hooks/runaway-notice.mjs', prompt(lead), { env })), '', 'under: nothing');

    appendFileSync(lead, req('l2', OPUS, 400000)); // lead 12 -> level 10
    const first = runHook('hooks/runaway-notice.mjs', prompt(lead), { env });
    assert.match(notice(first), /about 12 plan units/);
    assert.equal(first.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.equal(notice(runHook('hooks/runaway-notice.mjs', prompt(lead), { env })), '', 'same level: not again');

    // A subagent's usage counts toward the SAME session total: 12 + 8 = 20 -> level 20.
    writeFileSync(join(sub, 'agent-a1.jsonl'), req('s1', SONNET, 800000));
    assert.match(notice(runHook('hooks/runaway-notice.mjs', prompt(lead), { env })), /about 20 plan units/);
    assert.equal(notice(runHook('hooks/runaway-notice.mjs', prompt(lead), { env })), '');

    // Skipping several multiples at once is still ONE notice.
    appendFileSync(join(sub, 'agent-a1.jsonl'), req('s2', SONNET, 3000000)); // +30 -> 50
    const jump = notice(runHook('hooks/runaway-notice.mjs', prompt(lead), { env }));
    assert.match(jump, /about 50 plan units/);
    assert.equal((jump.match(/This session, including its subagents/g) || []).length, 1);

    const rows = readJsonl(join(telemetryDir(), 'session-budget.jsonl'));
    assert.deepEqual(rows.map((r) => r.level), [10, 20, 50]);
    assert.equal(rows[2].threshold, 10);
    assert.equal(rows[2].transcripts, 2);
    assert.equal(rows[2].scan_complete, true);
  } finally { fx.cleanup(); }
});

test('delivered after a foreground Agent returns (PostToolUse ^Agent$), lead only', () => {
  const fx = makeFixture();
  try {
    const { lead, sub } = layout(fx);
    const env = { CLAUDE_PLUGIN_OPTION_SESSION_BUDGET_UNITS: '10' };
    writeFileSync(lead, req('l1', OPUS, 100000));
    writeFileSync(join(sub, 'agent-a1.jsonl'), req('s1', OPUS, 900000)); // 1.5 + 13.5 = 15
    const post = { ...prompt(lead), hook_event_name: 'PostToolUse', tool_name: 'Agent' };
    const fromSub = runHook('hooks/runaway-notice.mjs', { ...post, agent_id: 'a1', agent_type: 'general-purpose' }, { env });
    assert.equal(fromSub.stdout.trim(), '', 'a payload from inside a subagent never scans or drains');
    assert.equal(existsSync(join(stateDir(), 'session-budget')), false);
    const lead1 = runHook('hooks/runaway-notice.mjs', post, { env });
    assert.equal(lead1.json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(notice(lead1), /about 15 plan units/);
  } finally { fx.cleanup(); }
});

test('session_budget_units 0 is off: nothing scanned, logged or delivered', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    writeFileSync(lead, req('l1', OPUS, 5000000)); // 75 units
    const r = runHook('hooks/runaway-notice.mjs', prompt(lead), { env: { CLAUDE_PLUGIN_OPTION_SESSION_BUDGET_UNITS: '0' } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
    assert.equal(existsSync(join(telemetryDir(), 'session-budget.jsonl')), false);
    assert.equal(existsSync(join(stateDir(), 'session-budget')), false);
    // The default (350) is on: 75 units is under it, so also silent, but it does scan.
    assert.equal(runHook('hooks/runaway-notice.mjs', prompt(lead)).stdout.trim(), '');
    assert.equal(existsSync(join(stateDir(), 'session-budget')), true);
  } finally { fx.cleanup(); }
});

test('advice only: the hook output has no decision, no permission decision, exit 0', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    writeFileSync(lead, req('l1', OPUS, 2000000));
    const r = runHook('hooks/runaway-notice.mjs', prompt(lead), { env: { CLAUDE_PLUGIN_OPTION_SESSION_BUDGET_UNITS: '5' } });
    assert.equal(r.status, 0);
    assert.deepEqual(Object.keys(r.json), ['hookSpecificOutput']);
    assert.deepEqual(Object.keys(r.json.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  } finally { fx.cleanup(); }
});

test('incremental: only appended bytes are read; a request spanning two reads is counted once at its max', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    const seen = [];
    const opts = { threshold: 1000, notify: (s, t) => seen.push(t) };
    const first = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: SONNET, usage: { output_tokens: 1 } } });
    writeFileSync(lead, `${first}\n`);
    const a = checkSessionBudget({ session_id: SID, transcript_path: lead }, opts);
    // The same request continues in the next read with more output: max, not sum.
    const second = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { id: 'm1', model: SONNET, usage: { output_tokens: 1000000 } } });
    appendFileSync(lead, `${second}\n`);
    const b = checkSessionBudget({ session_id: SID, transcript_path: lead }, opts);
    assert.ok(a.total < 0.001);
    assert.ok(Math.abs(b.total - 10) < 1e-6, `got ${b.total}`);
    // A line still being written (no newline yet) is not consumed.
    appendFileSync(lead, JSON.stringify({ type: 'assistant', requestId: 'r2', message: { id: 'm2', model: SONNET, usage: { output_tokens: 1000000 } } }));
    assert.ok(Math.abs(checkSessionBudget({ session_id: SID, transcript_path: lead }, opts).total - 10) < 1e-6);
    appendFileSync(lead, '\n');
    assert.ok(Math.abs(checkSessionBudget({ session_id: SID, transcript_path: lead }, opts).total - 20) < 1e-6);
    // The same state was reused: unchanged file, same total.
    assert.ok(Math.abs(checkSessionBudget({ session_id: SID, transcript_path: lead }, opts).total - 20) < 1e-6);
  } finally { fx.cleanup(); }
});

test('a scan that hits its deadline saves progress and announces nothing until it is complete (no understated first notice)', () => {
  const fx = makeFixture();
  try {
    const { lead } = layout(fx);
    writeFileSync(lead, req('l1', SONNET, 1000000));
    const seen = [];
    const opts = { threshold: 5, notify: (s, t) => seen.push(t) };
    const cut = checkSessionBudget({ session_id: SID, transcript_path: lead }, { ...opts, deadlineMs: -1 });
    assert.equal(cut.complete, false);
    assert.equal(cut.total, 0);
    assert.equal(cut.fired, false);
    const done = checkSessionBudget({ session_id: SID, transcript_path: lead }, opts);
    assert.equal(done.complete, true);
    assert.ok(Math.abs(done.total - 10) < 1e-6);
    assert.equal(done.fired, true);
    assert.equal(seen.length, 1);
  } finally { fx.cleanup(); }
});

test('haiku and workflow-nested subagent transcripts count; an unpriced model counts as zero and is reported', () => {
  const fx = makeFixture();
  try {
    const { lead, sub } = layout(fx);
    mkdirSync(join(sub, 'workflows', 'wf_1'), { recursive: true });
    writeFileSync(lead, req('l1', 'claude-mystery-1', 9000000));
    writeFileSync(join(sub, 'workflows', 'wf_1', 'agent-w1.jsonl'), req('w1', 'claude-haiku-4-5', 2000000)); // 10 units at API price
    const state = { files: {}, level: 0 };
    const r = scanSession({ sessionId: SID, transcriptPath: lead, deadline: Date.now() + 5000, state });
    assert.ok(Math.abs(r.total - 10) < 1e-6, `got ${r.total}`);
    assert.equal(r.estTurns, 1);
    assert.equal(r.unpriced, 1);
    assert.equal(r.files, 2);
  } finally { fx.cleanup(); }
});

test('no transcript_path or session_id: nothing happens, never throws', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(checkSessionBudget({ session_id: SID }, { threshold: 1 }), { skipped: 'no-transcript' });
    assert.deepEqual(checkSessionBudget(undefined, { threshold: 1 }), { skipped: 'no-transcript' });
    assert.deepEqual(checkSessionBudget({ session_id: SID, transcript_path: 'x' }, { threshold: 0 }), { skipped: 'off' });
    const r = checkSessionBudget({ session_id: SID, transcript_path: join(fx.dir, 'missing.jsonl') }, { threshold: 1 });
    assert.equal(r.fired, false);
  } finally { fx.cleanup(); }
});

test('the plugin declares session_budget_units (default 350) and the hook timeout covers a scan', () => {
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(cfg.userConfig.session_budget_units.default, 350);
  assert.equal(cfg.userConfig.session_budget_units.type, 'number');
  const h = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of ['UserPromptSubmit', 'PostToolUse']) {
    const hook = h[ev].flatMap((g) => g.hooks).find((x) => x.args.some((a) => a.endsWith('runaway-notice.mjs')));
    assert.ok(hook.timeout >= 10, `${ev} runaway-notice timeout ${hook.timeout}`);
  }
});
