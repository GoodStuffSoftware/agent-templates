// 0.31.36: spawn fixes that go out with no message. The spawn guard sets run_in_background, inserts a ROLE
// line and rewrites an over-provisioned ladder rung through updatedInput, and says nothing about it; the
// spawn row (silent_fixes, fit_before_fix, gate1_action) is where the fix is visible. Fixture state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { inferRole, BRIEF_ROLES } from '../hooks/lib/brief-directives.mjs';

function seedStart(stateDir, sessionId, agentType) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'subagent-starts.jsonl'),
    `${JSON.stringify({ v: 2, at: new Date().toISOString(), session_id: sessionId, agent_type: agentType })}\n`, { flag: 'a' });
}

// One main-session spawn through the guard. `started` seeds ladder rungs the session has "started", which is
// what lets the guard rewrite to them (the harness has shown them registered).
function spawn(toolInput, { started = [], extra = {}, env } = {}) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sid = 'sess-silent';
    for (const a of started) seedStart(stateDir, sid, a);
    const res = runHook('hooks/spawn-guard.mjs', { session_id: sid, agent_type: 'main', cwd: dir, tool_input: toolInput, ...extra }, { env });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const out = res.json?.hookSpecificOutput || {};
    return { res, out, ui: out.updatedInput || null, msg: res.json?.systemMessage || '', ctx: out.additionalContext || '', row: rows[rows.length - 1] || null };
  } finally {
    cleanup();
  }
}

const RUNGS = ['agent-companion:ac-sonnet-low', 'agent-companion:ac-sonnet-high'];
const GP = { subagent_type: 'general-purpose', model: 'sonnet' };

test('inferRole: every TYPE class maps to a valid ROLE; unknown and absent are other', () => {
  for (const t of ['lookup', 'research', 'survey', 'explore', 'verify']) assert.equal(inferRole(t), 'lookup', t);
  assert.equal(inferRole('code-review'), 'reviewer');
  for (const t of ['bounded-feature', 'bounded-feature-small', 'mechanical-edit', 'integration', 'debug-root-cause',
    'large-refactor', 'novel-design', 'critical-change', 'long-autonomous-run', 'subagent-worker']) assert.equal(inferRole(t), 'writer', t);
  assert.equal(inferRole('banana'), 'other');
  assert.equal(inferRole(null), 'other');
  assert.equal(inferRole('LOOKUP'), 'lookup');
  for (const t of ['lookup', 'code-review', 'integration', 'banana', null]) assert.ok(BRIEF_ROLES.includes(inferRole(t)), `${t} gives a role the guard reads back`);
});

test('foreground autofix: a main-session spawn that left the flag out gets run_in_background true, with no message', () => {
  const r = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' });
  assert.equal(r.ui?.run_in_background, true);
  assert.doesNotMatch(r.msg, /FOREGROUND|run_in_background/i);
  assert.doesNotMatch(r.ctx, /FOREGROUND|run_in_background/i);
  assert.equal(r.row.gate1_action, 'fix');
  assert.equal(r.row.gate1_mode, 'fix');
  assert.ok(r.row.silent_fixes.includes('background_set'));
});

test('foreground autofix: a FOREGROUND: line is the opt-out, an explicit false is the lead\'s own choice (logged only)', () => {
  const j = spawn({ ...GP, name: 'w', prompt: 'FOREGROUND: the lead needs it now\nTYPE: bounded-feature\ndo it' });
  assert.notEqual(j.ui?.run_in_background, true);
  assert.equal(j.row.gate1_action, 'none');
  assert.ok(!(j.row.silent_fixes || []).includes('background_set'));
  const f = spawn({ ...GP, name: 'w', run_in_background: false, prompt: 'TYPE: bounded-feature\ndo it' });
  assert.notEqual(f.ui?.run_in_background, true, 'explicit false is left alone');
  assert.equal(f.row.gate1_action, 'none');
  assert.ok(f.row.silent_fixes.includes('foreground_logged'));
  assert.doesNotMatch(f.msg, /FOREGROUND/);
});

test('foreground autofix: a subagent caller, a teammate spawn and a haiku-tier spawn are untouched', () => {
  const sub = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { extra: { agent_type: 'subagent', agent_id: 'agent-caller-1' } });
  assert.notEqual(sub.ui?.run_in_background, true, 'a subagent\'s own spawn is not the lead\'s foreground');
  assert.equal(sub.row.gate1_action, 'none');
  const team = spawn({ ...GP, name: 'w', team_name: 't', prompt: 'TYPE: bounded-feature\ndo it' });
  assert.notEqual(team.ui?.run_in_background, true);
  const cheap = spawn({ subagent_type: 'general-purpose', model: 'haiku', name: 'w', prompt: 'TYPE: lookup\nlook' });
  assert.notEqual(cheap.ui?.run_in_background, true, 'the cheapest tier stays exempt');
  assert.equal(cheap.row.gate1_exempt, true);
});

