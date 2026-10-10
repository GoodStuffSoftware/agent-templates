// Project-pinned agents (0.31.13): a project or user agent whose own definition
// pins model and/or effort is the operator's tier choice. The spawn guard does
// not deny, nag or rewrite such a spawn over task weight, and still applies
// every role rule. A spawn that is not pinned decides exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFixture, runHook, readJsonl, decisionOf, PLUGIN_ROOT } from './helpers.mjs';
import { rulesPath } from '../hooks/lib/rules.mjs';
import { projectAgentRoots } from '../hooks/lib/context.mjs';

const agentFile = (fm, body = 'body') => `---\nname: x\n${fm}\n---\n${body}\n`;
const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };

// A project folder (`<home>/proj`, with a .git folder) holding pinned and
// unpinned project agents, plus a user agent under the home folder.
function setup() {
  const fx = makeFixture();
  const proj = join(fx.dir, 'proj');
  mkdirSync(join(proj, '.git'), { recursive: true });
  const pa = join(proj, '.claude', 'agents');
  put(join(pa, 'proj-architect.md'), agentFile('model: opus\neffort: xhigh'));
  put(join(pa, 'proj-builder.md'), agentFile('model: opus\neffort: medium'));
  put(join(pa, 'proj-scout.md'), agentFile('model: haiku'));
  put(join(pa, 'proj-effortonly.md'), agentFile('effort: high'));
  put(join(pa, 'proj-noeffort.md'), agentFile('model: opus'));
  put(join(pa, 'proj-fable.md'), agentFile('model: fable'));
  put(join(pa, 'proj-inherit.md'), agentFile('model: inherit'));
  put(join(pa, 'proj-inheriteff.md'), agentFile('model: inherit\neffort: high'));
  put(join(pa, 'proj-nopin.md'), agentFile('description: none'));
  put(join(pa, 'proj-marked.md'), agentFile(
    'model: opus\neffort: xhigh',
    '<!-- self-review protocol BEGIN: generated from config/model-tiers.json `selfReview` by scripts/routing-table.mjs --sync-agent-descriptions; do not edit by hand -->\nown protocol\n<!-- self-review protocol END -->',
  ));
  put(join(fx.dir, '.claude', 'agents', 'user-agent.md'), agentFile('model: opus\neffort: high'));
  return { ...fx, proj };
}

// A routing profile that sends bounded-feature to sonnet/medium and integration
// to sonnet/high, as a real profile can: a pinned opus agent then disagrees
// with the table, which is the case 0.31.12 denied.
function writeProfile(fx) {
  const row = (model, effort) => ({
    state: 'trial', model, effort, cacheTtl: null, source: 'operator-observed', since: '2026-10-01', reviewBy: '2027-01-01',
    waivesFloor: null, note: null, provenance: null,
  });
  put(join(fx.stateDir, 'config', 'routing-profile.json'), JSON.stringify({
    schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 3,
    basedOn: { tableVersion: 7, tableUpdated: '2026-09-23' }, objective: 'api-cost', planUsageMultipliers: null, types: {},
    rows: { 'bounded-feature': row('sonnet', 'medium'), integration: row('sonnet', 'high') },
  }));
}

let counter = 0;
function spawn(fx, { type, prompt, model, cwd, env, effort, extra } = {}) {
  counter += 1;
  const sid = `sess-pin-${process.pid}-${counter}`;
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd: cwd || fx.proj,
    ...(effort ? { effort: { level: effort } } : {}),
    tool_input: {
      subagent_type: type, run_in_background: true, name: `w${counter}`, prompt, ...(model ? { model } : {}), ...(extra || {}),
    },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...(env || {}) } });
  assert.equal(res.status, 0, res.stderr);
  const row = readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sid).pop();
  const hso = res.json?.hookSpecificOutput || {};
  return {
    res, row, sid,
    decision: decisionOf(res.json),
    reason: hso.permissionDecisionReason || '',
    msg: res.json?.systemMessage || '',
    ctx: hso.additionalContext || res.json?.additionalContext || '',
    updated: hso.updatedInput || null,
    all: JSON.stringify(res.json || {}),
  };
}
const W = 'ROLE: writer\n';

