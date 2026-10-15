// agent-companion runs from ONE install per machine: the user-scope record in
// installed_plugins.json. A project- or local-scope record (made when a project's
// tracked .claude/settings.json enables the plugin) is a stray copy: version.mjs
// reports it as "should not exist (user scope only)", never as STALE, and the
// scout raises ONE plugin_project_copy signal for all of them instead of
// plugin_version_behind / plugin_copy_stale. Every fixture lives in a makeFixture()
// home with placeholder paths; the real installed_plugins.json is never read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { HOUR, machine as buildMachine, FIXTURE_SHA } from './version-fixture.mjs';
import { collect, enablingSettingsFiles, strayCopies, STRAY_RULE } from '../scripts/version.mjs';

const NOW = Date.parse('2026-10-13T20:00:00.000Z');
const KEY = 'agent-companion@agent-templates';

function writeSettings(projectDir, file, json) {
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.claude', file), JSON.stringify(json));
}

// One user record (0.31.17, current) plus five project records at older
// versions. proj1 enables the plugin in settings.json, proj2 in
// settings.local.json; proj3 enables a different plugin; proj4 sets it false;
// proj5 has no settings file at all.
function strayMachine(dir, { user = '0.31.17', withUser = true } = {}) {
  const m = buildMachine(dir, NOW, { cli: user, desktop: null, marketplace: '0.31.17', publishedMsAgo: 30 * HOUR });
  const projects = [1, 2, 3, 4, 5].map((i) => join(dir, 'dev', `proj${i}`));
  for (const p of projects) mkdirSync(p, { recursive: true });
  writeSettings(projects[0], 'settings.json', { enabledPlugins: { [KEY]: true } });
  writeSettings(projects[1], 'settings.local.json', { enabledPlugins: { [KEY]: true } });
  writeSettings(projects[2], 'settings.json', { enabledPlugins: { 'other-plugin@agent-templates': true } });
  writeSettings(projects[3], 'settings.json', { enabledPlugins: { [KEY]: false } });
  const versions = ['0.30.0', '0.30.0', '0.31.13', '0.31.13', '0.30.0'];
  const records = projects.map((projectPath, i) => ({
    scope: i === 1 ? 'local' : 'project', projectPath, version: versions[i],
    installPath: join(m.claude, 'plugins', 'cache', 'agent-templates', 'agent-companion', versions[i]),
    installedAt: '2026-09-18T20:28:32.855Z', lastUpdated: '2026-09-20T18:46:41.054Z', gitCommitSha: FIXTURE_SHA,
  }));
  const user_ = withUser ? [{
    scope: 'user', installPath: m.cliPath, version: user,
    installedAt: '2026-09-18T20:28:32.855Z', lastUpdated: '2026-10-12T18:46:41.054Z', gitCommitSha: FIXTURE_SHA,
  }] : [];
  writeFileSync(join(m.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { [KEY]: [...user_, ...records] },
  }));
  return { ...m, projects };
}