test('foreground autofix: foreground_guard off and block keep their old meaning; warn reads as fix', () => {
  const off = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { env: { CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'off' } });
  assert.notEqual(off.ui?.run_in_background, true);
  assert.equal(off.row.gate1_action, 'none');
  const block = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { env: { CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' } });
  assert.equal(block.out.permissionDecision, 'deny');
  const warn = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { env: { CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'warn' } });
  assert.equal(warn.ui?.run_in_background, true);
  assert.equal(warn.row.gate1_mode, 'fix');
});

test('ROLE insert: each TYPE class gets its inferred ROLE line first, silently; an existing ROLE is untouched', () => {
  const cases = [
    ['TYPE: lookup', 'lookup'], ['TYPE: research', 'lookup'], ['TYPE: verify', 'lookup'],
    ['TYPE: bounded-feature', 'writer'], ['TYPE: mechanical-edit', 'writer'], ['TYPE: debug-root-cause', 'writer'],
    ['TYPE: code-review\nWRITER: sonnet/high', 'reviewer'],
  ];
  for (const [head, role] of cases) {
    const r = spawn({ ...GP, name: 'w', run_in_background: true, prompt: `${head}\nwork` });
    assert.ok((r.ui?.prompt || '').startsWith(`ROLE: ${role}\n${head}`), `${head}: ${(r.ui?.prompt || '').slice(0, 50)}`);
    assert.ok(r.row.silent_fixes.includes(`role_inserted:${role}`), head);
    assert.doesNotMatch(`${r.msg}${r.ctx}`, /ROLE/, `${head}: no message about it`);
  }
  const none = spawn({ ...GP, name: 'w', run_in_background: true, prompt: 'just do the thing' });
  assert.ok((none.ui?.prompt || '').startsWith('ROLE: other\n'));
  const own = spawn({ ...GP, name: 'w', run_in_background: true, prompt: 'ROLE: fixer\nTYPE: bounded-feature\nwork' });
  assert.equal((own.ui?.prompt || '').match(/^ROLE:/gm)?.length, 1, 'no second ROLE line');
  assert.ok((own.ui?.prompt || '').startsWith('ROLE: fixer\n'));
  assert.equal(own.row.declared_role, 'fixer');
  assert.ok(!(own.row.silent_fixes || []).some((s) => s.startsWith('role_inserted')));
});

