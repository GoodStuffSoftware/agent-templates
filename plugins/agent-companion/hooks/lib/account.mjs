// Which claude.ai account is in use (0.31.59). Some people sign more than one account into the Claude desktop app and switch
// between them (for example when one subscription's weekly limit runs out). Each account has its own weekly limit, plan and
// reset time, so a plan-meter reading belongs to ONE account. This module answers two questions and nothing else:
//
//   currentAccount()                 the id of the account in use now, or null when no source says.
//   noteAccount()                    append { at, acct } to <state>/state/account-history.jsonl when the account differs from the last
//                                    entry (a SessionStart hook and the sampler call it). Nothing is written when it is unchanged.
//   accountHistory({ samples? })     [{ at, acct, after? }] sorted by time (at: ISO string), consecutive same-account entries collapsed
//                                    to the earliest. Built from the sources below, that file and the transitions seen in tagged
//                                    meter samples. [] when nothing is known. An entry that came from a first SIGHT of the account
//                                    (not from session-sync's dated switch) carries `after`: the last time the previous account was
//                                    seen. The switch happened somewhere in (after, at]; that interval is UNCERTAIN, never guessed.
//   accountAt(history, t)            the account at time t (ms or ISO) by that history, or null before its first entry and inside an
//                                    uncertain interval.
//   uncertainSpans(history)          [{ from, to, acct }] (ms) the uncertain intervals; `acct` is the account seen before.
//
// The id is an opaque string (a UUID in practice). It is kept in local state only (the `acct` field of state/plan-meter-samples.jsonl);
// nothing here sends it anywhere. Every source is OPTIONAL and read defensively (a missing file, malformed JSON or another shape is
// ignored), so a user with one account, or with none of the sources, gets null / [] and the plugin behaves as it did before.
//
// Sources, in the order currentAccount() tries them:
//   a. The desktop app's own record of the signed-in account: `lastKnownAccountUuid` in <app data>/Claude/config.json. Read the way
//      the session-sync plugin reads it (a bounded text scan for that one key; the file is not parsed, copied or logged; only the
//      uuid leaves). The app data folder is probed like the other desktop readers here (literal profile path, never an env var the
//      MSIX package redirects); the test seam AGENT_COMPANION_DESKTOP_DIR names the folder that holds config.json.
//   b. With the session-sync plugin installed: ~/.claude/session-sync/accounts/state.json (`signed.acct` = the active account) and
//      ~/.claude/session-sync/accounts/switch-history.json (an array of { at, acct }, ISO times). state.json also gives one history
//      entry ({ signed.at, signed.acct }) when it has a time. Used for the history, and for currentAccount() when (a) found nothing.
//   c. The plugin's own record, state/account-history.jsonl (noteAccount above): the first time each run of an account was seen.
//   d. What the get_usage result or hook input itself carries: checked against real stored samples (2026-11): neither carries an
//      account id (the result names the PLAN, e.g. "Max" or "Ultra", the hook input has session_id, transcript_path, cwd and the
//      like). So this source contributes only the `acct` tag the sampler writes from (a) or (b), and the transitions between tags.
// Nothing here imports across plugins; session-sync's files are only read.

import { openSync, readSync, closeSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRoot, claudeDir, stateDir, stateRootPath } from './context.mjs';
import { readSampleLines } from './plan-meter.mjs';

const SIGNED_IN_RE = /"lastKnownAccountUuid"\s*:\s*"([0-9a-f-]{36})"/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const idOf = (v) => (typeof v === 'string' && ID_RE.test(v) ? v.toLowerCase() : null);
const msOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

// The folder that holds the desktop app's config.json, or null.
function appDataDir() {
  if (process.env.AGENT_COMPANION_DESKTOP_DIR) return process.env.AGENT_COMPANION_DESKTOP_DIR;
  const home = homeRoot();
  if (process.platform === 'win32') return join(home, 'AppData', 'Roaming', 'Claude');
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude');
  return join(home, '.config', 'Claude');
}

