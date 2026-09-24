// ADR 0003 slice 2: the ONE routing-profile writer, its append-only journal,
// rollback, concurrency and the /ac routing CLI. Hermetic: each test works in
// its own temp state root; no model is called.
//
// The journal round-trip is a PROPERTY test: seeded random sequences of set,
// unset, rollback --row and rollback --to (plus writes the validator must
// refuse), where rebuilding ANY revision from the journal must equal the
// file exactly as it stood at that revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, utimesSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFixture, runScript, PLUGIN_ROOT, TESTS_DIR } from './helpers.mjs';

const fx = makeFixture();
test.after(() => fx.cleanup());
const store = await import('../scripts/lib/routing-profile-store.mjs');
const rp = await import('../hooks/lib/routing-profile.mjs');
const ctx = await import('../hooks/lib/context.mjs');

const NOW = new Date('2026-09-24T12:00:00Z');
// Point the writer at a fresh state root (it resolves paths per call).
function freshRoot(tag) {
  const d = join(fx.dir, 'roots', `${tag}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  process.env.AGENT_COMPANION_STATE_DIR = d;
  rp._resetProfileCache();
  return d;
}
const files = () => store.profileFiles();
const readFile = () => JSON.parse(readFileSync(files().profile, 'utf8'));
const readEntries = () => rp.parseJournal(readFileSync(files().journal, 'utf8'));
const expectCode = (fn, code) => assert.throws(fn, (e) => e instanceof store.ProfileWriteError && e.code === code);

// --- Property: the journal rebuilds every revision exactly ------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ROUTINE = ['bounded-feature', 'mechanical-edit', 'debug-root-cause', 'operate'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function randomValidSet(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const r = rand();
  if (r < 0.55) return [pick(ROUTINE), { model: pick(['sonnet', 'opus']), effort: pick(EFFORTS) }];
  if (r < 0.7) return ['integration', { model: pick(['sonnet', 'opus']), effort: pick(['high', 'xhigh', 'max']) }];
  if (r < 0.8) return ['integration', { model: 'sonnet', effort: pick(['low', 'medium']), waiveFloor: 'elevated' }];
  if (r < 0.9) return ['critical-change', { model: 'opus', effort: pick(['xhigh', 'max']) }];
  return ['code-review', { effort: pick(EFFORTS) }];
}
function randomRefusedSet(rand) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  return pick([
    ['critical-change', { model: 'sonnet', effort: 'xhigh' }], // F1
    ['bounded-feature', { model: 'fable', effort: 'high' }], // F2
    ['code-review', { model: 'opus', effort: 'high' }], // F3
    ['bounded-feature', { model: 'gpt-x', effort: 'high' }], // F4
    ['integration', { model: 'sonnet', effort: 'low' }], // F5 without the waiver
  ]);
}

test('property: random set/unset/rollback sequences — rebuilding any revision from the journal equals the file at that revision', () => {
  const SEQUENCES = 25;
  const OPS = 20;
  const applied = {};
  for (let seed = 1; seed <= SEQUENCES; seed += 1) {
    freshRoot(`prop${seed}`);
    const rand = mulberry32(seed * 7919);
    const snapshots = new Map(); // revision -> the file exactly as written
    let rev = null;
    for (let i = 0; i < OPS; i += 1) {
      const r = rand();
      const before = existsSync(files().profile) ? readFileSync(files().profile, 'utf8') : null;
      const jBefore = existsSync(files().journal) ? readFileSync(files().journal, 'utf8') : null;
      let res = null;
      const ctxMsg = `seed ${seed} op ${i}`;
      try {
        if (r < 0.45 || rev === null) {
          const [type, o] = randomValidSet(rand);
          res = store.setRow(type, { ...o, because: `seed ${seed}`, now: NOW });
        } else if (r < 0.6) {
          const live = Object.entries(readFile().rows).filter(([, v]) => v.state !== 'retired').map(([k]) => k);
          const pick = live.length ? live[Math.floor(rand() * live.length)] : 'operate';
          res = store.unsetRow(pick, { now: NOW });
        } else if (r < 0.75) {
          const all = [...ROUTINE, 'integration', 'critical-change', 'code-review'];
          res = store.rollbackRow(all[Math.floor(rand() * all.length)], { now: NOW });
        } else if (r < 0.92) {
          const target = Math.floor(rand() * (rev + 1));
          res = store.rollbackTo(target, { now: NOW });
          const got = rp.profileContent(readFile());
          const want = target === 0 ? rp.profileContent(rp.rebuildAt(readEntries().entries, 0)) : rp.profileContent(snapshots.get(target));
          assert.equal(rp.canonical(got), rp.canonical(want), `${ctxMsg}: rollback --to ${target} restores that revision exactly`);
        } else {
          const [type, o] = randomRefusedSet(rand);
          assert.throws(() => store.setRow(type, { ...o, now: NOW }), (e) => e.code === 'refused', `${ctxMsg}: ${type} ${JSON.stringify(o)} must be refused`);
        }
      } catch (e) {
        if (!(e instanceof store.ProfileWriteError) || !['not-found', 'usage'].includes(e.code)) throw e;
      }
      if (res) {
        const action = res.entries.at(-1).action;
        applied[action] = (applied[action] || 0) + 1;
        const expected = rev === null ? 1 : rev + 1;
        assert.equal(res.revision, expected, `${ctxMsg}: revision goes up by exactly 1`);
        rev = res.revision;
        const onDisk = readFile();
        assert.equal(onDisk.revision, rev);
        snapshots.set(rev, onDisk);
      } else {
        // A refused or no-op command changes nothing at all.
        assert.equal(existsSync(files().profile) ? readFileSync(files().profile, 'utf8') : null, before, `${ctxMsg}: file unchanged`);
        assert.equal(existsSync(files().journal) ? readFileSync(files().journal, 'utf8') : null, jBefore, `${ctxMsg}: journal unchanged`);
      }
    }
    const { entries, errors } = readEntries();
    assert.deepEqual(errors, []);
    assert.deepEqual(entries.map((e) => e.revision), Array.from({ length: rev + 1 }, (_, k) => k), `seed ${seed}: one line per revision, 0..${rev}`);
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), ['action', 'after', 'at', 'before', 'by', 'revision', 'type']);
    }
    for (const [n, snap] of snapshots) {
      assert.equal(rp.canonical(rp.rebuildAt(entries, n)), rp.canonical(snap), `seed ${seed}: rebuild of revision ${n}`);
    }
    assert.ok(store.journalMatchesFile(readFile(), entries));
  }
  // Not vacuous: every kind of change was actually applied, many times.
  for (const a of ['set', 'unset', 'rollback-row', 'rollback-to']) assert.ok((applied[a] || 0) >= 10, `${a} applied ${applied[a] || 0} times`);
});

// --- Deterministic journal cases ------------------------------------------

test('the first write journals an init at revision 0 and the set at revision 1', () => {
  freshRoot('init');
  const res = store.setRow('bounded-feature', { model: 'sonnet', effort: 'medium', because: 'x', now: NOW });
  assert.equal(res.revision, 1);
  const { entries } = readEntries();
  assert.deepEqual(entries.map((e) => [e.revision, e.action, e.type]), [[0, 'init', null], [1, 'set', 'bounded-feature']]);
  const p = readFile();
  assert.equal(p.schema, 'agent-companion/routing-profile');
  assert.equal(p.schemaVersion, 1);
  assert.deepEqual(p.basedOn, { tableVersion: ctx.modelTiers().version, tableUpdated: ctx.modelTiers().updated });
  assert.deepEqual(p.rows['bounded-feature'], {
    state: 'trial', model: 'sonnet', effort: 'medium', cacheTtl: null, source: 'operator-observed',
    since: '2026-09-24', reviewBy: '2026-12-23', waivesFloor: null, note: 'x', provenance: null,
  });
});

test('a hand edit (no revision bump) is journalled as the file stands before the next change', () => {
  freshRoot('hand');
  store.setRow('bounded-feature', { model: 'sonnet', effort: 'medium', now: NOW });
  const edited = readFile();
  edited.rows['bounded-feature'].effort = 'high';
  writeFileSync(files().profile, JSON.stringify(edited));
  const res = store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW });
  assert.equal(res.revision, 3);
  const { entries } = readEntries();
  assert.deepEqual(entries.map((e) => [e.revision, e.action]), [[0, 'init'], [1, 'set'], [2, 'adopt-external-edit'], [3, 'set']]);
  assert.equal(rp.rebuildAt(entries, 2).rows['bounded-feature'].effort, 'high');
  assert.equal(rp.rebuildAt(entries, 1).rows['bounded-feature'].effort, 'medium');
  assert.equal(rp.canonical(rp.rebuildAt(entries, 3)), rp.canonical(readFile()));
});

test('a hand-written file with no journal is adopted at its own revision; a deleted file restarts above the journal', () => {
  freshRoot('adopt');
  mkdirSync(files().dir, { recursive: true });
  writeFileSync(files().profile, JSON.stringify({ ...rp.emptyProfile(), revision: 10, rows: {} }));
  assert.equal(store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }).revision, 11);
  assert.deepEqual(readEntries().entries.map((e) => [e.revision, e.action]), [[10, 'adopt-external-edit'], [11, 'set']]);
  rmSync(files().profile);
  assert.equal(store.setRow('operate', { model: 'opus', effort: 'low', now: NOW }).revision, 13);
  const { entries } = readEntries();
  assert.deepEqual(entries.slice(-2).map((e) => [e.revision, e.action]), [[12, 'init'], [13, 'set']]);
  assert.deepEqual(Object.keys(rp.rebuildAt(entries, 13).rows), ['operate']);
});

test('the writer refuses to build on an invalid file or an unfoldable journal, and touches neither', () => {
  freshRoot('refuse');
  mkdirSync(files().dir, { recursive: true });
  writeFileSync(files().profile, '{ nope');
  expectCode(() => store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }), 'invalid-file');
  assert.equal(readFileSync(files().profile, 'utf8'), '{ nope');
  writeFileSync(files().profile, JSON.stringify({ ...rp.emptyProfile(), schemaVersion: 2 }));
  expectCode(() => store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }), 'invalid-file');
  rmSync(files().profile);
  writeFileSync(files().journal, '{"revision":0,"type":null}\nnot json\n');
  expectCode(() => store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }), 'corrupt-journal');
  assert.equal(existsSync(files().profile), false);
});

// S2 review P3 (lead decision): rollback validates in READ mode (F1-F4), so a
// journalled revision the writer would now refuse on F5 — here an adopted
// hand edit — is restored exactly; F5 then raises it at resolve time.
test('rollback restores a journalled revision exactly even when write-mode F5 would refuse it', () => {
  freshRoot('rb-read');
  store.setRow('explore', { model: 'sonnet', effort: 'low', now: NOW });
  // Hand edit: an elevated row below the F5 floor, no waiver.
  const p = readFile();
  p.rows.integration = {
    state: 'trial', model: 'sonnet', effort: 'low', cacheTtl: null, source: 'operator-observed',
    since: '2026-09-01', reviewBy: null, waivesFloor: null, note: null, provenance: null,
  };
  writeFileSync(files().profile, JSON.stringify(p, null, 2));
  rp._resetProfileCache();
  const adopted = store.setRow('verify', { model: 'sonnet', effort: 'low', now: NOW }); // journals the adopt first
  const adoptRev = readEntries().entries.find((e) => e.action === 'adopt-external-edit').revision;
  const target = adopted.revision; // the state holding the hand-edited row (+ verify)
  store.setRow('integration', { model: 'sonnet', effort: 'high', now: NOW });

  const r = store.rollbackTo(target, { now: NOW });
  const { entries } = readEntries();
  assert.equal(JSON.stringify(rp.profileContent(readFile())), JSON.stringify(rp.profileContent(rp.rebuildAt(entries, target))), 'restored byte for byte');
  assert.deepEqual([readFile().rows.integration.effort, r.revision], ['low', target + 2]);
  // Resolve time: F5 raises the restored row as usual (elevated floor:
  // medium, since the 0.29.2 "effort" decision lowered it from high).
  rp._resetProfileCache();
  assert.equal(ctx.resolveRoute({ type: 'integration', now: NOW }).effort, 'medium');

  // rollback --row does the same for one row.
  store.setRow('integration', { model: 'sonnet', effort: 'xhigh', now: NOW });
  store.rollbackRow('integration', { now: NOW });
  assert.equal(readFile().rows.integration.effort, 'low');
  assert.ok(adoptRev < target);
  // Read mode still refuses what the resolver refuses (F1-F4).
  expectCode(() => store.commitChange(() => ({ action: 'rollback-row', type: 'integration', validate: 'read',
    row: { ...readFile().rows.integration, model: 'fable' } })), 'refused');
});

// 0.29.0 final review F5: an adopted hand edit was journalled without its
// rows being judged, so a row the resolver refuses (and skips) rode along in
// every later revision, and rollback --to refused every one of them for that
// row. The adoption now records the rows the resolver skips, and a rollback
// judges only the rows it changes, letting a recorded skipped row back in
// exactly as journalled.
test('F5: an adopted hand edit records the rows the resolver skips; rollback --to is not refused for them', () => {
  freshRoot('adopt-skip');
  store.setRow('explore', { model: 'sonnet', effort: 'low', now: NOW }); // rev 1
  const p = readFile();
  const bad = {
    state: 'trial', model: 'fable', effort: 'high', cacheTtl: null, source: 'operator-observed',
    since: '2026-09-01', reviewBy: null, waivesFloor: null, note: null, provenance: null,
  };
  p.rows.integration = bad;
  writeFileSync(files().profile, JSON.stringify(p, null, 2));
  rp._resetProfileCache();
  const afterAdopt = store.setRow('verify', { model: 'sonnet', effort: 'low', now: NOW }); // adopt (2) + set (3)
  const adopt = readEntries().entries.find((e) => e.action === 'adopt-external-edit');
  assert.ok(Array.isArray(adopt.skipped) && adopt.skipped.length === 1, JSON.stringify(adopt.skipped));
  assert.equal(adopt.skipped[0].type, 'integration');
  assert.equal(typeof adopt.skipped[0].reason, 'string');
  store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }); // rev 4

  // Back to rev 3: the skipped row is carried unchanged; nothing else is refused.
  const r = store.rollbackTo(afterAdopt.revision, { now: NOW });
  const { entries } = readEntries();
  assert.equal(JSON.stringify(rp.profileContent(readFile())), JSON.stringify(rp.profileContent(rp.rebuildAt(entries, afterAdopt.revision))));
  // Fix the row, then roll back to a revision holding the recorded skipped row: restored exactly.
  store.setRow('integration', { model: 'opus', effort: 'high', now: NOW });
  store.rollbackTo(r.revision, { now: NOW });
  assert.deepEqual(readFile().rows.integration, bad);
  // A refused row the journal never recorded as skipped is still refused.
  expectCode(() => store.commitChange(() => ({ action: 'rollback-row', type: 'integration', validate: 'read',
    row: { ...bad, effort: 'low' } })), 'refused');
  // A clean adoption records nothing extra: its entry is byte-for-byte what it was.
  freshRoot('adopt-clean');
  store.setRow('explore', { model: 'sonnet', effort: 'low', now: NOW });
  const q = readFile();
  q.rows.operate = { ...bad, model: 'sonnet', effort: 'low' };
  writeFileSync(files().profile, JSON.stringify(q, null, 2));
  rp._resetProfileCache();
  store.setRow('verify', { model: 'sonnet', effort: 'low', now: NOW });
  assert.equal('skipped' in readEntries().entries.find((e) => e.action === 'adopt-external-edit'), false);
});

// F5: the depth check stripped strings with a regex that overflowed on a
// string value of a few MB (a RangeError out of the writer and `show`).
test('F5: the nesting-depth scan handles a 20 MB string value without throwing', () => {
  const big = 'x'.repeat(20_000_000);
  assert.equal(rp.textNestingDepth(`{"a":"${big}","b":[[{"c":"\\"[{"}]]}`), 4);
  assert.equal(rp.textNestingDepth('{"a":"\\\\"}'), 1, 'an escaped backslash ends before the closing quote');
  assert.equal(rp.textNestingDepth('[[[[', 2), 3, 'stops once past the limit');
  const res = rp.parseProfileText(JSON.stringify({ schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 1, note: big }));
  assert.ok(['ok', 'invalid'].includes(res.status));
});

// S2 review P7: the writer threw an uncaught RangeError on a deeply nested
// profile and a raw EISDIR when the profile path is a directory. Both are
// now clean refusals: a message, a non-zero exit, nothing written, no lock.
test('a deeply nested profile, or a directory at the profile path, is refused cleanly: nothing written, lock released', () => {
  const root = freshRoot('p7');
  mkdirSync(files().dir, { recursive: true });
  const n = 20000;
  const deep = `{"schema":"agent-companion/routing-profile","schemaVersion":1,"revision":1,"rows":{},"x":${'['.repeat(n)}${']'.repeat(n)}}`;
  writeFileSync(files().profile, deep);
  expectCode(() => store.setRow('explore', { model: 'sonnet', effort: 'low', now: NOW }), 'invalid-file');
  assert.equal(readFileSync(files().profile, 'utf8'), deep, 'the file is untouched');
  assert.deepEqual(readdirSync(files().dir), ['routing-profile.json'], 'no journal, lock or temp file');
  // The hook-path reader never stringifies the whole profile, so a deep
  // UNKNOWN key cannot hurt it and is tolerated like any unknown key (P9
  // keeps the whole-text scan off the hot path); it never throws. A deep ROW
  // is refused on its own (rowShapeErrors), since callers do stringify rows.
  rp._resetProfileCache();
  assert.equal(ctx.resolveRoute({ type: 'explore', now: NOW }).profileStatus, 'ok');
  const deepRow = { schema: 'agent-companion/routing-profile', schemaVersion: 1, revision: 1, rows: { explore: {
    state: 'trial', model: 'sonnet', effort: 'low', source: 'benchmark', since: '2026-09-01', provenance: {},
  } } };
  let node = deepRow.rows.explore.provenance;
  for (let i = 0; i < 100; i += 1) { node.x = {}; node = node.x; }
  writeFileSync(files().profile, JSON.stringify(deepRow));
  rp._resetProfileCache();
  const r = ctx.resolveRoute({ type: 'explore', now: NOW });
  assert.notEqual(r.layer, 'profile');
  assert.match(r.skipped.find((x) => x.layer === 'profile').reason, /row nests deeper than 61 levels/);
  const rec = runScript('scripts/recommend.mjs', ['--type', 'explore', '--explain', '--json'], { env: { AGENT_COMPANION_STATE_DIR: root } });
  assert.equal(rec.status, 0, rec.stderr);
  writeFileSync(files().profile, deep);

  rmSync(files().profile);
  mkdirSync(files().profile);
  expectCode(() => store.setRow('explore', { model: 'sonnet', effort: 'low', now: NOW }), 'invalid-file');
  assert.deepEqual(readdirSync(files().dir), ['routing-profile.json'], 'no journal, lock or temp file');
  const env = { AGENT_COMPANION_STATE_DIR: root };
  const set = runScript('scripts/routing-profile.mjs', ['set', 'explore', '--model', 'sonnet', '--effort', 'low'], { env });
  assert.equal(set.status, 1);
  assert.match(set.stderr, /cannot be read \(EISDIR\)/);
  assert.doesNotMatch(set.stderr, /\n\s+at /, 'no stack trace');
  const show = runScript('scripts/routing-profile.mjs', ['show'], { env });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /INVALID \(unreadable\)/);
  rmSync(files().profile, { recursive: true });
});

test('compare-revision: a stale expectRevision is a conflict, not a lost update', () => {
  freshRoot('cas');
  store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW });
  store.setRow('operate', { model: 'sonnet', effort: 'high', now: NOW });
  expectCode(() => store.commitChange(() => ({ action: 'set', type: 'operate', row: null }), { expectRevision: 1 }), 'conflict');
  assert.equal(readFile().rows.operate.effort, 'high');
  const ok = store.commitChange((cur) => ({ action: 'set', type: 'operate', row: { ...cur.rows.operate, effort: 'max' } }), { expectRevision: 2 });
  assert.equal(ok.revision, 3);
});

test('a stale lock left by a crashed writer is broken; no lock or temp file survives a write', () => {
  freshRoot('lock');
  mkdirSync(files().dir, { recursive: true });
  writeFileSync(files().lock, '{"pid":1}');
  const old = new Date(Date.now() - store.STALE_LOCK_MS - 5000);
  utimesSync(files().lock, old, old);
  assert.equal(store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }).revision, 1);
  assert.deepEqual(readdirSync(files().dir).sort(), ['routing-profile.journal.jsonl', 'routing-profile.json']);
});

test('F5 at write: a haiku row on an elevated type needs --waive-floor elevated (P2)', () => {
  freshRoot('haiku-f5');
  expectCode(() => store.setRow('large-refactor', { model: 'haiku', now: NOW }), 'refused');
  assert.throws(() => store.setRow('large-refactor', { model: 'haiku', now: NOW }), /F5: haiku takes no effort parameter, so it cannot meet the elevated floor \(medium\); pass --waive-floor elevated/);
  assert.equal(store.setRow('large-refactor', { model: 'haiku', waiveFloor: 'elevated', now: NOW }).revision, 1);
  assert.equal(store.setRow('verify', { model: 'haiku', now: NOW }).revision, 2, 'a routine type needs no waiver');
});

// S2 review P1/P8: the writer's lock is the shared helper (lib/file-lock.mjs).
// Stat-then-unlink broke a LIVE writer's lock (duplicate revisions, a lost
// set, a corrupt journal), and a killed writer's lock blocked for 30 s.
test('a LIVE writer\'s lock is never broken, however old: the next writer waits for its release', async () => {
  const root = freshRoot('livelock');
  mkdirSync(files().dir, { recursive: true });
  // This test process is the live owner; its lock is an hour old.
  writeFileSync(files().lock, JSON.stringify({ pid: process.pid, token: 'live-holder', at: Date.now() - 3_600_000 }));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(files().lock, old, old);
  const child = runChild({ AGENT_COMPANION_STATE_DIR: root }, ['1', 'operate:sonnet']);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(JSON.parse(readFileSync(files().lock, 'utf8')).token, 'live-holder', 'the waiting writer broke a live lock');
  assert.equal(existsSync(files().profile), false, 'the waiting writer wrote while the lock was held');
  rmSync(files().lock);
  const r = await child;
  assert.equal(r.code, 0, r.err);
  assert.equal(readFile().revision, 1);
});

test('a killed writer\'s lock (dead pid) is broken within a second, not after 30 s', () => {
  freshRoot('deadlock');
  mkdirSync(files().dir, { recursive: true });
  const { spawnSync } = process.getBuiltinModule('node:child_process');
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  writeFileSync(files().lock, JSON.stringify({ pid: dead, token: 'killed', at: Date.now() - 2000 }));
  const t0 = Date.now();
  assert.equal(store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }).revision, 1);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(readdirSync(files().dir).sort(), ['routing-profile.journal.jsonl', 'routing-profile.json']);
});

