// 0.31.40: Claude Code 2.1.300 validates a hook's updatedInput like the tool's own input (unknown keys are
// dropped, input that fails validation is denied), and 2.1.302 made desktop and VS Code run the main
// conversation's subagents in the background themselves.
//  - every updatedInput the spawn guard emits carries only Agent-tool input fields, with values of the right shape;
//  - the foreground fix is skipped where the harness already backgrounds the spawn, and kept everywhere else
//    (older version, unknown version, terminal, SDK).
// Fixture state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';
import { AGENT_INPUT_KEYS, sanitizeAgentInput } from '../hooks/lib/sg-helpers.mjs';
import { cliVersionFromPath, harnessBackgroundsMain, versionAtLeast } from '../hooks/lib/harness-bg.mjs';

// The Agent tool's input fields as the harness declares them (2.1.309 schema: description, prompt, subagent_type,
// model, effort, run_in_background, name, isolation, mode; team_name is deprecated but still accepted).
const AGENT_FIELDS = new Set(['description', 'prompt', 'subagent_type', 'model', 'effort', 'run_in_background', 'name', 'isolation', 'mode', 'team_name']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'lower', 'higher']);

function seedStart(stateDir, sessionId, agentType) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'subagent-starts.jsonl'),
    `${JSON.stringify({ v: 2, at: new Date().toISOString(), session_id: sessionId, agent_type: agentType })}\n`, { flag: 'a' });
}

function spawn(toolInput, { started = [], env, cwd, setup } = {}) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sid = 'sess-schema';
    for (const a of started) seedStart(stateDir, sid, a);
    if (setup) setup(dir);
    const res = runHook('hooks/spawn-guard.mjs', { session_id: sid, agent_type: 'main', cwd: cwd ? cwd(dir) : dir, tool_input: toolInput }, { env });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const ui = res.json?.hookSpecificOutput?.updatedInput || null;
    return { ui, row: rows[rows.length - 1] || null, res };
  } finally {
    cleanup();
  }
}

// What a shape-valid updatedInput looks like: only schema keys, each value of the right type.
function assertAgentShaped(ui, label) {
  assert.ok(ui && typeof ui === 'object', `${label}: an updatedInput was emitted`);
  for (const [k, v] of Object.entries(ui)) {
    assert.ok(AGENT_FIELDS.has(k), `${label}: ${k} is not an Agent input field`);
    if (k === 'run_in_background') assert.equal(typeof v, 'boolean', `${label}: run_in_background is a boolean`);
    else if (k === 'effort') assert.ok(EFFORTS.has(v), `${label}: effort ${v}`);
    else assert.equal(typeof v, 'string', `${label}: ${k} is a string`);
  }
}

const RUNGS = ['agent-companion:ac-sonnet-low', 'agent-companion:ac-sonnet-high'];
const GP = { subagent_type: 'general-purpose', model: 'sonnet' };

test('the key list the guard keeps is the Agent tool\'s input fields', () => {
  assert.deepEqual([...AGENT_INPUT_KEYS].sort(), [...AGENT_FIELDS].sort());
});

test('sanitizeAgentInput: unknown keys and wrongly shaped values are dropped, valid ones are kept', () => {
  const kept = { description: 'd', prompt: 'p', subagent_type: 'general-purpose', model: 'sonnet', effort: 'high',
    run_in_background: true, name: 'n', isolation: 'worktree', mode: 'plan', team_name: 't' };
  assert.deepEqual(sanitizeAgentInput(kept), kept);
  const out = sanitizeAgentInput({ ...kept, bogus: 1, cwd: '/x', background: true });
  assert.deepEqual(out, kept, 'keys outside the schema are gone');
  assert.deepEqual(sanitizeAgentInput({ prompt: 'p', effort: 'ultra', run_in_background: 'yes', model: '', name: 5, mode: null }), { prompt: 'p' });
  assert.deepEqual(sanitizeAgentInput({ prompt: 'p', run_in_background: false }), { prompt: 'p', run_in_background: false }, 'false is a value, not an absence');
  assert.equal(sanitizeAgentInput(null), null);
});