// (a) The signed-in account uuid from the app's config.json, or null. Bounded: 64 KB chunks, 1 MB at most, first match wins.
function appSignedIn() {
  let fd;
  try { fd = openSync(join(appDataDir(), 'config.json'), 'r'); } catch { return null; }
  const CHUNK = 64 * 1024;
  const MAX = 1024 * 1024;
  const buf = Buffer.alloc(CHUNK);
  let total = 0;
  let carry = '';
  try {
    while (total < MAX) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n <= 0) break;
      total += n;
      const text = carry + buf.toString('latin1', 0, n);
      const m = SIGNED_IN_RE.exec(text);
      if (m) return m[1].toLowerCase();
      carry = text.slice(-120);
    }
  } catch { /* unreadable: unknown */ } finally {
    buf.fill(0);
    try { closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

// (b) session-sync's records. { signed: { acct, at } | null, switches: [{ at, acct }] }; anything of another shape is ignored.
function syncRecords() {
  const dir = join(claudeDir(), 'session-sync', 'accounts');
  const out = { signed: null, switches: [] };
  const st = readJson(join(dir, 'state.json'));
  const s = st && typeof st === 'object' ? st.signed : null;
  if (s && typeof s === 'object') {
    const acct = idOf(s.acct);
    if (acct) out.signed = { acct, at: Number.isFinite(msOf(s.at)) ? new Date(msOf(s.at)).toISOString() : null };
  }
  const h = readJson(join(dir, 'switch-history.json'));
  if (Array.isArray(h)) {
    for (const e of h) {
      const acct = e && typeof e === 'object' ? idOf(e.acct) : null;
      const t = e && typeof e === 'object' ? msOf(e.at) : NaN;
      if (acct && Number.isFinite(t)) out.switches.push({ at: new Date(t).toISOString(), acct });
    }
  }
  return out;
}

// The account in use now (see the sources above), or null.
export function currentAccount() {
  try {
    return appSignedIn() || syncRecords().signed?.acct || null;
  } catch {
    return null;
  }
}

// The plugin's own record of when each run of an account was first seen (hooks call noteAccount()).
const HISTORY_FILE = 'account-history.jsonl';
const HISTORY_READ_MAX = 256 * 1024; // the file grows only on a switch; read at most its tail
const historyPath = () => join(stateRootPath(), 'state', HISTORY_FILE); // a read: never creates the state root

function ownRecords() {
  try {
    const text = readFileSync(historyPath(), 'utf8');
    const out = [];
    for (const ln of (text.length > HISTORY_READ_MAX ? text.slice(-HISTORY_READ_MAX) : text).split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try {
        const j = JSON.parse(ln);
        const acct = j && typeof j === 'object' ? idOf(j.acct) : null;
        const t = j && typeof j === 'object' ? msOf(j.at) : NaN;
        if (acct && Number.isFinite(t)) out.push({ at: new Date(t).toISOString(), acct });
      } catch { /* torn line */ }
    }
    return out;
  } catch { return []; }
}

// Record the account in use now when it differs from the last recorded one: one cheap read of the app record, one small read of the
// history file, and a write only on a switch (nothing at all when unchanged). Fail-soft: false on any problem. `account` and `now`
// are seams (the sampler passes the account it already read).
export function noteAccount({ account, now = new Date() } = {}) {
  try {
    const acct = idOf(account === undefined ? currentAccount() : account);
    if (!acct) return false;
    const last = ownRecords().pop();
    if (last && last.acct === acct) return false;
    appendFileSync(join(stateDir(), HISTORY_FILE), `${JSON.stringify({ at: now.toISOString(), acct })}\n`);
    return true;
  } catch {
    return false;
  }
}

// Sorted [{ at, acct, after? }]. Dated switches (session-sync's switch history and signed entry) are exact. Every other source only SAW an
// account at a time (the plugin's own record, the first tagged sample, a sample whose tag differs from the one before): the switch was
// somewhere between the last sign of the previous account and that first sight, so the entry carries `after` (that last sign) and the
// interval (after, at) is uncertain (accountAt answers null there). Consecutive entries of one account collapse to the earliest.
// `samples`: parsed sample lines (readSampleLines); default reads state/plan-meter-samples.jsonl.
export function accountHistory({ samples } = {}) {
  try {
    const rec = syncRecords();
    const signs = rec.switches.map((e) => ({ ...e, exact: true }));
    if (rec.signed && rec.signed.at) signs.push({ at: rec.signed.at, acct: rec.signed.acct, exact: true });
    for (const e of ownRecords()) signs.push({ ...e, exact: false });
    for (const s of samples || readSampleLines()) if (s.acct) signs.push({ at: s.ts, acct: s.acct, exact: false });
    const ms = (e) => Date.parse(e.at);
    const ordered = signs.filter((e) => Number.isFinite(ms(e))).sort((a, b) => ms(a) - ms(b) || (a.exact ? 0 : 1) - (b.exact ? 0 : 1));
    const out = [];
    let lastSign = null; // when the account in force was last seen
    for (const e of ordered) {
      const cur = out.length ? out[out.length - 1].acct : null;
      if (e.acct !== cur) {
        out.push(e.exact || cur === null ? { at: e.at, acct: e.acct } : { at: e.at, acct: e.acct, after: lastSign });
      }
      lastSign = e.at;
    }
    return out;
  } catch {
    return [];
  }
}

// The uncertain intervals of a history: [{ from, to, acct }] (ms), `acct` the account seen before. [] for an exactly dated history.
export function uncertainSpans(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const e = history[i];
    const from = e && e.after ? Date.parse(e.after) : NaN;
    const to = Date.parse(e && e.at);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) out.push({ from, to, acct: history[i - 1].acct });
  }
  return out;
}

// The account at time t (ms or ISO) by `history` (accountHistory()'s result): the last entry at or before t; null before the first entry
// and inside an uncertain interval (after the previous account was last seen, before the next was first seen).
export function accountAt(history, t) {
  const ms = msOf(t);
  if (!Number.isFinite(ms) || !Array.isArray(history)) return null;
  let found = null;
  for (const e of history) {
    if (Date.parse(e.at) <= ms) found = e.acct;
    else {
      const after = e.after ? Date.parse(e.after) : NaN;
      if (Number.isFinite(after) && ms > after) return null;
      break;
    }
  }
  return found;
}
