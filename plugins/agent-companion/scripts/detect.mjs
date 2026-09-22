// Deterministic signal detection for the daily calibration scout.
//
// Everything here is a hash, a count, or a diff — no model judgement. That is
// deliberate: if an LLM decides from keywords whether something changed, the
// triggering becomes nondeterministic, and a scout that silently misses a signal
// is WORSE than a fixed cadence, because you believe you are covered.
//
// The model's job starts where this script ends: read these signals, decide
// which heavy routine is warranted, write the summary.
//
// Emits JSON to stdout: { changed: bool, signals: [...], baseline: {...} }

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { modelTiers, telemetryDir as resolveTelemetryDir, stateFile, claudeDir, opt } from '../hooks/lib/context.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { telemetryCoverage } from './lib/coverage.mjs';
import { scanRecurrence } from './recurrence.mjs';

const argv = process.argv.slice(2);
const daysArg = (() => {
  const i = argv.indexOf('--days');
  return i >= 0 ? Number(argv[i + 1]) : 7;
})();

// Recover any durable history left in the legacy plugin data directory FIRST.
// Fails open on its own (locked / errored -> {skipped}); the scout still runs
// against whatever is already in the state root.
const syncResult = syncLegacy();

// Durable state now lives under the state root (survives a plugin uninstall),
// not the plugin data directory — see hooks/lib/context.mjs. detect.mjs reads
// ONLY telemetryDir()/state, no more per-marketplace union: the import above
// has already merged every legacy sibling directory into this one place.
const telemetryDir = resolveTelemetryDir();
function readJsonl(name) {
  const out = [];
  const f = join(telemetryDir, name);
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}

const baselineFile = stateFile('baseline.json');
const baseline = existsSync(baselineFile)
  ? JSON.parse(readFileSync(baselineFile, 'utf8'))
  : {};

const signals = [];
const now = new Date().toISOString();
const next = { checkedAt: now };

function sig(kind, detail, dispatch) {
  signals.push({ kind, detail, dispatch });
}

// --- 1. Harness version ------------------------------------------------
// The highest-value check. A renamed matcher or a new hook event does not
// error — the guards just stop firing, silently.
try {
  const v = execSync('claude --version', { encoding: 'utf8', timeout: 20000 }).trim();
  next.version = v;
  if (baseline.version && baseline.version !== v) {
    sig('harness_version_changed', `${baseline.version} -> ${v}`,
      'harness-surface-diff + guardrail-canary');
  }
} catch {
  next.version = baseline.version ?? null;
  sig('harness_version_unreadable', 'could not run `claude --version`', 'manual-check');
}

// --- 2. Unknown agent types -------------------------------------------
// Enforcement fails open on these by design; detection must not.
const unknownRecords = readJsonl('unknown-agent-types.jsonl');
if (unknownRecords.length) {
  const types = [...new Set(unknownRecords.map((r) => r.agent_type).filter(Boolean))];
  const seen = new Set(baseline.knownUnknowns || []);
  const fresh = types.filter((t) => !seen.has(t));
  next.knownUnknowns = types;
  if (fresh.length) {
    sig('new_agent_type', `unrecognised agent_type(s): ${fresh.join(', ')}`,
      'harness-surface-diff');
  }
}

// --- 3. Spawn + guardrail activity ------------------------------------
const spawns = readJsonl('spawns.jsonl');
const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
const recent = spawns.filter((s) => Date.parse(s.at) > dayAgo);
const premium = recent.filter((s) => /fable|opus/i.test(s.model || ''));
const inherited = recent.filter((s) => s.model === '(inherited)');

next.spawnTotal = spawns.length;
if (recent.length) {
  sig('spawn_activity',
    `${recent.length} spawns/24h; ${premium.length} premium; ${inherited.length} with no explicit model`,
    premium.length > (baseline.premiumPerDay ?? 0) * 2 ? 'spend-deep-dive' : 'none');
}
next.premiumPerDay = premium.length;

// Inherited-model spawns are the exact mechanism behind unexamined premium
// fan-out: nothing chose the tier, the lead's model did.
if (inherited.length > 0) {
  sig('inherited_model_spawns',
    `${inherited.length} spawn(s) in 24h specified no model and inherited the lead's tier`,
    'routing-review');
}

// --- 4. Silent-failure canary -----------------------------------------
// A guard that stopped matching looks identical to one never tripped.
// Zero denials across a week of real spawn activity is a signal, not good news.
const denials = readJsonl('denials.jsonl');
const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
const recentDenials = denials.filter((d) => Date.parse(d.at) > weekAgo);
const weekSpawns = spawns.filter((s) => Date.parse(s.at) > weekAgo);
if (weekSpawns.length > 20 && recentDenials.length === 0) {
  sig('zero_denials',
    `${weekSpawns.length} spawns in 7d and zero guard denials — guards may have stopped matching`,
    'guardrail-canary');
}

