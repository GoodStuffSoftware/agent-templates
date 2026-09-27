// Session churn (offline): lib/session-churn.mjs counts, the
// transcript-harvest --churn writer, and detect.mjs's session_churn signal.
// Plus the two spawn-row fixes in detect.mjs section 3:
// inherited_effort_spawns and spawn_activity's routed-aware premium count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, readJsonl } from './helpers.mjs';
import { telemetryDir, stateFile } from '../hooks/lib/context.mjs';
import {
  isCorrection, churnOfTranscript, scanChurn, mergeChurnRows, churnVerdict, CHURN_THRESHOLDS,
} from '../scripts/lib/session-churn.mjs';

const TODAY = new Date().toISOString().slice(0, 10);
const ts = () => new Date().toISOString();

function transcript(root, sessionId, recs) {
  const d = join(root, 'proj-a');
  mkdirSync(d, { recursive: true });
  const p = join(d, `${sessionId}.jsonl`);
  writeFileSync(p, recs.map((r) => JSON.stringify({ timestamp: ts(), sessionId, ...r })).join('\n') + '\n');
  return p;
}
const asst = (id, effort) => ({ type: 'assistant', requestId: id, effort, message: { id, model: 'claude-opus-5-5', usage: {} } });
const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const result = (err) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: err, content: 'x' }] } });

test('isCorrection: conservative list', () => {
  for (const t of ['no, use the other file', 'That is not what I asked for', 'I told you to run the tests', 'you ignored the brief', 'why did you delete it?', 'revert that']) {
    assert.ok(isCorrection(t), t);
  }
  for (const t of ['now add the tests', 'nobody uses that path', 'no problem, carry on', 'Is there no config?', 'x'.repeat(2000) + ' why did you']) {
    assert.equal(isCorrection(t), false, t.slice(0, 40));
  }
});

test('churnOfTranscript counts effort switches, error runs, corrections; dedupes a request over lines', async () => {
  const fx = makeFixture();
  try {
    const p = transcript(fx.dir, 'sess-a', [
      prompt('build it'),
      asst('r1', 'high'), asst('r1', 'high'),
      asst('r2', 'low'),
      result(true), result(true), result(true), result(true), // one run of 4 = one run
      result(false),
      result(true), result(true), // run of 2: not counted
      prompt('no, that is wrong'),
      prompt('<command-name>/effort</command-name>'),
      asst('r3', 'high'),
    ]);
    const rows = await churnOfTranscript(p, 'sess-a', TODAY);
    const r = rows.get(TODAY);
    assert.equal(r.requests, 3);
    assert.equal(r.effort_switches, 2);
    assert.equal(r.tool_error_runs, 1);
    assert.equal(r.corrections, 1);
    assert.equal(r.prompts, 2, 'the harness tag is not a prompt');
    assert.equal(JSON.stringify(r).includes('wrong'), false, 'aggregates only, no text');
  } finally { fx.cleanup(); }
});

test('scanChurn adds review rounds from parity-type spawns; merge keeps history, replaces fresh keys', async () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'projects');
    transcript(root, 'sess-b', [prompt('go'), asst('r1', 'high')]);
    const spawnRows = [
      { at: ts(), session_id: 'sess-b', declared_type: 'code-review' },
      { at: ts(), session_id: 'sess-b', declared_type: 'code-review' },
      { at: ts(), session_id: 'sess-b', declared_type: 'bounded-feature' },
      { at: ts(), session_id: 'sess-c', declared_type: 'code-review' },
    ];
    const { rows, stats } = await scanChurn({ root, spawnRows });
    assert.equal(stats.scanned, 1);
    const b = rows.find((r) => r.session_id === 'sess-b');
    assert.equal(b.review_rounds, 2);
    assert.equal(rows.find((r) => r.session_id === 'sess-c').review_rounds, 1);
    const old = { session_id: 'sess-old', day: new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10), corrections: 9 };
    const ancient = { session_id: 'sess-x', day: '2000-01-01', corrections: 9 };
    const merged = mergeChurnRows([old, ancient, { ...b, corrections: 99 }], rows);
    assert.ok(merged.find((r) => r.session_id === 'sess-old'));
    assert.equal(merged.find((r) => r.session_id === 'sess-x'), undefined);
    assert.equal(merged.find((r) => r.session_id === 'sess-b').corrections, 0);
  } finally { fx.cleanup(); }
});

