// "Shared resources:" session line: what the machine-wide resource queue holds
// right now, for every agent on the box (hooks/advisory-b.mjs adds it beside
// "Other live sessions", at SessionStart and, when it changed, per prompt).
//
// Reads resourceStatus() (scripts/ci-budget.mjs) in-process: no spawn, no cpu
// sample, fail soft. The line appears only when something is held, queued,
// reserved or was cleared in the last 15 minutes, and stays near 300 characters.
// Spec: docs/resource-queue.md (status schema v1; `reservations` is read when the
// status carries it).

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { stateDir } from './context.mjs';

export const LINE_MAX_CHARS = 300;
export const CLEARED_WINDOW_MS = 15 * 60_000;
// An orchestration session ("lead") is one with a helper spawn in the last hour; the line shows the
// count from two leads up and warns above LEAD_WARN_ABOVE (each extra lead adds cold re-reads).
export const LEAD_WINDOW_MS = 3600_000;
export const LEAD_WARN_ABOVE = 4;
export const LEAD_SHOW_FROM = 2;
const LEDGER_TAIL_BYTES = 256 * 1024;

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}~` : t; };

export function ageText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function who(h, long) {
  const name = clip(h.label || (h.session ? String(h.session).slice(0, 8) : h.id), 16);
  if (!long) return name;
  const proj = clip(h.project || h.repo || '', 12);
  return `${name}${proj ? `@${proj}` : ''} ${ageText(h.ageMs)}${h.alive === false ? ' DEAD' : h.stale ? ' STALE' : ''}${isQuiet(h) ? ' IDLE?' : ''}${h.overTime ? ' OVER' : ''}${h.hbStale ? ' HB?' : ''}`;
}

// A holder over time AND measured quiet shows both flags (the sweep sets idleFlag beside overTime; a
// status that carries only overTime.activity "idle" is read the same way).
const isQuiet = (h) => Boolean(h.idleFlag) || h.overTime?.activity === 'idle';
const isFlagged = (h) => isQuiet(h) || Boolean(h.overTime) || Boolean(h.hbStale);
// The way out for a hung flagged holder: the stable launcher (installed at SessionStart) plus its lease id.
export const releaseHint = (h) => `release a flagged one by hand: node ~/.claude/agent-companion/bin/resource-queue.mjs release ${h.id}`;

function reservationText(r, now) {
  const res = clip(r.resource ?? r.name ?? '', 14);
  const forWho = clip(r.forGroup ?? r.for ?? r.group ?? '', 14);
  const left = Number.isFinite(Number(r.expiresAt)) && Number(r.expiresAt) > 0 ? ` ${ageText(Number(r.expiresAt) - now)} left` : '';
  return `${res} for ${forWho}${left}`.trim();
}

/** Recent clears inside the window, newest first. */
export function recentClearsIn(status, now) {
  return (status.recentClears ?? []).filter((c) => Number(c.at) >= now - CLEARED_WINDOW_MS && Number(c.at) <= now + 60_000);
}

/**
 * How many orchestration sessions on this machine spawned a helper in the last hour, from the plugin's
 * per-session worker ledger (state/worker-ledger/<session>.jsonl, one row per SubagentStart and Stop).
 * One stat per file; only a file touched inside the window is read, and only its last 256 KB. Never throws.
 */
export function activeLeads({ now = Date.now(), windowMs = LEAD_WINDOW_MS, dir = join(stateDir(), 'worker-ledger') } = {}) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  const cutoff = now - windowMs;
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      const f = join(dir, name);
      if (statSync(f).mtimeMs < cutoff) continue;
      if (lastStartMs(f) >= cutoff) n += 1;
    } catch { /* one bad file never hides the rest */ }
  }
  return n;
}

// Newest 'start' row time in a ledger file (ms), or 0. Reads at most the tail of the file.
function lastStartMs(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, LEDGER_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    let best = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"start"')) continue;
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (r && r.ev === 'start') { const t = Date.parse(r.at); if (Number.isFinite(t) && t > best) best = t; }
    }
    return best;
  } catch { return 0; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

const leadsShown = (leads) => Number(leads) >= LEAD_SHOW_FROM;
const leadsPart = (leads) => `leads active (helper spawn in the last hour): ${leads}`;
const LEADS_WARNING = ` More than ${LEAD_WARN_ABOVE} leads active: each extra lead adds cold re-reads of its whole conversation.`;

/** Is there anything worth a line? */
export function hasActivity(status, now = Date.now()) {
  if (!status || status.ok === false) return false;
  if ((status.resources ?? []).some((r) => (r.holders ?? []).length || r.held > 0)) return true;
  if ((status.queue ?? []).length) return true;
  if ((status.reservations ?? []).length) return true;
  if (recentClearsIn(status, now).length) return true;
  return false;
}

/**
 * The line, or null when nothing is held, queued, reserved or recently cleared.
 * Each holder is spelled out once (first resource that lists it); later resources
 * name it by label only, so the 300-character budget goes to the information.
 */
export function renderSharedResources(status, { now = Date.now(), max = LINE_MAX_CHARS, leads = 0 } = {}) {
  const queueBusy = hasActivity(status, now);
  if (!queueBusy && !leadsShown(leads)) return null;
  const seen = new Set();
  const parts = [];
  for (const r of status.resources ?? []) {
    const holders = r.holders ?? [];
    if (!holders.length && !(r.held > 0)) continue;
    const list = holders.map((h) => {
      const first = !seen.has(h.id);
      seen.add(h.id);
      return who(h, first);
    });
    parts.push(`${r.name} ${r.held}/${r.capacity}${list.length ? `: ${list.join(', ')}` : ''}`);
  }
  const q = status.queue ?? [];
  if (q.length) {
    parts.push(`queue: ${q.slice(0, 4).map((e, i) => `${i + 1}) ${clip(e.label || e.session || e.id, 14)}${e.project ? `@${clip(e.project, 10)}` : ''} ${ageText(e.waitedMs)}${e.alive === false ? ' DEAD' : ''}${(e.blockedBy ?? []).length ? ` for ${e.blockedBy.join('+')}` : ''}`).join(', ')}${q.length > 4 ? ` +${q.length - 4}` : ''}`);
  }
  const rs = status.reservations ?? [];
  if (rs.length) parts.push(`reserved: ${rs.slice(0, 2).map((r) => reservationText(r, now)).join(', ')}${rs.length > 2 ? ` +${rs.length - 2}` : ''}`);
  const cl = recentClearsIn(status, now);
  if (cl.length) {
    const c = cl[0];
    parts.push(`cleared ${ageText(now - c.at)} ago: ${clip(c.rule, 14)} ${clip(c.label || c.id, 16)}${cl.length > 1 ? ` +${cl.length - 1}` : ''}`);
  }
  // A flagged live holder is kept until it exits or the 4 h ceiling; the line names the manual way out
  // (first flagged holder), and the body is clipped to leave room for it.
  if (leadsShown(leads)) parts.push(leadsPart(leads));
  const warn = Number(leads) > LEAD_WARN_ABOVE ? LEADS_WARNING : '';
  const flagged = (status.resources ?? []).flatMap((r) => r.holders ?? []).find((h) => h.alive !== false && isFlagged(h));
  const hint = flagged ? ` ${releaseHint(flagged)}.` : '';
  // The lead warning and the release hint are reserved first; the body is clipped to what is left.
  const tail = `${warn}${hint}`;
  let line = `Shared resources: ${parts.join('; ')}.`;
  if (line.length > max - tail.length) line = `${line.slice(0, Math.max(1, max - tail.length - 2))}~.`;
  return `${line}${tail}`;
}

/** Changes only when who holds, who waits, what is reserved or what was cleared changes (not with the clock). */
export function resourceSignature(status, now = Date.now(), leads = 0) {
  // The lead count joins the signature as a bucket (none, a few, over the warning level), so a change
  // of count inside a bucket does not re-show the line on every prompt.
  const lb = Number(leads) > LEAD_WARN_ABOVE ? 'warn' : leadsShown(leads) ? 'few' : '';
  if (!hasActivity(status, now)) return lb ? JSON.stringify(['leads', lb]) : '';
  const hs = [];
  for (const r of status.resources ?? []) for (const h of r.holders ?? []) hs.push(`${r.name}:${h.id}:${h.alive === false ? 'd' : h.stale ? 's' : 'a'}${isQuiet(h) ? 'i' : ''}${h.overTime ? 'o' : ''}${h.hbStale ? 'h' : ''}`);
  return JSON.stringify([
    hs, (status.queue ?? []).map((e) => e.id), (status.reservations ?? []).map((r) => r.id ?? r.resource),
    recentClearsIn(status, now).map((c) => `${c.at}:${c.id}`), lb,
  ]);
}

async function readStatus(opts = {}) {
  const mod = await import(pathToFileURL(join(SCRIPTS, 'ci-budget.mjs')).href);
  return mod.resourceStatus(opts);
}

const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * The note for a hook event. mode 'start': the line whenever there is one.
 * mode 'change': only when the signature differs from the last one this session saw.
 * Never throws; returns null on any failure.
 */
export async function sharedResourcesNote(p, { mode = 'start', now = Date.now(), status = null, sigFile = null, leads = null } = {}) {
  try {
    const st = status ?? await readStatus();
    const nLeads = leads ?? activeLeads({ now });
    const line = renderSharedResources(st, { now, leads: nLeads });
    const sig = resourceSignature(st, now, nLeads);
    const f = sigFile ?? join(stateDir(), `resource-line-${safe(p?.session_id)}.sig`);
    let prev = null;
    try { prev = readFileSync(f, 'utf8'); } catch { /* none */ }
    if (prev !== sig) { try { writeFileSync(f, sig); } catch { /* ignore */ } }
    if (!line) return null;
    if (mode === 'change' && prev === sig) return null;
    return line;
  } catch { return null; }
}

/** SessionStart: make sure the stable launcher exists (idempotent, one small file read). */
export async function ensureLauncher() {
  try {
    const mod = await import(pathToFileURL(join(SCRIPTS, 'resource-queue.mjs')).href);
    return mod.installLauncher();
  } catch { return 'failed'; }
}