test('1. a pinned opus/xhigh agent on a weight-3 type is not denied, nagged or rewritten; its fit is still recorded', () => {
  const fx = setup();
  try {
    writeProfile(fx);
    const r = spawn(fx, { type: 'proj-architect', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(r.decision, 'proceed', r.reason || r.msg);
    assert.doesNotMatch(r.all, /Best fit|over-provisioned|under-provisioned|reviewer parity/);
    assert.equal(r.row.project_pinned, true);
    assert.equal(r.row.pin_scope, 'project');
    assert.equal(r.row.pin_fields, 'model+effort');
    assert.equal(r.row.pin_model_overridden, false);
    assert.equal(r.row.fit, 'over', 'the table-vs-pin comparison stays measurable');
    assert.equal(r.row.fit_expected, 'sonnet/medium');
    assert.equal(r.row.routed, true);
    assert.equal(r.row.model, 'opus');
    assert.equal(r.row.model_autofilled, false);
    assert.equal(r.row.subagent_type_rewritten_to, null);
    // Control: with project_pins off the same spawn is judged by weight (0.31.12).
    const off = spawn(fx, {
      type: 'proj-architect', prompt: `TYPE: bounded-feature\n${W}do it`, env: { CLAUDE_PLUGIN_OPTION_PROJECT_PINS: 'false' },
    });
    assert.equal(off.decision, 'deny');
    assert.match(off.reason, /Best fit/);
    assert.equal(off.row.project_pinned, false);
  } finally { fx.cleanup(); }
});

test('1b. an explicit weight that departs from the preset is not a reason to deny a pinned agent either', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-architect', prompt: `TYPE: bounded-feature\nWEIGHT: 2\n${W}do it` });
    assert.equal(r.decision, 'proceed', r.reason);
    assert.doesNotMatch(r.all, /Best fit|over-provisioned/);
    assert.equal(r.row.fit, 'over');
    const g = spawn(fx, { type: 'general-purpose', model: 'opus', prompt: `TYPE: bounded-feature\nWEIGHT: 2\n${W}do it` });
    assert.equal(g.decision, 'deny', 'the same brief on an unpinned agent is still denied');
    assert.match(g.reason, /Best fit/);
  } finally { fx.cleanup(); }
});

test('2. no WARRANT on a premium pinned spawn: no warrant deny and no soft note', () => {
  const fx = setup();
  try {
    for (const prompt of ['do it', `TYPE: frobnicate\n${W}do it`, `TYPE: bounded-feature\n${W}do it`]) {
      const r = spawn(fx, { type: 'proj-architect', prompt });
      assert.equal(r.decision, 'proceed', `${prompt}: ${r.reason}`);
      assert.doesNotMatch(r.all, /Premium warrant|WARRANT/);
    }
    // Control: an unpinned premium spawn with no TYPE and no WARRANT still gets its note.
    const g = spawn(fx, { type: 'general-purpose', model: 'opus', prompt: 'do it' });
    assert.match(g.msg, /no WARRANT line/);
  } finally { fx.cleanup(); }
});

