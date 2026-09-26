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

import { basename } from 'node:path';
import { telemetryDir, isFixtureSession, tailRecords } from './context.mjs';

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

// Append -2, -3, ... until `candidate` does not collide with `existing`.
// Capped so a pathological existing-list can't loop unboundedly; the last
// resort falls back to a short random suffix rather than looping forever.
export function makeUnique(candidate, existing) {
  const taken = new Set(existing || []);
  if (!taken.has(candidate)) return candidate;
  const base = candidate.slice(0, MAX_NAME - 3); // room for "-NN"
  for (let n = 2; n <= 50; n += 1) {
    const c = `${base}-${n}`;
    if (!taken.has(c)) return c;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
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
