// State for the post-release watch (scripts/release-watch.mjs), shared with the hooks that show or honour it.
//
// Files, all under <state root>/state/ (fail open on a missing or unparseable file):
//   release-watch-run.json    the schedule for the newest install: T, version, due[], done[], prevT
//   release-watch-flag.json   the open flag: flags[], notifiedAt, ackedAt, clearedAt, cooldown{}
//   release-hold.json         the hold: { since, version, reason, flags, workers, clearedAt }
//   release-watch-checks.jsonl  one row per check and per clear
// AGENT_COMPANION_FAKE_NOW moves the clock for tests. Nothing here throws.

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './context.mjs';

export const COOLDOWN_MS = 4 * 3600e3;
export const WORSEN_FACTOR = 2;

export const now = () => {
  const f = process.env.AGENT_COMPANION_FAKE_NOW;
  if (f) { const t = /^\d+$/.test(f) ? Number(f) : Date.parse(f); if (t > 0) return t; }
  return Date.now();
};

export const paths = () => {
  const d = stateDir();
  return {
    run: join(d, 'release-watch-run.json'),
    flag: join(d, 'release-watch-flag.json'),
    hold: join(d, 'release-hold.json'),
    checks: join(d, 'release-watch-checks.jsonl'),
  };
};

export function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function writeJson(file, obj) {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 1));
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function appendRow(row) {
  try { appendFileSync(paths().checks, JSON.stringify(row) + '\n'); return true; } catch { return false; }
}

const iso = (t) => new Date(t).toISOString();

// ---- flag ----
export function readFlag() { return readJson(paths().flag); }
export function flagIsOpen(f = readFlag()) { return !!(f && Array.isArray(f.flags) && f.flags.length && !f.clearedAt); }

// A flag the operator answered (reply or clear) stays answered for the rest of that install: its signal level is stored in
// cooldown[name] = { level, T, at }, and the flag comes back only when a later window's level is more than WORSEN_FACTOR
// times the answered level. Levels are rates (per hour, per 100 spawns or a share), so a count that merely grows cannot get around it.
// flags: [{ name, value, level?, detail? }]. Returns the flag object written, or null when nothing new.
// Flags that report on the watch itself, not on the release: they show in the check, the tick and the flag line, but never start a hold
// (a fresh install with no telemetry would otherwise hold all work).
export const NO_HOLD_FLAGS = new Set(['usage-source-empty']);
const holdable = (flags) => (Array.isArray(flags) ? flags : []).filter((x) => x && !NO_HOLD_FLAGS.has(x.name));
const levelOf = (f) => (typeof f.level === 'number' ? f.level : typeof f.value === 'number' ? f.value : null);
const answeredFor = (cool, name, T) => { const c = cool[name]; return c && c.T === T ? c : null; };
export function openFlag({ version, T, check, flags, at = now() } = {}) {
  try {
    const old = readFlag();
    const cool = (old && old.cooldown) || {};
    const fresh = (Array.isArray(flags) ? flags : []).filter((f) => {
      if (!f || !f.name) return false;
      const c = answeredFor(cool, f.name, T ?? null);
      if (!c) return true;
      const l = levelOf(f);
      return l != null && typeof c.level === 'number' && c.level > 0 && l > c.level * WORSEN_FACTOR;
    });
    if (!fresh.length) return null;
    const open = flagIsOpen(old);
    const oldByName = new Map(open ? old.flags.map((o) => [o.name, o]) : []);
    // Renotify (restart the countdown) only for a name not already in the open flag, or one that doubled since it was raised.
    // A watch-health flag (NO_HOLD_FLAGS) joining an answered flag never restarts the countdown: it could not hold, and it must not re-open the hold path of the flag already answered.
    const renotify = !open || holdable(fresh).some((f) => { const o = oldByName.get(f.name); const lo = o && levelOf(o); const l = levelOf(f); return !o || (lo > 0 && l > lo * WORSEN_FACTOR); });
    const merged = open ? [...old.flags.filter((o) => !fresh.some((f) => f.name === o.name)), ...fresh] : fresh;
    const next = {
      version: version ?? old?.version ?? null,
      T: T ?? old?.T ?? null,
      check: check ?? old?.check ?? null,
      flags: merged,
      openedAt: open ? old.openedAt : iso(at),
      notifiedAt: renotify ? iso(at) : old.notifiedAt,
      ackedAt: renotify ? null : old.ackedAt ?? null,
      clearedAt: null,
      cooldown: cool,
    };
    return writeJson(paths().flag, next) ? next : null;
  } catch { return null; }
}

const answerLevels = (f, at, cool = {}) => {
  const c = { ...cool };
  for (const x of f.flags || []) c[x.name] = { level: levelOf(x), T: f.T ?? null, at: iso(at) };
  return c;
};

// A genuine prompt from the operator: stops the hold countdown and marks the open flags answered. Never lifts a hold.
export function noteReply(at = now()) {
  try {
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || isHoldActive()) return false;
    return writeJson(paths().flag, { ...f, ackedAt: iso(at), cooldown: answerLevels(f, at, f.cooldown) });
  } catch { return false; }
}

// ---- hold ----
export function readHold() { return readJson(paths().hold); }
// Held only while the file exists with neither clearedAt nor ackedAt: a failed delete can't leave a stuck hold.
export function isHoldActive() {
  try { const h = readHold(); return !!(h && !h.clearedAt && !h.ackedAt); } catch { return false; }
}

const lastRow = (event) => {
  try {
    const L = readFileSync(paths().checks, 'utf8').split('\n').filter(Boolean);
    for (let k = L.length - 1; k >= 0; k--) { try { const r = JSON.parse(L[k]); if (r && r.event === event) return Date.parse(r.at) || null; } catch { /* skip */ } }
  } catch { /* none */ }
  return null;
};

