// 0.31.22 scout-triage fixes: project_agent_drift naming and de-duplication, routine_model_drift
// skipping finished one-off tasks, and the spawn row's cwd / project_root / project_dir_env plus
// the CLAUDE_PROJECT_DIR fallback for project agents. Synthetic fixtures only.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { makeFixture, runScript, runHook, readJsonl } from './helpers.mjs';
import { resolveRoute, projectAgentRoots, resolvedProjectRoot, pathKey } from '../hooks/lib/context.mjs';

const put = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const driftAgent = (dir, name, fm) => {
  const lines = Object.entries({ name, description: `${name} agent`, ...fm }).map(([k, v]) => `${k}: ${v}`);
  put(join(dir, '.claude', 'agents', `${name}.md`), `---\n${lines.join('\n')}\n---\n\nBody.\n`);
};

// --- project_agent_drift ------------------------------------------------------------------
function driftSignal(fx, cwd, projects) {
  const cj = join(fx.dir, 'claude.json');
  writeFileSync(cj, JSON.stringify({ projects: Object.fromEntries(projects.map((p) => [p, {}])) }));
  const res = runScript('scripts/detect.mjs', [], {
    cwd, env: { AGENT_COMPANION_DISCOVERY_CLAUDE_JSON: cj, AGENT_COMPANION_CI_STATUS_NO_GH: '1' }, timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  return res.json.signals.find((s) => s.kind === 'project_agent_drift');
}

test('project_agent_drift: a repo root is named "repo root", a worktree by its tree, and a root listed in both slash forms once', () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'proj-a');
    const tree = join(fx.dir, 'proj-a', '.claude', 'worktrees', 'tree-one');
    const clean = join(fx.dir, 'clean');
    for (const d of [root, tree]) driftAgent(d, 'debugger', { model: 'sonnet', effort: 'high', routingType: 'debug-root-cause' });
    const exp = resolveRoute({ type: 'explore', profile: false });
    driftAgent(clean, 'explorer', { model: exp.model, effort: exp.effort, routingType: 'explore' });
    const slashes = root.replace(/\//g, '\\');
    const s = driftSignal(fx, clean, [root, slashes, tree]);
    assert.ok(s);
    assert.match(s.detail, /^2 project\(s\)/, s.detail);
    assert.match(s.detail, /repo root: /);
    assert.match(s.detail, /tree-one: /);
    assert.doesNotMatch(s.detail, /<name>|proj-a:/);
    assert.equal((s.detail.match(/repo root/g) || []).length, 1, 'the root is listed once');
  } finally { fx.cleanup(); }
});

// --- routine_model_drift ------------------------------------------------------------------
test('routine_model_drift: a disabled one-time task whose fire time has passed raises no signal; a live unpinned task still does', () => {
  const fx = makeFixture();
  try {
    const sessions = join(fx.dir, 'sessions');
    const skill = (name) => {
      const f = join(fx.dir, '.claude', 'scheduled-tasks', name, 'SKILL.md');
      put(f, `---\nname: ${name}\ndescription: d\n---\nBody\n`);
      const t = new Date(Date.now() - 2 * 3600 * 1000); utimesSync(f, t, t);
    };
    let n = 0;
    const record = (task) => {
      const id = `local_${String(++n).padStart(8, '0')}-0000`;
      put(join(sessions, 'acct', 'org', `${id}.json`), JSON.stringify({
        sessionId: id, scheduledTaskId: task, createdAt: Date.now() - 3600 * 1000, model: 'claude-sonnet-5-5', effort: 'low', cwd: join(fx.dir, 'nowhere'),
      }));
    };
    skill('one-off'); skill('cron-task'); skill('future-once');
    record('one-off'); record('cron-task'); record('future-once');
    put(join(sessions, 'acct', 'org', 'scheduled-tasks.json'), JSON.stringify({ scheduledTasks: [
      { id: 'one-off', enabled: false, fireAt: Date.now() - 3600 * 1000 },
      { id: 'cron-task', enabled: true, cronExpression: '0 4 * * *' },
      { id: 'future-once', enabled: false, fireAt: Date.now() + 86400000 },
    ] }));
    const res = runScript('scripts/detect.mjs', [], { cwd: fx.dir, env: { AGENT_COMPANION_SESSIONS_DIR: sessions }, timeout: 90000 });
    assert.equal(res.status, 0, res.stderr);
    const hits = res.json.signals.filter((s) => s.kind === 'routine_model_drift');
    assert.equal(hits.length, 1);
    assert.match(hits[0].detail, /cron-task/);
    assert.match(hits[0].detail, /future-once/);
    assert.doesNotMatch(hits[0].detail, /one-off/);
  } finally { fx.cleanup(); }
});

