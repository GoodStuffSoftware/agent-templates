// Ladder track rounds 2-4: the daily scout's cross-session version checks.
//
// spawn-guard.mjs stamps guard_version / guard_source / guard_scope /
// loaded_at into every spawns.jsonl row, and scripts/detect.mjs judges each
// session by the version it LOADED against what was installed when it loaded
// (round 4: two signals):
//   - stale_copy_loaded (high): loaded after a newer version was installed,
//     yet runs the older guard: a stale copy, remedy remove the stale entry;
//   - session_outdated (low): loaded before the latest install and still on
//     it: an old session, remedy restart or /reload-plugins; quiet under a
//     day old or fewer than two updates behind;
//   - an unknown load time is only counted (session_load_unknown).
// This is the only channel that sees a session whose own hooks are all stale
// (the 2026-09-24 incident, replayed below from a sanitised fixture).
//
// plugin_version_behind: compares the installed version against the latest
// AVAILABLE one (the marketplace clone locally, the routine's own checkout in
// the cloud), directionally; never against whichever checkout runs the scout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { spawnSync } from 'node:child_process';
import { scopeKey } from '../hooks/lib/context.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const CACHE_REL = ['.claude', 'plugins', 'cache', 'agent-templates', 'agent-companion'];

function writeInstalled(dir, list, key = 'agent-companion@agent-templates') {
  mkdirSync(join(dir, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [key]: list } }));
}
// Plugin cache version dirs, as the harness leaves them: a superseded
// version carries `.orphaned_at` (ms since epoch) from when it was replaced.
function writeCache(dir, list) {
  for (const { version, orphanedMsAgo } of list) {
    const d = join(dir, ...CACHE_REL, version);
    mkdirSync(join(d, '.claude-plugin'), { recursive: true });
    writeFileSync(join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'agent-companion', version }));
    if (orphanedMsAgo !== null && orphanedMsAgo !== undefined) writeFileSync(join(d, '.orphaned_at'), String(Date.now() - orphanedMsAgo));
  }
}
const installPath = (dir, v) => join(dir, ...CACHE_REL, v);

// A row shaped like the current guard's, with the stamp fields.
function row(sessionId, msAgo, stamp) {
  return {
    v: 2, at: iso(msAgo), session_id: sessionId, model: 'opus', subagent_type: 'general-purpose',
    route_layer: null, declared_type: null, effective_effort: 'inherited(high)', fit_trial: false, route_profile_rev: null,
    ...stamp,
  };
}
const stamp = (guard, loadedMsAgo, extra = {}) => ({
  guard_version: guard, guard_source: 'cache', guard_scope: 'user',
  loaded_at: loadedMsAgo === null ? null : iso(loadedMsAgo), ...extra,
});
// A row shaped like a pre-0.29.0 guard's: no route_layer and no stamp keys at all.
function legacyRow(sessionId, msAgo) {
  return { v: 2, at: iso(msAgo), session_id: sessionId, model: 'opus', subagent_type: 'general-purpose', inherited: false };
}

function writeSpawns(stateDir, rows) {
  const t = join(stateDir, 'telemetry');
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, 'spawns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeLoadState(stateDir, records) {
  const s = join(stateDir, 'state');
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'version-notice-state.json'), JSON.stringify(records));
}

function runDetect(dir, { script = 'scripts/detect.mjs', env = {} } = {}) {
  const res = runScript(script, [], { cwd: dir, env, timeout: 60000 });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.json, `detect.mjs printed no JSON: ${res.stdout}`);
  return res.json.signals;
}
const find = (signals, kind) => signals.filter((s) => s.kind === kind);
const STALE = 'stale_copy_loaded';
const OUTDATED = 'session_outdated';
const UNKNOWN = 'session_load_unknown';
const REMOVE_ENTRY = /remove the stale agent-companion entry in the desktop plugin manager/;
const versionSignals = (signals) => signals.filter((s) => [STALE, OUTDATED, UNKNOWN].includes(s.kind));

