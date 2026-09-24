// SessionStart — surface what the locally scheduled scout found.
//
// The stateful signals (harness version delta, zero denials, spawn activity,
// unknown agent types) only exist where the plugin data directory persists,
// which means a scheduled `detect.mjs` on this machine. But a scheduled script
// has no one to tell. This hook reads its last result and puts unresolved
// signals in front of the next person to start a session here.
//
// Zero recurring tokens: the scheduled run is plain node, and this injects a
// few lines of context ONLY when there is a signal. A quiet scout adds nothing.
//
// Two INDEPENDENT sources feed one combined output, each gated by its own
// option, neither allowed to early-exit the whole hook (a single early
// `passthrough()` would silence the other):
//   1. scout_surface — the full scout-latest.json signal list, as before.
//   2. ci_status_signal — a one-line "main CI red since ..." note, read ONLY
//      from the cache detect.mjs's main_ci_red check already wrote to
//      baseline.json (state/baseline.json's `ciStatusCache`). This NEVER
//      calls gh or the network: it resolves the CURRENT cwd's repo with a
//      local `git remote get-url origin` (no network — reads local git
//      metadata only) and looks up that repo's cached status. A cache miss,
//      a green cache, or a repo the cache does not cover is silent.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  readStdin, opt, dataDirs, stateDir, stateFile, passthrough,
} from './lib/context.mjs';
import { syncLegacy } from './lib/state-sync.mjs';
import { normalizeGitUrl } from '../scripts/lib/publication-sweep.mjs';
import { githubOwnerRepoFromUrl, repoCacheKey } from '../scripts/lib/ci-status.mjs';

const MAX_AGE_DAYS = 7;

// --- Piece 1: the generic scout-signal list (unchanged behaviour) ---------
function buildScoutBlock() {
  if (!opt('scout_surface', true)) return null;

  let latest = null;
  const primary = join(stateDir(), 'scout-latest.json');
  if (existsSync(primary)) {
    try { latest = JSON.parse(readFileSync(primary, 'utf8')); } catch { /* fall through */ }
  }
  if (!latest) {
    // Several data dirs can exist (one per marketplace, plus -inline). Take
    // the freshest scout result across all of them.
    for (const d of dataDirs()) {
      const f = join(d, 'scout-latest.json');
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (!latest || Date.parse(j.checkedAt) > Date.parse(latest.checkedAt)) latest = j;
      } catch { /* unreadable: skip */ }
    }
  }
  if (!latest || !Array.isArray(latest.signals) || latest.signals.length === 0) return null;

  const ageDays = (Date.now() - Date.parse(latest.checkedAt)) / 86400000;
  if (!(ageDays <= MAX_AGE_DAYS)) return null; // stale results are not news

  const lines = latest.signals.map((s) => `- ${s.kind}: ${s.detail}${s.dispatch && s.dispatch !== 'none' ? ` → ${s.dispatch}` : ''}`);
  const when = latest.checkedAt.slice(0, 16).replace('T', ' ');

  return {
    summary: `agent-companion scout (${when}): ${latest.signals.length} signal(s) — ${latest.signals.map((s) => s.kind).join(', ')}`,
    context:
      `[agent-companion] The locally scheduled calibration scout last ran ${when} and found:\n${lines.join('\n')}\n` +
      'These are drift signals, not errors. If the user asks about routing, model changes, guards, or costs, mention them; ' +
      'otherwise do not act on them unprompted. The audit skill can investigate: node <plugin>/scripts/audit.mjs --only harness-drift,guard-canary',
  };
}

// --- Piece 2: the cheap, cache-only "main CI red" note --------------------
// Never touches the network. `ciStatusCache` is written by
// scripts/detect.mjs's main_ci_red check into state/baseline.json; this only
// reads that file and a local (no-network) git remote lookup for the CURRENT
// project, so a stale or missing cache is silent, never a reason to call gh
// from a SessionStart hook.
function currentRepoKey() {
  try {
    // Inline windowsHide spawn (same minimal pattern as
    // hooks/lib/memory-index.mjs's own runGit()) rather than importing
    // scripts/lib/proc.mjs — hooks/ keeps its own tiny git wrapper so it
    // never depends on that module (see proc.mjs's own header).
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(), timeout: 5000, encoding: 'utf8', windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    const originUrl = String(r.stdout || '').trim();
    if (!originUrl) return null;
    const gh = githubOwnerRepoFromUrl(originUrl, normalizeGitUrl);
    return gh ? repoCacheKey(gh.owner, gh.repo) : null;
  } catch {
    return null; // not a git repo, no origin, or git unavailable here: nothing to check
  }
}

function buildCiRedLine() {
  if (!opt('ci_status_signal', true)) return null;
  const key = currentRepoKey();
  if (!key) return null;

  let baseline = null;
  try { baseline = JSON.parse(readFileSync(stateFile('baseline.json'), 'utf8')); } catch { return null; }
  const entry = baseline?.ciStatusCache?.[key];
  if (!entry || !entry.ok || !entry.red || !Array.isArray(entry.workflows) || entry.workflows.length === 0) return null;

  // One line, one workflow (the first) — additional red workflows are named
  // in the count only, so this stays the "at most one line" this hook budgets.
  const first = entry.workflows[0];
  const more = entry.workflows.length > 1 ? ` (+${entry.workflows.length - 1} more workflow(s) also red)` : '';
  return `[agent-companion] main CI red since ${first.redSince}, ${first.name} — ${first.latestUrl}${more}`;
}

try {
  readStdin();

  // Recover any durable history left behind under the (pre-0.17.0) plugin
  // data directory before reading anything. Fully fail-open on its own; a
  // SessionStart hook must never block or throw because import had a bad day.
  try { syncLegacy(); } catch { /* fail open */ }

  let ciLine = null;
  try { ciLine = buildCiRedLine(); } catch { ciLine = null; }

  let scoutBlock = null;
  try { scoutBlock = buildScoutBlock(); } catch { scoutBlock = null; }

  if (!ciLine && !scoutBlock) passthrough();

  const contextParts = [ciLine, scoutBlock?.context].filter(Boolean);
  const summary = scoutBlock?.summary || ciLine;

  process.stdout.write(JSON.stringify({
    systemMessage: summary,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextParts.join('\n'),
    },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