// 0.29.0 final review F3: a directory at the lock path used to be waited on
// for the whole 15 s and then refused as "locked by another writer".
test('a directory at the lock path is refused at once as invalid-file, not after 15 s as locked', () => {
  freshRoot('lockdir');
  mkdirSync(files().lock, { recursive: true });
  const t0 = Date.now();
  expectCode(() => store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }), 'invalid-file');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  assert.throws(() => store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW }), /routing-profile lock at .* cannot be used \(something other than a lock file stands at the lock path \(a directory\)\)/);
  assert.equal(existsSync(files().profile), false, 'nothing was written');
});

test('unset retires the row (kept, journalled); rollback --row restores it; unknown rows are not-found', () => {
  freshRoot('unset');
  store.setRow('operate', { model: 'sonnet', effort: 'low', now: NOW });
  store.unsetRow('operate', { now: NOW });
  assert.equal(readFile().rows.operate.state, 'retired');
  expectCode(() => store.unsetRow('operate', { now: NOW }), 'usage');
  expectCode(() => store.unsetRow('explore', { now: NOW }), 'not-found');
  store.rollbackRow('operate', { now: NOW });
  assert.equal(readFile().rows.operate.state, 'trial');
  store.rollbackRow('operate', { now: NOW }); // undo of the undo
  assert.equal(readFile().rows.operate.state, 'retired');
  expectCode(() => store.rollbackRow('explore', { now: NOW }), 'not-found');
  expectCode(() => store.rollbackTo(99, { now: NOW }), 'not-found');
  expectCode(() => store.rollbackTo('x', { now: NOW }), 'usage');
});

