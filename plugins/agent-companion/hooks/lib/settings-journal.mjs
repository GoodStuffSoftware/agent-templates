// Settings journal (daily usage analysis, batch 11).
//
// SessionStart compares the CONFIGURED default model and effort (the settings
// files, not the session's own runtime value), the plugin version and a digest of
// this plugin's options with the LAST row of telemetry/settings-changes.jsonl and
// appends one row only when one of them differs (plus one baseline row when the
// journal is empty). Cost on the hot path: one bounded tail read of the journal
// and the two small settings files; at most one small append.
//
// A session's own model/effort (an opus lead beside a sonnet/low routine) is NOT a
// settings change and is never journalled while a settings file names a value.
// Only when no settings file names a model (or effort) is the SessionStart payload
// (then the environment) used as a fallback for that key, and then a value the
// journal already shows in its recent rows counts as a per-session value, not a
// change: alternating sessions write nothing after the first two distinct values.
//
// The last journal row is the state, so there is no second state file to keep in
// step. A value the payload or settings do not show (null) is "not observed": it
// never counts as a change and the prior value is carried into the new row.
//
// Privacy: a row holds the four values, the session id and the cwd. Never a
// prompt, never a transcript path, never an option value (a digest only). Every
// field is length-bounded (a long cwd is cut and hashed), so a row stays far
// inside the tail window and one large field can never hide the last row.
//
// The resolver half (settingEvents / settingInstant) turns the journal into the
// `setting:<key>=<value>` window events the usage-analysis resolver consumes.
import { createHash } from 'node:crypto';
import { readFileSync, openSync, readSync, closeSync, fstatSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateRootPath, claudeDir, pluginName, pluginVersion, TELEMETRY_SCHEMA, isFixtureSession } from './context.mjs';

export const JOURNAL_FILE = 'settings-changes.jsonl';
export const SETTING_KEYS = ['model', 'effort', 'plugin_version', 'options'];
const TAIL_BYTES = 4096;
const TAIL_MAX_BYTES = 65536; // the window grows to this while the tail holds no complete line
const CWD_MAX = 160;
const FIELD_MAX = 100;

const clip = (v, n = FIELD_MAX) => (typeof v === 'string' ? v.slice(0, n) : v);

// A long cwd keeps its head and a hash of the whole path, so two deep paths stay distinguishable.
export function boundCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  if (cwd.length <= CWD_MAX) return cwd;
  return `${cwd.slice(0, CWD_MAX - 14)}~${createHash('sha1').update(cwd).digest('hex').slice(0, 12)}`;
}

function readJsonSafe(file) {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8'));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}

// The values this process can observe now. Pure given (payload, env, files).
// `fallback[k]` is true when model/effort came from the session (payload or environment), not a settings file.
export function observeSettings(p, { env = process.env, dir = claudeDir() } = {}) {
  const local = readJsonSafe(join(dir, 'settings.local.json'));
  const user = readJsonSafe(join(dir, 'settings.json'));
  const str = (v) => (typeof v === 'string' && v ? v : null);
  // The configured default: the settings files (local over user). The payload and the environment are
  // per-session values (a routine can run another model), so they are only a fallback.
  const cfgModel = str(local?.model) || str(user?.model);
  const cfgEffort = str(local?.effortLevel) || str(user?.effortLevel);
  const model = cfgModel || str(p?.model) || str(env.ANTHROPIC_MODEL);
  const effort = cfgEffort || str(p?.effort?.level) || str(p?.effort) || str(env.CLAUDE_CODE_EFFORT_LEVEL);
  const fallback = { model: !cfgModel && model !== null, effort: !cfgEffort && effort !== null };
  // Option digest: plugin options from the environment and settings, values hashed.
  const name = pluginName();
  const pairs = [];
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CLAUDE_PLUGIN_OPTION_') && v !== undefined) pairs.push(`env:${k.slice(21).toLowerCase()}=${v}`);
  }
  for (const [tag, s] of [['local', local], ['user', user]]) {
    const configs = s?.pluginConfigs;
    if (!configs || typeof configs !== 'object') continue;
    for (const ck of Object.keys(configs)) {
      if (ck !== name && !ck.startsWith(`${name}@`)) continue;
      const o = configs[ck]?.options;
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) pairs.push(`${tag}:${k}=${JSON.stringify(v)}`);
    }
  }
  pairs.sort();
  const options = pairs.length ? createHash('sha1').update(pairs.join('\n')).digest('hex').slice(0, 12) : 'none';
  return { model: clip(model), effort: clip(effort), plugin_version: clip(pluginVersion()), options, fallback };
}

