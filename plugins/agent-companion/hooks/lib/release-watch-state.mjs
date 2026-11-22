// State for the post-release watch (scripts/release-watch.mjs), shared with the hooks that show or honour it.
//
// Files, all under <state root>/state/ (fail open on a missing or unparseable file):
//   release-watch-run.json    the schedule for the newest install: T, version, due[], done[], prevT
//   release-watch-flag.json   the open flag: flags[], notifiedAt, ackedAt, clearedAt, cooldown{}
//   release-hold.json         the hold: { since, version, reason, flags, workers, clearedAt }
//   release-watch-checks.jsonl  one row per check and per clear
// AGENT_COMPANION_FAKE_NOW moves the clock for tests. Nothing here throws.

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './context.mjs';

export const COOLDOWN_MS = 4 * 3600e3;
export const WORSEN_FACTOR = 1.5;

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
    return v && typeof v === 'object' ? v : null;
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

// flags: [{ name, value?, detail? }]. Names in cooldown (cleared < 4 h ago) are dropped unless their value grew past
// WORSEN_FACTOR times the value recorded at the clear. Returns the flag object written, or null when nothing new.
export function openFlag({ version, T, check, flags, at = now() } = {}) {
  try {
    const old = readFlag();
    const cool = (old && old.cooldown) || {};
    const fresh = (Array.isArray(flags) ? flags : []).filter((f) => {
      if (!f || !f.name) return false;
      const c = cool[f.name];
      if (!c || !(c.until > at)) return true;
      return typeof f.value === 'number' && typeof c.value === 'number' && c.value > 0 && f.value > c.value * WORSEN_FACTOR;
    });
    if (!fresh.length) return null;
    const open = flagIsOpen(old);
    const merged = open ? [...old.flags.filter((o) => !fresh.some((f) => f.name === o.name)), ...fresh] : fresh;
    const next = {
      version: version ?? old?.version ?? null,
      T: T ?? old?.T ?? null,
      check: check ?? old?.check ?? null,
      flags: merged,
      openedAt: open ? old.openedAt : iso(at),
      // A new flag name renotifies: the lead is told again and the countdown restarts.
      notifiedAt: iso(at),
      ackedAt: null,
      clearedAt: null,
      cooldown: cool,
    };
    return writeJson(paths().flag, next) ? next : null;
  } catch { return null; }
}

// A genuine prompt from the operator: stops the hold countdown. Never lifts a hold.
export function noteReply(at = now()) {
  try {
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || isHoldActive()) return false;
    return writeJson(paths().flag, { ...f, ackedAt: iso(at) });
  } catch { return false; }
}

// ---- hold ----
export function readHold() { return readJson(paths().hold); }
export function isHoldActive() {
  try { const h = readHold(); return !!(h && !h.clearedAt); } catch { return false; }
}

// Writes the hold when: delay > 0, the flag is open and unanswered, and notifiedAt + delay has passed. Returns the hold or null.
export function maybeHold({ holdMinutes, at = now() } = {}) {
  try {
    const delay = Number(holdMinutes);
    if (!(delay > 0)) return null;
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt || isHoldActive()) return null;
    const n = Date.parse(f.notifiedAt);
    if (!(n > 0) || at < n + delay * 60e3) return null;
    const hold = {
      since: iso(at), version: f.version ?? null,
      reason: `release watch flagged ${f.flags.map((x) => x.name).join(', ')} and nobody answered within ${delay} min`,
      flags: f.flags, workers: 'handoff', clearedAt: null,
    };
    return writeJson(paths().hold, hold) ? hold : null;
  } catch { return null; }
}

// ---- clear ----
export function clear({ by = 'operator', at = now() } = {}) {
  const out = { flagCleared: false, holdCleared: false };
  try {
    const f = readFlag();
    if (f && !f.clearedAt) {
      const cooldown = { ...(f.cooldown || {}) };
      for (const x of f.flags || []) cooldown[x.name] = { until: at + COOLDOWN_MS, value: typeof x.value === 'number' ? x.value : null };
      writeJson(paths().flag, { ...f, clearedAt: iso(at), clearedBy: by, cooldown });
      out.flagCleared = true;
    }
    if (existsSync(paths().hold)) {
      try { unlinkSync(paths().hold); out.holdCleared = true; } catch { /* fail open */ }
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
      return `[agent-companion] RELEASE HOLD since ${h.since}: ${h.reason}. New agents and heavy jobs are blocked and running workers hand off. Tell the operator now; clear only with \`node <plugin>/scripts/release-watch.mjs clear --by operator\` or when they say "clear hold" or "release hold".`;
    }
    const f = readFlag();
    if (!flagIsOpen(f) || f.ackedAt) return null;
    const names = f.flags.map((x) => x.name + (x.detail ? ` (${x.detail})` : '')).join('; ');
    return `[agent-companion] RELEASE WATCH ${f.version || ''} check ${f.check ?? '?'}: ${names}. Push-notify the operator at once (PushNotification) and relay their answer. Unanswered, new agents and heavy jobs are held after the delay (option release_watch_hold_minutes); run \`node <plugin>/scripts/release-watch.mjs status\` for detail.`;
  } catch { return null; }
}
