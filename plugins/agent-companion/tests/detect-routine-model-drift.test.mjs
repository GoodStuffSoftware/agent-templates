// The scout's routine_model_drift signal (scripts/detect.mjs + scripts/lib/routine-model-drift.mjs).
// Synthetic fixtures only: a temp sessions store, temp scheduled tasks, temp run folders.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const kind = (res) => (res.json?.signals || []).filter((s) => s.kind === 'routine_model_drift');

function run(dir, sessions, env = {}) {
  const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: { AGENT_COMPANION_SESSIONS_DIR: sessions, ...env }, timeout: 90000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, 'detect prints JSON');
  return res;
}
const task = (dir, name, model) => write(join(dir, '.claude', 'scheduled-tasks', name, 'SKILL.md'),
  `---\nname: ${name}\ndescription: d\n${model ? `model: ${model}\n` : ''}---\nBody\n`);
const pinFolder = (dir, name, map) => {
  const f = join(dir, name);
  write(join(f, '.claude', 'settings.local.json'), JSON.stringify({ modelSettings: Object.fromEntries(Object.entries(map).map(([m, l]) => [m, { effortLevel: l }])) }));
  return f;
};
let n = 0;
const record = (sessions, over) => {
  const id = `local_${String(++n).padStart(8, '0')}-0000`;
  write(join(sessions, 'acct', 'org', `${id}.json`), JSON.stringify({ sessionId: id, createdAt: Date.now() - 3600 * 1000, ...over }));
};

test('drift: a run on the wrong model and effort is flagged with recorded and expected values', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sessions = join(dir, 'sessions');
    const cwd = pinFolder(dir, 'low-folder', { 'claude-opus-5-5': 'low' });
    task(dir, 'scout', 'opus');
    record(sessions, { scheduledTaskId: 'scout', cwd, model: 'claude-fable-5-1', effort: 'high' });
    const hit = kind(run(dir, sessions));
    assert.equal(hit.length, 1);
    assert.equal(hit[0].dispatch, 'manual-check');
    assert.match(hit[0].detail, /scout run 00000001/);
    assert.match(hit[0].detail, /claude-fable-5-1 but the task's model: line says opus/);
    assert.match(hit[0].detail, /pin is keyed to claude-opus-5-5, not claude-fable-5-1/);
  } finally { cleanup(); }
});

test('drift: right model, wrong effort against the folder pin', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sessions = join(dir, 'sessions');
    const cwd = pinFolder(dir, 'low-folder', { 'claude-opus-5-5': 'low' });
    task(dir, 'scout', 'opus');
    record(sessions, { scheduledTaskId: 'scout', cwd, model: 'claude-opus-5-5[1m]', effort: 'high' });
    const hit = kind(run(dir, sessions));
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /effort high but the folder pin for this model says low/);
    assert.doesNotMatch(hit[0].detail, /model: line says/);
  } finally { cleanup(); }
});

test('matching run (alias vs full id, effort equals the pin): no drift signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sessions = join(dir, 'sessions');
    const cwd = pinFolder(dir, 'low-folder', { 'claude-opus-5-5': 'low' });
    task(dir, 'scout', 'opus');
    record(sessions, { scheduledTaskId: 'scout', cwd, model: 'claude-opus-5-5[1m]', effort: 'low' });
    record(sessions, { cwd, model: 'claude-fable-5-1', effort: 'high' }); // interactive: ignored
    record(sessions, { scheduledTaskId: 'scout', cwd, model: 'claude-fable-5-1', effort: 'high', createdAt: Date.now() - 5 * 86400 * 1000 }); // older than 48 h
    assert.equal(kind(run(dir, sessions)).length, 0);
  } finally { cleanup(); }
});

test('no model: line: the task is listed once, then quiet until the set changes', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sessions = join(dir, 'sessions');
    const cwd = pinFolder(dir, 'low-folder', { 'claude-opus-5-5': 'low' });
    task(dir, 'bare-task', null);
    task(dir, 'other', 'opus');
    record(sessions, { scheduledTaskId: 'bare-task', cwd, model: 'claude-opus-5-5', effort: 'low' });
    record(sessions, { scheduledTaskId: 'other', cwd, model: 'claude-opus-5-5', effort: 'low' });
    const first = kind(run(dir, sessions));
    assert.equal(first.length, 1);
    assert.match(first[0].detail, /no model: line/);
    assert.match(first[0].detail, /bare-task/);
    assert.doesNotMatch(first[0].detail, /other/);
    assert.equal(kind(run(dir, sessions)).length, 0, 'known set: no repeat');
    task(dir, 'third', null);
    record(sessions, { scheduledTaskId: 'third', cwd, model: 'claude-opus-5-5', effort: 'low' });
    const again = kind(run(dir, sessions));
    assert.equal(again.length, 1);
    assert.match(again[0].detail, /third/);
  } finally { cleanup(); }
});

test('missing store, unreadable record, missing tasks directory: no signal, no crash', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(kind(run(dir, join(dir, 'does-not-exist'))).length, 0);
    const sessions = join(dir, 'sessions');
    write(join(sessions, 'acct', 'org', 'local_bad.json'), '{not json');
    record(sessions, { scheduledTaskId: 'ghost', cwd: join(dir, 'nowhere'), model: 'claude-opus-5-5', effort: 'low' });
    assert.equal(kind(run(dir, sessions)).length, 0);
  } finally { cleanup(); }
});

test('scout_suppress silences the kind', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const sessions = join(dir, 'sessions');
    task(dir, 'scout', 'opus');
    record(sessions, { scheduledTaskId: 'scout', cwd: dir, model: 'claude-fable-5-1', effort: 'high' });
    assert.equal(kind(run(dir, sessions)).length, 1);
    assert.equal(kind(run(dir, sessions, { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'routine_model_drift' })).length, 0);
  } finally { cleanup(); }
});

test('the kind is documented in the scout routine and skill', () => {
  for (const f of [['routines', 'calibration-scout-daily.md'], ['skills', 'calibration-scout', 'SKILL.md']]) {
    assert.match(readFileSync(join(PLUGIN_ROOT, ...f), 'utf8'), /routine_model_drift/);
  }
});