// --- Concurrency: two writers, no lost update -------------------------------

function runChild(env, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(TESTS_DIR, 'fixtures', 'routing-profile', 'writer-child.mjs'), ...args], {
      env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('concurrency: two writers racing on one profile lose no update and leave a contiguous journal', async () => {
  const root = freshRoot('race');
  const N = 15;
  const [a, b] = await Promise.all([
    runChild({ AGENT_COMPANION_STATE_DIR: root }, [String(N), 'bounded-feature:sonnet', 'mechanical-edit:opus']),
    runChild({ AGENT_COMPANION_STATE_DIR: root }, [String(N), 'debug-root-cause:sonnet', 'operate:opus']),
  ]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const ra = JSON.parse(a.out.trim());
  const rb = JSON.parse(b.out.trim());
  const revs = [...ra, ...rb].map((x) => x.revision).sort((x, y) => x - y);
  assert.deepEqual(revs, Array.from({ length: 2 * N }, (_, k) => k + 1), 'every write got its own revision');
  const p = readFile();
  assert.equal(p.revision, 2 * N);
  // Each type's final value is its writer's LAST write to it.
  for (const list of [ra, rb]) {
    for (const type of new Set(list.map((x) => x.type))) {
      const last = list.filter((x) => x.type === type).at(-1);
      assert.deepEqual([p.rows[type].model, p.rows[type].effort], [last.model, last.effort], type);
    }
  }
  const { entries, errors } = readEntries();
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => e.revision), Array.from({ length: 2 * N + 1 }, (_, k) => k));
  assert.equal(rp.canonical(rp.rebuildAt(entries, 2 * N)), rp.canonical(p));
  assert.deepEqual(readdirSync(files().dir).sort(), ['routing-profile.journal.jsonl', 'routing-profile.json'], 'no lock or temp file left behind');
});