test('3. the premium cap: pinned opus is not counted, a pinned fable still is', () => {
  const fx = setup();
  try {
    const window = () => { try { return JSON.parse(readFileSync(join(fx.stateDir, 'state', 'premium-window.json'), 'utf8')).length; } catch { return 0; } };
    const env = { CLAUDE_PLUGIN_OPTION_PREMIUM_MAX_CONCURRENT: '2' };
    for (let i = 0; i < 4; i += 1) {
      const r = spawn(fx, { type: 'proj-architect', prompt: 'do it', env });
      assert.equal(r.decision, 'proceed', `pinned opus spawn ${i + 1}: ${r.reason}`);
    }
    assert.equal(window(), 0, 'pinned opus never enters the window');
    // A fable-pinned project agent is counted, with no warrant needed (the pin is the warrant).
    assert.equal(spawn(fx, { type: 'proj-fable', prompt: 'do it', env }).decision, 'proceed');
    assert.equal(spawn(fx, { type: 'proj-fable', prompt: 'do it', env }).decision, 'proceed');
    assert.equal(window(), 2);
    const third = spawn(fx, { type: 'proj-fable', prompt: 'do it', env });
    assert.equal(third.decision, 'deny');
    assert.match(third.reason, /Premium fan-out cap/);
    // The exempt pinned opus still passes while the window is full.
    assert.equal(spawn(fx, { type: 'proj-architect', prompt: 'do it', env }).decision, 'proceed');
  } finally { fx.cleanup(); }
});

test('4. an effort-only pin is never rewritten: no model autofill, no rung swap; the missing-model note stands', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-effortonly', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(r.decision, 'proceed');
    assert.equal(r.updated?.model, undefined, 'no model written');
    assert.ok(r.updated?.subagent_type === undefined || r.updated.subagent_type === 'proj-effortonly', 'no rung swap');
    assert.equal(r.row.model_autofilled, false);
    assert.equal(r.row.subagent_type_rewritten_to, null);
    assert.equal(r.row.project_pinned, true);
    assert.equal(r.row.pin_fields, 'effort');
    assert.match(r.msg, /names no model/);
    // Control: switched off, the model is filled in from the table (0.31.12).
    const off = spawn(fx, {
      type: 'proj-effortonly', prompt: `TYPE: bounded-feature\n${W}do it`, env: { CLAUDE_PLUGIN_OPTION_PROJECT_PINS: 'false' },
    });
    assert.equal(off.row.model_autofilled, true);
    assert.ok(off.updated?.model);
  } finally { fx.cleanup(); }
});

test('5. a model parameter that replaces the pin gets one non-blocking note, recorded, and no rewrite by the guard', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-builder', model: 'sonnet', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(r.decision, 'proceed');
    assert.equal(r.row.pin_model_overridden, true);
    assert.match(r.msg, /proj-builder is pinned by its project definition to opus\/medium/);
    assert.match(r.msg, /replaces the pinned model/);
    assert.match(r.msg, /Not blocking/);
    assert.ok(r.updated?.model === undefined || r.updated.model === 'sonnet', 'the call\'s own model is never changed');
    assert.ok(r.updated?.subagent_type === undefined || r.updated.subagent_type === 'proj-builder');
    assert.equal(r.row.model_autofilled, false);
    assert.equal(r.row.subagent_type_rewritten_to, null);
    assert.doesNotMatch(r.all, /under-provisioned/, 'no weight note on a pin');
    // No override: no parameter, or the same alias as the pin.
    const none = spawn(fx, { type: 'proj-builder', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(none.row.pin_model_overridden, false);
    assert.doesNotMatch(none.msg, /replaces the pinned model/);
    const same = spawn(fx, { type: 'proj-builder', model: 'opus', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(same.row.pin_model_overridden, false);
    assert.doesNotMatch(same.msg, /replaces the pinned model/);
  } finally { fx.cleanup(); }
});

test('5b. an effort-only pin (model: inherit) has no model to replace: no override note, not flagged', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-inheriteff', model: 'sonnet', prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(r.row.pin_fields, 'effort');
    assert.equal(r.row.pin_model_overridden, false);
    assert.doesNotMatch(r.all, /replaces the pinned model/);
  } finally { fx.cleanup(); }
});