// The parseable rows of the journal's bounded tail, oldest first ([] when absent). The window starts at
// TAIL_BYTES and doubles (to TAIL_MAX_BYTES) while it holds no complete line, so one oversized row (an
// older version stored cwd unbounded) cannot hide the journal state.
export function tailRows(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    if (!size) return [];
    for (let want = TAIL_BYTES; ; want *= 2) {
      const start = Math.max(0, size - want);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      const rows = [];
      for (const l of lines) {
        const t = l.trim();
        if (t[0] !== '{') continue;
        try { rows.push(JSON.parse(t)); } catch { /* torn line */ }
      }
      if (rows.length || start === 0 || want >= TAIL_MAX_BYTES) return rows;
    }
  } catch { return []; } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

// Last parseable row of the journal, from a bounded tail. null when absent.
export function lastRow(file) {
  const rows = tailRows(file);
  return rows.length ? rows[rows.length - 1] : null;
}

// Pure: the row to append, or null. `prior` is the last journal row or null. `history` is the earlier
// tail rows: for a key whose value came from the session (`seen.fallback[k]`), a value any recent row
// already shows is a per-session value, not a change.
export function nextRow(prior, seen, { at, session_id, cwd, history = [] }) {
  const base = {};
  const changed = [];
  for (const k of SETTING_KEYS) {
    const now = seen[k] ?? null;
    const was = prior ? (prior[k] ?? null) : null;
    const sessionOnly = now !== null && now !== was && !!seen.fallback?.[k] && history.some((r) => r && r[k] === now);
    base[k] = sessionOnly ? was : (now ?? was);
    if (now !== null && now !== was && !sessionOnly) changed.push(k);
  }
  if (prior && changed.length === 0) return null;
  if (!prior && SETTING_KEYS.every((k) => base[k] === null)) return null;
  return {
    at, session_id: clip(session_id, 80), cwd: boundCwd(cwd), ...base,
    changed: prior ? changed : ['baseline'],
  };
}

// A short-lived lock around the read-then-append, taken only when a row is about to be written (the common
// start writes nothing and never touches it). Simultaneous starts that see the same change then append one
// row: the loser re-reads the journal under the lock and finds nothing left to write. Fail open: a lock that
// cannot be taken within LOCK_WAIT_MS is ignored (a duplicate row beats a stalled session start), and a lock
// older than LOCK_STALE_MS is a dead holder's and is removed.
const LOCK_WAIT_MS = 400;
const LOCK_STALE_MS = 5000;
function takeLock(lock) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const t0 = Date.now();
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); return true; } catch (e) {
      if (e && e.code !== 'EEXIST') return false;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* raced: retry */ }
    }
    if (Date.now() - t0 > LOCK_WAIT_MS) return false;
    Atomics.wait(nap, 0, 0, 5);
  }
}

// Never throws. Returns the appended row, or null.
export function journalSettings(p, opts = {}) {
  try {
    const sid = p?.session_id;
    if (typeof sid !== 'string' || !sid || isFixtureSession(sid)) return null;
    const dir = join(stateRootPath(), 'telemetry');
    const file = join(dir, JOURNAL_FILE);
    const seen = observeSettings(p, opts);
    const plan = () => {
      const rows = tailRows(file);
      return nextRow(rows.length ? rows[rows.length - 1] : null, seen, {
        at: new Date(opts.now ?? Date.now()).toISOString(),
        session_id: sid,
        cwd: typeof p.cwd === 'string' ? p.cwd : null,
        history: rows.slice(0, -1),
      });
    };
    if (!plan()) return null; // nothing to write: no lock, no write
    mkdirSync(dir, { recursive: true });
    const lock = `${file}.lock`;
    const held = takeLock(lock);
    try {
      const row = plan(); // under the lock: another start may have written this change already
      if (!row) return null;
      writeFileSync(file, JSON.stringify({ v: TELEMETRY_SCHEMA, ...row }) + '\n', { flag: 'a' });
      return row;
    } finally {
      if (held) { try { unlinkSync(lock); } catch { /* ignore */ } }
    }
  } catch { return null; }
}

// --- resolver half ---------------------------------------------------------
// Events from journal rows (oldest first): one per switch of a key's value. A
// value that reverts later (A, B, A) yields an event at each switch.
export function settingEvents(rows) {
  const out = [];
  const last = {};
  for (const r of rows || []) {
    const ms = Date.parse(r?.at);
    if (!Number.isFinite(ms)) continue;
    for (const k of SETTING_KEYS) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      if (last[k] !== v) { out.push({ key: k, value: String(v), ms, session_id: r.session_id }); last[k] = v; }
    }
  }
  return out;
}

// `setting:<key>=<value>` -> the FIRST instant (ms) that value was in force, or
// null. Pass `after` (ms) to find the first switch to it at or after that time.
export function settingInstant(rows, spec, { after = -Infinity } = {}) {
  const m = /^(?:setting:)?([a-z_]+)=(.+)$/.exec(String(spec));
  if (!m) return null;
  const hit = settingEvents(rows).find((e) => e.key === m[1] && e.value === m[2] && e.ms >= after);
  return hit ? hit.ms : null;
}

export function readJournal(file = join(stateRootPath(), 'telemetry', JOURNAL_FILE)) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l[0] === '{').flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}
