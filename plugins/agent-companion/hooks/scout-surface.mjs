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
  readStdin, opt, dataDirs, stateDir, stateFile, passthrough, sessionIsSubagent, scoutSuppressed,
} from './lib/context.mjs';
import { syncLegacy } from './lib/state-sync.mjs';
import { normalizeGitUrl } from '../scripts/lib/publication-sweep.mjs';
import { githubOwnerRepoFromUrl, repoCacheKey } from '../scripts/lib/ci-status.mjs';
import { readPending, markSeen } from '../scripts/lib/release-watch.mjs';
import { pendingSurface, markSurfaced, launchCheckup } from '../scripts/lib/daily-checkup.mjs';

const MAX_AGE_DAYS = 7;
const RELEASE_KIND = 'cli_release_available';

// --- Piece 1: the generic scout-signal list --------------------------------
// The same kind can fire several times in one scout run (a measured session
// start named routing_trial_review_due and model_benchmark_suggested four
// times each in a 15-signal list). The line says each kind once, with a
// count when it repeats; the full list stays in scout-latest.json.
function dedupeKinds(signals) {
  const counts = new Map();
  for (const sig of Array.isArray(signals) ? signals : []) {
    const k = String(sig && sig.kind ? sig.kind : 'unknown');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
}

function buildScoutBlock() {
  if (!opt('scout_surface', true)) return null;

  let latest = null;
  let latestFile = null;
  const primary = join(stateDir(), 'scout-latest.json');
  if (existsSync(primary)) {
    try { latest = JSON.parse(readFileSync(primary, 'utf8')); latestFile = primary; } catch { /* fall through */ }
  }
  if (!latest) {
    // Several data dirs can exist (one per marketplace, plus -inline). Take
    // the freshest scout result across all of them.
    for (const d of dataDirs()) {
      const f = join(d, 'scout-latest.json');
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (!latest || Date.parse(j.checkedAt) > Date.parse(latest.checkedAt)) { latest = j; latestFile = f; }
      } catch { /* unreadable: skip */ }
    }
  }
  if (!latest || !Array.isArray(latest.signals)) return null;
  // Drop what the operator suppressed (a result written before the option was
  // set still carries it) and the release signal, which has its own line below.
  const hidden = scoutSuppressed();
  hidden.add(RELEASE_KIND);
  latest = { ...latest, signals: latest.signals.filter((s) => !hidden.has(String((s && s.kind) || 'unknown'))) };
  if (latest.signals.length === 0) return null;

  const ageDays = (Date.now() - Date.parse(latest.checkedAt)) / 86400000;
  if (!(ageDays <= MAX_AGE_DAYS)) return null; // stale results are not news

  const when = latest.checkedAt.slice(0, 16).replace('T', ' ');

  return {
    summary: `agent-companion scout (${when}): ${latest.signals.length} signal(s) — ${dedupeKinds(latest.signals).join(', ')}`,
    // A pointer, not the signal list: the full text (kind, detail, dispatch per
    // signal) stays in scout-latest.json, read only if the user asks.
    context:
      `[agent-companion] Scout ${when}: ${latest.signals.length} drift signal(s) (not errors): ${dedupeKinds(latest.signals).join(', ')}. ` +
      `Details: ${latestFile}. Mention only if asked about routing, models, guards or costs.`,
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

// --- Piece 3: a newer Claude Code release the operator has not been told about --
// The scout (scripts/lib/release-watch.mjs) did the reading; this only looks at
// its small state file, so there is no network and no child process here. One
// line, shown once per release: the versions are marked seen as it is built.
function buildReleaseLine() {
  if (!opt('release_watch', true)) return null;
  if (scoutSuppressed().has(RELEASE_KIND)) return null;
  const stateFilePath = stateFile('release-watch.json');
  let running = null;
  try { running = JSON.parse(readFileSync(stateFile('baseline.json'), 'utf8')).version; } catch { /* scout has not run */ }
  const pending = readPending(stateFilePath, running);
  if (!pending) return null;
  markSeen(stateFilePath, pending.versions);
  const oldest = pending.versions[pending.versions.length - 1];
  const range = pending.versions.length > 1 ? `${oldest} to ${pending.versions[0]}` : pending.versions[0];
  return `[agent-companion] Claude Code ${pending.latest} is out (installed ${pending.installed}): ${pending.releases} new release(s) (${range}), `
    + `${pending.items} changelog item(s) on agents, hooks, cache, compaction, effort, plugins and related. `
    + `Details: ${stateFile('cli-release-details.md')}`;
}

// --- Piece 4: yesterday's plan usage, once per day -------------------------
// The scout started scripts/daily-checkup.mjs in the background (no model call);
// this only reads the last line of its history file, so there is no scan and no
// network here. One line, shown once per day: the day's share of the weekly
// limit against the target, the week so far, and any change switched on that day.
// The day is marked shown as the line is built (the caller prints it last).
function buildCheckupLine() {
  if (!opt('daily_checkup', true)) return null;
  const pending = pendingSurface();
  if (!pending) return null;
  markSurfaced(pending.rec.day);
  return pending.line;
}

try {
  const p = readStdin();

  // Drift signals and the main-CI note are for whoever steers the session. A
  // subagent that compacted runs the same SessionStart hooks, and has no use
  // for either (it cannot act on routing drift, and "main is red" is not its
  // brief), so it gets neither.
  if (sessionIsSubagent(p)) passthrough();

  // Recover any durable history left behind under the (pre-0.17.0) plugin
  // data directory before reading anything. Fully fail-open on its own; a
  // SessionStart hook must never block or throw because import had a bad day.
  try { syncLegacy(); } catch { /* fail open */ }

  let ciLine = null;
  try { ciLine = buildCiRedLine(); } catch { ciLine = null; }

  let scoutBlock = null;
  try { scoutBlock = buildScoutBlock(); } catch { scoutBlock = null; }

  // Last, so a hook that dies before printing has not marked anything seen.
  let releaseLine = null;
  try { releaseLine = buildReleaseLine(); } catch { releaseLine = null; }

  let checkupLine = null;
  try { checkupLine = buildCheckupLine(); } catch { checkupLine = null; }

  // Main sessions also start the background checkup when the scout has not (it is
  // idempotent: one attempt per 3 hours, one run at a time). Returns at once.
  try { launchCheckup(); } catch { /* advisory */ }

  if (!ciLine && !scoutBlock && !releaseLine && !checkupLine) passthrough();

  const contextParts = [ciLine, scoutBlock?.context, releaseLine, checkupLine].filter(Boolean);
  const summary = scoutBlock?.summary || ciLine || releaseLine || checkupLine;

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
