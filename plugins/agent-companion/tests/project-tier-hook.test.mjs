// hooks/project-tier.mjs: the SessionStart line naming the project's tier. One line for a lead session,
// nothing for a subagent or cloud session, valid JSON every time, silent when the file turns it off.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';
import { tiersPath } from '../hooks/lib/project-tier.mjs';

function withRepo(config, fn) {
  const fx = makeFixture();
  try {
    const repo = join(fx.dir, 'work', 'acme-app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    if (config !== undefined) writeFileSync(tiersPath(), typeof config === 'string' ? config : JSON.stringify(config));
    return fn({ ...fx, repo });
  } finally {
    fx.cleanup();
  }
}

const start = (cwd, extra = {}) => ({ session_id: 'sess-pt-1', hook_event_name: 'SessionStart', source: 'startup', cwd, ...extra });
const ctx = (res) => res.json?.hookSpecificOutput?.additionalContext;

test('a lead session gets one SessionStart line: the project and its assigned tier', () => withRepo({ projects: { 'acme-app': 'gates' } }, ({ repo }) => {
  const res = runHook('hooks/project-tier.mjs', start(repo));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.hookSpecificOutput.hookEventName, 'SessionStart');
  const line = ctx(res);
  assert.match(line, /^\[agent-companion\] Project acme-app, project_tier gates \(Full gates\): low = /);
  assert.ok(!line.includes('\n'), 'one line');
  assert.match(line, /E2E once per batch and tree, never per change\.$/);
}));

test('each tier has its own line, and no config file means tier risk', () => {
  withRepo({ projects: { 'acme-app': 'push' } }, ({ repo }) => {
    assert.match(ctx(runHook('hooks/project-tier.mjs', start(repo))), /project_tier push \(Push on your word\)/);
  });
  withRepo(undefined, ({ repo }) => {
    const res = runHook('hooks/project-tier.mjs', start(repo));
    assert.equal(res.status, 0, res.stderr);
    assert.match(ctx(res), /Project acme-app, project_tier risk \(Risk-tiered\)/);
  });
});

test('outside a git repo there is no session line: nothing, as valid JSON, on every SessionStart source', () => withRepo({ default: 'gates' }, ({ dir, repo }) => {
  const plain = join(dir, 'plain');
  mkdirSync(plain, { recursive: true });
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    const res = runHook('hooks/project-tier.mjs', start(plain, { source }));
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(res.json, {}, source);
  }
  // the same session inside the repo still gets its line again after a resume, clear or compaction (SessionStart fires on each)
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.match(ctx(runHook('hooks/project-tier.mjs', start(repo, { source }))), /^\[agent-companion\] Project acme-app, project_tier gates/, source);
  }
}));

test('a subagent session gets nothing, as valid JSON', () => withRepo(undefined, ({ repo }) => {
  const res = runHook('hooks/project-tier.mjs', start(repo, { agent_id: 'agent-123', agent_type: 'general-purpose' }));
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.json, {});
  const viaTranscript = runHook('hooks/project-tier.mjs', start(repo, { transcript_path: '/p/s/subagents/agent-1.jsonl' }));
  assert.deepEqual(viaTranscript.json, {});
}));

test('a cloud session gets nothing', () => withRepo(undefined, ({ repo }) => {
  const res = runHook('hooks/project-tier.mjs', start(repo), { env: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.json, {});
}));

test('sessionLine false in the file turns the line off; reviewEveryChange rewrites the no-reviewer cells', () => {
  withRepo({ sessionLine: false }, ({ repo }) => {
    assert.deepEqual(runHook('hooks/project-tier.mjs', start(repo)).json, {});
  });
  withRepo({ default: 'push', reviewEveryChange: true }, ({ repo }) => {
    const line = ctx(runHook('hooks/project-tier.mjs', start(repo)));
    assert.doesNotMatch(line, /no reviewer/);
    assert.match(line, /low = one reviewer reads, then push/);
  });
});

test('a malformed file, bad stdin and a missing cwd never break the session', () => {
  withRepo('{ nope', ({ repo }) => {
    const res = runHook('hooks/project-tier.mjs', start(repo));
    assert.equal(res.status, 0, res.stderr);
    assert.match(ctx(res), /project_tier risk/);
  });
  withRepo(undefined, () => {
    const bad = runHook('hooks/project-tier.mjs', undefined);
    assert.equal(bad.status, 0, bad.stderr);
    assert.ok(bad.json === null || typeof bad.json === 'object');
    const noCwd = runHook('hooks/project-tier.mjs', { session_id: 's', hook_event_name: 'SessionStart' });
    assert.equal(noCwd.status, 0, noCwd.stderr);
  });
});

test('hooks.json registers it once, under SessionStart, with a timeout', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const hits = [];
  for (const [event, entries] of Object.entries(hooks)) {
    for (const e of entries) for (const h of e.hooks || []) if ((h.args || []).some((a) => a.endsWith('/hooks/project-tier.mjs'))) hits.push({ event, h });
  }
  assert.equal(hits.length, 1);
  assert.equal(hits[0].event, 'SessionStart');
  assert.ok(hits[0].h.timeout > 0);
});