const versionJson = (fx) => {
  const res = runScript('scripts/version.mjs', ['--json'], { cwd: fx.dir, timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  return res.json;
};

function detectSignals(fx, env = {}) {
  const res = runScript('scripts/detect.mjs', [], {
    cwd: fx.dir,
    env: { AGENT_COMPANION_FAKE_NOW: new Date(NOW).toISOString(), ...env },
    timeout: 90000,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, `detect.mjs printed no JSON: ${res.stdout}`);
  return res.json.signals;
}

test('version report: the user copy is current, five project/local records "should not exist", no STALE', () => {
  const fx = makeFixture();
  try {
    const m = strayMachine(fx.dir);
    const r = versionJson(fx);
    assert.equal(r.cli.length, 1, 'only the user-scope record is an install');
    assert.equal(r.cli[0].scope, 'user');
    assert.equal(r.cli[0].version, '0.31.17');
    assert.equal(r.projectCopies.length, 5);
    assert.deepEqual(r.projectCopies.map((p) => p.version), ['0.30.0', '0.30.0', '0.31.13', '0.31.13', '0.30.0']);
    assert.deepEqual(r.projectCopies.map((p) => p.scope), ['project', 'local', 'project', 'project', 'project']);
    assert.ok(r.copies.every((c) => !c.stale), 'no copy is judged stale');
    assert.equal(r.copies.filter((c) => c.kind === 'cli-cache').length, 1);
    assert.equal(r.verdict.ok, false);
    assert.deepEqual(r.verdict.stale, []);
    assert.equal(r.verdict.strayCopies, 5);
    assert.match(r.verdict.line, new RegExp(`^all copies current; 5 project- or local-scope records ${STRAY_RULE.replace(/[()]/g, '\\$&')}`));
    assert.doesNotMatch(r.verdict.line, /STALE/);

    const text = runScript('scripts/version.mjs', [], { cwd: fx.dir, timeout: 30000 }).stdout;
    assert.doesNotMatch(text, /STALE/);
    assert.equal(text.split('should not exist (user scope only)').length - 1, 6, 'five record lines plus the verdict');
    for (const p of m.projects) assert.ok(text.includes(p), `names ${p}`);
    assert.match(text, /Fix \(project record [^)]*proj1\):.*remove the `agent-companion@agent-templates` line from enabledPlugins in .*proj1.*settings\.json.*already enable it.*then remove this record from installed_plugins\.json/s);
    assert.match(text, /not `claude plugin uninstall`/);
  } finally { fx.cleanup(); }
});

test('version report: a project record names the settings file that recreates it, or says none does', () => {
  const fx = makeFixture();
  try {
    const m = strayMachine(fx.dir);
    const p = versionJson(fx).projectCopies;
    const norm = (s) => s.replace(/\\/g, '/');
    assert.deepEqual(p[0].settingsFiles.map(norm), [norm(join(m.projects[0], '.claude', 'settings.json'))]);
    assert.deepEqual(p[1].settingsFiles.map(norm), [norm(join(m.projects[1], '.claude', 'settings.local.json'))]);
    assert.deepEqual(p[2].settingsFiles, [], 'a different plugin enabled there is not ours');
    assert.deepEqual(p[3].settingsFiles, [], 'enabled:false does not recreate the record');
    assert.deepEqual(p[4].settingsFiles, [], 'no settings file at all');
    assert.match(p[0].fix, /remove the `agent-companion@agent-templates` line from enabledPlugins in .*settings\.json/);
    assert.match(p[4].fix, /^no settings file in that project enables the plugin now/);
    assert.equal(p.every((x) => x.projectPathExists), true);
  } finally { fx.cleanup(); }
});

test('enablingSettingsFiles: both files, truthy only, bad JSON and other plugins skipped', () => {
  const fx = makeFixture();
  try {
    const proj = join(fx.dir, 'dev', 'both');
    writeSettings(proj, 'settings.json', { enabledPlugins: { [KEY]: true, 'agent-companion@other-market': true } });
    writeSettings(proj, 'settings.local.json', { enabledPlugins: { [KEY]: true } });
    const found = enablingSettingsFiles(proj);
    assert.deepEqual(found.map((x) => x.key), [KEY, 'agent-companion@other-market', KEY]);
    assert.equal(found.length, 3);
    writeFileSync(join(proj, '.claude', 'settings.json'), '{ not json');
    assert.equal(enablingSettingsFiles(proj).length, 1);
    assert.deepEqual(enablingSettingsFiles(join(fx.dir, 'dev', 'missing')), []);
    assert.deepEqual(enablingSettingsFiles(''), []);
    assert.deepEqual(enablingSettingsFiles(null), []);
  } finally { fx.cleanup(); }
});

test('scout: no plugin_version_behind and no plugin_copy_stale from project records, ONE plugin_project_copy listing five paths', () => {
  const fx = makeFixture();
  try {
    const m = strayMachine(fx.dir);
    const sigs = detectSignals(fx);
    assert.equal(sigs.filter((s) => s.kind === 'plugin_version_behind').length, 0, JSON.stringify(sigs.filter((s) => /plugin/.test(s.kind))));
    assert.equal(sigs.filter((s) => s.kind === 'plugin_copy_stale').length, 0);
    assert.equal(sigs.filter((s) => s.kind === 'scout_copy_stale').length, 0);
    const hits = sigs.filter((s) => s.kind === 'plugin_project_copy');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.equal(hits[0].dispatch, 'plugin-project-copy');
    assert.match(hits[0].detail, /^5 project- or local-scope agent-companion records should not exist \(user scope only\)/);
    // The scout scrubs absolute paths out of every signal, so each record is
    // named by "repo root N" (or its worktree name) and the settings file by its name inside it.
    assert.match(hits[0].detail, /repo root 1 \(project scope, 0\.30\.0; recreated by \.claude\/settings\.json\)/);
    assert.match(hits[0].detail, /repo root 2 \(local scope, 0\.30\.0; recreated by \.claude\/settings\.local\.json\)/);
    assert.match(hits[0].detail, /repo root 3 \(project scope, 0\.31\.13; no enabling settings file found\)/);
    assert.match(hits[0].detail, /repo root 4 \(project scope, 0\.31\.13; no enabling settings file found\)/);
    assert.match(hits[0].detail, /repo root 5 \(project scope, 0\.30\.0; no enabling settings file found\)/);
    assert.match(hits[0].detail, /Full paths: run \/ac version\./);
    assert.equal((hits[0].detail.match(/no enabling settings file found/g) || []).length, 3);
    assert.match(hits[0].detail, /remove the agent-companion line from enabledPlugins/);
    assert.ok(m.projects.length === 5);
  } finally { fx.cleanup(); }
});

test('scout: project records alone (no user record) raise only plugin_project_copy', () => {
  const fx = makeFixture();
  try {
    strayMachine(fx.dir, { withUser: false });
    const sigs = detectSignals(fx);
    assert.deepEqual(sigs.filter((s) => /^plugin_|scout_copy_stale/.test(s.kind)).map((s) => s.kind), ['plugin_project_copy']);
  } finally { fx.cleanup(); }
});

test('scout: a user record that IS behind still raises plugin_version_behind and plugin_copy_stale, once each', () => {
  const fx = makeFixture();
  try {
    const m = buildMachine(fx.dir, NOW, { cli: '0.31.16', desktop: null, marketplace: '0.31.17', publishedMsAgo: 30 * HOUR });
    const proj = join(fx.dir, 'dev', 'proj1');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(m.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { [KEY]: [
        { scope: 'user', installPath: m.cliPath, version: '0.31.16', lastUpdated: '2026-10-12T18:46:41.054Z' },
        { scope: 'project', projectPath: proj, installPath: m.cliPath, version: '0.30.0', lastUpdated: '2026-09-20T18:46:41.054Z' },
      ] },
    }));
    const sigs = detectSignals(fx);
    const behind = sigs.filter((s) => s.kind === 'plugin_version_behind');
    assert.equal(behind.length, 1);
    assert.match(behind[0].detail, /\(user scope\) is installed at 0\.31\.16/);
    const stale = sigs.filter((s) => s.kind === 'plugin_copy_stale');
    assert.equal(stale.length, 1);
    assert.match(stale[0].detail, /CLI cache copy \(user scope\) is 0\.31\.16/);
    assert.equal(sigs.filter((s) => s.kind === 'plugin_project_copy').length, 1);
  } finally { fx.cleanup(); }
});

