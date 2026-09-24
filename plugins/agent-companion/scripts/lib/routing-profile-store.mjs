// THE routing-profile writer (ADR 0003 §1, §6; slice 2). Every change to
// <stateRoot>/config/routing-profile.json goes through commitChange() below —
// the CLI's set / unset / rollback, and later slices' apply and migrate.
// Nothing else writes the file.
//
// One write, in order:
//   1. take the lock (config/routing-profile.lock) through the shared
//      helper (hooks/lib/file-lock.mjs), so two writers serialise instead of
//      losing an update. The lock names its owner (pid + token); it is
//      released only by that owner, and broken only when the owner's process
//      is gone AND it is older than STALE_LOCK_MS, by a re-verified rename.
//      A live writer's lock is never broken (S2 review P1: stat-then-unlink
//      broke live locks, duplicating revisions and corrupting the journal),
//      and a killed writer's lock no longer blocks for 30 s (P8).
//   2. read the file and the journal FRESH (never the resolver's cache);
//      refuse to write over a file that is invalid or from a newer major
//      version — the operator fixes or removes it, the writer never guesses
//   3. optional compare-revision: expectRevision must equal the file's
//   4. reconcile: if the journal does not rebuild the file exactly (a hand
//      edit, a restored backup, a crash between rename and append), first
//      journal the file as it stands ("adopt-external-edit"), so the journal
//      stays a complete history
//   5. apply the change and VALIDATE: schema, and every row the change
//      touches through context.mjs's profileRowRefusal() in write mode
//      (F1-F4 refused; F5 only with an operator-observed waiver). A
//      rollback is checked in read mode instead (F1-F4 only), so any
//      journalled revision the resolver would accept is restorable exactly
//   6. write a temp file beside the profile and rename it over (atomic on
//      the same volume), then append the journal line(s)
//   7. release the lock
// Every path it touches is under the state root (routingProfilePath()).

import {
  writeFileSync, readFileSync, renameSync, unlinkSync, appendFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  modelTiers, routingProfilePath, profileRowRefusal, taskTypeDef,
} from '../../hooks/lib/context.mjs';
import {
  parseProfileText, parseJournal, rebuildAt, journalMaxRevision, emptyProfile, profileContent, canonical, applyEntry,
  typeShapeErrors, rowShapeErrors, ACTIVE_STATES, JOURNAL_FILE, LOCK_FILE,
} from '../../hooks/lib/routing-profile.mjs';
import { withFileLock, LockTimeoutError } from '../../hooks/lib/file-lock.mjs';

// A dead owner's lock this old is broken. A live owner's never is, whatever
// its age, so this only has to exceed the instant between creating a lock
// and its owner being checkable.
export const STALE_LOCK_MS = 1_000;
const LOCK_TIMEOUT_MS = 15_000;

export class ProfileWriteError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.code = code; // refused | conflict | invalid-file | locked | corrupt-journal | not-found | usage
    this.details = details;
  }
}

export function profileFiles() {
  const profile = routingProfilePath();
  const dir = dirname(profile);
  return { dir, profile, journal: join(dir, JOURNAL_FILE), lock: join(dir, LOCK_FILE) };
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The writer never runs unlocked: a timeout is a 'locked' refusal.
function withLock(lockPath, fn) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    return withFileLock(lockPath, () => fn(), { waitMs: LOCK_TIMEOUT_MS, staleMs: STALE_LOCK_MS, failOpen: false });
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      throw new ProfileWriteError('locked', `routing profile is locked by another writer (${lockPath}); retry, or remove the lock if no writer is running`);
    }
    throw e;
  }
}

// Rename with retries: on Windows a reader holding the target open for the
// instant of its readFileSync makes the replace fail with EPERM/EBUSY.
function renameOver(tmp, target) {
  for (let i = 0; ; i += 1) {
    try { renameSync(tmp, target); return; } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw e;
      }
      sleepMs(15);
    }
  }
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameOver(tmp, file);
}

// Current file + journal, read fresh. Throws ProfileWriteError on a file or
// journal the writer must not build on.
export function readForWrite(files = profileFiles()) {
  let profile = null;
  if (existsSync(files.profile)) {
    const res = parseProfileText(readFileSync(files.profile, 'utf8'));
    if (res.status !== 'ok') {
      throw new ProfileWriteError('invalid-file',
        `the routing profile at ${files.profile} is invalid (${res.reason}); fix or remove it before writing — the resolver is ignoring it`,
        res.errors || []);
    }
    profile = res.profile;
  }
  let entries = [];
  if (existsSync(files.journal)) {
    const j = parseJournal(readFileSync(files.journal, 'utf8'));
    if (j.errors.length) {
      throw new ProfileWriteError('corrupt-journal', `the routing-profile journal at ${files.journal} cannot be folded; repair it before writing`, j.errors);
    }
    entries = j.entries;
  }
  return { profile, entries };
}

// Is the file exactly what the journal rebuilds at its revision?
export function journalMatchesFile(profile, entries) {
  if (!profile) return true;
  if (journalMaxRevision(entries) !== profile.revision) return false;
  const rebuilt = rebuildAt(entries, profile.revision);
  return !!rebuilt && canonical(rebuilt) === canonical(profile);
}