test('6. role rules still apply to a pinned spawn: contract, standing rules, ROLE nudge, recorded declarations', () => {
  const fx = setup();
  try {
    mkdirSync(dirname(rulesPath()), { recursive: true });
    writeFileSync(rulesPath(), JSON.stringify([
      { id: 't-writer', scope: 'spawn', when: '^TYPE:\\s*bounded-feature', then: 'FIRST ACTION: run a read-only diagnostic.' },
      { id: 't-review', scope: 'spawn', when: '^TYPE:\\s*code-review', then: 'REVIEW FRAMING: try to refute the change.' },
      { id: 't-box', scope: 'spawn', when: '\\bpm2\\b', then: 'SHARED BOX: never restart pm2 processes you did not start.' },
    ]));
    const w = spawn(fx, { type: 'proj-architect', prompt: `TYPE: bounded-feature\n${W}restart pm2 afterwards` });
    assert.equal(w.decision, 'proceed');
    const prompt = w.updated?.prompt || '';
    assert.match(prompt, /\[agent-companion: reporting contract\]/);
    assert.match(prompt, /FIRST ACTION: run a read-only diagnostic/);
    assert.match(prompt, /SHARED BOX: never restart pm2/);
    assert.doesNotMatch(prompt, /REVIEW FRAMING/);
    assert.equal(w.row.declared_type, 'bounded-feature');
    assert.equal(w.row.declared_role, 'writer');
    assert.doesNotMatch(w.ctx, /no `ROLE:` line/);
    const rv = spawn(fx, { type: 'proj-architect', prompt: 'TYPE: code-review\nWRITER: opus/xhigh\nROLE: reviewer\nreview it' });
    assert.equal(rv.decision, 'proceed');
    assert.match(rv.updated?.prompt || '', /REVIEW FRAMING: try to refute/);
    assert.equal(rv.row.declared_role, 'reviewer');
    // No ROLE line: the nudge is delivered, as for any spawn.
    const nr = spawn(fx, { type: 'proj-architect', prompt: 'TYPE: bounded-feature\ndo it' });
    assert.match(nr.ctx, /no `ROLE:` line/);
    assert.equal(nr.row.declared_role, null);
    assert.equal(nr.row.project_pinned, true);
  } finally { fx.cleanup(); }
});

