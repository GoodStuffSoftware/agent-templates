// 0.31.16: `routing-profile.mjs set --review-by <date>` and `--settled`, and the scout's
// routing_trial_review_due signal reading the operator's profile rows. Synthetic state
// roots only; the operator's real profile is never read.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeFixture, runScript } from './helpers.mjs';

const NOW = '2026-10-12T10:00:00.000Z';
const rp = (fx, args, now = NOW) => runScript('scripts/routing-profile.mjs', args, { cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: now } });
const profile = (fx) => JSON.parse(readFileSync(JSON.parse(rp(fx, ['show', '--json']).stdout).path, 'utf8'));
const showJson = (fx) => JSON.parse(rp(fx, ['show', '--json']).stdout);
const SET = ['set', 'verify', '--model', 'sonnet', '--effort', 'low'];

test('set --review-by writes that review date and the journal still matches the file', () => {
  const fx = makeFixture();
  try {
    const r = rp(fx, [...SET, '--review-by', '2026-10-19']);
    assert.equal(r.status, 0, r.stderr);
    const row = profile(fx).rows.verify;
    assert.equal(row.state, 'trial');
    assert.equal(row.reviewBy, '2026-10-19');
    assert.equal(showJson(fx).journalMatches, true);
  } finally { fx.cleanup(); }
});

test('set without --review-by keeps the 90-day default', () => {
  const fx = makeFixture();
  try {
    assert.equal(rp(fx, SET).status, 0);
    assert.equal(profile(fx).rows.verify.reviewBy, '2027-01-10');
  } finally { fx.cleanup(); }
});

test('set --review-by refuses a past date, an unparseable date and a missing value, and writes nothing', () => {
  const fx = makeFixture();
  try {
    for (const bad of ['2026-10-11', 'tomorrow', '2026-02-30', '2026-13-01']) {
      const r = rp(fx, [...SET, '--review-by', bad]);
      assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
      assert.match(r.stderr, /--review-by/);
    }
    assert.equal(rp(fx, [...SET, '--review-by']).status, 2);
    assert.equal(showJson(fx).status, 'absent', 'no profile file was written');
    // today itself is allowed
    assert.equal(rp(fx, [...SET, '--review-by', '2026-10-12']).status, 0);
  } finally { fx.cleanup(); }
});

test('set --settled writes an adopted row with no review date; the journal matches', () => {
  const fx = makeFixture();
  try {
    const r = rp(fx, [...SET, '--settled', '--because', 'back to the previous rung']);
    assert.equal(r.status, 0, r.stderr);
    const row = profile(fx).rows.verify;
    assert.equal(row.state, 'adopted');
    assert.equal(row.reviewBy, null);
    assert.equal(row.source, 'operator-observed');
    assert.equal(row.model, 'sonnet');
    const s = showJson(fx);
    assert.equal(s.journalMatches, true);
    assert.match(s.rows[0].status, /^applies/);
  } finally { fx.cleanup(); }
});

test('--settled cannot be combined with --review-by', () => {
  const fx = makeFixture();
  try {
    const r = rp(fx, [...SET, '--settled', '--review-by', '2026-10-19']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /settled/);
  } finally { fx.cleanup(); }
});

const dueSignals = (fx, now) => {
  const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: now } });
  assert.equal(res.status, 0, res.stderr);
  return res.json.signals.filter((s) => s.kind === 'routing_trial_review_due' && /profile row/.test(s.detail));
};

test('scout: a profile trial row is due on its reviewBy, not before', () => {
  const fx = makeFixture();
  try {
    assert.equal(rp(fx, [...SET, '--review-by', '2026-10-19']).status, 0);
    assert.equal(dueSignals(fx, '2026-10-18T00:00:00.000Z').length, 0);
    const due = dueSignals(fx, '2026-10-19T00:00:00.000Z');
    assert.equal(due.length, 1);
    assert.match(due[0].detail, /^verify routing trial due for review/);
    assert.match(due[0].detail, /reviewBy 2026-10-19 has passed/);
  } finally { fx.cleanup(); }
});

test('scout: a settled row and a retired row never raise the trial-review signal', () => {
  const fx = makeFixture();
  try {
    assert.equal(rp(fx, [...SET, '--settled']).status, 0);
    assert.equal(dueSignals(fx, '2030-01-01T00:00:00.000Z').length, 0);
    assert.equal(rp(fx, [...SET, '--review-by', '2026-10-19']).status, 0);
    assert.equal(rp(fx, ['unset', 'verify']).status, 0);
    assert.equal(dueSignals(fx, '2030-01-01T00:00:00.000Z').length, 0);
  } finally { fx.cleanup(); }
});
