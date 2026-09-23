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

import { execSyncHidden } from './lib/proc.mjs';
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  modelTiers, telemetryDir as resolveTelemetryDir, stateFile, claudeDir, opt, parseSemver, semverBelow,
} from '../hooks/lib/context.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { telemetryCoverage } from './lib/coverage.mjs';

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
// A fake clock for date-dependent signals (retirement windows, routing-trial
// review dates) — tests inject AGENT_COMPANION_FAKE_NOW rather than waiting
// on the real calendar or reimplementing "days until" against Date.now().
// Unset in production, where this is exactly `new Date()`.
function nowDate() {
  const fake = process.env.AGENT_COMPANION_FAKE_NOW;
  return fake ? new Date(fake) : new Date();
}
const now = nowDate().toISOString();
const next = { checkedAt: now };

function sig(kind, detail, dispatch) {
  signals.push({ kind, detail, dispatch });
}

// Advisory-only, additive signal: SUGGESTS the model-benchmark skill, never
// runs it (a real benchmark spends model calls and plan usage — this script
// only ever hashes/counts/diffs, per its own file banner). Fired alongside
// three conditions the operator asked this scout to flag: a genuinely new
// model alias in the routing table's own lineup (1c, below), an alias/
// version-floor drift signal (1 and 1b, this section), or a routing trial
// past its reviewBy (5b, below). Kept as its OWN signal kind with its OWN
// dispatch rather than folded into those signals' existing `dispatch`
// strings, because those are asserted exactly by tests/alias-version-floor
// and tests/routing-trial — changing them would be an unrelated behavior
// change to what those signals already mean.
function suggestModelBenchmark(reason) {
  sig('model_benchmark_suggested',
    `${reason} — consider running the model-benchmark skill to refresh the routing table's evidence. Suggestion only: this scout never runs it itself.`,
    'model-benchmark');
}

// --- 1. Harness version ------------------------------------------------
// The highest-value check. A renamed matcher or a new hook event does not
// error — the guards just stop firing, silently.
try {
  const v = execSyncHidden('claude --version', { encoding: 'utf8', timeout: 20000 }).trim();
  next.version = v;
  if (baseline.version && baseline.version !== v) {
    sig('harness_version_changed', `${baseline.version} -> ${v}`,
      'harness-surface-diff + guardrail-canary');
    suggestModelBenchmark(`Claude Code version changed (${baseline.version} -> ${v})`);
  }
} catch {
  next.version = baseline.version ?? null;
  sig('harness_version_unreadable', 'could not run `claude --version`', 'manual-check');
}

// --- 1b. Alias-resolution version floor ---------------------------------
// config/model-tiers.json's `aliasResolution.minClaudeCodeVersion` records
// the Claude Code version its per-alias `resolvesTo` facts (price, default
// effort, context, ...) hold from — per that config's own note, `opus`
// resolved to Opus 5 instead of Opus 5.5 on any build below v2.1.280. That
// floor was recorded as DATA but never checked against the running harness
// anywhere, so an operator two patch versions behind it (a real, live-
// verified case, not hypothetical) got routing advice for a model their
// `opus` alias might not actually resolve to, with nothing surfacing the
// gap. Reuses the version string section 1 above already fetched — no
// second `claude --version` call.
// parseSemver/semverBelow now live in hooks/lib/context.mjs — shared with
// hooks/spawn-guard.mjs's own build-floor warning and the audit's
// resolved-model mismatch check, so the "below the floor" definition cannot
// drift into three separate copies.
try {
  const cfg = modelTiers();
  const floor = cfg.aliasResolution?.minClaudeCodeVersion;
  const floorParsed = parseSemver(floor);
  const running = parseSemver(next.version);
  if (floor && floorParsed && running && semverBelow(running, floorParsed)) {
    sig('alias_resolution_below_version_floor',
      `running Claude Code ${next.version} is below the ${floor} floor config/model-tiers.json's alias facts assume — ` +
      (cfg.aliasResolution.note || 'aliases (e.g. `opus`) may still resolve to an OLDER model than the routing table claims'),
      'routing-review');
    suggestModelBenchmark(`running Claude Code ${next.version} is below the alias-resolution floor ${floor}`);
  }
  // floor present but running version unreadable this run: section 1 above
  // already raised harness_version_unreadable — nothing further to add here.
} catch { /* config unreadable: the audit reports that separately */ }

