// Intake decide step: turn what the scout DETECTS into something to DECIDE.
//
// Two inputs, one output. Every intake cycle used to end at a file or a repeated
// session line; nobody was asked a question. This builds the questions, with no
// model call and no network:
//
//   1. Claude Code releases not yet decided (state/release-watch.json `releases`
//      minus `decided`): one finding per release with the matching changelog
//      items, the plugin file or option each could change, and a draft
//      recommendation (adopt / ignore / watch).
//   2. Scout signals unacknowledged for more than STALE_DAYS (scout-delta.json):
//      one finding per kind with what it means and the action (fix, ack with a
//      reason, or retire the detector).
//
// The findings are shaped for the findings store contract (doc id, fields). The
// scout routine writes them and only THEN marks a release decided
// (markDecided in release-watch.mjs), so a failed write is retried next run.
// Pure functions first; file I/O is limited to buildQueue's reads and
// writeDecisionsFile.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions, parseSemver } from '../../hooks/lib/context.mjs';
import { readState, undecidedOf } from './release-watch.mjs';
import { STALE_DAYS, ageDaysOf } from './scout-handoff.mjs';

export const SOURCE = 'scout';
export const RELEASE_KIND = 'cli_release_available';
export const DETAIL_MAX = 300;
export const DECISIONS_FILE = 'cli-release-decisions.md';

// The findings contract's one slug rule: lowercase, anything outside a-z 0-9 and
// "-" becomes "-", runs of "-" collapse, first 60 characters. Nothing else.
export function slug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60);
}