test('after a normal update, nothing is judged stale: pre-update rows, a session open across the update, fresh sessions on the new version', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: installPath(dir, '0.29.2'), lastUpdated: iso(2 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: 2 * HOUR }, { version: '0.29.2' }]);
    writeSpawns(stateDir, [
      row('aaaaaaaa-pre-update', 3 * HOUR, stamp('0.29.1', 4 * HOUR)),
      row('bbbbbbbb-straddler', 3 * HOUR, stamp('0.29.1', 5 * HOUR)),
      row('bbbbbbbb-straddler', 1 * HOUR, stamp('0.29.1', 5 * HOUR)),
      // Same straddler shape, load time unknown: neither signal, only a count.
      row('bbbbbbbq-straddler-unknown', 1 * HOUR, stamp('0.29.1', null)),
      row('cccccccc-fresh', 0.5 * HOUR, stamp('0.29.2', 1 * HOUR)),
    ]);
    const signals = runDetect(dir);
    assert.deepEqual(find(signals, STALE), []);
    assert.deepEqual(find(signals, OUTDATED), []);
    const unknown = find(signals, UNKNOWN);
    assert.equal(unknown.length, 1, JSON.stringify(unknown));
    assert.match(unknown[0].detail, /^1 sessions with unknown load time/);
    assert.doesNotMatch(unknown[0].detail, /remedy|reload|restart|remove/i);
    assert.equal(unknown[0].dispatch, 'none');
  } finally {
    cleanup();
  }
});

test('the normal-update fixture: a session that loads 0.29.1 just before the update and first spawns after it says nothing', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: installPath(dir, '0.29.2'), lastUpdated: iso(3 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: 3 * HOUR }, { version: '0.29.2' }]);
    writeSpawns(stateDir, [
      // Loaded 1 minute before the update; every spawn is after it.
      row('11111111-loads-before', 2.5 * HOUR, stamp('0.29.1', 3 * HOUR + MIN)),
      row('11111111-loads-before', 1 * HOUR, stamp('0.29.1', 3 * HOUR + MIN)),
      // The startup autoupdater's race: the load is stamped 1 minute AFTER the
      // entry changed (and the marker was written), inside the settle window.
      row('22222222-autoupdate-race', 2 * HOUR, stamp('0.29.1', 3 * HOUR - MIN)),
    ]);
    assert.deepEqual(versionSignals(runDetect(dir)), []);
  } finally {
    cleanup();
  }
});

test('a dev checkout newer than installed is never called stale (nor a newer cache copy, nor an older checkout)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: installPath(dir, '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.0', orphanedMsAgo: 5 * HOUR }, { version: '0.29.1' }]);
    writeSpawns(stateDir, [
      row('dddddddd-dev', 1 * HOUR, stamp('0.29.3', 2 * HOUR, { guard_source: 'checkout' })),
      row('eeeeeeee-newer-cache', 1 * HOUR, stamp('0.29.3', 2 * HOUR)),
      row('ffffffff-old-dev', 1 * HOUR, stamp('0.28.0', 2 * HOUR, { guard_source: 'checkout' })),
    ]);
    assert.deepEqual(versionSignals(runDetect(dir)), []);
  } finally {
    cleanup();
  }
});

test('stale_copy_loaded: a new session loaded after 0.29.3 was installed but running 0.29.2 (both stamp), with the remove-entry remedy', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(3 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.2', orphanedMsAgo: 3 * HOUR }, { version: '0.29.3' }]);
    writeSpawns(stateDir, [
      row('12345678-stale-session', 1 * HOUR, stamp('0.29.2', 2 * HOUR)),
      row('12345678-stale-session', 0.5 * HOUR, stamp('0.29.2', 2 * HOUR)),
    ]);
    const signals = runDetect(dir);
    const hits = find(signals, STALE);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /2 spawn\(s\) in 24h from 1 session/);
    assert.match(hits[0].detail, /guard 0\.29\.2 < 0\.29\.3, installed when it loaded \(user scope\)/);
    assert.match(hits[0].detail, /session 12345678/);
    assert.match(hits[0].detail, /Remedy: remove the stale agent-companion entry in the desktop plugin manager, then \/reload-plugins, then verify with a trivial ladder spawn; fresh session if that still fails\./);
    assert.equal(hits[0].dispatch, 'plugin-update');
    assert.equal(hits[0].severity, 'high');
    assert.deepEqual(find(signals, OUTDATED), []);
  } finally {
    cleanup();
  }
});