test('every updatedInput the guard emits carries only Agent input fields, in each scenario that emits one', () => {
  // Stray keys on the incoming input: whatever builds the rewrite starts from a copy of it.
  const stray = { bogus: 1, background: true, cwd: '/somewhere' };
  const scenarios = [
    ['foreground fix', () => spawn({ ...GP, ...stray, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' })],
    ['ROLE insert', () => spawn({ ...GP, ...stray, name: 'w', run_in_background: true, prompt: 'TYPE: lookup\nlook' })],
    ['namegate autofill', () => spawn({ ...GP, ...stray, run_in_background: true, prompt: 'TYPE: bounded-feature\ndo it' })],
    ['model autofill', () => spawn({ subagent_type: 'general-purpose', ...stray, name: 'w', run_in_background: true, prompt: 'TYPE: bounded-feature\ndo it' })],
    ['over-provisioned rewrite', () => spawn({ subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', ...stray, name: 'w', run_in_background: true,
      prompt: 'TYPE: mechanical-edit\nrename x' }, { started: RUNGS })],
    ['all fixes at once', () => spawn({ subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', ...stray, prompt: 'TYPE: mechanical-edit\nrename x' }, { started: RUNGS })],
    ['project effort fill', () => spawn({ subagent_type: 'proj-sonnet', ...stray, run_in_background: true, name: 'w', prompt: 'ROLE: writer\nTYPE: bounded-feature\ndo it' }, {
      cwd: (d) => join(d, 'proj'),
      setup: (d) => {
        mkdirSync(join(d, 'proj', '.git'), { recursive: true });
        const f = join(d, 'proj', '.claude', 'agents', 'proj-sonnet.md');
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, '---\nname: proj-sonnet\nmodel: sonnet\n---\nbody\n');
      },
    })],
  ];
  let emitted = 0;
  for (const [label, run] of scenarios) {
    const r = run();
    assert.ok(r.ui, `${label}: expected an updatedInput`);
    assertAgentShaped(r.ui, label);
    for (const k of Object.keys(stray)) assert.ok(!(k in r.ui), `${label}: stray key ${k} dropped`);
    emitted += 1;
  }
  assert.equal(emitted, scenarios.length);
});

test('a bad effort or flag on the incoming input never reaches the harness through a rewrite', () => {
  const r = spawn({ ...GP, name: 'w', effort: 'ultra', prompt: 'TYPE: bounded-feature\ndo it' });
  assert.ok(r.ui, 'the foreground fix still goes out');
  assert.equal(r.ui.run_in_background, true);
  assertAgentShaped(r.ui, 'bad effort');
  assert.ok(!('effort' in r.ui));
});

test('version parsing: the CLI version is read from the path of the running binary', () => {
  assert.deepEqual(cliVersionFromPath('C:\\Users\\x\\AppData\\Roaming\\Claude\\claude-code\\2.1.309\\abc123\\claude.exe'), [2, 1, 309]);
  assert.deepEqual(cliVersionFromPath('/home/x/.local/share/claude/versions/2.1.302/claude'), [2, 1, 302]);
  assert.equal(cliVersionFromPath('/usr/local/bin/claude'), null);
  assert.equal(cliVersionFromPath(undefined), null);
  assert.equal(versionAtLeast([2, 1, 302], [2, 1, 302]), true);
  assert.equal(versionAtLeast([2, 1, 299], [2, 1, 302]), false);
  assert.equal(versionAtLeast([2, 2, 0], [2, 1, 302]), true);
  assert.equal(versionAtLeast([3, 0, 0], [2, 9, 999]), true);
  assert.equal(versionAtLeast(null, [2, 1, 302]), false);
});

test('harnessBackgroundsMain: desktop and VS Code from 2.1.302 only; unknown version or other entrypoint is false', () => {
  const path = (v) => `C:\\x\\claude-code\\${v}\\h\\claude.exe`;
  const env = (entry, v) => ({ CLAUDE_CODE_ENTRYPOINT: entry, ...(v ? { CLAUDE_CODE_EXECPATH: path(v) } : {}) });
  assert.equal(harnessBackgroundsMain(env('claude-desktop', '2.1.309')), true);
  assert.equal(harnessBackgroundsMain(env('claude-desktop', '2.1.302')), true);
  assert.equal(harnessBackgroundsMain(env('claude-vscode', '2.1.310')), true);
  assert.equal(harnessBackgroundsMain(env('claude-desktop', '2.1.301')), false, 'before the change');
  assert.equal(harnessBackgroundsMain(env('claude-desktop', '2.1.299')), false, 'the version this machine\'s PATH has');
  assert.equal(harnessBackgroundsMain(env('claude-desktop', null)), false, 'version unknown: keep the fix');
  assert.equal(harnessBackgroundsMain(env('cli', '2.1.309')), false, 'the terminal');
  assert.equal(harnessBackgroundsMain(env('sdk-cli', '2.1.309')), false);
  assert.equal(harnessBackgroundsMain({}), false);
});

const desktop = (v) => ({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_EXECPATH: `C:\\x\\claude-code\\${v}\\h\\claude.exe` });

test('foreground fix: skipped on desktop 2.1.302 and later, the row says the harness did it, the name is still filled', () => {
  const r = spawn({ ...GP, prompt: 'TYPE: bounded-feature\ndo it' }, { env: desktop('2.1.309') });
  assert.notEqual(r.ui?.run_in_background, true, 'nothing to set: the harness runs it in the background');
  assert.equal(r.row.gate1_action, 'none');
  assert.ok(r.row.silent_fixes.includes('background_by_harness'));
  assert.ok(!r.row.silent_fixes.includes('background_set'));
  assert.ok(r.ui?.name, 'the namegate still names a spawn the harness backgrounds');
  assertAgentShaped(r.ui, 'desktop');
  // An explicit false is overruled by the harness too: nothing logged as the lead's own foreground choice.
  const f = spawn({ ...GP, name: 'w', run_in_background: false, prompt: 'TYPE: bounded-feature\ndo it' }, { env: desktop('2.1.309') });
  assert.notEqual(f.ui?.run_in_background, true);
  assert.ok(!f.row.silent_fixes.includes('foreground_logged'));
});

test('foreground fix: block mode does not deny a spawn the harness backgrounds anyway', () => {
  const r = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { env: { ...desktop('2.1.309'), CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' } });
  assert.notEqual(r.res.json?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(r.row.gate1_action, 'none');
});

test('foreground fix: kept on desktop before 2.1.302 (2.1.299 and 2.1.301), with an unknown version, in the terminal and in VS Code before the change', () => {
  for (const [label, env] of [
    ['desktop 2.1.299', desktop('2.1.299')],
    ['desktop 2.1.301', desktop('2.1.301')],
    ['desktop, no path', { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }],
    ['terminal 2.1.309', { CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: 'C:\\x\\claude-code\\2.1.309\\h\\claude.exe' }],
    ['vscode 2.1.300', { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_CODE_EXECPATH: 'C:\\x\\claude-code\\2.1.300\\h\\claude.exe' }],
  ]) {
    const r = spawn({ ...GP, name: 'w', prompt: 'TYPE: bounded-feature\ndo it' }, { env });
    assert.equal(r.ui?.run_in_background, true, label);
    assert.equal(r.row.gate1_action, 'fix', label);
    assert.ok(r.row.silent_fixes.includes('background_set'), label);
  }
});