function basedOnNow() {
  const cfg = modelTiers();
  return { tableVersion: cfg.version ?? null, tableUpdated: cfg.updated ?? null };
}

// Validate the rows a change touches (write mode) plus the profile's shape.
// Returns the list of refusals (empty = OK). Local types are validated for
// shape so a written profile never carries a type the reader would drop.
export function validateForWrite(next, touched, { now, mode = 'write' } = {}) {
  const errs = [];
  const res = parseProfileText(JSON.stringify(next));
  if (res.status !== 'ok') return res.errors;
  for (const [n, def] of Object.entries(next.types || {})) {
    for (const e of typeShapeErrors(def)) errs.push(`type ${n}: ${e}`);
  }
  const state = { status: 'ok', profile: next, revision: next.revision };
  for (const type of touched) {
    const row = next.rows[type];
    if (row === undefined) continue; // removed
    if (row && ACTIVE_STATES.has(row.state)) {
      const td = taskTypeDef(type, { state });
      const reason = profileRowRefusal(type, row, { typeDef: td ? td.def : null, now, mode });
      if (reason) errs.push(`${type}: ${reason}`);
    } else {
      // A retired row never resolves, so only its shape is checked.
      for (const e of rowShapeErrors(row)) errs.push(`${type}: invalid row: ${e}`);
    }
  }
  return errs;
}