export const releaseDocId = (version) => `findings/${SOURCE}-${slug(`cli-release-${version}`)}`;
export const staleDocId = (kind) => `findings/${SOURCE}-${slug(`decide-${kind}`)}`;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(0, n - 3))}...` : t;
};

// --- what each changelog topic could change in this plugin ------------------
// file: relative to the plugin root (a test checks it exists); option: a
// plugin option name (a test checks it is declared), when one governs it.
export const SURFACES = {
  subagents: [
    { file: 'hooks/spawn-guard.mjs', option: 'foreground_guard', note: 'spawn input rewrite and routing on the Agent tool' },
    { file: 'hooks/subagent-context.mjs', option: 'subagent_context_notice_tokens', note: 'worker context notices' },
  ],
  hooks: [
    { file: 'hooks/hooks.json', note: 'hook event wiring' },
    { file: 'hooks/spawn-guard.mjs', note: 'updatedInput and permission output' },
  ],
  cache: [
    { file: 'hooks/lib/keep-warm.mjs', option: 'keep_warm', note: 'cache keep-warm line' },
    { file: 'scripts/lib/cache-advisor.mjs', note: 'cache TTL advice' },
  ],
  compaction: [
    { file: 'scripts/lib/cache-advisor.mjs', option: 'compact_window_drift_pct', note: 'recommended auto-compact window' },
    { file: 'hooks/compact-floor.mjs', option: 'main_compact_floor_tokens', note: 'main compact floor' },
  ],
  effort: [
    { file: 'config/model-tiers.json', note: 'tier efforts and minEffort' },
    { file: 'hooks/spawn-guard.mjs', option: 'lead_effort_live_check', note: 'effort floor and lead effort check' },
  ],
  models: [
    { file: 'config/model-tiers.json', note: 'tier ids, aliases and retirement' },
    { file: 'scripts/lib/pinned-model.mjs', option: 'pinned_model_check', note: 'pinned model id check' },
  ],
  transcripts: [
    { file: 'scripts/transcript-harvest.mjs', note: 'transcript reads' },
    { file: 'scripts/usage-analysis.mjs', option: 'usage_analysis', note: 'usage analysis input' },
  ],
  SendMessage: [
    { file: 'hooks/resume-guard.mjs', option: 'resume_guard', note: 'continue-versus-fresh advice' },
  ],
  worktree: [
    { file: 'hooks/spawn-guard.mjs', option: 'isolation_demotion_notice', note: 'isolation and shared-tree notices' },
  ],
  workflow: [
    { file: 'hooks/spawn-guard.mjs', note: 'guard coverage of workflow-spawned agents' },
  ],
  plugins: [
    { file: 'hooks/self-update.mjs', note: 'plugin update path' },
    { file: 'scripts/version.mjs', note: 'installed-copy detection' },
  ],
};

// Topics where a change can alter what a guard or the routing table does. The
// rest (plugins, workflow, worktree, SendMessage) are watched, not adopted for.
export const CORE_TOPICS = new Set(['subagents', 'hooks', 'cache', 'compaction', 'effort', 'models', 'transcripts']);

const FIX_RE = /\b(?:fix(?:ed|es)?|resolved?|no longer|prevent(?:s|ed)?|stops?)\b/i;
const BREAKING_RE = /\b(?:breaking|deprecat\w*|removed|renamed|no longer supported)\b/i;

const RANK = { ignore: 0, watch: 1, adopt: 2 };

export function surfacesFor(topics) {
  const seen = new Set();
  const out = [];
  for (const t of topics || []) {
    for (const s of SURFACES[t] || []) {
      const key = `${s.file}|${s.option || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// One item -> { text, topics, kind, rec, surfaces }. The draft rule:
//   adopt  a fix on a core topic (the update brings it), or a breaking change
//          (update, then run the guard canary);
//   watch  a feature on a core topic, or any fix off the core topics;
//   ignore a non-core feature.
export function decideItem(item) {
  const text = String((item && item.text) || '');
  const topics = Array.isArray(item && item.topics) ? item.topics : [];
  const core = topics.some((t) => CORE_TOPICS.has(t));
  const breaking = BREAKING_RE.test(text);
  const fix = FIX_RE.test(text);
  let rec = 'ignore';
  if (breaking || (fix && core)) rec = 'adopt';
  else if (core || fix) rec = 'watch';
  const surfaces = surfacesFor(topics);
  if (/\bSubagent(?:Start|Stop)\b/.test(text)) {
    surfaces.unshift({ file: 'hooks/subagent-context.mjs', note: 'SubagentStart and SubagentStop hook firing counts and telemetry (hooks.json wires both)' });
  }
  return { text, topics, kind: breaking ? 'breaking' : fix ? 'fix' : 'change', rec, surfaces };
}

const WHY = {
  adopt: 'a fix or breaking change on a surface the guards read; update and run the guard canary',
  watch: 'touches a surface we steer, no fix we depend on; revisit when it ships in a release we run',
  ignore: 'only side topics (plugins, workflows, worktrees, SendMessage); nothing to change',
};

export function decideRelease(release) {
  const items = (release.items || []).map(decideItem);
  let rec = 'ignore';
  for (const i of items) if (RANK[i.rec] > RANK[rec]) rec = i.rec;
  const topics = [...new Set(items.flatMap((i) => i.topics))];
  return { version: release.version, rec, why: WHY[rec], topics, items };
}

const surfaceLabel = (s) => (s.option ? `${s.file} (option ${s.option})` : s.file);

export function releaseDetail(d) {
  const shown = d.items.filter((i) => i.surfaces.length).slice(0, 3);
  const parts = shown.map((i) => `"${clip(i.text, 55)}" -> ${i.surfaces[0].file}`);
  const more = d.items.length - shown.length;
  const tail = ` Full list: ${DECISIONS_FILE} in the scout state dir.`;
  const head = `${d.items.length} item(s). Recommend ${d.rec}: ${d.why}. `;
  const body = parts.join('; ') + (more > 0 ? `; +${more} more.` : '.');
  return clip(head + body + tail, DETAIL_MAX).replace(/\.\.\.$/, '...');
}

export function releaseFinding(d, nowIso) {
  const topics = d.topics.slice(0, 4).join(', ');
  const byFile = new Map();
  for (const s of d.items.flatMap((i) => i.surfaces)) if (!byFile.has(s.file)) byFile.set(s.file, s);
  const surfaces = [...byFile.values()].map(surfaceLabel).slice(0, 3);
  return {
    docId: releaseDocId(d.version),
    source: SOURCE,
    title: `Claude Code ${d.version}: ${d.rec}${topics ? ` (${topics})` : ''}`,
    detail: releaseDetail(d),
    url: `https://github.com/anthropics/claude-code/releases/tag/v${d.version}`,
    impact: `Could change: ${surfaces.join(', ') || 'guards and routing'}.`,
    expect: 'decide',
    firstSeen: nowIso,
    lastSeen: nowIso,
    lookedAt: null,
    useful: null,
  };
}

// --- stale signals ---------------------------------------------------------

// What a long-open signal means and what to do about it. Unlisted kinds get the
// generic wording, worded by whether the signal carries an action.
export const STALE_GUIDE = {
  project_agent_drift: { means: 'A project agent definition disagrees with the routing table (below or above its tier, effort inherited, or no parity reviewer).', action: 'fix' },
  decision_review_due: { means: 'A standing decision passed its review date and was never settled (a settled review is closed by setting reviewedOn on the decision).', action: 'fix' },
  budget_notices: { means: 'Count of session and worker budget notices; informational, it changes nothing by itself.', action: 'ack' },
  spawn_activity: { means: 'Count of spawns in 24h; informational, a volume reading with no defect.', action: 'retire' },
  inherited_effort_spawns: { means: 'Spawns named no effort and ran at the lead effort.', action: 'fix' },
  inherited_model_spawns: { means: 'Spawns named no model and inherited the lead tier.', action: 'fix' },
  session_churn: { means: 'Sessions crossed the churn thresholds (effort switches, tool errors, corrections, review rounds).', action: 'fix' },
  haiku_fit_leak: { means: 'Spawns the table routes to haiku ran on another model.', action: 'fix' },
};

const ACTION_TEXT = {
  fix: 'fix it',
  ack: 'ack it with a reason',
  retire: 'retire the detector (add the kind to scout_suppress)',
};

export function staleDetail(entry) {
  const guide = STALE_GUIDE[entry.kind] || {
    means: entry.actionable ? 'The scout keeps raising this signal and nobody has acted on it.' : 'An informational signal that nobody has acknowledged.',
    action: entry.actionable ? 'fix' : 'ack',
  };
  const open = `${entry.open} of ${entry.count} open`;
  const head = `${guide.means} Open since ${entry.firstDay} (${open}). Recommend: ${ACTION_TEXT[guide.action]}; else ack with a reason, or retire the detector.`;
  return clip(head, DETAIL_MAX);
}

export function staleFinding(entry, nowIso) {
  return {
    docId: staleDocId(entry.kind),
    source: SOURCE,
    title: `Scout signal ${entry.kind} open since ${entry.firstDay}: fix, ack or retire`,
    detail: staleDetail(entry),
    url: undefined,
    impact: entry.actionable ? 'An unaddressed signal means a guard or routing row may be weaker than believed.' : undefined,
    expect: 'decide',
    firstSeen: nowIso,
    lastSeen: nowIso,
    lookedAt: null,
    useful: null,
  };
}

// scout-delta.json entries open for more than `staleDays` days, oldest first.
// The release kind is excluded (its own decide step covers it) and so are
// suppressed kinds. A delta older than 2 days is not evidence (the scout did not run).
export function staleEntries(view, { staleDays = STALE_DAYS, skipKinds = [], nowMs = Date.now() } = {}) {
  if (!view || !Array.isArray(view.unacknowledged)) return [];
  const checked = Date.parse(view.checkedAt);
  if (Number.isFinite(checked) && nowMs - checked > 2 * 86400000) return [];
  const skip = new Set([RELEASE_KIND, ...skipKinds]);
  return view.unacknowledged
    .filter((u) => u && !skip.has(u.kind))
    .map((u) => ({ ...u, ageDays: ageDaysOf(u, view.evaluatedAt || view.checkedAt) }))
    .filter((u) => u.ageDays !== null && u.ageDays > staleDays)
    .sort((a, b) => b.ageDays - a.ageDays || a.kind.localeCompare(b.kind));
}

// --- the file for the full list ----------------------------------------------

export function decisionsMarkdown(decisions, nowIso) {
  const L = [`# Claude Code release decisions (drafted ${nowIso})`, '', 'Draft recommendations from `scripts/intake-decide.mjs`: adopt = update and verify, watch = revisit, ignore = nothing to change. The finding in the morning brief carries the short form.', ''];
  for (const d of decisions) {
    L.push(`## ${d.version}: ${d.rec}`);
    L.push('');
    for (const i of d.items) {
      L.push(`- [${i.topics.join(', ')}] (${i.rec}) ${i.text}`);
      for (const s of i.surfaces) L.push(`  - could change: ${surfaceLabel(s)} (${s.note})`);
    }
    L.push('');
  }
  return L.join('\n');
}

export function writeDecisionsFile(file, decisions, nowIso) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, decisionsMarkdown(decisions, nowIso));
    return true;
  } catch { return false; }
}