// --- spawn rows: cwd, project root, and the moved-cwd lookup -------------------------------
let counter = 0;
function spawn(fx, cwd, env) {
  counter += 1;
  const sid = `sess-1016-${process.pid}-${counter}`;
  const res = runHook('hooks/spawn-guard.mjs', {
    session_id: sid, agent_type: 'main', cwd,
    tool_input: { subagent_type: 'proj-architect', run_in_background: true, name: `w${counter}`, prompt: 'TYPE: bounded-feature\nROLE: writer\ndo it' },
  }, { env: { CLAUDE_PLUGIN_DATA: join(fx.dir, '.claude', 'plugins', 'data', 'agent-companion-x'), ...(env || {}) } });
  assert.equal(res.status, 0, res.stderr);
  return readJsonl(join(fx.stateDir, 'telemetry', 'spawns.jsonl')).filter((r) => r.session_id === sid).pop();
}

test('spawn row records cwd and project_root; a cwd that moved out of the project finds the agent through CLAUDE_PROJECT_DIR', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'proj');
    mkdirSync(join(proj, '.git'), { recursive: true });
    put(join(proj, '.claude', 'agents', 'proj-architect.md'), '---\nname: proj-architect\nmodel: opus\neffort: xhigh\n---\nbody\n');
    const moved = join(fx.dir, 'elsewhere', 'nogit');
    mkdirSync(moved, { recursive: true });

    const inside = spawn(fx, join(proj, 'src'), { CLAUDE_PROJECT_DIR: '' });
    mkdirSync(join(proj, 'src'), { recursive: true });
    const ok = spawn(fx, proj, { CLAUDE_PROJECT_DIR: '' });
    assert.equal(ok.cwd, pathKey(proj));
    assert.equal(ok.project_root, pathKey(proj));
    assert.equal(ok.project_dir_env, null);
    assert.equal(ok.project_pinned, true);
    assert.ok(inside.cwd);
    for (const k of [ok.cwd, ok.project_root, inside.cwd]) assert.match(k, /^path:[0-9a-f]{12}$/, 'rows carry path keys, never a path');

    // Reproduction of the 2026-10-15 miss: the lead's cwd is a folder with no .git and no agents.
    const miss = spawn(fx, moved, { CLAUDE_PROJECT_DIR: '' });
    assert.equal(miss.cwd, pathKey(moved));
    assert.equal(miss.project_root, null);
    assert.equal(miss.project_pinned, false, 'without the session project folder the definition is not found');

    // The fix: the harness's project folder is searched too.
    const found = spawn(fx, moved, { CLAUDE_PROJECT_DIR: proj });
    assert.equal(found.cwd, pathKey(moved));
    assert.equal(found.project_root, pathKey(proj));
    assert.equal(found.project_dir_env, pathKey(proj));
    assert.equal(found.project_pinned, true);
    assert.equal(found.pin_scope, 'project');
  } finally { fx.cleanup(); }
});

test('projectAgentRoots adds CLAUDE_PROJECT_DIR before the user folder and resolvedProjectRoot stays null without a repo', () => {
  const fx = makeFixture();
  const prev = process.env.CLAUDE_PROJECT_DIR;
  try {
    const proj = join(fx.dir, 'proj2');
    mkdirSync(proj, { recursive: true });
    const bare = join(fx.dir, 'bare');
    mkdirSync(bare, { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = proj;
    const norm = (p) => p.replace(/\\/g, '/');
    const roots = projectAgentRoots(bare).map(norm);
    assert.ok(roots.includes(norm(join(proj, '.claude', 'agents'))));
    assert.equal(roots[roots.length - 1], norm(join(fx.dir, '.claude', 'agents')), 'the user folder stays last');
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolvedProjectRoot(bare), null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
    fx.cleanup();
  }
});
