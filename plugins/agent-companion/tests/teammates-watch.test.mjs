// Teammates watch (scripts/lib/teammates-watch.mjs, the scout's section in
// scripts/detect.mjs, scripts/teammates-probe.mjs). Fixture directories and
// synthetic "binaries" only: nothing reads the real desktop install or the
// real ~/.claude/teams (the detector is pointed at the fixture via
// AGENT_COMPANION_CLAUDE_CODE_DIRS and the fixture's own claude dir).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript } from './helpers.mjs';
import { stateFile } from '../hooks/lib/context.mjs';
import {
  LAST_WORKING_MS, WATCH_DAYS, MARKERS, newestDesktopBuild, scanMarkers, teamEvidence, decide, versionKey,
} from '../scripts/lib/teammates-watch.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-10-06T12:00:00.000Z');

function writeTeam(dir, name, { createdAt, members = ['team-lead'] }) {
  const d = join(dir, '.claude', 'teams', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'config.json'), JSON.stringify({
    name, createdAt,
    members: members.map((m) => ({ name: m, agentType: m === 'team-lead' ? 'team-lead' : 'general-purpose' })),
  }));
}

function writeBuild(root, version, text = 'x') {
  const d = join(root, version, 'abc123');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'claude.exe'), text);
  return join(d, 'claude.exe');
}

test('scanMarkers: counts each string, including ones that straddle a chunk edge, and an unreadable file is null', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'bin');
    const body = `pad TeamCreate pad TeamCreate TeamDelete teammate_spawned ${'z'.repeat(50)} CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS end TeamCreate`;
    writeFileSync(f, body);
    const whole = scanMarkers(f);
    assert.deepEqual(whole, { TeamCreate: 3, TeamDelete: 1, teammate_spawned: 1, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1 });
    // Every chunk size, so some edge lands inside every marker: the count never changes.
    for (let chunk = 5; chunk < 60; chunk++) assert.deepEqual(scanMarkers(f, MARKERS, chunk), whole, `chunk ${chunk}`);
    assert.equal(scanMarkers(join(dir, 'no-such-file')), null);
  } finally { cleanup(); }
});

test('newestDesktopBuild: the highest version wins, numerically; missing roots are fine', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const root = join(dir, 'cc');
    writeBuild(root, '2.1.9');
    const newest = writeBuild(root, '2.1.286');
    writeBuild(root, '2.1.100');
    mkdirSync(join(root, 'not-a-version'), { recursive: true });
    const b = newestDesktopBuild([join(dir, 'missing'), root]);
    assert.equal(b.version, '2.1.286');
    assert.equal(b.binary, newest);
    assert.equal(newestDesktopBuild([join(dir, 'missing')]), null);
  } finally { cleanup(); }
});

test('teamEvidence: a lead-only team is no evidence; a teammate before the cutoff is none; one after it is', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const claude = join(dir, '.claude');
    writeTeam(dir, 'session-leadonly', { createdAt: NOW - DAY });
    writeTeam(dir, 'old-team', { createdAt: LAST_WORKING_MS - 30 * DAY, members: ['team-lead', 'w1', 'w2'] });
    assert.deepEqual(teamEvidence({ dir: claude, sinceMs: LAST_WORKING_MS }), []);
    writeTeam(dir, 'new-team', { createdAt: NOW - DAY, members: ['team-lead', 'w1'] });
    const ev = teamEvidence({ dir: claude, sinceMs: LAST_WORKING_MS });
    assert.equal(ev.length, 1);
    assert.equal(ev[0].name, 'new-team');
    assert.equal(ev[0].members, 1);
    assert.deepEqual(teamEvidence({ dir: join(dir, 'nowhere'), sinceMs: 0 }), []);
    writeFileSync(join(claude, 'teams', 'junk.txt'), 'x');
    mkdirSync(join(claude, 'teams', 'broken'), { recursive: true });
    writeFileSync(join(claude, 'teams', 'broken', 'config.json'), '{{{');
    assert.equal(teamEvidence({ dir: claude, sinceMs: LAST_WORKING_MS }).length, 1, 'junk and corrupt files are ignored');
  } finally { cleanup(); }
});