// --- 1c. New model in the routing table's lineup ------------------------
// A model alias can be ADDED to config/model-tiers.json's `tiers` (a new
// release, or an existing one flipped `available: true`) without the
// benchmark ever having run a single cell against it — bench/runner.mjs's
// own CELLS table is a SEPARATE, hand-maintained list, so nothing connects
// "the routing table now names this alias" to "the benchmark evidence
// backing taskTypes.*.override actually covers it." Same freshness pattern
// as section 2's unknown-agent-types check: track the known set, fire only
// on a genuinely NEW arrival, never re-fire once seen.
try {
  const cfg = modelTiers();
  const availableAliases = Object.entries(cfg.tiers || {})
    .filter(([, spec]) => spec.available !== false)
    .map(([alias]) => alias)
    .sort();
  const seenAliases = new Set(baseline.knownModelAliases || []);
  const freshAliases = availableAliases.filter((a) => !seenAliases.has(a));
  next.knownModelAliases = availableAliases;
  // First run ever (no baseline.knownModelAliases at all): every alias is
  // "fresh" by construction, and that is not a real signal — it would fire
  // on every fresh install. Only fire once a baseline actually existed.
  if (baseline.knownModelAliases && freshAliases.length) {
    sig('new_model_in_lineup', `new model alias/tier in config/model-tiers.json: ${freshAliases.join(', ')}`, 'routing-review');
    suggestModelBenchmark(`new model alias/tier in the lineup: ${freshAliases.join(', ')}`);
  }
} catch { /* config unreadable: the audit reports that separately */ }

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
// day. Beyond 30 days out, warn only at a few fixed milestones — a signal
// that fires daily for two months trains the reader to ignore it. INSIDE the
// last 30 days the deadline is close enough to be worth a daily line even
// when a replacement is staged: a staged replacement still means the alias
// itself is about to disappear, and "the routing table has a fallback" is not
// the same fact as "the model is retiring soon" — both are worth surfacing on
// approach, not just once at the 30-day mark itself.
const RETIRE_MILESTONES = new Set([60, 45]);
const RETIRE_DAILY_WINDOW = 30;
try {
  const cfg = modelTiers();
  for (const [alias, spec] of Object.entries(cfg.tiers || {})) {
    if (!spec.retiresAfter) continue;
    // Calendar days, not elapsed hours: "30 days out" must mean the calendar
    // day 30 days before, whatever time of day the scout happens to run.
    const n = nowDate();
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
    } else if (days >= 0 && days <= RETIRE_DAILY_WINDOW) {
      // Inside 30 days: warn every run. A staged replacement lowers the
      // dispatch (nothing new to decide) but does not silence the signal.
      sig('model_retirement_approaching',
        `${alias} retires in ${days} day(s) (${spec.retiresAfter}); ${plan}`, staged ? 'none' : 'routing-review');
    } else if (days > RETIRE_DAILY_WINDOW && days <= 60 && RETIRE_MILESTONES.has(days)) {
      sig('model_retirement_approaching',
        `${alias} retires in ${days} day(s) (${spec.retiresAfter}); ${plan}`, staged ? 'none' : 'routing-review');
    }
  }
} catch { /* config unreadable: the audit reports that separately */ }

// --- 5b. Routing trial due for review -----------------------------------
// A taskType's `override` (config/model-tiers.json's routing trial: a
// benchmark-backed (model, effort) pair standing in for the plain
// weight/kind/consequence grid — see taskTypesNote) carries a `reviewBy`
// date. Past that date the override is still live and still routing spawns —
// nothing expires it automatically, unlike a tier's retiresAfter — so this is
// the one signal standing between "trial" and "silently permanent." Uses
// nowDate() (fake-clock injectable) rather than the real calendar so a test
// can assert the finding fires without waiting on 2026-09-30.
try {
  const cfg = modelTiers();
  const n = nowDate();
  const todayUtc = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  for (const [name, t] of Object.entries(cfg.taskTypes || {})) {
    const ov = t.override;
    if (!ov || !ov.reviewBy) continue;
    const reviewUtc = Date.parse(ov.reviewBy);
    if (Number.isNaN(reviewUtc)) continue;
    if (todayUtc >= reviewUtc) {
      sig('routing_trial_review_due',
        `${name} routing trial due for review: compare spawn telemetry outcomes and escalation rates since ${ov.trialSince || 'trial start'} (reviewBy ${ov.reviewBy} has passed)`,
        'routing-review');
      suggestModelBenchmark(`${name}'s routing trial reviewBy (${ov.reviewBy}) has passed`);
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