test('stale_copy_loaded from the cache: the guard\'s own version had already been replaced when the session loaded, even one update behind', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    // 0.29.2 -> 0.29.3 ten hours ago, 0.29.3 -> 0.29.4 three hours ago. The
    // session loaded 5 h ago, while 0.29.3 was installed, yet runs 0.29.2.
    writeInstalled(dir, [{ scope: 'user', version: '0.29.4', installPath: installPath(dir, '0.29.4'), lastUpdated: iso(3 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.2', orphanedMsAgo: 10 * HOUR }, { version: '0.29.3', orphanedMsAgo: 3 * HOUR }, { version: '0.29.4' }]);
    writeSpawns(stateDir, [
      row('23456789-cache-proof', 1 * HOUR, stamp('0.29.2', 5 * HOUR)),
      // Loaded 0.29.3 while 0.29.3 was installed: an old session, not a stale copy.
      row('34567890-just-old', 1 * HOUR, stamp('0.29.3', 5 * HOUR)),
    ]);
    const signals = runDetect(dir);
    const hits = find(signals, STALE);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /session 23456789: guard 0\.29\.2 < 0\.29\.3, installed when it loaded; 0\.29\.2 had already been replaced/);
    assert.doesNotMatch(hits[0].detail, /34567890/);
    assert.deepEqual(find(signals, OUTDATED), []); // 5 h old: quiet
  } finally {
    cleanup();
  }
});

// R3-1: an ordinary session left open across several quick updates is not a stale copy.
for (const [label, gapMin] of [['23 min', 23], ['3 min', 3]]) {
  test(`two updates ${label} apart: a session loaded before both is not a stale copy (trusted and unknown load time)`, () => {
    const { dir, stateDir, cleanup } = makeFixture();
    try {
      const second = 1 * HOUR;
      const first = second + gapMin * MIN;
      writeInstalled(dir, [{ scope: 'user', version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(second) }]);
      writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: first }, { version: '0.29.2', orphanedMsAgo: second }, { version: '0.29.3' }]);
      writeSpawns(stateDir, [
        row('45678901-two-updates', 0.5 * HOUR, stamp('0.29.1', 5 * HOUR)),
        row('45678902-two-updates-unknown', 0.5 * HOUR, stamp('0.29.1', null)),
        // Loaded between the two updates, running what was installed then.
        row('45678903-between', 0.5 * HOUR, stamp('0.29.2', first - MIN)),
      ]);
      const signals = runDetect(dir);
      assert.deepEqual(find(signals, STALE), []);
      assert.deepEqual(find(signals, OUTDATED), []);
      assert.match(find(signals, UNKNOWN)[0]?.detail || '', /^1 sessions with unknown load time/);
    } finally {
      cleanup();
    }
  });
}

test('one update touching two scopes: another scope\'s marker is never taken as this session\'s stale proof, and counts as one update', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const project = join(dir, 'proj');
    // user 0.29.1 -> 0.29.3, then project 0.29.2 -> 0.29.3 a minute later.
    writeInstalled(dir, [
      { scope: 'user', version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(2 * HOUR) },
      { scope: 'project', projectPath: project, version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(2 * HOUR - MIN) },
    ]);
    writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: 2 * HOUR }, { version: '0.29.2', orphanedMsAgo: 2 * HOUR - MIN }, { version: '0.29.3' }]);
    const projectScope = scopeKey({ scope: 'project', projectPath: project });
    writeSpawns(stateDir, [
      // A user-scope session on 0.29.1, loaded 30 h ago: old, and one update behind.
      row('56789012-user-old', 1 * HOUR, stamp('0.29.1', 30 * HOUR)),
      row('56789013-user-recent', 1 * HOUR, stamp('0.29.1', 5 * HOUR)),
      row('56789014-project-old', 1 * HOUR, stamp('0.29.2', 30 * HOUR, { guard_scope: projectScope })),
    ]);
    const signals = runDetect(dir);
    assert.deepEqual(find(signals, STALE), []);
    assert.deepEqual(find(signals, OUTDATED), []);
  } finally {
    cleanup();
  }
});