const M1 = { TeamCreate: 2, TeamDelete: 2, teammate_spawned: 5, CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 6 };
const none = () => [];
const some = (sinceMs) => [{ name: 't', members: 2, createdAt: Math.max(sinceMs, NOW - DAY) }];
const keyA = versionKey({ cli: '2.1.283', desktop: '2.1.286' });
const keyB = versionKey({ cli: '2.1.290', desktop: '2.1.290' });

test('decide: first run records state silently when there is no teammate (no signal on a fresh install)', () => {
  const r = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW });
  assert.deepEqual(r.signals, []);
  assert.equal(r.state.versionKey, keyA);
  assert.equal(r.state.verdict, 'unknown');
  assert.equal(r.state.changedAt, null);
});

test('decide: first run on a machine where teammates already work says so, once', () => {
  const first = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: some, nowMs: NOW });
  assert.deepEqual(first.signals.map((s) => s.kind), ['teammates_available']);
  assert.equal(first.signals[0].dispatch, 'teammates-confirm');
  assert.equal(first.state.verdict, 'available');
  const again = decide({ prev: first.state, key: keyA, markers: M1, evidenceFor: some, nowMs: NOW + DAY });
  assert.deepEqual(again.signals, [], 'a verdict is sticky: no daily repeat');
});

test('decide: a version change suggests the probe once (strings unchanged: says that proves nothing) and restarts the watch', () => {
  const prev = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW - 5 * DAY }).state;
  const r = decide({ prev, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW });
  assert.deepEqual(r.signals.map((s) => s.kind), ['teammates_probe_suggested']);
  const s = r.signals[0];
  assert.equal(s.dispatch, 'teammates-probe');
  assert.match(s.detail, /node scripts\/teammates-probe\.mjs/);
  assert.match(s.detail, /Suggestion only/);
  assert.match(s.detail, /team strings are unchanged, which proves nothing/);
  assert.equal(r.state.changedAt, NOW);
  const next = decide({ prev: r.state, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW + DAY });
  assert.deepEqual(next.signals, [], 'suggested once per change, not daily');
});

test('decide: changed team strings are named in the suggestion', () => {
  const prev = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW - DAY }).state;
  const r = decide({ prev, key: keyB, markers: { ...M1, TeamCreate: 9 }, evidenceFor: none, nowMs: NOW });
  assert.match(r.signals[0].detail, /team strings also changed \(TeamCreate 2->9/);
});

test('decide: after a change, a teammate created since then raises teammates_available; an older one does not', () => {
  const prev = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW - 5 * DAY }).state;
  const changed = decide({ prev, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW });
  // evidence the reader is asked for starts at the change time, not at LAST_WORKING_MS
  let askedSince = null;
  const day2 = decide({ prev: changed.state, key: keyB, markers: M1, nowMs: NOW + DAY, evidenceFor: (s) => { askedSince = s; return []; } });
  assert.equal(askedSince, NOW - DAY, 'floor is changedAt - 24h when the build mtime is unknown');
  assert.deepEqual(day2.signals, []);
  const day3 = decide({ prev: day2.state, key: keyB, markers: M1, evidenceFor: some, nowMs: NOW + 2 * DAY });
  assert.deepEqual(day3.signals.map((s) => s.kind), ['teammates_available']);
  assert.match(day3.signals[0].detail, /desktop teammates work again/);
});

test('decide: the floor for "new" is the installed build mtime when known', () => {
  const prev = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW - 5 * DAY }).state;
  const built = NOW - 3 * DAY;
  const changed = decide({ prev, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW, buildMtimeMs: built });
  assert.equal(changed.state.floorAt, built);
  let askedSince = null;
  decide({ prev: changed.state, key: keyB, markers: M1, nowMs: NOW + DAY, evidenceFor: (s) => { askedSince = s; return []; } });
  assert.equal(askedSince, built, 'a teammate created on the new build before the scout ran still counts');
});

test('decide: the teammates_available text does not claim desktop teammates work', () => {
  const r = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: some, nowMs: NOW });
  const d = r.signals[0].detail;
  assert.match(d, /a teammate was created on this machine \(CLI or desktop\)/);
  assert.match(d, /check whether desktop teammates work again/);
  assert.doesNotMatch(d, /desktop teammates work again on/);
});