test('scout: only a user record, or none: no plugin_project_copy; the cloud is not judged', () => {
  const fx = makeFixture();
  try {
    assert.equal(detectSignals(fx).filter((s) => s.kind === 'plugin_project_copy').length, 0);
    buildMachine(fx.dir, NOW, { cli: '0.31.17', desktop: null, marketplace: '0.31.17', publishedMsAgo: 30 * HOUR });
    assert.equal(detectSignals(fx).filter((s) => s.kind === 'plugin_project_copy').length, 0);
    strayMachine(fx.dir);
    assert.equal(detectSignals(fx, { CLAUDE_CODE_REMOTE_SESSION_ID: 'cloud-session-1' }).filter((s) => s.kind === 'plugin_project_copy').length, 0);
  } finally { fx.cleanup(); }
});

test('a record with no scope and no projectPath is the user record; one with a projectPath and no scope is stray', () => {
  const fx = makeFixture();
  try {
    const m = buildMachine(fx.dir, NOW, { cli: '0.31.17', desktop: null, marketplace: '0.31.17', publishedMsAgo: 30 * HOUR });
    writeFileSync(join(m.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { [KEY]: [
        { installPath: m.cliPath, version: '0.31.17' },
        { projectPath: join(fx.dir, 'dev', 'x'), installPath: m.cliPath, version: '0.30.0' },
      ] },
    }));
    const r = collect({ claudeDirPath: m.claude, desktopRoots: [], now: NOW });
    assert.equal(r.cli.length, 1);
    assert.equal(r.projectCopies.length, 1);
    assert.equal(strayCopies(m.claude).length, 1);
  } finally { fx.cleanup(); }
});