// Intervals [from, to] (epoch ms) in which a hold was on, from the 'hold' and 'clear' rows plus the hold file. Whatever telemetry
// is written inside them (denials the hold causes, queue refusals) is the hold's own and never counts toward a signal.
export const HOLD_GRACE_MS = 5 * 60e3;
export function holdIntervals(nowMs = now()) {
  const out = [];
  try {
    let from = null;
    try {
      for (const l of readFileSync(paths().checks, 'utf8').split('\n')) {
        if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; }
        const t = Date.parse(r && r.at);
        if (!(t > 0)) continue;
        if (r.event === 'hold' && from == null) from = t;
        else if (r.event === 'clear' && from != null) { out.push([from, t + HOLD_GRACE_MS]); from = null; }
      }
    } catch { /* no rows */ }
    if (from != null) out.push([from, nowMs + HOLD_GRACE_MS]);
    const h = readHold();
    const hs = h && Date.parse(h.since);
    if (hs > 0 && !out.some(([a]) => a === hs)) { const ce = Date.parse(h.clearedAt || h.ackedAt); out.push([hs, (ce > 0 ? ce : nowMs) + HOLD_GRACE_MS]); }
  } catch { /* fail open: no intervals */ }
  return out;
}

// Writes the hold when: delay > 0, the flag is open and unanswered, no clear is newer than the notification, and notifiedAt + delay has passed.
export function maybeHold({ holdMinutes, at = now() } = {}) {
  try {
    const delay = Number(holdMinutes);
    if (!(delay > 0)) return null;
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || isHoldActive()) return null;
    const hf = holdable(f.flags);
    if (!hf.length) return null; // only watch-health flags (usage-source-empty): report, never hold
    const n = Date.parse(f.notifiedAt);
    if (!(n > 0) || at < n + delay * 60e3) return null;
    const lc = lastRow('clear');
    if (lc && lc >= n) return null; // a clear after the notification: never hold on that flag
    const hold = {
      since: iso(at), version: f.version ?? null,
      reason: `release watch flagged ${hf.map((x) => x.name).join(', ')} and nobody answered within ${delay} min`,
      flags: hf, workers: 'handoff', clearedAt: null,
    };
    if (!writeJson(paths().hold, hold)) return null;
    appendRow({ at: iso(at), event: 'hold', version: hold.version, flags: hf.map((x) => x.name) });
    return hold;
  } catch { return null; }
}

// ---- clear ----
// Writes the cleared state first (atomic temp + rename) and checks it by reading it back; the file delete is best effort.
// The hold reader honours clearedAt, so a failed delete cannot leave the hold stuck or bring it back.
export function clear({ by = 'operator', at = now() } = {}) {
  const out = { flagCleared: false, holdCleared: false };
  try {
    const f = readFlag();
    if (f && !f.clearedAt) {
      writeJson(paths().flag, { ...f, clearedAt: iso(at), clearedBy: by, cooldown: answerLevels(f, at, f.cooldown) });
      let back = readFlag();
      if (!(back && back.clearedAt)) { try { unlinkSync(paths().flag); } catch { /* fail open */ } back = readFlag(); }
      out.flagCleared = !flagIsOpen(back);
    }
    const h = readHold();
    if (h && !h.clearedAt) {
      writeJson(paths().hold, { ...h, clearedAt: iso(at), clearedBy: by });
      try { unlinkSync(paths().hold); } catch { /* fail open: the cleared state written above already lifts it */ }
      out.holdCleared = !isHoldActive();
    } else if (existsSync(paths().hold)) {
      try { unlinkSync(paths().hold); } catch { /* fail open */ }
    }
    if (out.flagCleared || out.holdCleared) appendRow({ at: iso(at), event: 'clear', by, ...out });
  } catch { /* fail open */ }
  return out;
}

// ---- the line shown to lead sessions ----
// Open and unanswered flag: tell the lead to push-notify the operator at once and relay the answer.
// Held: say so and how to lift it. Open and answered: silence. Returns null when there is nothing to say.
export function flagLine() {
  try {
    if (isHoldActive()) {
      const h = readHold();
      return `[agent-companion] RELEASE HOLD since ${h.since}: ${h.reason}. New agents and heavy jobs are blocked and running workers hand off. Tell the operator now. Only the operator lifts it, by saying "clear hold"; run \`node <plugin>/scripts/release-watch.mjs clear --by operator\` only after they have said so.`;
    }
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    const names = f.flags.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ');
    return `[agent-companion] RELEASE WATCH ${f.version || ''} check ${f.check ?? '?'}: ${names}. Push-notify the operator at once (PushNotification) and relay their answer. ${holdable(f.flags).length ? 'Unanswered, new agents and heavy jobs are held after the delay (option release_watch_hold_minutes); ' : 'This flag never starts a hold; '}run \`node <plugin>/scripts/release-watch.mjs status\` for detail.`;
  } catch { return null; }
}

// ---- the hold as seen by the guards ----
// One message for every guard that refuses work while held. null when no hold (or on any read error: fail open).
export function holdDenyMessage(what = 'new work') {
  try {
    if (!isHoldActive()) return null;
    const h = readHold() || {};
    const names = Array.isArray(h.flags) && h.flags.length ? h.flags.map((x) => x && x.name).filter(Boolean).join(', ') : 'unspecified';
    return `[agent-companion] A post-release hold is on since ${h.since || '?'} (release ${h.version || '?'}; flags: ${names}), so ${what} is refused. `
      + 'Tell the operator at once. Only the operator lifts it, by saying "clear hold"; do not try to lift it yourself. The lead may still answer the operator; leases already granted keep running.';
  } catch { return null; }
}
