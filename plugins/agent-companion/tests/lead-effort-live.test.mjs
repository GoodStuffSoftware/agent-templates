// Lead effort, rollout-aware (0.31.13):
//   1. the built-in lead-effort-check wording: xhigh before the rollout id is
//      reached, high from it; nothing asked at or above the target;
//   2. the live-effort check at a main session's first Agent spawn: a note to
//      the lead when below, an operator-only message when above, nothing when
//      equal; once per session; telemetry lead_effort_live / lead_effort_target;
//   3. the spawn guard's allow / deny / rewrite decisions do not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import {
  LEAD_EFFORT_CHECK_TEXT, LEAD_EFFORT_CHECK_TEXT_HIGH, leadEffortRolloutId,
  defaultRules, effectiveRule, leadEffortCheckText, readRules, writeRules,
} from '../hooks/lib/rules.mjs';
import { leadEffortTargetNow, leadEffortVerdict } from '../hooks/lib/lead-effort-live.mjs';

// The rollout id is a plugin option (lead_effort_rollout_id); these tests use
// a generic id, set for the whole file through the option's environment form.
const ROLLOUT_ID = 'test-lead-rollout';
const OPT_ENV = 'CLAUDE_PLUGIN_OPTION_LEAD_EFFORT_ROLLOUT_ID';
process.env[OPT_ENV] = ROLLOUT_ID;
const SWITCH = '2030-01-10T12:00:00Z';
const BEFORE = '2030-01-09T12:00:00Z';
const AFTER = '2030-01-11T12:00:00Z';

function setup({ rule = true, rollout = true } = {}) {
  const fx = makeFixture();
  mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
  if (rule) {
    writeFileSync(join(fx.stateDir, 'config', 'standing-rules.json'), JSON.stringify([{ id: 'lead-effort-check', enabled: true }]));
  }
  if (rollout) writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ [ROLLOUT_ID]: SWITCH }));
  return fx;
}

function spawn(fx, { sid = 's1', effort, sub = false, now, env = {}, tool = {} } = {}) {
  const payload = {
    session_id: sid, cwd: fx.dir, tool_name: 'Agent',
    ...(effort ? { effort: { level: effort } } : {}),
    ...(sub ? { agent_id: 'agent-x', agent_type: 'general-purpose' } : {}),
    tool_input: {
      subagent_type: 'general-purpose', run_in_background: true, name: 'w', description: 'd',
      prompt: 'TYPE: explore\nROLE: lookup\nlook around', ...tool,
    },
  };
  const res = runHook('hooks/spawn-guard.mjs', payload, { env: { ...(now ? { AGENT_COMPANION_FAKE_NOW: now } : {}), ...env } });
  assert.equal(res.status, 0, res.stderr);
  const rows = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sid);
  return { res, row: rows[rows.length - 1] || null };
}
const ctxOf = (res) => res.json?.hookSpecificOutput?.additionalContext || '';
const msgOf = (res) => res.json?.systemMessage || '';

// ---- 1. wording ----------------------------------------------------------

test('wording: one template, xhigh and high variants, no max raise, no lowering', () => {
  assert.equal(LEAD_EFFORT_CHECK_TEXT, leadEffortCheckText('xhigh'));
  assert.equal(LEAD_EFFORT_CHECK_TEXT_HIGH, leadEffortCheckText('high'));
  for (const [text, lv] of [[LEAD_EFFORT_CHECK_TEXT, 'xhigh'], [LEAD_EFFORT_CHECK_TEXT_HIGH, 'high']]) {
    assert.ok(text.includes(`an orchestration lead runs at ${lv}.`));
    assert.ok(text.includes(`Option 1 "Raise to ${lv} (Recommended)"`));
    assert.ok(text.includes('Option 2 "Stay at <current>": continue, and do not ask again this session.'));
    assert.ok(text.includes(`Interactive and below ${lv}: ask with the AskUserQuestion tool`));
    assert.ok(text.includes(`state the effort once only if it is below ${lv}.`));
    assert.ok(text.includes(`At ${lv} or above: say nothing and do not ask.`));
    assert.ok(text.endsWith('Never raise to max, never lower, never suggest lowering.'));
    assert.doesNotMatch(text, /Raise to max|set_session_effort/);
    assert.ok(text.length < 1200, `${text.length}`);
  }
  assert.ok(!LEAD_EFFORT_CHECK_TEXT_HIGH.includes('xhigh'), 'the high wording never names xhigh');
});