test('session_outdated: a session loaded two days ago that missed two updates is informational, never the remove-entry remedy', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(1 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: 10 * HOUR }, { version: '0.29.2', orphanedMsAgo: 1 * HOUR }, { version: '0.29.3' }]);
    writeSpawns(stateDir, [
      row('67890123-two-days', 0.5 * HOUR, stamp('0.29.1', 48 * HOUR)),
      row('67890123-two-days', 0.25 * HOUR, stamp('0.29.1', 48 * HOUR)),
      // Missed the same two updates but loaded 20 h ago: younger than a day, quiet.
      row('67890124-young', 0.5 * HOUR, stamp('0.29.1', 20 * HOUR)),
    ]);
    const signals = runDetect(dir);
    assert.deepEqual(find(signals, STALE), []);
    const hits = find(signals, OUTDATED);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /^2 spawn\(s\) in 24h from 1 long-running session/);
    assert.match(hits[0].detail, /session 67890123: guard 0\.29\.1, installed 0\.29\.3, 2 updates since it loaded 47 h before its latest spawn \(user scope\); remedy: restart or \/reload-plugins this session to pick up 0\.29\.3/);
    assert.doesNotMatch(hits[0].detail, /67890124/);
    assert.doesNotMatch(hits[0].detail, REMOVE_ENTRY);
    assert.equal(hits[0].dispatch, 'none');
    assert.equal(hits[0].severity, 'low');
  } finally {
    cleanup();
  }
});

test('with no .orphaned_at marker, a session loaded before the update is not proven stale', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.3', installPath: installPath(dir, '0.29.3'), lastUpdated: iso(3 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.1' }, { version: '0.29.3' }]); // no markers
    writeSpawns(stateDir, [row('55555555-unknown-ref', 1 * HOUR, stamp('0.29.1', 22 * HOUR))]);
    assert.deepEqual(versionSignals(runDetect(dir)), []);
  } finally {
    cleanup();
  }
});

test('a bundle copy (outside the cache, not a checkout) is judged like a cache copy', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.5', installPath: installPath(dir, '0.29.5'), lastUpdated: iso(3 * HOUR) }]);
    writeSpawns(stateDir, [row('66666666-bundle', 1 * HOUR, stamp('0.29.4', 2 * HOUR, { guard_source: 'bundle' }))]);
    const hits = find(runDetect(dir), STALE);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /session 66666666: guard 0\.29\.4 < 0\.29\.5/);
  } finally {
    cleanup();
  }
});

test('multiple installs: every visible install is listed, and each row is judged against ITS OWN scope', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const project = join(dir, 'proj');
    writeInstalled(dir, [
      { scope: 'user', version: '0.29.5', installPath: installPath(dir, '0.29.5'), lastUpdated: iso(3 * HOUR) },
      { scope: 'project', projectPath: project, version: '0.29.4', installPath: installPath(dir, '0.29.4'), lastUpdated: iso(3 * HOUR) },
    ]);
    const projectScope = scopeKey({ scope: 'project', projectPath: project });
    writeSpawns(stateDir, [
      row('99999999-user-stale', 1 * HOUR, stamp('0.29.4', 2 * HOUR)),
      row('88888888-project-ok', 1 * HOUR, stamp('0.29.4', 2 * HOUR, { guard_scope: projectScope })),
    ]);
    const hits = find(runDetect(dir), STALE);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /from 1 session/);
    assert.match(hits[0].detail, /session 99999999/);
    assert.doesNotMatch(hits[0].detail, /88888888/);
    assert.match(hits[0].detail, /Installs visible: user@0\.29\.5, project@0\.29\.4/);
  } finally {
    cleanup();
  }
});

