// compact_window_drift — the scout signal fed by the cache advisor's
// numbers-only history of FULL-read recommendations. Synthetic history only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runScript } from './helpers.mjs';
import {
  ADVISOR_HISTORY_FILE, ADVISOR_HISTORY_MAX, appendAdvisorHistory, checkWindowDrift, historyEntryOf,
} from '../scripts/lib/cache-advisor.mjs';

const summary = (window, { truncated = false } = {}) => ({
  generatedAt: '2026-09-01T00:00:00Z', windowDays: 30, completeDays: 30, truncated,
  global: { window, band5: [window * 0.9, window * 1.1] },
  models: { 'claude-opus-5-5': { status: 'ok', window, requests: 30 }, 'claude-sonnet-5': { status: 'ok', window, requests: 10 } },
});

function tmp() { return mkdtempSync(join(tmpdir(), 'ac-drift-')); }
function seed(dir, windows) { for (const w of windows) appendAdvisorHistory(summary(w), dir); }

test('entry is numbers only: window, band, mix shares, days', () => {
  const e = historyEntryOf(summary(100000));
  assert.deepEqual(Object.keys(e).sort(), ['band5', 'date', 'days', 'mix', 'window']);
  assert.deepEqual(e.mix, { 'claude-opus-5-5': 0.75, 'claude-sonnet-5': 0.25 });
});

test('no history, or one entry: no signal', () => {
  const d = tmp();
  try {
    assert.equal(checkWindowDrift(d), null);
    seed(d, [100000]);
    assert.equal(checkWindowDrift(d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('+19% no signal; +21% and -21% fire', () => {
  for (const [w, fires] of [[119000, false], [121000, true], [79000, true]]) {
    const d = tmp();
    try {
      seed(d, [100000, w]);
      const r = checkWindowDrift(d);
      assert.equal(!!r, fires, `window ${w}`);
      if (fires) assert.equal(r.to, w);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test('slow drift against the anchor fires once, then the anchor resets', () => {
  const d = tmp();
  try {
    let fired = 0;
    appendAdvisorHistory(summary(100000), d);
    let w = 100000;
    for (let i = 0; i < 5; i++) {
      w = Math.round(w * 1.05);
      appendAdvisorHistory(summary(w), d);
      if (checkWindowDrift(d)) fired++;
    }
    assert.equal(fired, 1);
    const h = JSON.parse(readFileSync(join(d, ADVISOR_HISTORY_FILE), 'utf8'));
    assert.ok(h.anchor.window > 120000);
    assert.equal(checkWindowDrift(d), null, 'no repeat once the anchor moved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('partial reads never enter the history or move the baseline', () => {
  const d = tmp();
  try {
    seed(d, [100000]);
    assert.equal(appendAdvisorHistory(summary(200000, { truncated: true }), d), null);
    assert.equal(checkWindowDrift(d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('history is capped', () => {
  const d = tmp();
  try {
    seed(d, Array.from({ length: ADVISOR_HISTORY_MAX + 5 }, () => 100000));
    const h = JSON.parse(readFileSync(join(d, ADVISOR_HISTORY_FILE), 'utf8'));
    assert.equal(h.entries.length, ADVISOR_HISTORY_MAX);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('corrupt file fails open', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, ADVISOR_HISTORY_FILE), '{not json');
    assert.equal(checkWindowDrift(d), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('detect.mjs surfaces compact_window_drift with the value to type; threshold option respected', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const sd = join(stateDir, 'state');
    mkdirSync(sd, { recursive: true });
    const write = () => writeFileSync(join(sd, ADVISOR_HISTORY_FILE), JSON.stringify({
      anchor: historyEntryOf(summary(100000)),
      entries: [historyEntryOf(summary(100000)), historyEntryOf(summary(130000))],
    }));
    write();
    const off = runScript('scripts/detect.mjs', [], { cwd: dir, env: { CLAUDE_PLUGIN_OPTION_COMPACT_WINDOW_DRIFT_PCT: '50' } });
    assert.equal(off.status, 0, off.stderr);
    assert.equal(off.json.signals.find((s) => s.kind === 'compact_window_drift'), undefined);
    const res = runScript('scripts/detect.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const s = res.json.signals.find((x) => x.kind === 'compact_window_drift');
    assert.ok(s, JSON.stringify(res.json.signals));
    assert.match(s.detail, /100000 -> 130000/);
    assert.match(s.detail, /\/autocompact 130k/);
  } finally { cleanup(); }
});