test('wording: the high text is exactly the operator-facing wording (pinned)', () => {
  assert.equal(
    LEAD_EFFORT_CHECK_TEXT_HIGH,
    'Orchestrating agents (workers, reviewers, several open threads, releases)? Before the first spawn and again after any resume or compaction, call get_session with session_id "self" and read its effort field (get_session can show the effort the session started with: if the operator says it has already been raised, continue); an orchestration lead runs at high. ' +
    'Unattended (scheduledTaskId in get_session, a headless or -p run, or no AskUserQuestion tool): do not ask; state the effort once only if it is below high. ' +
    'Interactive and below high: ask with the AskUserQuestion tool (the options selector), not in prose; no spawn and no other tool call until it is answered. Header "Lead effort"; name the current effort and why this looks like orchestration. ' +
    'Option 1 "Raise to high (Recommended)": the operator raises it with the app\'s effort control (you cannot); wait until get_session "self" shows high or they say continue. ' +
    'Option 2 "Stay at <current>": continue, and do not ask again this session. ' +
    'At high or above: say nothing and do not ask. Never raise to max, never lower, never suggest lowering.',
  );
});

test('wording: built-in rule is xhigh before the rollout id, high from it, xhigh when the id is absent', () => {
  const fx = setup({ rule: true, rollout: true });
  try {
    const rule = () => readRules().rules.find((r) => r.id === 'lead-effort-check');
    assert.equal(rule().activeFrom, ROLLOUT_ID);
    process.env.AGENT_COMPANION_FAKE_NOW = BEFORE;
    assert.equal(effectiveRule(rule()).then, LEAD_EFFORT_CHECK_TEXT);
    process.env.AGENT_COMPANION_FAKE_NOW = AFTER;
    assert.equal(effectiveRule(rule()).then, LEAD_EFFORT_CHECK_TEXT_HIGH);
    assert.equal(effectiveRule(rule()).enabled, true);
    // no rollout file: the id cannot resolve, the xhigh wording stays
    writeFileSync(join(fx.stateDir, 'rollout.json'), '{}');
    assert.equal(effectiveRule(rule()).then, LEAD_EFFORT_CHECK_TEXT);
  } finally {
    delete process.env.AGENT_COMPANION_FAKE_NOW;
    fx.cleanup();
  }
});

test('wording: shipped disabled, and an untouched built-in is not restated by writeRules', () => {
  const fx = makeFixture();
  try {
    assert.equal(defaultRules().find((r) => r.id === 'lead-effort-check').enabled, false);
    assert.equal(writeRules(readRules()), true);
    const written = JSON.parse(readFileSync(join(fx.stateDir, 'config', 'standing-rules.json'), 'utf8'));
    assert.deepEqual(written.rules, [], 'no diff for any untouched built-in');
  } finally {
    fx.cleanup();
  }
});

test('wording: an operator row with its own activeFrom/after still wins', () => {
  const fx = setup({ rule: false });
  try {
    mkdirSync(join(fx.stateDir, 'config'), { recursive: true });
    writeFileSync(join(fx.stateDir, 'config', 'standing-rules.json'), JSON.stringify([
      { id: 'lead-effort-check', enabled: true, activeFrom: ROLLOUT_ID, after: { then: 'custom high' } },
    ]));
    process.env.AGENT_COMPANION_FAKE_NOW = AFTER;
    const r = effectiveRule(readRules().rules.find((x) => x.id === 'lead-effort-check'));
    assert.equal(r.then, 'custom high');
    process.env.AGENT_COMPANION_FAKE_NOW = BEFORE;
    assert.equal(effectiveRule(readRules().rules.find((x) => x.id === 'lead-effort-check')).then, LEAD_EFFORT_CHECK_TEXT);
  } finally {
    delete process.env.AGENT_COMPANION_FAKE_NOW;
    fx.cleanup();
  }
});

