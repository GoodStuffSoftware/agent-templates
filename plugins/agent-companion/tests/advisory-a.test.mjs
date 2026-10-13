// Advisory hooks publish-check, window-check, chip-check. Synthetic fixtures only;
// every state file lands in a temp home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import {
  PUBLISH_NOTE, WINDOW_NOTE, CHIP_NOTE, claim, stateFilePath, CLAIM_KEEP_MS, addsUnhiddenSpawn, signoffQuestion, isSpawnTask,
} from '../hooks/lib/advisory-a.mjs';

const note = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
const quiet = (r) => { assert.equal(r.status, 0); assert.equal(r.stdout.trim(), ''); };
const OFF = (k) => ({ env: { [`CLAUDE_PLUGIN_OPTION_${k}`]: 'false' } });

test('hooks.json registers the three hooks with the right matchers', () => {
  const j = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8'));
  const find = (f) => j.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.args.some((a) => a.endsWith(f))));
  assert.equal(find('publish-check.mjs').matcher, '^(Artifact|AskUserQuestion)$');
  assert.equal(find('window-check.mjs').matcher, '^(Write|Edit)$');
  assert.equal(find('chip-check.mjs').matcher, '^mcp__.*spawn_task$');
  const pj = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const opts = pj.userConfig || pj.options || {};
  for (const k of ['publish_check', 'window_check', 'chip_check']) assert.equal(opts[k].default, true);
});

test('note lengths stay short', () => {
  for (const n of [PUBLISH_NOTE, WINDOW_NOTE, CHIP_NOTE]) assert.ok(n.length < 300);
});

// ---- F8 ----
test('publish-check: Artifact fires once per id per 30 min, main only', () => {
  const fx = makeFixture();
  try {
    const p = { session_id: 's1', tool_name: 'Artifact', tool_input: { id: 'a1' } };
    const r1 = runHook('hooks/publish-check.mjs', p);
    assert.equal(note(r1), PUBLISH_NOTE);
    assert.equal(r1.json.hookSpecificOutput.permissionDecision, undefined);
    quiet(runHook('hooks/publish-check.mjs', p));
    assert.equal(note(runHook('hooks/publish-check.mjs', { ...p, tool_input: { id: 'a2' } })), PUBLISH_NOTE);
    quiet(runHook('hooks/publish-check.mjs', { ...p, session_id: 's1', agent_id: 'w1', tool_input: { id: 'a3' } }));
    assert.equal(note(runHook('hooks/publish-check.mjs', { ...p, session_id: 's2' })), PUBLISH_NOTE);
  } finally { fx.cleanup(); }
});

test('publish-check: AskUserQuestion needs sign-off and UI words, once per session', () => {
  const fx = makeFixture();
  try {
    const ask = (q, sid = 's1') => runHook('hooks/publish-check.mjs',
      { session_id: sid, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: q }] } });
    quiet(ask('Which database should we use?'));
    quiet(ask('Do you approve the retry policy?'));
    quiet(ask('How should the page layout look?'));
    assert.equal(note(ask('Does the new settings screen look good, ok to ship?')), PUBLISH_NOTE);
    quiet(ask('Please sign off on the modal design'));
  } finally { fx.cleanup(); }
});

test('publish-check: option off, garbage payload, other tools stay silent', () => {
  const fx = makeFixture();
  try {
    quiet(runHook('hooks/publish-check.mjs', { session_id: 's1', tool_name: 'Artifact', tool_input: {} }, OFF('PUBLISH_CHECK')));
    quiet(runHook('hooks/publish-check.mjs', undefined));
    quiet(runHook('hooks/publish-check.mjs', { session_id: 's1', tool_name: 'Bash', tool_input: {} }));
  } finally { fx.cleanup(); }
});

test('signoffQuestion matcher precision', () => {
  assert.equal(signoffQuestion({ question: 'Approve the new popup?' }), true);
  assert.equal(signoffQuestion({ question: 'Approve the migration?' }), false);
  assert.equal(signoffQuestion(null), false);
});

// ---- F11 ----
test('addsUnhiddenSpawn: flags and passes', () => {
  const mod = 'node:child_process'; // not a literal import line: the windowsHide scan would read one as a real import
  const cp = `import { spawn } from '${mod}';\n`;
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', ['status']);`), true);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', ['status'], { stdio: 'ignore' });`), true);
  assert.equal(addsUnhiddenSpawn(`${cp}execSync('ls');`), true);
  assert.equal(addsUnhiddenSpawn("const cp = require('child_process');\ncp.fork('x.js');"), true);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', ['status'], { windowsHide: true });`), false);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', [], {\n  detached: true,\n  windowsHide: true,\n});`), false);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', [], opts);`), false); // cannot tell
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', [], { ...base });`), true);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('git', [], ...rest);`), false);
  // not child_process
  assert.equal(addsUnhiddenSpawn('const m = /a/.exec(s);\nre.exec(x);'), false);
  assert.equal(addsUnhiddenSpawn("spawn('x');"), false); // no child_process in file
  assert.equal(addsUnhiddenSpawn(`${cp}// spawn('x')\n * exec(y)`), false);
  assert.equal(addsUnhiddenSpawn(`${cp}function spawn(a) {}\nasync function exec(a) {}`), false);
  assert.equal(addsUnhiddenSpawn(`${cp}db.exec('select 1'); obj.spawn(2);`), false);
  assert.equal(addsUnhiddenSpawn(`${cp}spawn('x', [`), false); // unclosed (partial edit)
  assert.equal(addsUnhiddenSpawn('', 'child_process'), false);
});

