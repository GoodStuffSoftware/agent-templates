// long-runs.mjs: the daily long-run listing, driven with fixture files (no network, no real state).
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { longRuns, enrich, parseSince, main } from '../scripts/long-runs.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'long-runs-'));
const jl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const asst = (id, model, out, stop = 'tool_use') => ({ type: 'assistant', uuid: id, message: { id, model, stop_reason: stop, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });

const tpath = join(dir, 't.jsonl');
writeFileSync(tpath, jl([
  asst('m1', 'claude-sonnet-5-5', 5), asst('m1', 'claude-sonnet-5-5', 20), // same id twice: max, not sum
  { type: 'system', subtype: 'compact_boundary' }, asst('m2', 'claude-sonnet-5-5', 7, 'end_turn'),
]));
const tpath2 = join(dir, 't2.jsonl');
writeFileSync(tpath2, jl([asst('a', 'claude-opus-5', 1), { type: 'user' }, asst('b', 'claude-opus-5', 1)]));

const row = (o) => ({ ts: '2026-11-01T10:00:00Z', sessionId: 's', agentId: 'a1', agentType: 'ac-sonnet-high', steps: 150, startedAt: null, durationMin: 42, description: 'build x', transcriptPath: null, ...o });
const file = join(dir, 'long-runs.jsonl');

test('a missing file means none', () => {
  const r = longRuns({ file: join(dir, 'nope.jsonl'), now: NOW });
  assert.equal(r.line, 'Long runs (24h): none');
  assert.deepEqual(r.runs, []);
});

test('highest crossing per agent, last 24 h only, bad lines skipped', () => {
  writeFileSync(file, jl([
    row({ steps: 150 }), row({ steps: 250, ts: '2026-11-01T11:00:00Z' }), row({ steps: 350, ts: '2026-10-30T10:00:00Z' }),
    'not json', row({ agentId: 'a2', steps: 150, description: null }),
  ]));
  const r = longRuns({ file, now: NOW });
  assert.equal(r.runs.length, 2);
  assert.equal(r.runs[0].steps, 250);
  assert.match(r.line, /^Long runs \(24h\): 2 past 150 steps\n- ac-sonnet-high, model \?, 250 steps, 42 min, \? compactions: build x/);
  assert.match(r.line, /\(no description\)/);
  assert.equal(longRuns({ file, now: NOW, since: '4d' }).runs[0].steps, 350);
});

test('transcript enrichment: model, tokens, compactions, final steps, finished', () => {
  const e = enrich(tpath);
  assert.deepEqual(e, { model: 'claude-sonnet-5-5', tokens: 130 + 117, compactions: 1, finalSteps: 2, finished: true });
  assert.equal(enrich(tpath2).finished, false);
  assert.equal(enrich(join(dir, 'gone.jsonl')), null);
  writeFileSync(file, jl([row({ transcriptPath: tpath })]));
  const r = longRuns({ file, now: NOW }).runs[0];
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.compactions, 1);
  assert.equal(r.finished, true);
});

test('parseSince and the CLI', () => {
  assert.equal(parseSince('2h', NOW), NOW - 7200e3);
  assert.equal(parseSince('2026-11-01T00:00:00Z', NOW), Date.parse('2026-11-01T00:00:00Z'));
  assert.equal(parseSince('junk', NOW), null);
  const lines = [];
  assert.equal(main(['--since', 'junk'], { out: (s) => lines.push(s) }), 2);
  assert.equal(main(['--now', '2026-11-01T12:00:00Z'], { out: (s) => lines.push(s), file: join(dir, 'nope.jsonl') }), 0);
  assert.equal(JSON.parse(lines.at(-1)).line, 'Long runs (24h): none');
});