test('option lead_effort_rollout_id: empty means no switch (xhigh stays, even after the id would be reached)', () => {
  const fx = setup();
  const saved = process.env[OPT_ENV];
  try {
    delete process.env[OPT_ENV];
    assert.equal(leadEffortRolloutId(), '');
    const rule = readRules().rules.find((r) => r.id === 'lead-effort-check');
    assert.equal(rule.activeFrom, null);
    assert.equal(rule.after, null);
    process.env.AGENT_COMPANION_FAKE_NOW = AFTER;
    assert.equal(effectiveRule(rule).then, LEAD_EFFORT_CHECK_TEXT);
    assert.deepEqual(leadEffortTargetNow(AFTER), { target: 'xhigh', since: null });
    const { row } = spawn(fx, { effort: 'high', now: AFTER, env: { [OPT_ENV]: '' } });
    assert.equal(row.lead_effort_target, 'xhigh');
  } finally {
    delete process.env.AGENT_COMPANION_FAKE_NOW;
    process.env[OPT_ENV] = saved;
    fx.cleanup();
  }
});

test('option lead_effort_rollout_id: a value names the rollout whose switch-on moves the target to high', () => {
  const fx = setup();
  try {
    assert.equal(leadEffortRolloutId(), ROLLOUT_ID);
    assert.deepEqual(leadEffortTargetNow(BEFORE), { target: 'xhigh', since: null });
    assert.deepEqual(leadEffortTargetNow(AFTER), { target: 'high', since: '2030-01-10T12:00Z' });
    // another id's switch does not move it
    writeFileSync(join(fx.stateDir, 'rollout.json'), JSON.stringify({ 'some-other-id': SWITCH }));
    assert.deepEqual(leadEffortTargetNow(AFTER), { target: 'xhigh', since: null });
  } finally {
    fx.cleanup();
  }
});

// ---- 2. the live check ---------------------------------------------------

test('target and verdict: xhigh before the switch, high from it; below / above / equal', () => {
  const fx = setup();
  try {
    assert.deepEqual(leadEffortTargetNow(BEFORE), { target: 'xhigh', since: null });
    assert.deepEqual(leadEffortTargetNow(AFTER), { target: 'high', since: '2030-01-10T12:00Z' });
    const before = leadEffortTargetNow(BEFORE);
    const after = leadEffortTargetNow(AFTER);
    assert.equal(leadEffortVerdict('high', before).kind, 'below');
    assert.equal(leadEffortVerdict('xhigh', before), null);
    assert.equal(leadEffortVerdict('max', before).kind, 'above');
    assert.equal(leadEffortVerdict('medium', after).kind, 'below');
    assert.equal(leadEffortVerdict('high', after), null);
    assert.equal(leadEffortVerdict('xhigh', after).kind, 'above');
    assert.equal(leadEffortVerdict(null, after), null);
    assert.equal(leadEffortVerdict('turbo', after), null);
  } finally {
    fx.cleanup();
  }
});

test('live below target: one non-blocking note to the lead naming live and target', () => {
  const fx = setup();
  try {
    const { res, row } = spawn(fx, { effort: 'high', now: BEFORE });
    assert.equal(res.json.hookSpecificOutput.permissionDecision, undefined, 'never a decision');
    assert.match(ctxOf(res), /live effort is high/);
    assert.match(ctxOf(res), /lead target is xhigh/);
    assert.match(ctxOf(res), /Not blocking/);
    assert.doesNotMatch(msgOf(res), /lead target/);
    assert.equal(row.lead_effort_live, 'high');
    assert.equal(row.lead_effort_target, 'xhigh');
    // after the switch the same session value is at target: silent
    const fx2 = setup();
    try {
      const r2 = spawn(fx2, { effort: 'high', now: AFTER });
      assert.doesNotMatch(ctxOf(r2.res), /lead target/);
      assert.equal(r2.row.lead_effort_target, 'high');
    } finally { fx2.cleanup(); }
    const fx3 = setup();
    try {
      const r3 = spawn(fx3, { effort: 'medium', now: AFTER });
      assert.match(ctxOf(r3.res), /live effort is medium/);
      assert.match(ctxOf(r3.res), /lead target is high/);
    } finally { fx3.cleanup(); }
  } finally {
    fx.cleanup();
  }
});