test('teamEvidence: a config whose createdAt is not numeric is skipped, not dated by file mtime', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeTeam(dir, 'str-created', { createdAt: '2026-10-05T00:00:00Z', members: ['team-lead', 'w1'] });
    writeTeam(dir, 'no-created', { createdAt: undefined, members: ['team-lead', 'w1'] });
    writeTeam(dir, 'ok', { createdAt: NOW - DAY, members: ['team-lead', 'w1'] });
    const ev = teamEvidence({ dir: join(dir, '.claude'), sinceMs: 0 });
    assert.deepEqual(ev.map((e) => e.name), ['ok']);
  } finally { cleanup(); }
});

test('decide: the watch ends WATCH_DAYS after a change with no verdict, and a later change starts it again', () => {
  const prev = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: none, nowMs: NOW - 90 * DAY }).state;
  const changed = decide({ prev, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW - 60 * DAY });
  let asked = 0;
  const late = decide({ prev: changed.state, key: keyB, markers: M1, nowMs: NOW, evidenceFor: () => { asked++; return some(0); } });
  assert.equal(asked, 0, `more than ${WATCH_DAYS} days after the change: no more looking`);
  assert.deepEqual(late.signals, []);
  const keyC = versionKey({ cli: '2.2.0', desktop: '2.2.0' });
  const again = decide({ prev: late.state, key: keyC, markers: M1, evidenceFor: none, nowMs: NOW });
  assert.deepEqual(again.signals.map((s) => s.kind), ['teammates_probe_suggested']);
});

test('decide: a version change after "available" resets the verdict (it must be shown again on the new build)', () => {
  const avail = decide({ prev: undefined, key: keyA, markers: M1, evidenceFor: some, nowMs: NOW - 3 * DAY }).state;
  assert.equal(avail.verdict, 'available');
  const r = decide({ prev: avail, key: keyB, markers: M1, evidenceFor: none, nowMs: NOW });
  assert.equal(r.state.verdict, 'unknown');
  assert.deepEqual(r.signals.map((s) => s.kind), ['teammates_probe_suggested']);
});

// --- detect.mjs, end to end -------------------------------------------------

const detectEnv = (dir, extra = {}) => ({
  AGENT_COMPANION_CLAUDE_CODE_DIRS: join(dir, 'cc'),
  AGENT_COMPANION_FAKE_NOW: new Date(NOW).toISOString(),
  ...extra,
});
const tmSignals = (res) => res.json.signals.filter((s) => /^teammates_/.test(s.kind));

test('detect.mjs: first run records the teammates state and raises nothing; the next unchanged run is silent', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeBuild(join(dir, 'cc'), '2.1.286', 'TeamCreate TeamCreate teammate_spawned');
    const r1 = runScript('scripts/detect.mjs', [], { cwd: dir, env: detectEnv(dir) });
    assert.equal(r1.status, 0, r1.stderr);
    assert.deepEqual(tmSignals(r1), []);
    const st = JSON.parse(readFileSyncSafe(stateFile('baseline.json'))).teammates;
    assert.equal(st.markers.TeamCreate, 2, 'the binary was scanned');
    assert.equal(st.verdict, 'unknown');
    const r2 = runScript('scripts/detect.mjs', [], { cwd: dir, env: detectEnv(dir) });
    assert.deepEqual(tmSignals(r2), []);
  } finally { cleanup(); }
});