test('over-provisioned rung: rewritten to the routed rung with no message, the model moved too; the row keeps the before-state', () => {
  const r = spawn({ subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', name: 'w', run_in_background: true, prompt: 'TYPE: mechanical-edit\nrename x' }, { started: RUNGS });
  assert.equal(r.ui?.subagent_type, 'agent-companion:ac-sonnet-low');
  assert.equal(r.ui?.model, 'sonnet');
  assert.doesNotMatch(r.msg, /over-provisioned|re-spawn/i);
  assert.doesNotMatch(r.ctx, /over-provisioned|re-spawn/i);
  assert.equal(r.row.fit, 'fit');
  assert.equal(r.row.fit_before_fix, 'over');
  assert.equal(r.row.subagent_type_rewritten_to, 'agent-companion:ac-sonnet-low');
  assert.ok(r.row.silent_fixes.includes('fit_over_rewrite:agent-companion:ac-sonnet-high->agent-companion:ac-sonnet-low'));
});

test('over-provisioned rung: the rewrite lands BEFORE the self-review block and the row, so both see the rung that runs', () => {
  // ac-opus-max does not carry the self-review protocol and a bounded-feature spawn on it is over-provisioned:
  // it runs as ac-sonnet-high (model sonnet), whose definition carries the protocol. A late rewrite would append
  // a block telling the writer to review on ac-opus-max and log model opus.
  const r = spawn({ subagent_type: 'agent-companion:ac-opus-max', name: 'w', run_in_background: true, prompt: 'TYPE: bounded-feature\nbuild x' }, { started: RUNGS });
  assert.equal(r.ui?.subagent_type, 'agent-companion:ac-sonnet-high');
  assert.equal(r.row.model, 'sonnet', 'the row logs the model that runs');
  assert.equal(r.row.fit_before_fix, 'over');
  assert.equal(r.row.self_review_expected, true);
  assert.equal(r.row.self_review_injected, false, 'the rung that runs carries the protocol: nothing appended');
  assert.doesNotMatch(r.ui?.prompt || '', /ac-opus-max|WRITER: opus/, 'no stale review rung in the brief');
  // Control: with the rewrite opted out (PREMIUM line, plus the warrant a premium spawn needs) the block that is
  // appended names the rung that was spawned.
  const kept = spawn({ subagent_type: 'agent-companion:ac-opus-max', name: 'w', run_in_background: true,
    prompt: 'TYPE: bounded-feature\nPREMIUM: needs max\nWARRANT: weight 5 - test\nbuild x' }, { started: RUNGS });
  assert.equal(kept.row.self_review_injected, true);
  assert.match(kept.ui?.prompt || '', /subagent_type: "agent-companion:ac-opus-max"/);
});

test('over-provisioned rung: a PREMIUM: line, fit_over_autofix off, an unregistered rung and an under-provisioned rung change nothing', () => {
  const brief = 'TYPE: mechanical-edit\nrename x';
  const base = { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', name: 'w', run_in_background: true };
  const prem = spawn({ ...base, prompt: `PREMIUM: the rename touches generated code\n${brief}` }, { started: RUNGS });
  assert.notEqual(prem.ui?.subagent_type, 'agent-companion:ac-sonnet-low');
  assert.equal(prem.out.permissionDecision, undefined, 'PREMIUM also skips the over-provisioned deny');
  assert.ok(!(prem.row.silent_fixes || []).some((s) => s.startsWith('fit_over_rewrite')));
  // A premium rung: a PREMIUM line alone keeps it and passes the warrant check too (review S2).
  const opus = { subagent_type: 'agent-companion:ac-opus-high', name: 'w', run_in_background: true };
  const keep = spawn({ ...opus, prompt: 'TYPE: bounded-feature\nPREMIUM: needs depth\nbuild x' }, { started: RUNGS });
  assert.equal(keep.out.permissionDecision, undefined, 'PREMIUM alone is not denied by the warrant check');
  assert.notEqual(keep.ui?.subagent_type, 'agent-companion:ac-sonnet-high');
  const down = spawn({ ...opus, prompt: 'TYPE: bounded-feature\nbuild x' }, { started: RUNGS });
  assert.equal(down.ui?.subagent_type, 'agent-companion:ac-sonnet-high', 'control: without PREMIUM the premium rung is rewritten down');
  const off = spawn({ ...base, prompt: brief }, { started: RUNGS, env: { CLAUDE_PLUGIN_OPTION_FIT_OVER_AUTOFIX: 'false' } });
  assert.notEqual(off.ui?.subagent_type, 'agent-companion:ac-sonnet-low');
  assert.equal(off.row.fit_before_fix, null);
  const unreg = spawn({ ...base, prompt: brief }, { started: [] });
  assert.notEqual(unreg.ui?.subagent_type, 'agent-companion:ac-sonnet-low', 'no started ladder: not rewritten, as before');
  const under = spawn({ subagent_type: 'agent-companion:ac-sonnet-low', name: 'w', run_in_background: true, prompt: 'TYPE: bounded-feature\nbuild x' }, { started: RUNGS });
  assert.equal(under.row.fit, 'under');
  assert.ok(under.row.silent_fixes.includes('fit_under_logged'));
  assert.doesNotMatch(`${under.msg}${under.ctx}`, /under-provisioned/i, 'the under note is gone, the row has it');
  assert.notEqual(under.ui?.subagent_type, 'agent-companion:ac-sonnet-high', 'never upgraded silently');
});

test('the fixes ride one updatedInput: background, ROLE, rewrite and name together, one row', () => {
  const r = spawn({ subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', prompt: 'TYPE: mechanical-edit\nrename x' }, { started: RUNGS });
  assert.equal(r.ui?.run_in_background, true);
  assert.equal(r.ui?.subagent_type, 'agent-companion:ac-sonnet-low');
  assert.ok(r.ui?.name, 'namegate names it, silently');
  assert.ok(r.ui.prompt.startsWith('ROLE: writer\n'));
  assert.deepEqual(r.row.silent_fixes.filter((s) => !s.startsWith('fit_over_rewrite')).sort(), ['background_set', 'role_inserted:writer']);
  assert.equal(r.row.gate1_action, 'fix');
});