// --- The /ac routing CLI ----------------------------------------------------

test('CLI: set/why/unset/rollback/show end to end, with F1-F5 refusals at write', () => {
  const root = freshRoot('cli');
  const cwd = mkdtempSync(join(tmpdir(), 'ac-cli-cwd-'));
  const env = { AGENT_COMPANION_STATE_DIR: root, AGENT_COMPANION_FAKE_NOW: '2026-09-24T12:00:00.000Z' };
  const cli = (...args) => runScript('scripts/routing-profile.mjs', args, { env, cwd });
  try {
    const empty = cli('show');
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /no profile — every route comes from the shipped table/);

    const refusals = [
      [['set', 'integration', '--model', 'sonnet', '--effort', 'low'], /F5: effort 'low' is below the elevated floor \(medium\); pass --waive-floor elevated/],
      [['set', 'critical-change', '--model', 'sonnet', '--effort', 'xhigh'], /F1: critical consequence needs at least opus/],
      [['set', 'critical-change', '--model', 'opus', '--effort', 'high'], /F1: critical consequence needs effort at least xhigh/],
      [['set', 'bounded-feature', '--model', 'fable', '--effort', 'high'], /F2: fable is never a routing destination/],
      [['set', 'bounded-feature', '--model', 'mythos', '--effort', 'high'], /F2: mythos/],
      [['set', 'code-review', '--model', 'opus', '--effort', 'high'], /F3: a code-review row may set only a minimum effort, never a model/],
      [['set', 'bounded-feature', '--model', 'gpt-x', '--effort', 'high'], /'gpt-x' is not a tier alias/],
      [['set', 'bounded-feature', '--model', 'opus'], /opus takes an effort parameter/],
      [['set', 'explore', '--model', 'haiku', '--effort', 'low'], /effort 'low' unsupported by haiku/],
      [['set', 'no-such-type', '--model', 'sonnet', '--effort', 'low'], /exists in neither the shipped table nor the profile's types/],
      [['set', 'bounded-feature', '--model', 'sonnet', '--effort', 'low', '--waive-floor', 'elevated'], /F5: nothing to waive/],
    ];
    for (const [args, why] of refusals) {
      const r = cli(...args);
      assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, why, args.join(' '));
    }
    assert.equal(existsSync(join(root, 'config', 'routing-profile.json')), false, 'a refused write creates nothing');
    assert.equal(cli('set', 'integration', '--model', 'sonnet', '--effort', 'low', '--waive-floor', 'critical').status, 2);

    const set = cli('set', 'integration', '--model', 'sonnet', '--effort', 'medium', '--because', 'cheap works for my integration work', '--waive-floor', 'elevated');
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /set integration — routing profile now at revision 1/);
    assert.equal(cli('set', 'code-review', '--effort', 'xhigh').status, 0);

    const why = cli('why', 'integration');
    assert.equal(why.status, 0, why.stderr);
    assert.match(why.stdout, /winner:\s+profile -> sonnet\/medium/);
    assert.match(why.stdout, /waiver:\s+F5 elevated effort floor — HONOURED/);
    const rec = runScript('scripts/recommend.mjs', ['--type', 'integration', '--explain'], { env, cwd });
    assert.equal(why.stdout, rec.stdout, 'why is exactly recommend --explain');

    const shown = cli('show', '--json');
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(shown.json.revision, 2);
    assert.deepEqual(shown.json.rows.map((r) => [r.type, r.status]), [['integration', 'applies'], ['code-review', 'applies']]);
    assert.equal(shown.json.journalMatches, true);

    assert.equal(cli('unset', 'integration').status, 0);
    assert.match(cli('why', 'integration').stdout, /winner:\s+trial -> opus\/medium/);
    assert.equal(cli('rollback', '--row', 'integration').status, 0);
    assert.match(cli('why', 'integration').stdout, /winner:\s+profile/);
    assert.equal(cli('rollback', '--to', '0').status, 0);
    const after = cli('show', '--json').json;
    assert.deepEqual([after.revision, after.rows], [5, []]);
    assert.equal(cli('rollback', '--to', '999').status, 1);
    assert.equal(cli('rollback').status, 2);
    assert.equal(cli('frobnicate').status, 2);

    // Everything the CLI wrote is under the state root: nothing in the cwd
    // (a stand-in for a repo) and nothing in the plugin directory.
    assert.deepEqual(readdirSync(cwd), []);
    assert.deepEqual(readdirSync(join(root, 'config')).sort(), ['routing-profile.journal.jsonl', 'routing-profile.json']);
    const strays = [];
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === '.git') continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/routing-profile\.(json|journal\.jsonl|lock)$|routing-profile-invalid\.json$/.test(n)) strays.push(relative(PLUGIN_ROOT, p));
      }
    };
    walk(PLUGIN_ROOT);
    assert.deepEqual(strays, [], 'no profile, journal, lock or marker inside the plugin dir');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('CLI: the kill switch leaves writes possible but says nothing routes through them', () => {
  const root = freshRoot('cli-off');
  const r = runScript('scripts/routing-profile.mjs', ['set', 'operate', '--model', 'sonnet', '--effort', 'low'], {
    env: { AGENT_COMPANION_STATE_DIR: root, CLAUDE_PLUGIN_OPTION_ROUTING_PROFILE: 'false' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /routing_profile option is OFF/);
  const show = runScript('scripts/routing-profile.mjs', ['show'], { env: { AGENT_COMPANION_STATE_DIR: root, CLAUDE_PLUGIN_OPTION_ROUTING_PROFILE: 'false' } });
  assert.match(show.stdout, /routing_profile off \(kill switch/);
  assert.match(show.stdout, /would apply \(routing_profile is off\)/);
});