test('a session running a project record\'s copy is not STALE-with-restart: the record is what should not exist', () => {
  const fx = makeFixture();
  try {
    const m = strayMachine(fx.dir);
    const r = collect({ root: join(m.claude, 'plugins', 'cache', 'agent-templates', 'agent-companion', '0.30.0'), claudeDirPath: m.claude, desktopRoots: [], now: NOW });
    assert.ok(r.copies.every((c) => !c.stale));
    assert.doesNotMatch(r.verdict.line, /STALE|restart the session/);
    const mine = r.copies.find((c) => c.isThis);
    assert.match(mine.label, /record, should not exist \(user scope only\)/);
  } finally { fx.cleanup(); }
});

test('project records and NO user record: the report says there is no user-scope install and to install it first', () => {
  const fx = makeFixture();
  try {
    strayMachine(fx.dir, { withUser: false });
    const r = versionJson(fx);
    assert.equal(r.cli.length, 0);
    assert.match(r.verdict.line, /^no user-scope install; 5 project- or local-scope records should not exist \(user scope only\)/);
    assert.doesNotMatch(r.verdict.line, /all copies current/);
    assert.match(r.projectCopies[0].fix, /^there is no user-scope install yet: run `claude plugin install agent-companion@agent-templates --scope user` first, then remove the /);
    const sigs = detectSignals(fx);
    const hit = sigs.find((s) => s.kind === 'plugin_project_copy');
    assert.match(hit.detail, /There is NO user-scope install: run claude plugin install agent-companion@agent-templates --scope user first\./);
    // with a user record the extra clause is absent
    const fx2 = makeFixture();
    try {
      strayMachine(fx2.dir);
      assert.doesNotMatch(detectSignals(fx2).find((s) => s.kind === 'plugin_project_copy').detail, /NO user-scope install/);
    } finally { fx2.cleanup(); }
  } finally { fx.cleanup(); }
});

test('a record whose project folder is gone (a removed worktree) says so instead of "no settings file"', () => {
  const fx = makeFixture();
  try {
    const m = buildMachine(fx.dir, NOW, { cli: '0.31.17', desktop: null, marketplace: '0.31.17', publishedMsAgo: 30 * HOUR });
    writeFileSync(join(m.claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { [KEY]: [
        { scope: 'user', installPath: m.cliPath, version: '0.31.17' },
        { scope: 'project', projectPath: join(fx.dir, 'dev', 'gone-worktree'), installPath: m.cliPath, version: '0.30.0' },
      ] },
    }));
    const [p] = strayCopies(m.claude);
    assert.equal(p.projectPathExists, false);
    assert.match(p.fix, /^that project folder no longer exists \(a removed worktree\): remove this record from installed_plugins\.json/);
  } finally { fx.cleanup(); }
});

// ---- docs: no project-scope install advice anywhere in the plugin ----------

function mdFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) mdFiles(p, out);
    else if (name.endsWith('.md') && name !== 'CHANGELOG.md') out.push(p);
  }
  return out;
}

test('no plugin doc or skill suggests a project- or local-scope install; setup says user scope only', () => {
  for (const f of mdFiles(PLUGIN_ROOT)) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /--scope[ =](project|local)\b/, `${f} advises a project/local scope`);
    assert.doesNotMatch(text, /claude plugin (install|update) [^\n`]*(project|local) scope/i, `${f} advises a project/local scope`);
  }
  const setup = readFileSync(join(PLUGIN_ROOT, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(setup, /user scope only/);
  assert.match(setup, /enabledPlugins/);
  assert.match(setup, /their user settings already enable|user settings already enable/);
  assert.match(setup, /--scope user/);
  const routine = readFileSync(join(PLUGIN_ROOT, 'routines', 'calibration-scout-daily.md'), 'utf8');
  for (const line of routine.split('\n').filter((l) => /claude plugin (install|update) agent-companion/.test(l))) {
    assert.match(line, /--scope user/, `scout install/update step must name user scope: ${line}`);
  }
  assert.match(routine, /\| `plugin_project_copy` \|/, 'a dispatch row for the signal');
});