test('live above target: an operator message, nothing asked of the lead', () => {
  const fx = setup();
  try {
    const { res, row } = spawn(fx, { effort: 'xhigh', now: AFTER });
    assert.match(msgOf(res), /this session runs at xhigh; the lead target is high since 2030-01-10T12:00Z/);
    assert.doesNotMatch(ctxOf(res), /lead target|live effort/);
    assert.doesNotMatch(msgOf(res), /AskUserQuestion|raise|lower|please/i);
    assert.equal(row.lead_effort_live, 'xhigh');
    assert.equal(row.lead_effort_target, 'high');
  } finally {
    fx.cleanup();
  }
  const fx2 = setup();
  try {
    const { res } = spawn(fx2, { effort: 'max', now: BEFORE });
    assert.match(msgOf(res), /this session runs at max; the lead target is xhigh\./);
    assert.doesNotMatch(msgOf(res), /since/);
  } finally {
    fx2.cleanup();
  }
});

test('live equal to target: nothing is said, the row still records both fields', () => {
  for (const [effort, now, target] of [['xhigh', BEFORE, 'xhigh'], ['high', AFTER, 'high']]) {
    const fx = setup();
    try {
      const { res, row } = spawn(fx, { effort, now });
      assert.doesNotMatch(ctxOf(res), /lead target/);
      assert.doesNotMatch(msgOf(res), /lead target/);
      assert.equal(row.lead_effort_live, effort);
      assert.equal(row.lead_effort_target, target);
    } finally {
      fx.cleanup();
    }
  }
});

test('once per session; a different session is told again; a subagent spawn never is', () => {
  const fx = setup();
  try {
    const a1 = spawn(fx, { sid: 'sess-a', effort: 'medium', now: AFTER });
    assert.match(ctxOf(a1.res), /lead target is high/);
    const a2 = spawn(fx, { sid: 'sess-a', effort: 'medium', now: AFTER, tool: { name: 'w2' } });
    assert.doesNotMatch(ctxOf(a2.res), /lead target/);
    assert.equal(a2.row.lead_effort_live, 'medium', 'the row is still written on later spawns');
    const b1 = spawn(fx, { sid: 'sess-b', effort: 'medium', now: AFTER });
    assert.match(ctxOf(b1.res), /lead target is high/);
    // a subagent's spawns: no note, no message, null fields (and they do not use up the claim)
    const c0 = spawn(fx, { sid: 'sess-c', effort: 'medium', sub: true, now: AFTER });
    assert.doesNotMatch(ctxOf(c0.res), /lead target/);
    assert.equal(c0.row.lead_effort_live, null);
    assert.equal(c0.row.lead_effort_target, null);
    const c1 = spawn(fx, { sid: 'sess-c', effort: 'medium', now: AFTER, tool: { name: 'w3' } });
    assert.match(ctxOf(c1.res), /lead target is high/);
  } finally {
    fx.cleanup();
  }
});

test('a denied first spawn does not use up the note', () => {
  const fx = setup();
  try {
    // a premium model for a mechanical task: the best-fit deny
    const denied = spawn(fx, {
      sid: 'sess-d', effort: 'medium', now: AFTER,
      tool: { model: 'opus', prompt: 'TYPE: mechanical-edit\nROLE: writer\nrename a variable' },
    });
    assert.equal(denied.res.json?.hookSpecificOutput?.permissionDecision, 'deny');
    assert.doesNotMatch(ctxOf(denied.res), /lead target/);
    const next = spawn(fx, { sid: 'sess-d', effort: 'medium', now: AFTER, tool: { name: 'w9' } });
    assert.match(ctxOf(next.res), /lead target is high/);
  } finally {
    fx.cleanup();
  }
});

test('option lead_effort_live_check=false turns it off entirely (no text, null fields)', () => {
  const fx = setup();
  try {
    const { res, row } = spawn(fx, { effort: 'medium', now: AFTER, env: { CLAUDE_PLUGIN_OPTION_LEAD_EFFORT_LIVE_CHECK: 'false' } });
    assert.doesNotMatch(ctxOf(res), /lead target/);
    assert.doesNotMatch(msgOf(res), /lead target/);
    assert.equal(row.lead_effort_live, null);
    assert.equal(row.lead_effort_target, null);
  } finally {
    fx.cleanup();
  }
});