test('an untrusted load time (no loadedAtFrom, or "first-seen") is an unknown load time: counted, never judged', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.2', installPath: installPath(dir, '0.29.2'), lastUpdated: iso(3 * HOUR) }]);
    writeCache(dir, [{ version: '0.29.1', orphanedMsAgo: 3 * HOUR }, { version: '0.29.2' }]);
    writeSpawns(stateDir, [
      row('77777777-no-source', 1 * HOUR, stamp('0.29.1', null)),
      row('77777778-first-seen', 1 * HOUR, stamp('0.29.1', null)),
    ]);
    writeLoadState(stateDir, {
      '77777777-no-source': { loadedAt: Date.now() - 2 * HOUR, shown: [], at: Date.now() },
      '77777778-first-seen': { loadedAt: Date.now() - 2 * HOUR, loadedAtFrom: 'first-seen', shown: [], at: Date.now() },
    });
    const signals = runDetect(dir);
    assert.deepEqual(find(signals, STALE), []);
    assert.deepEqual(find(signals, OUTDATED), []);
    assert.match(find(signals, UNKNOWN)[0]?.detail || '', /^2 sessions with unknown load time/);
  } finally {
    cleanup();
  }
});

// --- the 2026-09-24 incident, replayed ----------------------------------------
// tests/fixtures/stale-guard-incident.json is a SANITISED replay of the real
// telemetry: the key sets of the real spawns.jsonl rows and their timing in
// minutes from the 22:46 update to 0.29.1, the plugin cache's `.orphaned_at`
// timeline (public release numbers), and each session's last load as the
// 0.22.0 self-update hook recorded it. Every id and value is synthetic.
//
// What the data shows, against the cache timeline: session 0 loaded at -1116
// min, while 0.28.0 was installed and after every version below 0.23.0 had
// been replaced (0.22.0 at -1443), yet its rows lack effective_effort (a
// guard below 0.23.0): a stale copy. Sessions 1-3 loaded at -1634, -1698 and
// -1959, while 0.22.0 was still installed: old sessions, 27-34 h old at their
// last spawn and six updates behind.
const INCIDENT = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'tests', 'fixtures', 'stale-guard-incident.json'), 'utf8'));
function materialiseIncident(dir, stateDir, { trustedLoads = false } = {}) {
  // The scout runs `scout_at_offset_min` after the update.
  const updateAgo = INCIDENT.scout_at_offset_min * MIN;
  const ago = (offsetMin) => updateAgo - offsetMin * MIN;
  writeInstalled(dir, [{ scope: 'user', version: INCIDENT.update.version, installPath: installPath(dir, INCIDENT.update.version), lastUpdated: iso(updateAgo) }]);
  writeCache(dir, INCIDENT.cache.map((c) => ({ version: c.version, orphanedMsAgo: c.orphaned_offset_min === null ? null : ago(c.orphaned_offset_min) })));
  writeSpawns(stateDir, INCIDENT.rows.map(([offset, session, shape]) => ({
    ...INCIDENT.shapes[shape], at: iso(ago(offset)), session_id: INCIDENT.sessions[session],
  })));
  const records = {};
  INCIDENT.sessions.forEach((sid, i) => {
    records[sid] = {
      loadedAt: Date.now() - ago(INCIDENT.old_writer_loaded_offset_min[i]), shown: [], at: Date.now(),
      ...(trustedLoads ? { loadedAtFrom: 'startup' } : {}),
    };
  });
  writeLoadState(stateDir, records);
}

test('incident replay (sanitised), load times this version would trust: 1 stale copy (22 spawns) and 3 outdated sessions (10 spawns)', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    materialiseIncident(dir, stateDir, { trustedLoads: true });
    const signals = runDetect(dir);
    const stale = find(signals, STALE);
    assert.equal(stale.length, 1, JSON.stringify(stale));
    assert.match(stale[0].detail, /^22 spawn\(s\) in 24h from 1 session\(s\)/);
    assert.match(stale[0].detail, new RegExp(`session ${INCIDENT.sessions[0].slice(0, 8)}: guard a pre-0\\.23\\.0 version < 0\\.28\\.0, installed when it loaded; every cached version below 0\\.23\\.0 had already been replaced`));
    const outdated = find(signals, OUTDATED);
    assert.equal(outdated.length, 1, JSON.stringify(outdated));
    assert.match(outdated[0].detail, /^10 spawn\(s\) in 24h from 3 long-running session\(s\)/);
    for (const sid of INCIDENT.sessions.slice(1)) {
      assert.match(outdated[0].detail, new RegExp(`session ${sid.slice(0, 8)}: guard a pre-0\\.23\\.0 version, installed 0\\.29\\.1, 6 updates since it loaded`));
    }
    assert.doesNotMatch(outdated[0].detail, REMOVE_ENTRY);
    assert.deepEqual(find(signals, UNKNOWN), []);
  } finally {
    cleanup();
  }
});