// --- the queue ---------------------------------------------------------------

function readJsonSafe(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; }
}

// Reads the scout's state, writes nothing but the decisions file. `installed`
// is the running Claude Code version floor (baseline.json), as the SessionStart
// hook uses; the higher of it and the version the last check ran against wins.
export function buildQueue({
  stateDirPath, nowMs = Date.now(), staleDays = STALE_DAYS, skipKinds = [], releases = true, runningVersion = null,
}) {
  const nowIso = new Date(nowMs).toISOString();
  const out = { checkedAt: nowIso, releases: [], quiet: [], stale: [], notes: [] };

  if (releases) {
    const state = readState(join(stateDirPath, 'release-watch.json'));
    const cands = [state.installedAtCheck, runningVersion].filter((v) => parseSemver(v)).map((v) => parseSemver(v).join('.'));
    if (!cands.length) {
      out.notes.push('release watch has no installed version yet (the scout has not run it)');
    } else {
      const inst = cands.reduce((m, v) => (compareVersions(v, m) === 1 ? v : m));
      const decisions = undecidedOf(state, inst).map(decideRelease);
      if (decisions.length) {
        writeDecisionsFile(join(stateDirPath, DECISIONS_FILE), decisions, nowIso);
        // Only a release with something that could change a hook, guard or option gets a
        // finding; the rest are recorded decided locally and keep the brief to decisions.
        out.releases = decisions.filter((d) => d.rec !== 'ignore').map((d) => ({ version: d.version, rec: d.rec, finding: releaseFinding(d, nowIso) }));
        out.quiet = decisions.filter((d) => d.rec === 'ignore').map((d) => d.version);
      }
    }
  }

  const view = readJsonSafe(join(stateDirPath, 'scout-delta.json'));
  if (!view) out.notes.push('no scout-delta.json yet (the scout has not written its hand-off)');
  else out.stale = staleEntries(view, { staleDays, skipKinds, nowMs }).map((e) => ({ kind: e.kind, ageDays: e.ageDays, finding: staleFinding(e, nowIso) }));
  return out;
}
