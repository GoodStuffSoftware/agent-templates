// Namegate (track "namegate", operator decision 2026-09-25): every
// background worker gets a name. "The personal doctrine already says 'never
// spawn a background Agent without a unique name', but most workers are
// spawned without one; the rule needs the guard behind it."
//
// This module is the mechanics spawn-guard.mjs's Gate 4 uses:
//   - decide whether a spawn is in scope (MAIN-session, background, no name)
//   - pick a unique `<project>-<type>-<slug>` name when autofill is on
//   - find this session's other already-named workers (for brief boilerplate)
//   - render the boilerplate a newly-autofilled worker's brief gets
//
// Autofill honoured by the harness: proven live 2026-09-25 by a throwaway
// probe outside this repo (never committed) — a disposable sandbox session
// with its own project-scoped `.claude/settings.json` PreToolUse hook on the
// Agent matcher, run via `claude -p --setting-sources project` (excludes the
// user-scope settings.json that enables installed plugins, so only the
// probe's own hook fired). The hook rewrote a nameless background Agent
// spawn's `updatedInput.name` to a nonce; the spawning session then used
// SendMessage addressed to that exact nonce and it resumed the spawned
// agent, which is only possible if the harness actually started the agent
// under the rewritten name. There is no PASSIVE proof available the way
// 0.29.6 proved the `subagent_type` rewrite (SubagentStart's payload carries
// no `name` field at all — see hooks/spawn-log.mjs), so this delivery check
// was the closest available analogue.

