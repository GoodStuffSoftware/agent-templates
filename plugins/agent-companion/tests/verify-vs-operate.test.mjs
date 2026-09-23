// Calibration: "haiku validates, it does not OPERATE" (team-orchestration
// skill; CONTRIBUTIONS_INBOX @ 9b355e7). Two task types encode the distinction
// so recommend.mjs routes them, not taste:
//   - `verify`  — read/confirm/screenshot, nothing changes -> weight 1, haiku
//   - `operate` — an ordered procedure or a change to a live system, even when
//                 every step looks trivial in isolation -> weight >= 3, sonnet+
import test from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from './helpers.mjs';

test('recommend --type verify routes to haiku (weight 1, no effort)', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'verify', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'haiku');
  assert.equal(res.json.weight, 1);
  assert.equal(res.json.premium, false);
});

test('recommend --type operate routes to sonnet at weight >= 3, never haiku', () => {
  const res = runScript('scripts/recommend.mjs', ['--type', 'operate', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.model, 'sonnet');
  assert.ok(res.json.weight >= 3, `operate weight ${res.json.weight} must be >= 3`);
});

test('a trivial-looking multi-step procedure against a live system must not resolve to weight 1/haiku', () => {
  // The whole point of the distinction: "each step looks trivial" is not a
  // reason to route at verify's weight. Simulate by weight alone (3) with no
  // task type, matching what `operate` resolves to.
  const res = runScript('scripts/recommend.mjs', ['--weight', '3', '--json']);
  assert.equal(res.status, 0, res.stderr);
  assert.notEqual(res.json.model, 'haiku');
});

test('--list includes both new task types with distinct weights', () => {
  const res = runScript('scripts/recommend.mjs', ['--list']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\bverify\s+w=1\b/);
  assert.match(res.stdout, /\boperate\s+w=3\b/);
});