test('incident replay (sanitised), as recorded: the 0.22.0 writer\'s load times are not trusted, so it is only "4 sessions with unknown load time"', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    materialiseIncident(dir, stateDir);
    const signals = runDetect(dir);
    assert.deepEqual(find(signals, STALE), []);
    assert.deepEqual(find(signals, OUTDATED), []);
    const unknown = find(signals, UNKNOWN);
    assert.equal(unknown.length, 1, JSON.stringify(unknown));
    assert.match(unknown[0].detail, /^4 sessions with unknown load time/);
  } finally {
    cleanup();
  }
});

test('the unstamped-row check is keyed on the stamp being absent: a listed 0.22.0 install does not turn it off', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [
      { scope: 'user', version: '0.29.1', installPath: installPath(dir, '0.29.1'), lastUpdated: iso(5 * HOUR) },
      { scope: 'project', projectPath: join(dir, 'old-proj'), version: '0.22.0', installPath: installPath(dir, '0.22.0'), lastUpdated: iso(100 * HOUR) },
    ]);
    writeCache(dir, [{ version: '0.22.0' }, { version: '0.29.0', orphanedMsAgo: 5 * HOUR }, { version: '0.29.1' }]);
    writeSpawns(stateDir, [
      legacyRow('sessleg1-desktop', 2 * HOUR),
      legacyRow('sessleg1-desktop', 1 * HOUR),
      legacyRow('sessleg2-fresh', 0.5 * HOUR),
      // A 0.29.x row with no stamp (route_layer present): version unknown, never guessed.
      row('sess029x-029x', 0.5 * HOUR, {}),
    ]);
    // Both legacy sessions loaded after the user install changed.
    writeLoadState(stateDir, {
      'sessleg1-desktop': { loadedAt: Date.now() - 3 * HOUR, loadedAtFrom: 'startup', shown: [], at: Date.now() },
      'sessleg2-fresh': { loadedAt: Date.now() - 1 * HOUR, loadedAtFrom: 'startup', shown: [], at: Date.now() },
      'sess029x-029x': { loadedAt: Date.now() - 1 * HOUR, loadedAtFrom: 'startup', shown: [], at: Date.now() },
    });
    const hits = find(runDetect(dir), STALE);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /3 spawn\(s\) in 24h from 2 session/);
    assert.match(hits[0].detail, /guard a pre-0\.23\.0 version < 0\.29\.1, installed when it loaded \(scope unknown, judged against user scope\)/);
    assert.match(hits[0].detail, /Installs visible: user@0\.29\.1, project@0\.22\.0/);
    assert.doesNotMatch(hits[0].detail, /sess029x/);
  } finally {
    cleanup();
  }
});

test('an unstamped row is bounded by the keys it carries: a 0.23-0.28 row is not judged against a 0.28.0 install', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.28.0', installPath: installPath(dir, '0.28.0'), lastUpdated: iso(5 * HOUR) }]);
    writeCache(dir, [{ version: '0.27.2', orphanedMsAgo: 5 * HOUR }, { version: '0.28.0' }]);
    writeSpawns(stateDir, [
      // Has effective_effort, lacks route_layer: a 0.23.0-0.28.x guard, which 0.28.0 may be.
      { ...legacyRow('sessleg4-legacy', 1 * HOUR), effective_effort: 'inherited(high)' },
    ]);
    writeLoadState(stateDir, { 'sessleg4-legacy': { loadedAt: Date.now() - 2 * HOUR, loadedAtFrom: 'startup', shown: [], at: Date.now() } });
    assert.deepEqual(versionSignals(runDetect(dir)), []);
  } finally {
    cleanup();
  }
});

// --- plugin_version_behind ---------------------------------------------------

