// Which claude.ai account is in use (0.31.59). Some people sign more than one account into the Claude desktop app and switch
// between them (for example when one subscription's weekly limit runs out). Each account has its own weekly limit, plan and
// reset time, so a plan-meter reading belongs to ONE account. This module answers two questions and nothing else:
//
//   currentAccount()                 the id of the account in use now, or null when no source says.
//   accountHistory({ samples? })     [{ at, acct }] sorted by time (at: ISO string), consecutive same-account entries collapsed
//                                    to the earliest. Built from the sources below plus the transitions seen in tagged meter
//                                    samples. [] when nothing is known.
//   accountAt(history, t)            the account at time t (ms or ISO) by that history, or null before its first entry.
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
//   c. What the get_usage result or hook input itself carries: checked against real stored samples (2026-11): neither carries an
//      account id (the result names the PLAN, e.g. "Max" or "Ultra", the hook input has session_id, transcript_path, cwd and the
//      like). So this source contributes only the `acct` tag the sampler writes from (a) or (b), and the transitions between tags.
// Nothing here imports across plugins; session-sync's files are only read.

import { openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeRoot, claudeDir } from './context.mjs';
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

// Sorted [{ at, acct }]: session-sync's switch history and signed entry, plus one entry per transition in the tagged meter samples
// (the first tagged sample, and each sample whose tag differs from the one before). Consecutive entries of one account collapse to
// the earliest. `samples`: parsed sample lines (readSampleLines); default reads state/plan-meter-samples.jsonl.
export function accountHistory({ samples } = {}) {
  try {
    const rec = syncRecords();
    const all = [...rec.switches];
    if (rec.signed && rec.signed.at) all.push({ at: rec.signed.at, acct: rec.signed.acct });
    let prev = null;
    for (const s of samples || readSampleLines()) {
      if (!s.acct) continue;
      if (s.acct !== prev) all.push({ at: s.ts, acct: s.acct });
      prev = s.acct;
    }
    all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const out = [];
    for (const e of all) if (!out.length || out[out.length - 1].acct !== e.acct) out.push(e);
    return out;
  } catch {
    return [];
  }
}

// The account at time t (ms or ISO) by `history` (accountHistory()'s result): the last entry at or before t, or null before the first.
export function accountAt(history, t) {
  const ms = msOf(t);
  if (!Number.isFinite(ms) || !Array.isArray(history)) return null;
  let found = null;
  for (const e of history) {
    if (Date.parse(e.at) <= ms) found = e.acct;
    else break;
  }
  return found;
}
