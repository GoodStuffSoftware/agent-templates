// The scout's haiku_fit_leak signal (scripts/detect.mjs): spawns in the last 7 days whose recorded
// route (fit_expected) named a haiku rung but which ran on another model. Temp fixtures only.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { telemetryDir } from '../hooks/lib/context.mjs';

const NOW = '2026-10-13T12:00:00Z';
const ago = (d) => new Date(Date.parse(NOW) - d * 86400000).toISOString();
const row = (o) => ({ session_id: 's1', model: 'sonnet', fit_expected: 'haiku/medium', subagent_type: 'general-purpose', at: ago(1), ...o });
const kind = (res) => (res.json?.signals || []).filter((s) => s.kind === 'haiku_fit_leak');

function run(dir, rows, env = {}) {
  mkdirSync(telemetryDir(), { recursive: true });
  writeFileSync(join(telemetryDir(), 'spawns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: { AGENT_COMPANION_FAKE_NOW: NOW, ...env }, timeout: 90000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json);
  return res;
}

test('counts haiku-routed spawns that ran elsewhere and names the top agent types', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const hit = kind(run(dir, [
      row({ subagent_type: 'pinned-explorer', project_pinned: true }),
      row({ subagent_type: 'pinned-explorer', project_pinned: true }),
      row({ subagent_type: 'general-purpose', model: '(inherited)' }),
      row({ model: 'haiku' }),                       // landed on haiku: not a leak
      row({ fit_expected: 'sonnet/low' }),           // not a haiku route
      row({ at: ago(9) }),                           // older than 7 days
    ]));
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /^3 spawn\(s\) in 7 days/);
    assert.match(hit[0].detail, /pinned-explorer x2 on sonnet \(2 project-pinned\)/);
    assert.match(hit[0].detail, /general-purpose x1 on \(inherited\)/);
    assert.equal(hit[0].dispatch, 'routing-review');
  } finally { cleanup(); }
});

test('no leaks: no signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(kind(run(dir, [row({ model: 'haiku' }), row({ fit_expected: null })])).length, 0);
  } finally { cleanup(); }
});

test('fails open on rows with no model, no fit_expected, or junk', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = run(dir, [{ at: ago(1) }, { at: 'junk', fit_expected: 'haiku/low' }, row({ model: undefined })]);
    assert.equal(kind(res).length, 1, 'a missing model counts as not haiku; the junk-dated row is skipped');
  } finally { cleanup(); }
});

test('scout_suppress drops the signal', () => {
  const { dir, cleanup } = makeFixture();
  try {
    assert.equal(kind(run(dir, [row({})], { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'haiku_fit_leak' })).length, 0);
  } finally { cleanup(); }
});