// THE writer. `change(current, { entries })` receives the current profile (a
// fresh copy; an empty profile when none exists) and the full journal up to
// it, and returns either
//   { action, type, row }        a row change (row null = remove the row)
//   { action, type: null, content }  a whole-profile change (every key but revision)
// or throws ProfileWriteError. Returns { revision, profile, entries }.
export function commitChange(change, { by = 'operator', expectRevision, now, at } = {}) {
  const files = profileFiles();
  return withLock(files.lock, () => {
    const { profile: onDisk, entries } = readForWrite(files);
    if (expectRevision !== undefined && expectRevision !== null) {
      const have = onDisk ? onDisk.revision : 0;
      if (have !== expectRevision) {
        throw new ProfileWriteError('conflict', `routing profile is at revision ${have}, not ${expectRevision}: someone else changed it; re-read and retry`);
      }
    }
    const stamp = at || new Date().toISOString();
    const pending = [];
    let cur;
    const jmax = journalMaxRevision(entries);
    if (!onDisk) {
      // A new file (or one deleted by hand): journal its creation, keeping
      // revisions monotonic across a reset.
      const initRev = jmax + 1;
      cur = { ...emptyProfile(basedOnNow()), revision: initRev };
      pending.push({ revision: initRev, at: stamp, action: 'init', type: null, before: null, after: profileContent(cur), by });
    } else if (!journalMatchesFile(onDisk, entries)) {
      const adoptRev = jmax < onDisk.revision ? onDisk.revision : jmax + 1;
      const prior = jmax >= 0 ? rebuildAt(entries, jmax) : null;
      cur = { ...JSON.parse(JSON.stringify(onDisk)), revision: adoptRev };
      pending.push({
        revision: adoptRev, at: stamp, action: 'adopt-external-edit', type: null,
        before: prior ? profileContent(prior) : null, after: profileContent(cur), by,
      });
    } else {
      cur = JSON.parse(JSON.stringify(onDisk));
    }

    const c = change(JSON.parse(JSON.stringify(cur)), { entries: [...entries, ...pending] });
    if (!c || typeof c !== 'object') throw new ProfileWriteError('usage', 'change() returned nothing');
    const revision = cur.revision + 1;
    let next;
    let entry;
    let touched;
    if (c.type === null) {
      next = { ...JSON.parse(JSON.stringify(c.content)), revision };
      touched = Object.keys(next.rows || {});
      entry = { revision, at: stamp, action: c.action, type: null, before: profileContent(cur), after: profileContent(next), by };
    } else {
      if (typeof c.type !== 'string' || !c.type) throw new ProfileWriteError('usage', 'a row change must name its type');
      const before = Object.prototype.hasOwnProperty.call(cur.rows, c.type) ? cur.rows[c.type] : null;
      const rows = { ...cur.rows };
      if (c.row === null || c.row === undefined) delete rows[c.type];
      else rows[c.type] = JSON.parse(JSON.stringify(c.row));
      next = { ...cur, rows, revision };
      touched = [c.type];
      entry = { revision, at: stamp, action: c.action, type: c.type, before, after: c.row ?? null, by };
    }
    // A rollback restores a journalled state: it is checked in READ mode
    // (F1-F4, what the resolver itself refuses), not write mode, so a revision
    // the writer would now refuse on F5 (an adopted hand edit, say) is still
    // restorable exactly; F5 then raises it at resolve time as usual (S2
    // review P3, lead decision).
    const errs = validateForWrite(next, touched, { now, mode: c.validate === 'read' ? 'read' : 'write' });
    if (errs.length) throw new ProfileWriteError('refused', `refused: ${errs[0]}`, errs);

    writeAtomic(files.profile, JSON.stringify(next, null, 2) + '\n');
    pending.push(entry);
    appendFileSync(files.journal, pending.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return { revision, profile: next, entries: pending };
  });
}

// Read-only view for show/why and the tests: file + journal, plus whether
// they agree. Never throws for a missing file.
export function inspect() {
  const files = profileFiles();
  const out = { files, profile: null, status: 'absent', errors: [], entries: [], journalErrors: [] };
  if (existsSync(files.profile)) {
    const res = parseProfileText(readFileSync(files.profile, 'utf8'));
    out.status = res.status;
    if (res.status === 'ok') out.profile = res.profile;
    else { out.reason = res.reason; out.errors = res.errors || []; }
  }
  if (existsSync(files.journal)) {
    const j = parseJournal(readFileSync(files.journal, 'utf8'));
    out.entries = j.entries;
    out.journalErrors = j.errors;
  }
  out.journalMatches = out.profile ? journalMatchesFile(out.profile, out.entries) : null;
  return out;
}

// --- Operations (the /ac routing commands). Each is ONE commitChange(). -----

export const DEFAULT_REVIEW_DAYS = 90;

// The clock: AGENT_COMPANION_FAKE_NOW (the scout's fake clock) wins, so
// tests can pin since/reviewBy; otherwise the real date.
export function nowDate() {
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  const d = fake ? new Date(fake) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
const ymd = (d) => d.toISOString().slice(0, 10);
const rowOf = (p, type) => (Object.prototype.hasOwnProperty.call(p.rows || {}, type) ? p.rows[type] : null);

// `set <type> --model M --effort E [--because "..."] [--waive-floor elevated]`:
// an operator-observed trial row, reviewBy 90 days out (soft: nothing expires
// it). A parity-sized type (code-review) takes --effort only: a minimum.
export function setRow(type, { model = null, effort = null, because = null, waiveFloor = null, by = 'operator', now } = {}) {
  const clock = now ? new Date(now) : nowDate();
  const since = ymd(clock);
  const reviewBy = ymd(new Date(clock.getTime() + DEFAULT_REVIEW_DAYS * 86400000));
  const row = {
    state: 'trial',
    model: model ? String(model).toLowerCase() : null,
    effort: effort ? String(effort).toLowerCase() : null,
    cacheTtl: null,
    source: 'operator-observed',
    since,
    reviewBy,
    waivesFloor: waiveFloor || null,
    note: because ? String(because) : null,
    provenance: null,
  };
  return commitChange(() => ({ action: 'set', type, row }), { by, now: clock });
}

// `unset <type>`: the row moves to retired (kept, never resolved).
export function unsetRow(type, { by = 'operator', now } = {}) {
  return commitChange((cur) => {
    const row = rowOf(cur, type);
    if (!row) throw new ProfileWriteError('not-found', `no routing-profile row for ${type}`);
    if (row.state === 'retired') throw new ProfileWriteError('usage', `the ${type} row is already retired`);
    return { action: 'unset', type, row: { ...row, state: 'retired' } };
  }, { by, now });
}

// The value a row held after each journal revision, oldest first.
function rowHistory(entries, type) {
  const out = [];
  let p = emptyProfile();
  for (const e of entries) {
    p = applyEntry(p, e);
    out.push({ revision: e.revision, value: rowOf(p, type) });
  }
  return out;
}

// `rollback --row <type>`: restore the value the row held before its most
// recent change (null = the row did not exist, so it is removed). Rolling
// back twice therefore toggles, like an undo of the undo.
export function rollbackRow(type, { by = 'operator', now } = {}) {
  return commitChange((cur, { entries }) => {
    const current = canonical(rowOf(cur, type));
    const hist = rowHistory(entries, type);
    let i = hist.length - 1;
    while (i >= 0 && canonical(hist[i].value) === current) i -= 1;
    if (i < 0) throw new ProfileWriteError('not-found', `the journal holds no earlier version of the ${type} row`);
    return { action: 'rollback-row', type, row: hist[i].value, validate: 'read' };
  }, { by, now });
}

// `rollback --to <revision>`: the whole profile, exactly as it stood at that
// revision (under a NEW revision number — history is never rewritten).
export function rollbackTo(target, { by = 'operator', now } = {}) {
  const n = typeof target === 'number' ? target : (/^\d+$/.test(String(target)) ? Number(target) : NaN);
  if (!Number.isInteger(n) || n < 0) throw new ProfileWriteError('usage', `--to needs a revision number, got ${JSON.stringify(target)}`);
  return commitChange((cur, { entries }) => {
    const at = rebuildAt(entries, n);
    if (!at) throw new ProfileWriteError('not-found', `the journal holds no revision ${n}`);
    const content = profileContent(at);
    if (canonical(content) === canonical(profileContent(cur))) {
      throw new ProfileWriteError('usage', `the profile already matches revision ${n}; nothing to roll back`);
    }
    return { action: 'rollback-to', type: null, content, validate: 'read' };
  }, { by, now });
}
