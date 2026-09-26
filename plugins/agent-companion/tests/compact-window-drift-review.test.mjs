// Review findings (drift track): the first three failed on the pre-fix writer tip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAdvisorHistory, loadAdvisorHistory, checkWindowDrift, ADVISOR_HISTORY_FILE } from '../scripts/lib/cache-advisor.mjs';

const S = (w) => ({ generatedAt: '2026-09-01', global: { window: w }, models: {}, completeDays: 30 });

test('a torn history file does not silently wipe prior history on the next append', () => {
  const d = mkdtempSync(join(tmpdir(), 'drift-rev-'));
  for (const w of [100000, 101000, 102000]) appendAdvisorHistory(S(w), d);
  const f = join(d, ADVISOR_HISTORY_FILE);
  writeFileSync(f, readFileSync(f, 'utf8').slice(0, 40)); // non-atomic write interrupted
  appendAdvisorHistory(S(200000), d);
  assert.ok(loadAdvisorHistory(d).entries.length > 1, 'history reset to a single entry; drift of 100k->200k is never reported');
});

test('scout anchor write does not drop an advisor entry appended since the scout read', () => {
  const d = mkdtempSync(join(tmpdir(), 'drift-rev-'));
  appendAdvisorHistory(S(100000), d); appendAdvisorHistory(S(150000), d);
  const f = join(d, ADVISOR_HISTORY_FILE);
  const seenByScout = readFileSync(f, 'utf8');
  appendAdvisorHistory(S(151000), d); // advisor save lands mid-scout
  // checkWindowDrift persists the whole object it read; emulate its write from the stale read:
  const h = JSON.parse(seenByScout); h.anchor = h.entries.at(-1); writeFileSync(f, JSON.stringify(h));
  assert.equal(loadAdvisorHistory(d).entries.length, 3);
});

test('non-finite window in a foreign file yields no signal rather than an Infinity/null pct', () => {
  const d = mkdtempSync(join(tmpdir(), 'drift-rev-'));
  writeFileSync(join(d, ADVISOR_HISTORY_FILE), '{"anchor":{"window":1},"entries":[{"window":1},{"window":1e308}]}');
  const r = checkWindowDrift(d, { persist: false });
  assert.ok(r === null || Number.isFinite(r.pct), `pct=${r && r.pct}`);
});

test('a corrupt history file is kept aside, not overwritten', () => {
  const d = mkdtempSync(join(tmpdir(), 'drift-rev-'));
  writeFileSync(join(d, ADVISOR_HISTORY_FILE), '{"anchor":{"wind');
  appendAdvisorHistory(S(100000), d);
  const aside = readdirSync(d).filter((n) => n.startsWith(`${ADVISOR_HISTORY_FILE}.corrupt-`));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(d, aside[0]), 'utf8'), '{"anchor":{"wind');
  assert.equal(loadAdvisorHistory(d).entries.length, 1);
});

test('checkWindowDrift persists only the anchor onto a fresh read', () => {
  const d = mkdtempSync(join(tmpdir(), 'drift-rev-'));
  appendAdvisorHistory(S(100000), d); appendAdvisorHistory(S(150000), d);
  assert.equal(checkWindowDrift(d).to, 150000);
  const h = loadAdvisorHistory(d);
  assert.equal(h.anchor.window, 150000);
  assert.equal(h.entries.length, 2);
});
