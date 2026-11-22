// 0.31.63: the spawn guard's API review route, driven through the real hook process (hooks/spawn-guard.mjs).
// The governor is "stubbed" by configuration, no module mocks and no network: a dummy key in a variable the key source names
// (the hook never reads or sends it) and api_credits_review_ratio 1, so decide() answers `api` from an empty ledger.
// The in-process cases (reasons, markers, ranges) are in tests/api-review-route.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, readJsonl } from './helpers.mjs';

const BRIEF = [
  'TYPE: code-review',
  'ROLE: reviewer',
  'WRITER: sonnet/high',
  'RISK: mid',
  '',
  'Review the invented change in zq-widget, branch feat/zq-widget, diff range base-line..head-line. Report findings only.',
].join('\n');

const ENV = {
  CLAUDE_PLUGIN_OPTION_API_REVIEW_ROUTE: 'all',
  CLAUDE_PLUGIN_OPTION_API_CREDITS_REVIEW_RATIO: '1',
  AC_API_KEY: 'dummy-not-a-real-key',
};

function spawn(dir, over = {}, env = {}) {
  return runHook('hooks/spawn-guard.mjs', {
    session_id: 'sess-api-route', agent_type: 'main', cwd: dir,
    tool_input: { subagent_type: 'agent-companion:ac-sonnet-high', model: 'sonnet', prompt: BRIEF, run_in_background: true, name: 'zq-rev', ...over },
  }, { env: { ...ENV, ...env } });
}
const lastRow = (stateDir) => { const r = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl')); return r[r.length - 1]; };
const rewrite = (res) => (res.json && res.json.hookSpecificOutput && res.json.hookSpecificOutput.updatedInput) || null;

test('a review the governor sends to the API is rewritten to the cheap rung, and the row says so', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = spawn(dir);
    assert.equal(res.status, 0, res.stderr);
    const u = rewrite(res);
    assert.ok(u, `expected an updatedInput rewrite, got ${res.stdout}`);
    assert.equal(u.subagent_type, 'agent-companion:ac-haiku');
    assert.equal(u.model, 'haiku');
    assert.match(u.prompt, /api-review\.mjs/);
    assert.match(u.prompt, /--diff-ref "base-line\.\.head-line"/);
    const r = lastRow(stateDir);
    assert.equal(r.review_route, 'api');
    assert.equal(r.review_route_reason, 'api');
    const briefs = readdirSync(join(stateDir, 'state', 'review-briefs'));
    assert.ok(briefs.some((f) => !f.endsWith('-review.md')), 'the original brief is kept for the runner');
  } finally { cleanup(); }
});

test('route off (the default) leaves the spawn alone and the row says off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const res = spawn(dir, {}, { CLAUDE_PLUGIN_OPTION_API_REVIEW_ROUTE: 'off' });
    assert.equal(res.status, 0, res.stderr);
    const u = rewrite(res);
    assert.ok(!u || u.subagent_type === 'agent-companion:ac-sonnet-high');
    const r = lastRow(stateDir);
    assert.equal(r.review_route, 'subagent');
    assert.equal(r.review_route_reason, 'off');
  } finally { cleanup(); }
});

test('a hard-denied spawn is never rewritten', () => {
  const { dir, cleanup } = makeFixture();
  try {
    // A foreground main-session spawn under foreground_guard=block is denied; the route step is skipped for it.
    const res = spawn(dir, { run_in_background: undefined }, { CLAUDE_PLUGIN_OPTION_FOREGROUND_GUARD: 'block' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json && res.json.hookSpecificOutput && res.json.hookSpecificOutput.permissionDecision, 'deny', res.stdout);
    assert.equal(rewrite(res), null);
  } finally { cleanup(); }
});

test('fail open: an exception in the route step leaves the input unchanged', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    // A file where the route step needs the review-briefs directory makes it throw after the governor said api.
    mkdirSync(join(stateDir, 'state'), { recursive: true });
    writeFileSync(join(stateDir, 'state', 'review-briefs'), 'not a directory');
    const res = spawn(dir);
    assert.equal(res.status, 0, res.stderr);
    const u = rewrite(res);
    assert.ok(!u || u.subagent_type === 'agent-companion:ac-sonnet-high', `input must not be rewritten: ${res.stdout}`);
    const r = lastRow(stateDir);
    assert.equal(r.review_route, 'subagent');
    assert.equal(r.review_route_reason, 'error');
  } finally { cleanup(); }
});