// --- 5. Model retirement ------------------------------------------------
// A tier alias that retires does not error; it resolves to whatever replaces
// it, or to nothing. Either way the routing table is silently wrong from that
// day. Warn at a few fixed distances rather than every morning — a signal that
// fires daily for two months trains the reader to ignore it — and say whether
// the table already carries the replacement, because a staged replacement
// switches itself on the date and needs no decision from anyone.
const RETIRE_MILESTONES = new Set([60, 30, 14, 7, 1, 0]);
try {
  const cfg = modelTiers();
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (!spec.retiresAfter) continue;
    // Calendar days, not elapsed hours: "30 days out" must mean the calendar
    // day 30 days before, whatever time of day the scout happens to run.
    const n = new Date();
    const todayUtc = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
    const days = Math.round((Date.parse(spec.retiresAfter) - todayUtc) / 86400000);
    const staged = !!(spec.replacement && spec.replacement.model);
    const plan = staged
      ? `replacement staged: ${spec.replacement.model}${spec.replacement.effort ? '/' + spec.replacement.effort : ''} takes over automatically from ${spec.retiresAfter}`
      : 'NO replacement staged — routing rows on this alias resolve to nothing after that date';
    if (days < 0 && !staged) {
      // Past the date with nothing staged is the one case that warrants daily noise.
      sig('model_retirement_approaching',
        `${alias} retired ${Math.abs(days)} day(s) ago (${spec.retiresAfter}); ${plan}`, 'routing-review');
    } else if (days >= 0 && days <= 60 && (RETIRE_MILESTONES.has(days) || (!staged && days <= 7))) {
      sig('model_retirement_approaching',
        `${alias} retires in ${days} day(s) (${spec.retiresAfter}); ${plan}`, staged ? 'none' : 'routing-review');
    }
  }
} catch { /* config unreadable: the audit reports that separately */ }