test('churnVerdict: needs two churning session-days in the window', () => {
  const now = new Date();
  const hot = { day: TODAY, session_id: 'a', effort_switches: CHURN_THRESHOLDS.effort_switches };
  assert.equal(churnVerdict([hot], { now }).fire, false);
  const v = churnVerdict([hot, { day: TODAY, session_id: 'b', corrections: CHURN_THRESHOLDS.corrections }], { now });
  assert.equal(v.fire, true);
  assert.match(v.detail, /2 lead session-day/);
  const stale = { day: '2000-01-01', session_id: 'c', corrections: 99 };
  assert.equal(churnVerdict([hot, stale], { now }).fire, false);
});

test('transcript-harvest --churn writes session-churn.jsonl; detect emits session_churn', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'projects');
    const churny = [prompt('no, stop'), prompt('I told you twice'), prompt('why did you do that'), asst('r1', 'high')];
    transcript(root, 'sess-d', churny);
    transcript(root, 'sess-e', churny);
    const env = { AGENT_COMPANION_TRANSCRIPTS_ROOT: root };
    const h = runScript('scripts/transcript-harvest.mjs', ['--churn'], { env });
    assert.equal(h.status, 0, h.stderr);
    const rows = readJsonl(join(telemetryDir(), 'session-churn.jsonl'));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.corrections === 3));
    const d = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000 });
    assert.equal(d.status, 0, d.stderr);
    const s = d.json.signals.find((x) => x.kind === 'session_churn');
    assert.ok(s, JSON.stringify(d.json.signals.map((x) => x.kind)));
    assert.equal(s.dispatch, 'routing-review');
  } finally { fx.cleanup(); }
});

function writeSpawns(rows) {
  writeFileSync(join(telemetryDir(), 'spawns.jsonl'), rows.map((r) => JSON.stringify({ at: ts(), session_id: 'sess-s', ...r })).join('\n') + '\n');
}
function detect(fx) {
  const d = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000 });
  assert.equal(d.status, 0, d.stderr);
  return d.json.signals;
}

test('inherited_effort_spawns counts spawn_effort_source === inherited in 24h', () => {
  const fx = makeFixture();
  try {
    writeSpawns([
      { model: 'opus', spawn_effort_source: 'inherited' },
      { model: 'opus', spawn_effort_source: 'definition' },
      { model: 'sonnet', spawn_effort_source: 'inherited' },
      { at: new Date(Date.now() - 3 * 86400000).toISOString(), model: 'opus', spawn_effort_source: 'inherited' },
    ]);
    const s = detect(fx).find((x) => x.kind === 'inherited_effort_spawns');
    assert.ok(s);
    assert.equal(s.dispatch, 'routing-review');
    assert.match(s.detail, /^2 spawn/);
  } finally { fx.cleanup(); }
});

test('spawn_activity premium: routed === false only when the field exists, regex otherwise', () => {
  const fx = makeFixture();
  try {
    writeFileSync(stateFile('baseline.json'), JSON.stringify({ premiumPerDay: 1 }));
    writeSpawns([
      { model: 'opus', routed: true },
      { model: 'opus', routed: true },
      { model: 'opus', routed: true },
      { model: 'opus', routed: false },
      { model: 'fable' }, // legacy row: regex
      { model: 'sonnet', routed: false },
    ]);
    const s = detect(fx).find((x) => x.kind === 'spawn_activity');
    assert.match(s.detail, /6 spawns\/24h; 2 premium/);
    assert.equal(s.dispatch, 'none', '2 is not more than twice the baseline of 1');
  } finally { fx.cleanup(); }
});