import { basename, join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { telemetryDir, isFixtureSession, tailRecords, stateDir } from './context.mjs';

// Only these characters may appear in an autofilled name; a name built from
// project/repo directory names, subagent types or a free-text description
// can otherwise carry spaces, slashes, unicode or shell-hostile characters.
const NAME_SAFE = /[^A-Za-z0-9._-]+/g;
const MAX_SEGMENT = 24; // cap per segment so one long description can't dominate
const MAX_NAME = 60; // cap the assembled name; SendMessage/roster displays stay readable

function slugify(text, maxLen = MAX_SEGMENT) {
  const s = String(text || '')
    .toLowerCase()
    .replace(NAME_SAFE, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, maxLen).replace(/-+$/g, '');
}

// `<project>` — basename(cwd). Simple and robust rather than climbing to a
// repo root: a worktree's own directory name (e.g. "agent-<hash>") is less
// legible than the checkout's real project name, but resolving THAT
// reliably needs git-root discovery this hook already pays for elsewhere
// (findRepoRoot) for a DIFFERENT purpose; reusing it here would tie a naming
// decision to git-detection edge cases (submodules, bare repos) for no gain
// this feature needs. basename(cwd) never throws and is never empty for a
// real path. Reversible: swap in findRepoRoot(cwd)?.root here if worktree
// names prove confusing in practice.
export function deriveProjectSlug(cwd) {
  let base = '';
  try { base = basename(String(cwd || '')); } catch { base = ''; }
  return slugify(base) || 'session';
}

// `<type>` — the brief's own declared TYPE (e.g. "bounded-feature") when
// present, since that is what the operator/orchestrator actually meant by
// "type" when writing the brief; falling back to subagent_type (stripped of
// a plugin namespace prefix) when no TYPE: line was declared, then "agent".
export function deriveTypeSlug({ declaredType, subagentType }) {
  if (declaredType) return slugify(declaredType);
  const t = String(subagentType || '');
  const bare = t.includes(':') ? t.slice(t.indexOf(':') + 1) : t;
  return slugify(bare) || 'agent';
}

// `<slug>` — a short human hint, preferring the spawn's own `description`
// (already short by convention — the Agent tool's own schema calls for
// "3-5 words") over the brief text, which is long and not meant to be
// summarised here.
export function deriveHintSlug(description) {
  return slugify(description, MAX_SEGMENT) || '';
}

// Build the full candidate before uniqueness is applied.
export function buildCandidateName({ cwd, declaredType, subagentType, description }) {
  const parts = [
    deriveProjectSlug(cwd),
    deriveTypeSlug({ declaredType, subagentType }),
    deriveHintSlug(description),
  ].filter(Boolean);
  const joined = parts.join('-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return (joined || 'worker').slice(0, MAX_NAME).replace(/-+$/g, '');
}

// This session's already-named spawns, oldest first, read from the same
// telemetry appendLog() already writes (spawns.jsonl, or fixtures.jsonl for
// a test/canary session id — see context.mjs's isFixtureSession/appendLog).
// Used both for "peers" in the boilerplate and for uniqueness. Bounded tail
// read, like every other telemetry read in this plugin; never throws.
export function sessionSpawnNames(sid, { bytes = 262144 } = {}) {
  try {
    const fixture = isFixtureSession(sid);
    const file = `${telemetryDir()}/${fixture ? 'fixtures.jsonl' : 'spawns.jsonl'}`;
    const needle = JSON.stringify(String(sid));
    const rows = tailRecords(file, {
      bytes,
      filter: (line) => line.includes(needle),
    });
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      if (!r || r.session_id !== sid) continue;
      if (fixture && r.stream !== 'spawns.jsonl') continue;
      // name_effective (what the spawn actually ran under, namegate autofill
      // included) is what a later spawn must not collide with; a row from
      // before this field existed falls back to the raw declared `name`,
      // which is the same thing for a spawn namegate never touched.
      const raw = typeof r.name_effective === 'string' ? r.name_effective
        : (typeof r.name === 'string' ? r.name : '');
      const n = raw.trim();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

// Names the harness itself reserves for addressing (fix round, review
// finding 2, 2026-09-25): an autofilled name must never equal one of these,
// case-insensitively, or a later SendMessage("team-lead"), say, would not
// reach the worker namegate meant to address. Checked against this repo's
// own docs/tool descriptions for others beyond the two the review brief
// named; none found (no agent-teams.md ships in this repo, and no other
// reserved-keyword doc exists here) — if the harness ever documents more,
// add them here and both makeUnique() and reserveUniqueName() below inherit
// the exclusion automatically.
const RESERVED_NAMES = new Set(['main', 'team-lead']);
export function isReservedName(name) {
  return RESERVED_NAMES.has(String(name || '').trim().toLowerCase());
}

// Append -2, -3, ... until `candidate` collides with neither `existing` nor
// a reserved name. Capped so a pathological existing-list can't loop
// unboundedly; the last resort falls back to a short random suffix rather
// than looping forever. Pure/in-memory — no reservation of the result, so
// two concurrent callers can still both pick the same name (review finding
// 1); reserveUniqueName() below is the race-safe wrapper the hook actually
// uses. Kept exported and still used as reserveUniqueName()'s own fail-open
// fallback when the state dir is unusable.
export function makeUnique(candidate, existing) {
  const taken = new Set(existing || []);
  const blocked = (n) => taken.has(n) || isReservedName(n);
  if (!blocked(candidate)) return candidate;
  const base = candidate.slice(0, MAX_NAME - 3); // room for "-NN"
  for (let n = 2; n <= 50; n += 1) {
    const c = `${base}-${n}`;
    if (!blocked(c)) return c;
  }
  const fallback = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  return blocked(fallback) ? `${base}-${Math.random().toString(36).slice(2, 6)}` : fallback;
}

// Marker debris (review finding 1's fix): bounded by age, not by an explicit
// release step — a hook process exiting mid-session leaves its markers
// behind on purpose (they must outlive the process so a LATER spawn in the
// same session still sees them as taken), so there is no "done, delete mine"
// moment to hook a cleanup into. Mirrors PROCESS_LOAD_KEEP_MS's own sizing
// rationale (context.mjs): a session's whole spawn burst is minutes, never
// remotely close to this, so the margin is generous on purpose.
const MARKER_KEEP_MS = 24 * 60 * 60 * 1000;

function sidHash(sid) {
  return createHash('sha1').update(String(sid)).digest('hex').slice(0, 16);
}

// One marker subdirectory per session (not one flat directory of
// session+name markers) so the age-sweep below can decide and delete a
// whole finished session's debris in one shot, and so two sessions that
// happen to pick the same candidate name never share a marker file.
function namegateMarkerDir(sid) {
  return join(stateDir(), 'namegate-names', sidHash(sid));
}

// Best-effort age sweep of finished sessions' marker subdirectories, run
// opportunistically on every reservation attempt (like noteAgentType()'s
// wx-marker, no separate cron/hook is needed). Never throws — a raced or
// already-gone directory is left alone rather than retried.
function pruneNamegateMarkers(now) {
  const root = join(stateDir(), 'namegate-names');
  let dirs;
  try { dirs = readdirSync(root); } catch { return; } // nothing written yet
  for (const d of dirs) {
    const full = join(root, d);
    try {
      const files = readdirSync(full);
      let newest = 0;
      for (const f of files) {
        try { newest = Math.max(newest, statSync(join(full, f)).mtimeMs); } catch { /* raced */ }
      }
      if (files.length === 0 || now - newest > MARKER_KEEP_MS) {
        for (const f of files) { try { unlinkSync(join(full, f)); } catch { /* raced */ } }
        try { rmdirSync(full); } catch { /* raced, or another process just reserved into it */ }
      }
    } catch { /* raced or gone: leave it */ }
  }
}

// Exclusive-create a marker for (sid, name) — the same `wx` atomicity
// hooks/spawn-log.mjs's noteAgentType() already uses for the identical
// read-check-append race (see tests/race.test.mjs). Returns true only for
// the ONE caller whose create wins; false on any conflict OR any failure
// (state dir missing/unwritable) — reserveUniqueName() below treats both
// alike: try the next candidate.
function tryReserve(sid, name) {
  const dir = namegateMarkerDir(sid);
  try { mkdirSync(dir, { recursive: true }); } catch { /* may already exist */ }
  try {
    writeFileSync(join(dir, `${name}.reserved`), '', { flag: 'wx' });
    return true;
  } catch {
    return false; // EEXIST (lost the race) or the dir is unusable
  }
}

// Race-safe replacement for a bare makeUnique() call (review finding 1): the
// chosen name is RESERVED before this returns, so two truly-concurrent hook
// invocations racing on the identical candidate (the parallel-Agent-calls-
// in-one-message shape this plugin's own orchestration doctrine recommends)
// cannot both walk away with the same name the way a plain read-then-decide
// check could — sessionSpawnNames()'s `existing` list is necessarily stale
// mid-race (a concurrent sibling's telemetry row may not be written yet);
// the marker reservation is what actually closes the gap. Also excludes
// reserved addressing names (review finding 2) via the same `blocked()`
// makeUnique() uses, since a candidate that resolves to one must never even
// attempt reservation.
//
// Fails open exactly like every other gate in this hook: if the state dir is
// unusable, EVERY tryReserve() call below fails, the loop exhausts, and this
// returns makeUnique()'s plain in-memory pick with no reservation at all —
// the pre-fix behaviour. Never throws, never blocks the spawn.
export function reserveUniqueName(sid, candidate, existing, { now = Date.now() } = {}) {
  try { pruneNamegateMarkers(now); } catch { /* best effort */ }
  const taken = new Set(existing || []);
  const blocked = (n) => taken.has(n) || isReservedName(n);
  const attempt = (n) => (!blocked(n) && tryReserve(sid, n)) ? n : null;

  let picked = attempt(candidate);
  if (picked) return picked;

  const base = candidate.slice(0, MAX_NAME - 3); // room for "-NN"
  for (let n = 2; n <= 50; n += 1) {
    picked = attempt(`${base}-${n}`);
    if (picked) return picked;
  }
  for (let i = 0; i < 8; i += 1) {
    picked = attempt(`${base}-${Math.random().toString(36).slice(2, 6)}`);
    if (picked) return picked;
  }
  // Exhausted every slot (state dir unusable, or a wildly unlucky/adversarial
  // `existing` set) — fail open to the unreserved pick rather than block.
  return makeUnique(candidate, existing);
}

// The boilerplate appended to an autofilled worker's own prompt: who it is,
// who its lead is, and who its already-named peers are (this session's
// other named spawns, per sessionSpawnNames() above — the guard can only
// know about a peer once THAT peer's own spawn has already gone through
// this hook and been logged; a peer spawned later is not listed here, the
// same "point-in-time" limit spawns.jsonl already has for every other
// consumer of it).
export function buildNamegateBrief({ name, peers }) {
  const peerLine = peers && peers.length
    ? `Peer workers this session so far: ${peers.join(', ')}.`
    : 'No other named workers from this session are known yet.';
  return `\n\nYou are worker \`${name}\` (name auto-assigned by agent-companion's namegate guard, ` +
    'since this spawn ran in the background with no name). Your lead is `main` ' +
    `(SendMessage to "main"). ${peerLine}`;
}

export const NAMEGATE_MAX_NAME = MAX_NAME;