test('detect.mjs: a changed desktop build suggests the probe; a teammate created afterwards raises teammates_available', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeBuild(join(dir, 'cc'), '2.1.286', 'TeamCreate');
    runScript('scripts/detect.mjs', [], { cwd: dir, env: detectEnv(dir) });
    const bin = writeBuild(join(dir, 'cc'), '2.1.290', 'TeamCreate TeamCreate TeamCreate');
    utimesSync(bin, new Date(NOW - 3600000), new Date(NOW - 3600000)); // the build mtime is the floor for "new"
    const changed = runScript('scripts/detect.mjs', [], { cwd: dir, env: detectEnv(dir) });
    assert.equal(changed.status, 0, changed.stderr);
    const sigs = tmSignals(changed);
    assert.deepEqual(sigs.map((s) => s.kind), ['teammates_probe_suggested'], JSON.stringify(sigs));
    assert.match(sigs[0].detail, /team strings also changed \(TeamCreate 1->3/);

    writeTeam(dir, 'session-team-test', { createdAt: NOW + 60 * 1000, members: ['team-lead', 'probe-a'] });
    const later = runScript('scripts/detect.mjs', [], {
      cwd: dir, env: detectEnv(dir, { AGENT_COMPANION_FAKE_NOW: new Date(NOW + DAY).toISOString() }),
    });
    const lsigs = tmSignals(later);
    assert.deepEqual(lsigs.map((s) => s.kind), ['teammates_available'], JSON.stringify(lsigs));
    assert.equal(lsigs[0].dispatch, 'teammates-confirm');
    const again = runScript('scripts/detect.mjs', [], {
      cwd: dir, env: detectEnv(dir, { AGENT_COMPANION_FAKE_NOW: new Date(NOW + 2 * DAY).toISOString() }),
    });
    assert.deepEqual(tmSignals(again), [], 'raised once');
  } finally { cleanup(); }
});

test('detect.mjs: no desktop install and no teams dir is silent and does not fail the scout', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const res = runScript('scripts/detect.mjs', [], { cwd: dir, env: detectEnv(dir) });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(tmSignals(res), []);
  } finally { cleanup(); }
});

// --- the manual probe -------------------------------------------------------

test('teammates-probe.mjs: exit 1 with only a lead; exit 0 and a verdict once a team lists a teammate; --json is parseable', () => {
  const { dir, cleanup } = makeFixture();
  try {
    writeBuild(join(dir, 'cc'), '2.1.286', 'TeamCreate teammate_spawned');
    writeTeam(dir, 'session-lead0001', { createdAt: NOW - DAY });
    const env = { AGENT_COMPANION_CLAUDE_CODE_DIRS: join(dir, 'cc') };
    const none1 = runScript('scripts/teammates-probe.mjs', [], { cwd: dir, env });
    assert.equal(none1.status, 1, none1.stdout + none1.stderr);
    assert.match(none1.stdout, /desktop build: 2\.1\.286/);
    assert.match(none1.stdout, /TeamCreate 1/);
    assert.match(none1.stdout, /VERDICT: no teammate found/);
    writeTeam(dir, 'session-team0002', { createdAt: NOW - DAY, members: ['team-lead', 'probe-a'] });
    const yes = runScript('scripts/teammates-probe.mjs', ['--json'], { cwd: dir, env });
    assert.equal(yes.status, 0, yes.stdout + yes.stderr);
    const j = JSON.parse(yes.stdout);
    assert.equal(j.teammatesAvailable, true);
    assert.equal(j.teamsWithTeammates, 1);
    assert.equal(j.desktopBuild, '2.1.286');
    const since = runScript('scripts/teammates-probe.mjs', ['--since', '2026-10-06'], { cwd: dir, env });
    assert.equal(since.status, 1, 'the only teammate team is older than --since');
    const bad = runScript('scripts/teammates-probe.mjs', ['--since', 'not-a-date'], { cwd: dir, env });
    assert.equal(bad.status, 2);
  } finally { cleanup(); }
});

import { readFileSync } from 'node:fs';
function readFileSyncSafe(f) { return readFileSync(f, 'utf8'); }

test('docs and signal text carry the measured team-era facts and no reuse-by-default framing', () => {
  const readme = readFileSyncSafe(new URL('../README.md', import.meta.url));
  const lib = readFileSyncSafe(new URL('../scripts/lib/teammates-watch.mjs', import.meta.url));
  const skill = readFileSyncSafe(new URL('../skills/calibration-scout/SKILL.md', import.meta.url));
  for (const [name, text] of [['README', readme], ['teammates-watch.mjs', lib]]) {
    assert.match(text, /0\.110/, name + ': team-era cost per call');
    assert.match(text, /0\.056/, name + ': current cost per call');
    assert.match(text, /2026-05-13 to 2026-06-20/, name + ': TeamCreate window');
    assert.match(text, /not in use in the whole-week weeks/i, name + ': whole-week weeks');
  }
  assert.doesNotMatch(readme + lib + skill, /reuse-by-default|Reuse workers, don't respawn/);
});