// --- 6. Plugin version behind ------------------------------------------
// The copy that is INSTALLED is not always the copy that is CURRENT. Locally
// the marketplace clone can be ahead of the installed cache; in the cloud, the
// claude.ai plugin directory snapshots a marketplace when it is added and
// serves that version until someone presses Sync. Either way the guards that
// run are older than the guards that shipped, and nothing errors. Compare this
// script's own manifest (the current copy) with what the harness has installed.
try {
  const own = JSON.parse(readFileSync(join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  // Was process.env.USERPROFILE || process.env.HOME directly — bypassed
  // AGENT_COMPANION_HOME_OVERRIDE entirely, so a test (or this script's own
  // manual verification) read the REAL ~/.claude/plugins/installed_plugins.json
  // even with the override set. claudeDir() honours the override like every
  // other path in this plugin.
  const inst = JSON.parse(readFileSync(join(claudeDir(), 'plugins', 'installed_plugins.json'), 'utf8'));
  const entries = Object.entries(inst.plugins || inst).filter(([k]) => k.startsWith(`${own.name}@`));
  const cloud = !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  for (const [key, val] of entries) {
    for (const e of Array.isArray(val) ? val : [val]) {
      if (e?.version && own.version && e.version !== own.version) {
        sig('plugin_version_behind',
          `${key} (${e.scope || 'user'} scope) is installed at ${e.version}; the current copy is ${own.version}` +
          (cloud
            ? ' — in the cloud this means the claude.ai plugin directory has not been synced since the marketplace was added (Sync button on the marketplace page)'
            : ' — run claude plugin marketplace update, then claude plugin update, then restart'),
          'plugin-update');
      }
    }
  }
  next.pluginVersion = own.version;
} catch { /* no install record here (a bare checkout): not a signal */ }

// --- 7. Enforcement silent (telemetry coverage vs. transcripts) --------
// spawns.jsonl going quiet looks identical whether nothing was spawned or the
// guard stopped recording. Transcripts are independent ground truth. Bounded
// to 20s / 5,000 files / 2GB here specifically — this is the DAILY scout, and
// a slow signal that blocks the quiet-day fast path defeats the point of it;
// the full-depth version of this check has no such cap (see the
// telemetry-coverage audit check).
try {
  const coverage = await telemetryCoverage({
    days: daysArg, maxMs: 20000, maxFiles: 5000, maxBytes: 2 * 1024 * 1024 * 1024,
    partialRatio: opt('coverage_partial_ratio', 0.5),
  });
  const bad = coverage.days.filter((d) => d.status === 'silent' || d.status === 'partial');
  if (bad.length) {
    const label = bad.map((d) => `${d.day}(${d.status})`).join(', ');
    sig('enforcement_silent',
      `${bad.length} day(s) in the last ${daysArg} had spawns but no guard telemetry: ${label}`
      + (coverage.truncated ? ' (transcript walk truncated by caps)' : ''),
      'telemetry-coverage');
  }
} catch { /* coverage check unreadable: not a signal, does not block the scout */ }

// --- 8. Recurring failures (capture-on-miss precursor) ------------------
// Recurrence across DISTINCT SESSIONS is the signal that says "we solved
// this before and had to solve it again" — see
// docs/adr/0002-stack-scoped-gotcha-retrieval.md. On this operator's corpus
// there are already 600+ signatures over threshold, so reporting the
// CURRENT list every morning would repeat the same signal forever and train
// the reader to ignore this scout entirely — worse than no notice, because
// it would also bury the genuine drift signals above. So the baseline
// remembers which signatures have ALREADY been surfaced — a capped set of
// short hashes, never raw signature text and never a file path, so this
// stays small and carries nothing sensitive — and this check fires ONLY for
// a signature that crosses minSessions for the FIRST time since the last
// run. When nothing new crossed, it emits no signal at all; silence is this
// check's default state, same as every other check in this file.
//
// Scans incrementally via --since this check's OWN last-scan cursor
// (baseline.recurrenceLastScan — see below for why that is a separate field
// from the shared baseline.checkedAt every run of this file advances).
// scanRecurrence() is called directly, in-process — same shape
// telemetryCoverage() above uses, no subprocess. On an ordinary day that is
// a handful of files touched since yesterday: a fraction of a second. The
// one exception is the very first run ever, when there is no prior cursor:
// Fix 3's own fallback in recurrence.mjs is a full corpus walk, measured at
// ~90s on this operator's 9.2GB corpus. That walk is deliberately NOT
// time-boxed here, unlike telemetryCoverage's 20s cap above — a truncated
// first walk would leave a PERMANENT blind spot, because --since judges a
// file too old to revisit once its mtime predates the cutoff, not just too
// old for today; a one-time 90s cost on the first run is preferable to
// silently never finishing the corpus.
const RECURRENCE_SEEN_CAP = 2000; // headroom over today's ~600 recurring sigs; see below
function hashSig(s) {
  // 16 hex chars (64 bits) — enough to make an accidental collision among a
  // few thousand entries astronomically unlikely, short enough to keep
  // baseline.json small. The signature TEXT is already normalised (paths,
  // hex, numbers stripped — see recurrence.mjs's signature()) before it
  // ever reaches here, so even the pre-image is not raw failure output.
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}
if (opt('recurrence_scan', true)) {
  try {
    // Deliberately its OWN timestamp, not the shared baseline.checkedAt
    // every run of this file advances unconditionally. Reusing the shared
    // one would make --since track "since detect.mjs last ran" rather than
    // "since this check last actually scanned" — indistinguishable most
    // days, but silently wrong the day someone flips recurrence_scan off
    // and back on: checkedAt keeps advancing while this check is skipped,
    // so re-enabling it would resume from a cutoff newer than its true last
    // scan and permanently miss whatever changed in between (--since can
    // only move a file out of scope, never back in). A dedicated cursor,
    // written only when the scan actually runs, closes that gap.
    const scan = await scanRecurrence({
      sinceMs: baseline.recurrenceLastScan ? Date.parse(baseline.recurrenceLastScan) : -Infinity,
      minSessions: 3,
    });
    const known = new Set(baseline.recurrenceSeen || []);
    const fresh = scan.ranked.filter((r) => !known.has(hashSig(r.sig)));
    if (fresh.length) {
      const sample = fresh.slice(0, 3).map((r) => `"${r.sig.slice(0, 50)}" (${r.sessions} sessions)`).join('; ');
      sig('recurring_failures',
        `${fresh.length} new recurring failure signature(s) crossed 3+ sessions since the last scan: ${sample}`,
        'gotcha-capture');
    }
    // Capped so baseline.json cannot grow without bound. A signature the cap
    // evicts (oldest-appended first) that is STILL recurring gets reported
    // once more when next seen — the honest cost of a bounded set, and one
    // the cap size keeps rare: ~2000 slots against ~600 signatures in use
    // today is months of headroom at this corpus's observed growth rate.
    next.recurrenceSeen = [...known, ...fresh.map((r) => hashSig(r.sig))].slice(-RECURRENCE_SEEN_CAP);
    next.recurrenceLastScan = now;
  } catch { /* recurrence scan unreadable: not a signal, does not block the scout */ }
}

writeFileSync(baselineFile, JSON.stringify({ ...baseline, ...next }, null, 2));

// Persist the latest result too. A locally SCHEDULED scout has no human at the
// keyboard when it runs; writing this lets the SessionStart hook surface any
// unresolved signal in the next interactive session — the zero-token way for a
// scheduled check to reach a person without waking a model to relay it.
const scoutResult = { checkedAt: now, changed: signals.length > 0, signals };
try {
  writeFileSync(stateFile('scout-latest.json'), JSON.stringify(scoutResult, null, 2));
} catch { /* reporting still goes to stdout */ }

// Append-only run history — scout-latest.json is overwritten every run and
// keeps no history of its own; this is the record of every past run.
try {
  appendFileSync(stateFile('scout-history.jsonl'), `${JSON.stringify(scoutResult)}\n`);
} catch { /* reporting still goes to stdout */ }

process.stdout.write(JSON.stringify({
  changed: signals.length > 0,
  checkedAt: now,
  signals,
  baseline: next,
  syncLegacy: syncResult,
}, null, 2));
