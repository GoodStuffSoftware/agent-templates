// S4b: SessionStart also fires inside a subagent that compacts, with the same
// payload shape plus agent_id. The lead's own session-start text must not be
// injected again there (measured 2026-10-06: 462 fires in 280 subagent files,
// mean 5,138 chars). Every agent-companion SessionStart hook is covered here:
// the ones that already skipped (capacity-probe, scout-surface, the standing
// rules' lead-only audience) and the ones fixed with this change
// (memory-budget, self-update, ladder-check, git-brief session-start).
// read-dedupe's reset injects nothing; it only clears the worker's own record.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixture, runHook } from './helpers.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';

function lead(dir, extra = {}) {
  return { session_id: 'sess-s4b', source: 'compact', cwd: dir, hook_event_name: 'SessionStart', ...extra };
}
const worker = (dir, extra = {}) => lead(dir, { agent_id: 'agent-s4b', agent_type: 'general-purpose', ...extra });
const quiet = (r) => assert.equal((r.stdout || '').trim(), '', `expected no output, got: ${r.stdout}`);

function bigClaudeMd(dir) {
  writeFileSync(join(dir, 'CLAUDE.md'), `# Rules\n${'A long standing rule that costs tokens.\n'.repeat(400)}`);
}

test('memory-budget: the lead gets its notice, a compacting subagent gets nothing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    bigClaudeMd(dir);
    const l = runHook('hooks/memory-budget.mjs', lead(dir), { cwd: dir });
    assert.equal(l.status, 0, l.stderr);
    assert.ok(l.json?.hookSpecificOutput?.additionalContext || l.json?.systemMessage, `control must produce a notice: ${l.stdout}`);
    quiet(runHook('hooks/memory-budget.mjs', worker(dir), { cwd: dir }));
  } finally { cleanup(); }
});

test('git-brief session-start: the lead gets its line, a compacting subagent does not; subagent-start still does', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const env = { AC_GIT_BRIEF_LOCAL_TIMEOUT_MS: '60000' };
    // A throwaway repository with one commit and no remote: no fetch, no network.
    const ident = { GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const here = join(dir, 'repo');
    mkdirSync(here, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'seed']]) {
      const r = spawnSync('git', args, { cwd: here, encoding: 'utf8', windowsHide: true, env: { ...cleanGitEnv(), ...ident } });
      assert.equal(r.status, 0, r.stderr);
    }
    const l = runHook('hooks/git-brief.mjs', lead(here), { args: ['--event', 'session-start'], env });
    assert.ok(l.json?.hookSpecificOutput?.additionalContext?.startsWith('Git:'), `control: ${l.stdout} ${l.stderr}`);
    quiet(runHook('hooks/git-brief.mjs', worker(here), { args: ['--event', 'session-start'], env }));
    const s = runHook('hooks/git-brief.mjs', worker(here), { args: ['--event', 'subagent-start'], env });
    assert.equal(s.json?.hookSpecificOutput?.hookEventName, 'SubagentStart', `the start event keeps its line: ${s.stdout}`);
  } finally { cleanup(); }
});

test('self-update: a compacting subagent gets nothing and records no session state', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    quiet(runHook('hooks/self-update.mjs', worker(dir), { cwd: dir }));
    const files = existsSync(stateDir) ? readdirSync(stateDir) : [];
    assert.deepEqual(files.filter((f) => /update|session|version/i.test(f)), [], `no per-session state for a worker: ${files}`);
  } finally { cleanup(); }
});

test('ladder-check: a compacting subagent is not a process load and gets no notice', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const env = { CLAUDE_PID: '424242' };
    const w = runHook('hooks/ladder-check.mjs', worker(dir), { cwd: dir, env });
    quiet(w);
    assert.equal(existsSync(join(stateDir, 'state', 'process-loads')), false, 'a worker must not write the process-load record');
    // Control: the lead's own SessionStart does write it.
    runHook('hooks/ladder-check.mjs', lead(dir, { source: 'startup' }), { cwd: dir, env });
    assert.equal(existsSync(join(stateDir, 'state', 'process-loads')), true, 'control: the lead records its load');
  } finally { cleanup(); }
});

test('capacity-probe and scout-surface already stay silent for a compacting subagent', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    mkdirSync(stateDir, { recursive: true });
    quiet(runHook('hooks/capacity-probe.mjs', worker(dir), { cwd: dir }));
    quiet(runHook('hooks/scout-surface.mjs', worker(dir), { cwd: dir }));
  } finally { cleanup(); }
});

test('standing-rules session-start: a subagent gets worker rules only, never the orchestration text', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const l = runHook('hooks/standing-rules.mjs', lead(dir), { cwd: dir, args: ['--event', 'session-start'] });
    const w = runHook('hooks/standing-rules.mjs', worker(dir), { cwd: dir, args: ['--event', 'session-start'] });
    const lt = l.json?.hookSpecificOutput?.additionalContext || '';
    const wt = w.json?.hookSpecificOutput?.additionalContext || '';
    assert.match(lt, /orchestrator/i, 'control: the lead gets the orchestration rule');
    assert.doesNotMatch(wt, /orchestrator|spawn|effort/i, `a worker must not get the lead's rules: ${wt}`);
    assert.ok(wt.length < lt.length, 'the worker text is shorter');
  } finally { cleanup(); }
});

test('read-dedupe reset: a subagent compaction clears only its own record and injects nothing', () => {
  const { dir, cleanup } = makeFixture();
  try {
    quiet(runHook('hooks/read-dedupe.mjs', worker(dir), { cwd: dir, args: ['--event', 'reset'] }));
  } finally { cleanup(); }
});
