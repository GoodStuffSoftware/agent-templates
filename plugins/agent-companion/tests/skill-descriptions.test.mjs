// Skill descriptions are listed in every session (and every subagent) that has
// the plugin. The seven skills with no invocation in 30 days (measured
// 2026-10-06 over the session transcripts) keep a short listing line: what it
// does plus its trigger. The skill body carries the detail. Skills that are
// used (memory-search, evaluate, version, recommend, ac) keep their longer text.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const SHORT = ['setup', 'standing-rules', 'model-benchmark', 'audit', 'brevity', 'calibration-scout', 'routing-table'];
const MAX = 160;

function description(skill) {
  const text = readFileSync(join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
  const m = text.match(/^description: (.*)$/m);
  assert.ok(m, `${skill}: description line`);
  return m[1];
}

for (const skill of SHORT) {
  test(`skill ${skill}: listing description stays short and still says when to use it`, () => {
    const d = description(skill);
    assert.ok(d.length <= MAX, `${skill} description is ${d.length} chars (max ${MAX})`);
    assert.ok(d.length >= 80, `${skill} description must still carry its trigger: ${d}`);
    assert.match(d, /\bUse\b|\(\/ac routing/, `${skill} description names when to use it`);
  });
}