test('rule disabled (the shipped default): the check does not run', () => {
  const fx = setup({ rule: false });
  try {
    const { res, row } = spawn(fx, { effort: 'medium', now: AFTER });
    assert.doesNotMatch(ctxOf(res), /lead target/);
    assert.equal(row.lead_effort_live, null);
    assert.equal(row.lead_effort_target, null);
  } finally {
    fx.cleanup();
  }
});

test('no live effort in the payload: nothing is said', () => {
  const fx = setup();
  try {
    const { res, row } = spawn(fx, { now: AFTER });
    assert.doesNotMatch(ctxOf(res), /lead target/);
    assert.doesNotMatch(msgOf(res), /lead target/);
    assert.equal(row.lead_effort_target, 'high');
  } finally {
    fx.cleanup();
  }
});

test('plugin.json declares lead_effort_live_check, default true; TELEMETRY.md documents both fields', () => {
  const root = join(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const decl = (manifest.userConfig || manifest.options || {}).lead_effort_live_check;
  assert.ok(decl, 'option declared');
  assert.equal(decl.default, true);
  const doc = readFileSync(join(root, 'docs', 'TELEMETRY.md'), 'utf8');
  assert.match(doc, /\| `lead_effort_live` \|/);
  assert.match(doc, /\| `lead_effort_target` \|/);
});

// ---- 3. no decision changes ---------------------------------------------

const PAYLOADS = {
  plain: { prompt: 'TYPE: explore\nROLE: lookup\nlook around' },
  premiumDeny: { model: 'opus', prompt: 'TYPE: mechanical-edit\nROLE: writer\nrename a variable' },
  premiumWarranted: { model: 'opus', prompt: 'TYPE: novel-design\nROLE: writer\nWARRANT: weight 5 - design' },
  autofill: { prompt: 'TYPE: bounded-feature\nROLE: writer\nWEIGHT: 3\nadd a flag' },
};

// What the guard DECIDED for a spawn: allow / deny, its reason, and the input
// it rewrote. Notes (additionalContext, systemMessage) are deliberately left out.
function decision(res) {
  const h = res.json?.hookSpecificOutput || {};
  return {
    decision: h.permissionDecision ?? (res.json ? 'proceed' : 'silent'),
    reason: h.permissionDecisionReason ?? null,
    rewrite: h.updatedInput ?? null,
  };
}

test('matrix: with the live check on or off, no allow / deny / rewrite changes (main and subagent, below / at / above, before / after the switch)', () => {
  const cells = [];
  let denies = 0;
  let rewrites = 0;
  let noted = 0;
  for (const sub of [false, true]) {
    for (const effort of ['medium', 'high', 'xhigh', 'max']) {
      for (const now of [BEFORE, AFTER]) {
        for (const [name, tool] of Object.entries(PAYLOADS)) {
          const run = (off) => {
            const fx = setup();
            try {
              const out = spawn(fx, {
                sid: `m-${name}`, effort, sub, now, tool,
                env: off ? { CLAUDE_PLUGIN_OPTION_LEAD_EFFORT_LIVE_CHECK: 'false' } : {},
              });
              return { d: decision(out.res), text: ctxOf(out.res) + msgOf(out.res) };
            } finally {
              fx.cleanup();
            }
          };
          const on = run(false);
          const off = run(true);
          assert.deepEqual(on.d, off.d, `${sub ? 'sub' : 'main'} ${effort} ${now} ${name}`);
          if (on.d.decision === 'deny') denies += 1;
          if (on.d.rewrite) rewrites += 1;
          if (/lead target/.test(on.text)) noted += 1;
          cells.push(`${sub}/${effort}/${now}/${name}`);
        }
      }
    }
  }
  assert.equal(cells.length, 2 * 4 * 2 * 4);
  // the matrix must be meaningful: it holds denies, rewrites and notes
  assert.ok(denies > 0, 'matrix includes denies');
  assert.ok(rewrites > 0, 'matrix includes rewrites');
  assert.ok(noted > 0, 'matrix includes live-effort text');
});