// A copy of the plugin's runnable parts stamped with `version`, so detect.mjs
// can be run FROM a checkout at a different version than the repo's own.
function checkoutAt(root, version) {
  for (const d of ['scripts', 'hooks', 'config', 'agents', '.claude-plugin']) {
    cpSync(join(PLUGIN_ROOT, d), join(root, d), { recursive: true });
  }
  const pjFile = join(root, '.claude-plugin', 'plugin.json');
  const pj = JSON.parse(readFileSync(pjFile, 'utf8'));
  writeFileSync(pjFile, JSON.stringify({ ...pj, version }, null, 2));
  return root;
}
function writeMarketplaceClone(dir, version) {
  const loc = join(dir, '.claude', 'plugins', 'marketplaces', 'agent-templates');
  mkdirSync(join(loc, '.claude-plugin'), { recursive: true });
  writeFileSync(join(loc, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'agent-templates', plugins: [{ name: 'agent-companion', source: './plugins/agent-companion' }] }));
  mkdirSync(join(loc, 'plugins', 'agent-companion', '.claude-plugin'), { recursive: true });
  writeFileSync(join(loc, 'plugins', 'agent-companion', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'agent-companion', version }));
}
function runDetectFrom(root, dir, env = {}) {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'detect.mjs')], {
    windowsHide: true, encoding: 'utf8', cwd: dir, env: { ...process.env, ...env }, timeout: 60000,
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).signals;
}

test('plugin_version_behind, the real inverted case: installed 0.29.1 and the checkout at 0.29.0 does not fire', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.1');
    assert.deepEqual(find(runDetectFrom(root, dir), 'plugin_version_behind'), []);
    // No marketplace clone at all: still silent (the checkout is never "latest" locally).
    const { dir: dir2, cleanup: c2 } = makeFixture();
    try {
      writeInstalled(dir2, [{ scope: 'user', version: '0.29.1', installPath: join(dir2, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
      assert.deepEqual(find(runDetectFrom(root, dir2), 'plugin_version_behind'), []);
    } finally {
      c2();
    }
  } finally {
    cleanup();
  }
});

test('plugin_version_behind: an unreleased dev checkout ahead of every release does not fire either', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.30.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.1');
    assert.deepEqual(find(runDetectFrom(root, dir), 'plugin_version_behind'), []);
  } finally {
    cleanup();
  }
});

test('plugin_version_behind fires when the marketplace clone is AHEAD of the install, naming both versions', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    writeMarketplaceClone(dir, '0.29.3');
    const hits = find(runDetect(dir), 'plugin_version_behind');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /installed at 0\.29\.1; the latest available is 0\.29\.3/);
  } finally {
    cleanup();
  }
});

test('plugin_version_behind in the cloud: the routine checkout is latest, still directional', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = checkoutAt(join(dir, 'checkout'), '0.29.0');
    writeInstalled(dir, [{ scope: 'user', version: '0.29.1', installPath: join(dir, 'x', '0.29.1'), lastUpdated: iso(5 * HOUR) }]);
    const env = { CLAUDE_CODE_REMOTE_SESSION_ID: 'test-cloud' };
    assert.deepEqual(find(runDetectFrom(root, dir, env), 'plugin_version_behind'), []);
    const ahead = checkoutAt(join(dir, 'checkout2'), '0.29.2');
    const hits = find(runDetectFrom(ahead, dir, env), 'plugin_version_behind');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /installed at 0\.29\.1; the latest available is 0\.29\.2/);
  } finally {
    cleanup();
  }
});

// --- new_agent_type ------------------------------------------------------------

test('new_agent_type ignores the ladder\'s own types, bare and namespaced, but still reports real unknowns', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    const t = join(stateDir, 'telemetry');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'unknown-agent-types.jsonl'), [
      { v: 2, at: iso(HOUR), agent_type: 'agent-companion:ac-opus-high' },
      { v: 2, at: iso(HOUR), agent_type: 'ac-sonnet-low' },
      { v: 2, at: iso(HOUR), agent_type: 'brand-new-harness-type' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const hits = find(runDetect(dir), 'new_agent_type');
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0].detail, /brand-new-harness-type/);
    assert.doesNotMatch(hits[0].detail, /ac-opus-high|ac-sonnet-low/);
  } finally {
    cleanup();
  }
});