test('window-check: Write fires once per file; subagent also; option off silent', () => {
  const fx = makeFixture();
  try {
    const mod = 'node:child_process';
    const content = `import { spawn } from '${mod}';\nspawn('node', ['a.js']);\n`;
    const p = { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'C:/fake/a.mjs', content } };
    const r = runHook('hooks/window-check.mjs', p);
    assert.equal(note(r), WINDOW_NOTE);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    quiet(runHook('hooks/window-check.mjs', p));
    assert.equal(note(runHook('hooks/window-check.mjs', { ...p, agent_id: 'w1', session_id: 's2' })), WINDOW_NOTE);
    assert.equal(note(runHook('hooks/window-check.mjs', { ...p, tool_input: { ...p.tool_input, file_path: 'C:/fake/b.ts' } })), WINDOW_NOTE);
    quiet(runHook('hooks/window-check.mjs', { ...p, session_id: 's3', tool_input: { ...p.tool_input, file_path: 'C:/fake/c.py' } }));
    quiet(runHook('hooks/window-check.mjs', { ...p, session_id: 's4', tool_input: { file_path: 'C:/fake/d.js', content: content.replace("['a.js']", "['a.js'], { windowsHide: true }") } }));
    quiet(runHook('hooks/window-check.mjs', { ...p, session_id: 's5' }, OFF('WINDOW_CHECK')));
  } finally { fx.cleanup(); }
});

test('window-check: Edit judges new_string, reads the file for child_process', () => {
  const fx = makeFixture();
  try {
    const f = join(fx.dir, 'x.js');
    writeFileSync(f, "const { spawn } = require('child_process');\n");
    const edit = (ns, sid) => runHook('hooks/window-check.mjs',
      { session_id: sid, tool_name: 'Edit', tool_input: { file_path: f, old_string: 'a', new_string: ns } });
    assert.equal(note(edit("spawn('a', []);", 'e1')), WINDOW_NOTE);
    quiet(edit("spawn('a', [], { windowsHide: true });", 'e2'));
    quiet(edit('const y = 2;', 'e3'));
    quiet(runHook('hooks/window-check.mjs', { session_id: 'e4', tool_name: 'Edit', tool_input: { file_path: join(fx.dir, 'missing.js'), new_string: "spawn('a');" } }));
    quiet(runHook('hooks/window-check.mjs', { session_id: 'e5', tool_name: 'Edit', tool_input: { file_path: f } }));
  } finally { fx.cleanup(); }
});

// ---- F13 ----
test('chip-check: spawn_task under any server prefix, lead only, once per session', () => {
  const fx = makeFixture();
  try {
    const p = { session_id: 's1', tool_name: 'mcp__ccd_session__spawn_task', tool_input: { title: 't' } };
    const r = runHook('hooks/chip-check.mjs', p);
    assert.equal(note(r), CHIP_NOTE);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
    quiet(runHook('hooks/chip-check.mjs', p));
    quiet(runHook('hooks/chip-check.mjs', { ...p, session_id: 's2', agent_id: 'w' }));
    quiet(runHook('hooks/chip-check.mjs', { ...p, session_id: 's3', tool_name: 'mcp__x__spawn_task_list' }));
    assert.equal(note(runHook('hooks/chip-check.mjs', { ...p, session_id: 's4', tool_name: 'mcp__other__spawn_task' })), CHIP_NOTE);
    quiet(runHook('hooks/chip-check.mjs', { ...p, session_id: 's5' }, OFF('CHIP_CHECK')));
    quiet(runHook('hooks/chip-check.mjs', undefined));
  } finally { fx.cleanup(); }
});

test('isSpawnTask', () => {
  assert.equal(isSpawnTask('mcp__ccd_session__spawn_task'), true);
  assert.equal(isSpawnTask('spawn_task'), false);
  assert.equal(isSpawnTask(undefined), false);
});

test('hooks import no child_process', () => {
  for (const f of ['publish-check', 'window-check', 'chip-check']) {
    const src = readFileSync(join(PLUGIN_ROOT, 'hooks', `${f}.mjs`), 'utf8');
    assert.ok(!/from 'node:child_process'|require\('child_process'\)/.test(src));
  }
  assert.ok(!/from 'node:child_process'|require\('child_process'\)/.test(readFileSync(join(PLUGIN_ROOT, 'hooks/lib/advisory-a.mjs'), 'utf8')));
});

test('claim: old per-session files are pruned, fresh ones and claim-once stay', () => {
  const fx = makeFixture();
  try {
    assert.equal(claim('chip-check', 'old', 'chip'), true);
    assert.equal(claim('chip-check', 'recent', 'chip'), true);
    const old = stateFilePath('chip-check', 'old');
    const t = (Date.now() - CLAIM_KEEP_MS - 60000) / 1000;
    utimesSync(old, t, t);
    assert.equal(claim('chip-check', 'cur', 'chip'), true);
    assert.equal(claim('chip-check', 'cur', 'chip'), false);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(stateFilePath('chip-check', 'recent')), true);
    assert.equal(claim('chip-check', 'recent', 'chip'), false);
  } finally { fx.cleanup(); }
});