test('7. self-review protocol for a pinned writer whose file carries none', () => {
  const fx = setup();
  try {
    const r = spawn(fx, { type: 'proj-architect', prompt: `TYPE: integration\n${W}build it` });
    assert.equal(r.decision, 'proceed');
    assert.match(r.updated?.prompt || '', /## Self-review before you return/);
    assert.match(r.updated?.prompt || '', /agent-companion:ac-opus-xhigh/);
    assert.equal(r.row.self_review_injected, true);
    assert.equal(r.row.self_review_expected, true);
    // Opt out per spawn with the existing line: nothing is injected.
    const lead = spawn(fx, { type: 'proj-architect', prompt: `TYPE: integration\nREVIEW: lead\n${W}build it` });
    assert.doesNotMatch(lead.updated?.prompt || '', /Self-review before you return/);
    assert.equal(lead.row.self_review_injected, false);
    assert.equal(lead.row.self_review_expected, false);
    // A definition that already holds the markers is not given a second copy.
    const marked = spawn(fx, { type: 'proj-marked', prompt: `TYPE: integration\n${W}build it` });
    assert.doesNotMatch(marked.updated?.prompt || '', /Self-review before you return/);
    assert.equal(marked.row.self_review_injected, false);
    assert.equal(marked.row.self_review_expected, true);
    // A pin whose pair is no rung (opus, no effort, none inherited) keeps the note.
    const noRung = spawn(fx, { type: 'proj-noeffort', prompt: `TYPE: integration\n${W}build it` });
    assert.equal(noRung.row.project_pinned, true);
    assert.equal(noRung.row.self_review_injected, false);
    assert.equal(noRung.row.self_review_expected, false);
    assert.match(noRung.msg, /carries no self-review protocol/);
    assert.doesNotMatch(noRung.msg, /Spawn agent-companion:ac-/, 'a pin is never pointed at another rung');
    // ...but the effort it inherits from the lead names the rung that will run.
    const inherited = spawn(fx, { type: 'proj-noeffort', effort: 'high', prompt: `TYPE: integration\n${W}build it` });
    assert.equal(inherited.row.self_review_injected, true);
    assert.match(inherited.updated?.prompt || '', /agent-companion:ac-opus-high/);
    // A non-writer TYPE is untouched.
    const ex = spawn(fx, { type: 'proj-architect', prompt: 'TYPE: explore\nROLE: lookup\nfind it' });
    assert.equal(ex.row.self_review_injected, false);
    assert.equal(ex.row.self_review_expected, null);
  } finally { fx.cleanup(); }
});

test('8. what is not pinned decides as before', () => {
  const fx = setup();
  try {
    writeProfile(fx);
    put(join(fx.proj, '.claude', 'agents', 'general-purpose.md'), agentFile('model: opus\neffort: high'));
    const brief = `TYPE: bounded-feature\n${W}do it`;
    const cases = [
      ['a ladder rung', { type: 'agent-companion:ac-opus-xhigh', prompt: brief }],
      ['a built-in', { type: 'Explore', model: 'haiku', prompt: 'TYPE: explore\nROLE: lookup\nfind it' }],
      ['another plugin\'s agent', { type: 'other:agent', model: 'opus', prompt: brief }],
      ['a project file named like a built-in', { type: 'general-purpose', prompt: brief }],
      ['model: inherit with no effort', { type: 'proj-inherit', prompt: brief }],
      ['a project agent with no pin', { type: 'proj-nopin', model: 'opus', prompt: brief }],
    ];
    for (const [label, c] of cases) {
      const r = spawn(fx, c);
      assert.equal(r.row.project_pinned, false, label);
      assert.equal(r.row.pin_scope, null, label);
      assert.equal(r.row.pin_fields, null, label);
      assert.equal(r.row.pin_model_overridden, false, label);
    }
    // Their decisions are the 0.31.12 ones: the opus-on-a-sonnet-route spawns are still denied.
    assert.equal(spawn(fx, cases[3][1]).decision, 'deny');
    assert.match(spawn(fx, cases[3][1]).reason, /Best fit/);
    assert.equal(spawn(fx, cases[5][1]).decision, 'deny');
    assert.equal(spawn(fx, cases[2][1]).decision, 'deny');
    // A user-scope agent is pinned, with scope user.
    const u = spawn(fx, { type: 'user-agent', prompt: brief });
    assert.equal(u.decision, 'proceed', u.reason);
    assert.equal(u.row.project_pinned, true);
    assert.equal(u.row.pin_scope, 'user');
    assert.equal(u.row.pin_fields, 'model+effort');
  } finally { fx.cleanup(); }
});

test('9. a lead in a subfolder finds the project\'s agents: pinned, and no autofill over them', () => {
  const fx = setup();
  try {
    const deep = join(fx.proj, 'sub', 'deeper');
    mkdirSync(deep, { recursive: true });
    const r = spawn(fx, { type: 'proj-effortonly', cwd: deep, prompt: `TYPE: bounded-feature\n${W}do it` });
    assert.equal(r.row.project_pinned, true);
    assert.equal(r.row.pin_scope, 'project');
    assert.equal(r.row.model_autofilled, false);
    assert.equal(r.updated?.model, undefined);
    const a = spawn(fx, { type: 'proj-architect', cwd: deep, prompt: `TYPE: integration\n${W}do it` });
    assert.equal(a.row.model_definition, 'opus');
    assert.equal(a.row.project_pinned, true);
  } finally { fx.cleanup(); }
});

test('9b. the walk stops at the first .git, at 8 levels, and with no .git at all', () => {
  const fx = makeFixture();
  try {
    const norm = (p) => p.replace(/\\/g, '/');
    // Stops at the first .git: the outer project's agents are not visible from inside a nested repo.
    const outer = join(fx.dir, 'outer');
    const inner = join(outer, 'inner');
    mkdirSync(join(outer, '.git'), { recursive: true });
    mkdirSync(join(inner, '.git'), { recursive: true });
    const deep = join(inner, 'src', 'deep');
    mkdirSync(deep, { recursive: true });
    const roots = projectAgentRoots(deep).map(norm);
    assert.ok(roots.includes(norm(join(inner, '.claude', 'agents'))));
    assert.ok(!roots.includes(norm(join(outer, '.claude', 'agents'))), 'the walk ends at the first .git');
    // A .git file (worktree checkout) counts as well.
    const wt = join(fx.dir, 'wt');
    mkdirSync(join(wt, 'a'), { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere\n');
    assert.ok(projectAgentRoots(join(wt, 'a')).map(norm).includes(norm(join(wt, '.claude', 'agents'))));
    // 8 levels: the directory 7 parents up is reached, the one 8 parents up is not.
    const base = join(fx.dir, 'lvl');
    mkdirSync(join(base, '.git'), { recursive: true });
    const at = (n) => join(base, ...Array.from({ length: n }, (_, i) => `d${i}`));
    mkdirSync(at(8), { recursive: true });
    assert.ok(projectAgentRoots(at(7)).map(norm).includes(norm(join(base, '.claude', 'agents'))), '7 parents up is found');
    assert.ok(!projectAgentRoots(at(8)).map(norm).includes(norm(join(base, '.claude', 'agents'))), '8 parents up is not');
    // No .git anywhere within reach: only the working directory's own folder, as before.
    const bare = join(fx.dir, 'nogit', 'a', 'b');
    mkdirSync(bare, { recursive: true });
    const r = projectAgentRoots(bare).map(norm);
    assert.deepEqual(r.slice(0, 1), [norm(join(bare, '.claude', 'agents'))]);
    assert.ok(!r.includes(norm(join(fx.dir, 'nogit', 'a', '.claude', 'agents'))));
    // The user's folder is always last.
    assert.equal(r[r.length - 1], norm(join(fx.dir, '.claude', 'agents')));
  } finally { fx.cleanup(); }
});

test('10. the spawn audit counts pinned rows apart and does not warn on a pinned under', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.stateDir, 'telemetry', 'spawns.jsonl');
    const row = (extra) => JSON.stringify({ v: 2, at: new Date().toISOString(), session_id: 's', model: 'opus', fit: 'under', fit_expected: 'opus/xhigh', declared_weight: 4, ...extra });
    const audit = () => {
      const out = execFileSync(process.execPath, [join(PLUGIN_ROOT, 'scripts', 'audit.mjs'), '--only', 'spawn-audit', '--json'], {
        windowsHide: true, encoding: 'utf8', cwd: PLUGIN_ROOT, env: { ...process.env }, timeout: 30000,
      });
      return JSON.parse(out).results.find((r) => r.id === 'spawn-audit');
    };
    put(f, `${row({ project_pinned: true })}\n${row({ project_pinned: true, fit: 'over' })}\n${row({ project_pinned: true, fit: 'fit' })}\n`);
    const pinned = audit();
    assert.equal(pinned.status, 'ok', JSON.stringify(pinned));
    assert.ok(pinned.findings.some((x) => /pinned by project definitions: 3 spawns, of which over=1 under=1 fit=1 against the table \(not judged\)/.test(x)), JSON.stringify(pinned.findings));
    assert.ok(!pinned.findings.some((x) => /fit where a weight or task type was declared/.test(x)), 'pinned rows are not in the weight line');
    // Control: the same under row without the flag still warns.
    put(f, `${row({ project_pinned: false })}\n`);
    const plain = audit();
    assert.equal(plain.status, 'warn');
    assert.ok(!plain.findings.some((x) => /pinned by project definitions/.test(x)));
  } finally { fx.cleanup(); }
});
