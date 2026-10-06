// Teammates watch: do agent-team teammates work in the desktop app again?
//
// Background (operator memory desktop-teammates-broken-since-2-1-178): teammates
// (TeamCreate / agent teams) WORKED in the desktop app through Claude Code
// 2.1.177 (the last team created that way was 2026-06-21), and have not since.
// 2.1.178 replaced TeamCreate with one implicit team per session, and the
// docs list agent teams as a CLI feature. Teammates kept a named worker alive
// across rounds, so a Claude Code update that brings them back is worth
// knowing about the day it happens. Their economics are NOT a given (measured
// 2026-10-06): TeamCreate ran only 2026-05-13 to 2026-06-20, and
// teammates were not in use in the whole-week weeks (August to early September).
// Team-era workers cost 0.110 plan units per call against 0.056 now, because a kept
// worker carries its whole earlier context on every call.
//
// WHAT CAN AND CANNOT BE TOLD STATICALLY. The names TeamCreate, TeamDelete,
// teammate_spawned and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS are all present in
// the 2.1.286 binary while teammates do not work (TeamCreate sits in a set of
// hidden tool names, and the env var is passed to every session), so string
// presence proves nothing. The gate itself lives in minified code. So the
// static part here is a CHANGE detector only: the counts of those four strings
// per installed version are recorded, and a different set is a reason to run
// the probe, never a verdict.
//
// THE VERDICT IS EVIDENCE OF A TEAMMATE. Every session writes an implicit team
// config (<claude dir>/teams/<name>/config.json). When it lists a member other
// than the lead, a teammate was created. The scout watches for one, created
// after the version changed, for as long as no verdict exists. Pure functions
// plus small file readers; nothing here spawns a model or edits a setting.

import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

// The last day a desktop session created a teammate (21 desktop team sessions,
// 2026-05-31 to 2026-06-21). Evidence older than this proves nothing about a
// later version.
export const LAST_WORKING_MS = Date.parse('2026-06-22T00:00:00.000Z');

