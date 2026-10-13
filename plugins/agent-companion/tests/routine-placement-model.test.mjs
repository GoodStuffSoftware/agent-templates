// Routine placement note, model half: the pin is shown with the model it is keyed to, and the
// task's model: line (or its absence) is stated. Advisory only; every fixture lives in a temp home.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { NOTE_MAX } from '../hooks/lib/routine-placement.mjs';

const CREATE = 'mcp__scheduled-tasks__create_scheduled_task';
const UPDATE = 'mcp__scheduled-tasks__update_scheduled_task';
const HOOK = 'hooks/routine-placement.mjs';
const note = (r) => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;

function pinFolder(fx, name, map) {
  const dir = join(fx.dir, name);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  if (map) {
    writeFileSync(join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ modelSettings: Object.fromEntries(Object.entries(map).map(([m, l]) => [m, { effortLevel: l }])) }));
  }
  return dir;
}
function taskFile(fx, name, model) {
  const d = join(fx.dir, '.claude', 'scheduled-tasks', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n${model ? `model: ${model}\n` : ''}---\nBody\n`);
}

test('the pin is shown with its model, and a task with no model: line says so', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'keyed', { 'claude-opus-5-5': 'low' });
    const n = note(runHook(HOOK, { tool_name: CREATE, tool_input: { taskId: 'new-task', prompt: 'x' }, cwd }));
    assert.ok(n.includes('folder effort pin: low, for claude-opus-5-5;'), n);
    assert.ok(n.includes('starts at low'));
    assert.ok(n.includes('applies only on the model it is keyed to'));
    assert.ok(n.includes('has no model: line'));
    assert.ok(n.length <= NOTE_MAX, `${n.length}`);
  } finally { fx.cleanup(); }
});

test('an existing task: the note reports its model: line, or its absence', () => {
  const fx = makeFixture();
  try {
    const cwd = pinFolder(fx, 'keyed', { 'claude-opus-5-5': 'low' });
    taskFile(fx, 'has-model', 'opus');
    taskFile(fx, 'bare', null);
    let n = note(runHook(HOOK, { tool_name: UPDATE, tool_input: { taskId: 'has-model', prompt: 'x' }, cwd }));
    assert.ok(n.includes('says model: opus'), n);
    assert.ok(!n.includes('has no model: line'));
    n = note(runHook(HOOK, { tool_name: UPDATE, tool_input: { taskId: 'bare', prompt: 'x' }, cwd }));
    assert.ok(n.includes('has no model: line'), n);
  } finally { fx.cleanup(); }
});

test('levels that differ by model list each model; no folder pin stays none', () => {
  const fx = makeFixture();
  try {
    const mixed = pinFolder(fx, 'mixed', { 'model-a': 'low', 'model-b': 'high' });
    const n = note(runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd: mixed }));
    assert.ok(n.includes('folder effort pin: model-a=low, model-b=high;'), n);
    assert.ok(n.length <= NOTE_MAX);
    const plain = pinFolder(fx, 'plain', null);
    const p = note(runHook(HOOK, { tool_name: CREATE, tool_input: {}, cwd: plain }));
    assert.ok(p.includes('folder effort pin: none'));
    assert.ok(!p.includes('applies only on the model'));
  } finally { fx.cleanup(); }
});