export const MARKERS = ['TeamCreate', 'TeamDelete', 'teammate_spawned', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'];

// How long a version change stays under watch with no verdict before the
// scout stops looking (it starts again at the next version change).
export const WATCH_DAYS = 21;

const VERSION_DIR = /^\d+\.\d+\.\d+/;

function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Where the desktop app keeps the Claude Code builds it runs:
// <root>/<version>/<hash>/claude[.exe]. AGENT_COMPANION_CLAUDE_CODE_DIRS
// (path-delimited) replaces the defaults, for tests and unusual installs.
export function desktopRoots(env = process.env) {
  if (env.AGENT_COMPANION_CLAUDE_CODE_DIRS !== undefined) return String(env.AGENT_COMPANION_CLAUDE_CODE_DIRS).split(delimiter).filter(Boolean);
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [];
  if (env.APPDATA) roots.push(join(env.APPDATA, 'Claude', 'claude-code'));
  roots.push(join(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
  roots.push(join(home, '.config', 'Claude', 'claude-code'));
  return roots;
}

// The newest desktop-bundled build: { version, binary } or null. Never throws.
export function newestDesktopBuild(roots = desktopRoots()) {
  let best = null;
  for (const root of roots) {
    let versions;
    try { versions = readdirSync(root); } catch { continue; }
    for (const v of versions) {
      if (!VERSION_DIR.test(v)) continue;
      let hashes;
      try { hashes = readdirSync(join(root, v)); } catch { continue; }
      for (const h of hashes) {
        for (const exe of ['claude.exe', 'claude']) {
          const binary = join(root, v, h, exe);
          try {
            if (!statSync(binary).isFile()) continue;
          } catch { continue; }
          if (!best || cmpVersion(v, best.version) > 0) best = { version: v, binary };
        }
      }
    }
  }
  return best;
}

// Occurrences of each marker string in a (large) binary, read in chunks with
// an overlap so a match across a chunk edge counts once. Never throws: an
// unreadable file gives null.
export function scanMarkers(binary, markers = MARKERS, chunkBytes = 8 * 1024 * 1024) {
  let fd;
  try {
    fd = openSync(binary, 'r');
    const counts = Object.fromEntries(markers.map((m) => [m, 0]));
    const needles = markers.map((m) => Buffer.from(m, 'utf8'));
    const keep = Math.max(...needles.map((n) => n.length)) - 1;
    const buf = Buffer.alloc(chunkBytes + keep);
    let carry = 0;
    for (;;) {
      const got = readSync(fd, buf, carry, chunkBytes, null);
      if (got <= 0) break;
      const end = carry + got;
      const view = buf.subarray(0, end);
      needles.forEach((n, i) => {
        // A match that lies wholly inside the carried tail was counted with the
        // previous chunk: only matches reaching past it are new.
        let at = view.indexOf(n, Math.max(0, carry - n.length + 1));
        while (at !== -1) { counts[markers[i]]++; at = view.indexOf(n, at + n.length); }
      });
      carry = Math.min(keep, end);
      buf.copy(buf, 0, end - carry, end);
    }
    return counts;
  } catch { return null; } finally { try { if (fd !== undefined) closeSync(fd); } catch { /* closed */ } }
}

// Teams created at or after sinceMs that list a member other than the lead:
// [{ name, members, createdAt }], oldest first. A team with no createdAt falls
// back to its config file's mtime. Never throws.
export function teamEvidence({ dir, sinceMs }) {
  const out = [];
  let names;
  try { names = readdirSync(join(dir, 'teams')); } catch { return out; }
  for (const name of names) {
    const file = join(dir, 'teams', name, 'config.json');
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const created = Number.isFinite(cfg.createdAt) ? cfg.createdAt : statSync(file).mtimeMs;
      if (!(created >= sinceMs)) continue;
      const others = (Array.isArray(cfg.members) ? cfg.members : []).filter((m) => m && m.name !== 'team-lead' && m.agentType !== 'team-lead');
      if (others.length) out.push({ name, members: others.length, createdAt: created });
    } catch { /* unreadable or foreign file: not evidence */ }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function versionKey({ cli, desktop }) {
  return `cli:${cli || '?'}|desktop:${desktop || '?'}`;
}

function markersDiffer(a, b) {
  if (!a || !b) return false;
  return MARKERS.some((m) => (a[m] ?? null) !== (b[m] ?? null));
}

// The whole decision, pure. `prev` is the stored state (undefined on the first
// run); `evidenceFor(sinceMs)` reads team evidence lazily.
// Returns { state, signals: [{ kind, detail, dispatch }] }. State:
//   { versionKey, markers, changedAt (ms | null), verdict: 'unknown' | 'available',
//     availableAt, checkedAt }
// First run: record the state and look for evidence since LAST_WORKING_MS (so a
// machine where teammates already work says so once). A changed version key:
// restart the watch and suggest the probe once. Until a verdict, every run
// looks for a teammate created since the change, for WATCH_DAYS.
export function decide({ prev, key, markers, evidenceFor, nowMs }) {
  const signals = [];
  const firstRun = !prev || typeof prev !== 'object';
  const changed = !firstRun && prev.versionKey !== key;
  let state;
  if (firstRun) {
    state = { versionKey: key, markers, changedAt: null, verdict: 'unknown', availableAt: null, checkedAt: nowMs };
  } else if (changed) {
    state = { versionKey: key, markers, changedAt: nowMs, verdict: 'unknown', availableAt: null, checkedAt: nowMs };
    const diff = markersDiffer(prev.markers, markers)
      ? ` The binary's team strings also changed (${MARKERS.map((m) => `${m} ${prev.markers?.[m] ?? '?'}->${markers?.[m] ?? '?'}`).join(', ')}).`
      : ' The binary\'s team strings are unchanged, which proves nothing either way.';
    signals.push({
      kind: 'teammates_probe_suggested',
      detail: `Claude Code changed (${prev.versionKey} -> ${key}), so desktop teammates may work again.${diff} ` +
        'Suggestion only: run `node scripts/teammates-probe.mjs` (it reads the team configs; its output also lists the manual test). ' +
        `This scout keeps watching for a teammate for ${WATCH_DAYS} days and raises teammates_available when one appears.`,
      dispatch: 'teammates-probe',
    });
  } else {
    state = { ...prev, markers: markers || prev.markers, checkedAt: nowMs };
  }

  if (state.verdict !== 'available') {
    const watching = state.changedAt === null || nowMs - state.changedAt <= WATCH_DAYS * 86400000;
    if (watching) {
      const since = Math.max(LAST_WORKING_MS, state.changedAt || 0);
      const ev = evidenceFor(since);
      if (ev.length) {
        const last = ev[ev.length - 1];
        state.verdict = 'available';
        state.availableAt = nowMs;
        signals.push({
          kind: 'teammates_available',
          detail: `${ev.length} team(s) created since ${new Date(since).toISOString().slice(0, 10)} list a teammate besides the lead ` +
            `(newest ${new Date(last.createdAt).toISOString().slice(0, 10)}, ${last.members} member(s)); desktop teammates work again on ${key}. ` +
            'Worth re-testing before relying on them: team-era workers cost 0.110 plan units per call against 0.056 now.',
          dispatch: 'teammates-confirm',
        });
      }
    }
  }
  return { state, signals };
}
