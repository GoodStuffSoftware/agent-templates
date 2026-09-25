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
import { join, basename } from 'node:path';
import { userInfo, homedir } from 'node:os';
import {
  modelTiers, telemetryDir as resolveTelemetryDir, stateFile, claudeDir, opt, parseSemver, semverBelow,
  homeRoot, stateRoot, resolveRoute, isLadderAgentName,
} from '../hooks/lib/context.mjs';
import {
  readInstalledPlugins, pluginEntries, scopeKey, versionBelow, compareVersions,
} from '../hooks/lib/plugin-installs.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { telemetryCoverage } from './lib/coverage.mjs';
import {
  sweepAll, sweepAllCloud, filterNewOrStale, normalizeGitUrl, loadFingerprintKey,
} from './lib/publication-sweep.mjs';
import {
  discoverViaGh, discoverOwners, discoverFromClaudeProjects, discoverLocalCheckouts,
  defaultDevRoots, parseExtraSpec, publicNameTokens, defaultCheckVisibility, cachedVisibility,
} from './lib/repo-discovery.mjs';
import { deriveTokens } from './lib/leak-scan-core.mjs';
import { makeScrubber } from './lib/scrub.mjs';
import { checkRepoCiStatus, githubOwnerRepoFromUrl, repoCacheKey } from './lib/ci-status.mjs';

// The operator's raw OS handle(s), for scrubbing signal text.
function rawOsHandles() {
  const out = [];
  try { out.push(userInfo().username); } catch { /* no passwd entry */ }
  for (const k of ['USERNAME', 'USER']) if (process.env[k]) out.push(process.env[k]);
  out.push(basename(homedir()));
  return [...new Set(out.filter(Boolean))];
}

const splitListLocal = (v) => (v ? String(v).split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);

// publication_leak_token_file: an operator-authored private-token file, fed
// into EVERY sweep scan (universal — applies regardless of strict). Default
// ~/.claude/agent-companion/leak-tokens.txt (the state root's config-shaped
// location) IF it exists; the option overrides the path. Never required —
// most operators have none, and a missing file is silently treated as "no
// token file", not an error.
function publicationTokenFile() {
  const configured = opt('publication_leak_token_file', '');
  if (configured) return configured;
  const defaultPath = join(stateRoot(), 'leak-tokens.txt');
  return existsSync(defaultPath) ? defaultPath : null;
}

const existsSyncSafe = existsSync;

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

// Signal text is SCRUBBED before it leaves this process (see the end of this
// file): a git error message, a configured repo path or a hit sample can
// otherwise carry the operator's own machine layout — profile paths in any
// escaping, dev-root paths naming private projects, path-encoded project
// dirs, the OS handle, private repo URLs, private project names — into a
// push notification or scout-surface line. Scrubbing happens once, at the
// end, because only then is the set of KNOWN-PUBLIC repos (which stay
// readable) complete. Applied to EVERY signal, not just publication-leak
// ones. See lib/scrub.mjs.
let knownPublicForScrub = [];
function sig(kind, detail, dispatch) {
  signals.push({ kind, detail: String(detail ?? ''), dispatch });
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
// The ladder's own rungs (config/model-tiers.json `ladder[].agent`, bare or
// agent-companion:-namespaced) are this plugin's own types, never drift —
// filtered here too, so rows recorded before the guard learned that stop
// raising the signal.
const unknownRecords = readJsonl('unknown-agent-types.jsonl').filter((r) => !isLadderAgentName(r.agent_type));
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
    // "model (effort x)", not "model/x": the signal scrubber (lib/scrub.mjs)
    // treats a bare a/b pair as a possibly-private owner/repo.
    const plan = staged
      ? `replacement staged: ${spec.replacement.model}${spec.replacement.effort ? ` (effort ${spec.replacement.effort})` : ''} takes over automatically from ${spec.retiresAfter}`
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
// can assert the finding fires without waiting on 2026-09-30. The trial is
// read through resolveRoute()'s layer stack — the only reader of
// taskTypes.<type>.override — so a trial that stops winning (skipped by a
// floor) is still reviewed while it is in the table.
try {
  const cfg = modelTiers();
  const n = nowDate();
  const todayUtc = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  for (const name of Object.keys(cfg.taskTypes || {})) {
    const entry = resolveRoute({ type: name, now: n }).stack.find((st) => st.layer === 'trial');
    const ov = entry && entry.present ? entry.meta : null;
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
// run are older than the guards that shipped, and nothing errors.
//
// "Latest" is the latest AVAILABLE version, never whichever checkout happens
// to be running this script: locally that is the marketplace clone's own
// plugin.json (what `claude plugin update` would install); in the cloud the
// routine runs from a checkout of the marketplace repo itself, so that
// checkout IS the latest available there. The comparison is directional:
// only an install BELOW latest fires. An older checkout running the scout
// (installed 0.29.1, checkout 0.29.0) stays silent, and so does an
// unreleased dev checkout that is ahead of every release.
const OWN_MANIFEST = (() => {
  try { return JSON.parse(readFileSync(join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')); } catch { return null; }
})();
const PLUGIN_NAME = (OWN_MANIFEST && OWN_MANIFEST.name) || 'agent-companion';

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
// The version a marketplace's local clone would install for `name`, or null.
function marketplaceVersion(marketplace, name) {
  if (!marketplace) return null;
  const known = readJsonFile(join(claudeDir(), 'plugins', 'known_marketplaces.json')) || {};
  const loc = (known[marketplace] && typeof known[marketplace].installLocation === 'string' && known[marketplace].installLocation)
    || join(claudeDir(), 'plugins', 'marketplaces', marketplace);
  let pluginDir = join(loc, 'plugins', name);
  let listed = null;
  const mj = readJsonFile(join(loc, '.claude-plugin', 'marketplace.json'));
  const ent = Array.isArray(mj?.plugins) ? mj.plugins.find((x) => x && x.name === name) : null;
  if (ent) {
    if (typeof ent.source === 'string' && ent.source.startsWith('./')) pluginDir = join(loc, ent.source);
    if (typeof ent.version === 'string') listed = ent.version;
  }
  const pj = readJsonFile(join(pluginDir, '.claude-plugin', 'plugin.json'));
  return (pj && typeof pj.version === 'string' && pj.version) || listed;
}

try {
  // claudeDir() honours the test home redirect like every other path in this
  // plugin, so a test never reads the real installed_plugins.json.
  const entries = pluginEntries(readInstalledPlugins(claudeDir()), PLUGIN_NAME);
  const cloud = !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  for (const e of entries) {
    const latest = cloud ? (OWN_MANIFEST && OWN_MANIFEST.version) : marketplaceVersion(e.key.split('@')[1], PLUGIN_NAME);
    if (!latest || !versionBelow(e.version, latest)) continue;
    sig('plugin_version_behind',
      `${e.key} (${e.scope || 'user'} scope) is installed at ${e.version}; the latest available is ${latest}` +
      (cloud
        ? ' — in the cloud this means the claude.ai plugin directory has not been synced since the marketplace was added (Sync button on the marketplace page)'
        : ' (the marketplace clone) — run claude plugin update, then restart'),
      'plugin-update');
  }
  if (OWN_MANIFEST && OWN_MANIFEST.version) next.pluginVersion = OWN_MANIFEST.version;
} catch { /* no install record here (a bare checkout): not a signal */ }

// --- 6b. Stale guard still running ---------------------------------------
// The cross-session half of the version check. spawn-guard.mjs stamps its
// own version, copy source (cache/checkout) and install scope key into every
// spawns.jsonl row. A spawn in the last 24h that was guarded by a version
// BELOW the version installed for that same scope means a stale copy of the
// plugin is still loaded somewhere — the 2026-09-24 incident, where a
// session loaded only an old 0.22.0 copy and nothing inside that session
// could say so. Rules, all chosen so a normal update never fires:
//   - directional and per scope: guard below installed for ITS scope only;
//     a checkout guard (the operator's own tree) is never judged;
//   - only rows written AFTER that scope's install entry's lastUpdated, and
//     only from sessions whose first spawn is also after it — a session
//     that was already open across an update runs its old hooks until it
//     reloads, which is expected, not a stale install;
//   - a row with no stamp at all is judged only when it also lacks
//     route_layer (every guard since 0.29.0 writes that key), i.e. it came
//     from a pre-0.29.0 guard, and only when every install is >= 0.29.0 —
//     its scope is unknown, so it must be behind every install to count.
const STALE_GUARD_REMEDY = 'remove the stale agent-companion entry in the desktop plugin manager, then /reload-plugins, ' +
  'then verify with a trivial ladder spawn; fresh session if that still fails';
const ROUTE_LAYER_SINCE = '0.29.0';
try {
  const entries = pluginEntries(readInstalledPlugins(claudeDir()), PLUGIN_NAME);
  if (entries.length && recent.length) {
    // One entry per scope key; if two marketplaces share a scope, the newer counts.
    const byScope = new Map();
    for (const e of entries) {
      const k = scopeKey(e);
      const cur = byScope.get(k);
      if (!cur || compareVersions(e.version, cur.version) === 1) byScope.set(k, e);
    }
    const newestUpdate = entries.reduce((best, e) => {
      const t = Date.parse(e.lastUpdated || '');
      return Number.isFinite(t) && (!best || t > Date.parse(best.lastUpdated)) ? e : best;
    }, null);
    const everyInstallHasRouteLayer = entries.every((e) => !versionBelow(e.version, ROUTE_LAYER_SINCE));
    const firstSeen = new Map();
    for (const s of spawns) {
      const t = Date.parse(s.at);
      if (!Number.isFinite(t) || !s.session_id) continue;
      if (!firstSeen.has(s.session_id) || t < firstSeen.get(s.session_id)) firstSeen.set(s.session_id, t);
    }
    const bySession = new Map();
    for (const s of recent) {
      if (s.guard_source === 'checkout') continue;
      let guard;
      let entry;
      if (typeof s.guard_version === 'string' && s.guard_version) {
        entry = byScope.get(s.guard_scope);
        if (!entry || !versionBelow(s.guard_version, entry.version)) continue;
        guard = s.guard_version;
      } else if (!('guard_version' in s) && !('route_layer' in s) && everyInstallHasRouteLayer && newestUpdate) {
        entry = newestUpdate;
        guard = `a pre-${ROUTE_LAYER_SINCE} version`;
      } else {
        continue;
      }
      const updated = Date.parse(entry.lastUpdated || '');
      const at = Date.parse(s.at);
      if (!Number.isFinite(updated) || !(at > updated)) continue;
      if (!((firstSeen.get(s.session_id) ?? at) > updated)) continue;
      const sidKey = String(s.session_id || 'unknown');
      const cur = bySession.get(sidKey) || { count: 0, guard, installed: entry.version, scope: entry.scope || 'user' };
      cur.count += 1;
      bySession.set(sidKey, cur);
    }
    if (bySession.size) {
      const total = [...bySession.values()].reduce((n, v) => n + v.count, 0);
      const list = [...bySession.entries()].slice(0, 5)
        .map(([sidKey, v]) => `session ${sidKey.slice(0, 8)}: guard ${v.guard} < installed ${v.installed} (${v.scope} scope)`);
      const more = bySession.size > 5 ? `, +${bySession.size - 5} more` : '';
      const installs = [...new Set(entries.map((e) => `${e.scope || 'user'}@${e.version}`))];
      sig('stale_guard_running',
        `${total} spawn(s) in 24h from ${bySession.size} session(s) were guarded by an older agent-companion than the one ` +
        `installed for their scope — a stale copy is still loaded: ${list.join('; ')}${more}.` +
        (installs.length > 1 ? ` Installs visible: ${installs.join(', ')}.` : '') +
        ` Remedy: ${STALE_GUARD_REMEDY}.`,
        'plugin-update');
    }
  }
} catch { /* telemetry or install record unreadable: not a signal */ }

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

// --- 8. Publication-leak sweep -----------------------------------------
// OFF BY DEFAULT (publication_leak_sweep) — this feature clones/fetches
// repos and, locally, calls the GitHub API, so it needs an explicit opt-in
// even though the sweep list itself is auto-discovered.
//
// LOCAL: auto-discovers every public repo the operator can push to (gh api,
// owned + org-member, skipping archived/forks) UNIONED with local checkouts
// under the dev root whose origin is a public GitHub repo — see
// repo-discovery.mjs. The gh LIST is cached for 24h (baseline) since it can
// span dozens of repos and gh is rate-limited. A LOCAL CHECKOUT not already
// known public has its visibility rechecked on every run (only a public
// answer is cached — see cachedVisibility()), so a repo newly turned public
// is swept on the next run, never delayed by a cache. publication_leak_repos
// adds repos discovery would miss and excludes ones (via `!entry`) it
// shouldn't cover. Each covered repo's origin default branch is fetched into
// a throwaway clone and scanned by the plugin's own generic checker plus its
// own leak-check.mjs when it has one.
//
// CLOUD never discovers or clones — a cloud routine already runs from a
// checkout of ITS OWN source repo, and cloning a SECOND copy of a repo into
// a temp dir and executing a script from it is exactly the "code from
// external" shape the cloud sandbox's classifier denies, even when the
// source is that repo's own origin. So in the cloud, publication_leak_repos
// is read as a plain list (no discovery, `!excludes` ignored — nothing to
// exclude from) and only the ONE entry that IS this session's own checkout
// gets scanned — in place, after confirming HEAD matches origin's default
// branch, always with --no-derived. Any OTHER entry is reported `skipped`
// rather than fetched or cloned.
const publicationSweepOn = !!opt('publication_leak_sweep', false);
const cloud = !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
let publicationRepos = [];
let publicationPublicNames = []; // every discovered-public name — exempt from the derived-name class (see repo-discovery.mjs's publicNameTokens)
let publicationAllowedOwners = new Set(); // item 2: the authenticated user + their orgs — gates target-script execution
// Visibility results are cached in the baseline, but ONLY a public answer
// (for 24h): not-public and unknown answers are never cached, so a repo that
// is not known public is rechecked on every run and one that turns public is
// swept on the very next run. A warm run only calls the API for repos not
// (yet) known public.
// A candidate whose visibility could not be determined (offline,
// rate-limited, API error) is NOT swept — never assumed public — so the
// count is surfaced as its own signal below instead of silently dropping.
const visibilityCache = { ...(baseline.publicationVisibilityCache || {}) };
// AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: test-only escape hatch — '1'
// treats every candidate as public, 'unknown' as undeterminable; neither
// makes a network call.
const mockVisibilityEnv = process.env.AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY;
const baseVisibility = mockVisibilityEnv === '1' ? async () => true
  : mockVisibilityEnv === 'unknown' ? async () => null
    : defaultCheckVisibility;
const visibility = cachedVisibility(baseVisibility, visibilityCache);
if (publicationSweepOn && cloud) {
  publicationRepos = parseExtraSpec(opt('publication_leak_repos', '')).include;
  publicationAllowedOwners = new Set(splitListLocal(opt('publication_leak_owners', '')).map((s) => s.toLowerCase()));
  // Default (no include list): sweep the session's own checkout, but ONLY
  // if it is actually public — no discovery needed for that, cwd's own
  // origin is right there. Never defaults to sweeping a private repo.
  if (publicationRepos.length === 0) {
    try {
      const originUrl = execSyncHidden('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 }).trim();
      const norm = normalizeGitUrl(originUrl); // "github.com/owner/repo"
      const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(norm);
      if (m) {
        const isPublic = await visibility.check(m[1], m[2]);
        if (isPublic === true) {
          publicationRepos = [originUrl];
          knownPublicForScrub = [originUrl];
        }
      }
    } catch { /* no origin readable here: nothing to default to, stays empty/silent */ }
  }
} else if (publicationSweepOn) {
  try {
    const { include, exclude } = parseExtraSpec(opt('publication_leak_repos', ''));

    // The gh LIST (owned + org-member public repos) is the one part of
    // discovery expensive/rate-limited enough to cache. 24h TTL; a run that
    // fails (gh missing/unauthenticated) is never cached as a success.
    const ghCache = baseline.publicationGhCache;
    const cacheFresh = ghCache?.ok && (Date.now() - Date.parse(ghCache.at || 0)) < 24 * 60 * 60 * 1000;
    let ghRepos;
    let ghNote;
    // AGENT_COMPANION_DISCOVERY_NO_GH: test/offline escape hatch — skip the
    // real `gh` invocation and take the "gh unavailable" degrade path
    // deterministically, instead of depending on whether this machine
    // happens to have gh installed/authenticated.
    if (cacheFresh) {
      ghRepos = ghCache.repos;
      ghNote = null;
      next.publicationGhCache = ghCache; // keep as-is; still fresh
    } else if (process.env.AGENT_COMPANION_DISCOVERY_NO_GH) {
      ghRepos = [];
      ghNote = process.env.AGENT_COMPANION_DISCOVERY_NO_GH === '1' ? 'gh is not installed' : String(process.env.AGENT_COMPANION_DISCOVERY_NO_GH);
      next.publicationGhCache = { at: now, ok: false, repos: [] };
    } else {
      const gh = discoverViaGh({});
      ghRepos = gh.ok ? gh.repos : [];
      ghNote = gh.ok ? null : gh.reason;
      next.publicationGhCache = { at: now, ok: gh.ok, repos: ghRepos };
    }

    // The trusted-owner set (item 2): a locally-discovered repo is kept
    // ONLY if its owner is the authenticated gh user or an org they belong
    // to. gh available: discoverOwners() (accurate). gh unavailable:
    // publication_leak_owners (explicit), unioned with the owners already
    // present in the gh-discovered repo list itself (the "owner set seen
    // across the operator's own repos' remotes" fallback — those repos were
    // already vetted by the gh affiliation query). Empty either way =
    // exclude every local-checkout candidate (safe default: never sweep an
    // unverified third party just because it sits in a local checkout).
    const ghOwnersResult = process.env.AGENT_COMPANION_DISCOVERY_NO_GH || cacheFresh
      ? { ok: false, owners: [] }
      : discoverOwners({});
    const explicitOwners = splitListLocal(opt('publication_leak_owners', ''));
    const ghRepoOwners = ghRepos.map((r) => (r.fullName || '').split('/')[0]).filter(Boolean);
    const allowedOwners = new Set(
      [...ghOwnersResult.owners, ...explicitOwners, ...ghRepoOwners].map((s) => s.toLowerCase()),
    );
    publicationAllowedOwners = allowedOwners;

    // Local visibility goes through `visibility` (public answers cached
    // 24h; not-public and unknown ones rechecked every run — see above).
    //
    // PRIMARY: ~/.claude.json's `projects` map — real paths Claude Code has
    // actually worked in. AGENT_COMPANION_DISCOVERY_CLAUDE_JSON overrides the
    // path (tests point this at a synthetic fixture file; production leaves
    // it unset and gets homeRoot()/.claude.json, honouring a test fixture's
    // isolated home the same as every other resolver in this plugin).
    const claudeJsonPath = process.env.AGENT_COMPANION_DISCOVERY_CLAUDE_JSON || join(homeRoot(), '.claude.json');
    const primary = await discoverFromClaudeProjects({ claudeJsonPath, checkVisibility: visibility.check });
    let localRepos = primary.ok ? primary.repos : [];
    let localSource = 'claude-json';
    if (!primary.ok) {
      // FALLBACK: ~/.claude.json missing/unparseable — walk the dev root
      // instead (see discoverLocalCheckouts()'s header for why this, not a
      // decode of ~/.claude/projects/<encoded> names). Dev root(s) resolve
      // through homeRoot(); AGENT_COMPANION_DISCOVERY_DEV_ROOT overrides them
      // (comma-separated) — the test escape hatch, mirroring leak-check.mjs's
      // own LEAK_CHECK_DEV_ROOT.
      const devRootOverride = process.env.AGENT_COMPANION_DISCOVERY_DEV_ROOT;
      const devRoots = devRootOverride
        ? devRootOverride.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
        : defaultDevRoots({ home: homeRoot() });
      localRepos = await discoverLocalCheckouts({ devRoots, checkVisibility: visibility.check });
      localSource = 'dev-root-fallback';
    }

    // A bare `owner/repo` shorthand (not an existing local path) expands to
    // an https URL so it normalizes/clones like any other entry — applied
    // to BOTH include and exclude, so `!owner/repo` actually matches a
    // discovered `https://github.com/owner/repo` entry rather than silently
    // never excluding anything.
    const expandShorthand = (raw) => (/^[\w.-]+\/[\w.-]+$/.test(raw) && !existsSyncSafe(raw) ? `https://github.com/${raw}.git` : raw);
    const excludeKeys = new Set(exclude.map((e) => normalizeGitUrl(expandShorthand(e))));
    const merged = [];
    const seen = new Set();
    const add = (r, source) => {
      const key = normalizeGitUrl(r.htmlUrl || r);
      if (seen.has(key) || excludeKeys.has(key)) return;
      seen.add(key);
      merged.push({ fullName: r.fullName || r, htmlUrl: r.htmlUrl || r, source });
    };
    for (const r of ghRepos) add(r, 'gh'); // already owner-restricted by the gh API query itself
    for (const r of localRepos) {
      // item 2: exclude a third-party repo merely cloned locally — only
      // keep it if its owner is verified trusted.
      const owner = (r.fullName || '').split('/')[0]?.toLowerCase();
      if (!owner || !allowedOwners.has(owner)) continue;
      add(r, 'local-checkout');
    }
    for (const raw of include) {
      add({ fullName: raw, htmlUrl: expandShorthand(raw) }, 'extra');
    }

    publicationRepos = merged.map((r) => r.htmlUrl);
    // A name that is itself public is not a leak: every discovered repo's
    // name/owner/"owner/repo" is exempt from the derived-name class in
    // both checkers (this plugin's own, and the target's own leak-check.mjs
    // via LEAK_CHECK_OWN_NAMES) — see publicNameTokens()'s own header.
    // 'extra' entries are excluded on purpose: they were never confirmed
    // public by discovery, so they get no free pass.
    publicationPublicNames = publicNameTokens(merged.filter((r) => r.source !== 'extra'));
    // Known residue F5 (accepted): repos from `extra` entries here, and from
    // an explicit publication_leak_repos list in the cloud branch above, are
    // never marked known-public, so their alerts read
    // "<repo-url> — rel:line [label]" (file/line kept, repo name hidden) —
    // safe but weaker. Unverified: if a cloud session's origin is a
    // proxy-style URL rather than github.com/o/r, the cloud default (no
    // explicit list) sweeps nothing.
    knownPublicForScrub = merged.filter((r) => r.source !== 'extra').flatMap((r) => [r.htmlUrl, r.fullName]);

    // gh missing/unauthenticated: note it ONCE (not daily), same
    // "changed since baseline" treatment as the skip-notes below.
    const prevGhNote = baseline.publicationGhNote || null;
    next.publicationGhNote = ghNote;
    if (ghNote && ghNote !== prevGhNote) {
      sig('publication_leak_sweep_note', `gh discovery unavailable — swept via local-checkout discovery only: ${ghNote}`, 'none');
    }

    // A repo newly seen as PUBLIC is the highest-risk moment (nobody has
    // swept it before) — fire a distinct signal, never deduped by the
    // regular per-hit baseline, and remember it permanently so it doesn't
    // re-fire once acknowledged.
    const knownPublic = new Set(baseline.publicationKnownPublicRepos || []);
    const nowPublicKeys = merged.filter((r) => r.source !== 'extra').map((r) => normalizeGitUrl(r.htmlUrl));
    const newlyPublic = merged.filter((r) => r.source !== 'extra' && !knownPublic.has(normalizeGitUrl(r.htmlUrl)));
    next.publicationKnownPublicRepos = [...new Set([...knownPublic, ...nowPublicKeys])];
    if (newlyPublic.length) {
      sig('publication_repo_newly_public',
        `${newlyPublic.length} repo(s) newly seen as public and now covered by the sweep: ${newlyPublic.map((r) => r.fullName).join(', ')}`,
        'manual-check');
    }
  } catch (err) {
    sig('publication_leak_sweep_error', `discovery crashed: ${err.message || err}`, 'manual-check');
  }
}
if (publicationSweepOn) {
  next.publicationVisibilityCache = visibilityCache;
  const unknown = visibility.stats.unknown;
  if (unknown > 0) {
    // Count only — never names: which repos exist is itself private.
    sig('publication_leak_visibility_unknown',
      `${unknown} candidate repo(s) had unknown visibility this run (offline, rate-limited or API error) and were NOT swept; retried next run`,
      'manual-check');
  }
}
if (publicationRepos.length) {
  try {
    // Per-machine HMAC key for hit fingerprints (see fingerprintHit()).
    const fingerprintKey = loadFingerprintKey(stateRoot());
    const { results } = cloud
      ? await sweepAllCloud(publicationRepos, {
        cwd: process.cwd(), tokenFile: publicationTokenFile(), publicNames: publicationPublicNames, fingerprintKey,
      })
      : await sweepAll(publicationRepos, {
        publicNames: publicationPublicNames,
        strictRepoUrls: splitListLocal(opt('publication_leak_strict_repos', '')),
        allowedOwners: publicationAllowedOwners,
        tokenFile: publicationTokenFile(),
        fingerprintKey,
      });
    // seenByRepo[repo] is { fingerprint: lastSeenISO } (not a flat
    // array/Set) — the timestamp is what makes the weekly re-fire (item 7)
    // possible: a standing accepted finding is re-surfaced once its record
    // turns 7+ days old, so a missed/dismissed notification is never
    // permanently silent. Every fingerprint reported THIS run (new,
    // re-fired, or unchanged) has its timestamp refreshed to now.
    const seenByRepo = baseline.publicationLeakSeen || {};
    const nextSeenByRepo = {};
    const allNewHits = [];
    const errors = [];
    const skipped = [];
    for (const r of results) {
      if (r.skipped) { skipped.push(r); continue; }
      // An error is always reported, but hits found alongside it (e.g. the
      // plugin checker's, when the target's own script crashed) are still
      // real findings and are processed, not dropped with the error.
      if (r.error) errors.push(`${r.repo}: ${r.error}`);
      if (r.error && r.hits.length === 0) continue;
      const prevMap = seenByRepo[r.repo] || {};
      const fresh = filterNewOrStale(r.hits, prevMap, { maxAgeDays: 7, now: Date.now() });
      const freshFps = new Set(fresh.map((h) => h.fingerprint));
      const nextMap = {};
      for (const h of r.hits) nextMap[h.fingerprint] = freshFps.has(h.fingerprint) ? now : (prevMap[h.fingerprint] || now);
      nextSeenByRepo[r.repo] = nextMap;
      for (const h of fresh) allNewHits.push({ repo: r.repo, ...h });
    }
    // Repos that errored OR were skipped this run keep their LAST successful
    // baseline rather than being wiped to empty, so a transient failure (or
    // simply running in cloud, where most configured repos are always
    // "skipped") doesn't make every hit look "new" again on a run that later
    // succeeds.
    for (const r of results) {
      if (!seenByRepo[r.repo]) continue;
      if (r.skipped || (r.error && r.hits.length === 0)) nextSeenByRepo[r.repo] = seenByRepo[r.repo];
      // Errored WITH partial hits: keep the old acceptances too, so a finding
      // the failed checker would have reported is not "new" next run.
      else if (r.error) nextSeenByRepo[r.repo] = { ...seenByRepo[r.repo], ...nextSeenByRepo[r.repo] };
    }
    next.publicationLeakSeen = nextSeenByRepo;

    if (allNewHits.length) {
      // `<repo> — <rel>:<line> [label]`: the repo is separated from the file
      // by whitespace, never glued on with ":" — a repo URL immediately
      // followed by ":README.md:3" reads (to a URL matcher, and to a person)
      // as one URL, and the scrubber would then replace repo, file and line
      // with a single <repo-url>, leaving the alert unactionable.
      const sample = allNewHits.slice(0, 5)
        .map((h) => `${h.repo} — ${h.rel}:${h.line} [${h.label}]`).join('; ');
      const more = allNewHits.length > 5 ? ` +${allNewHits.length - 5} more` : '';
      sig('publication_leak',
        `${allNewHits.length} new leak hit(s) across ${publicationRepos.length} configured repo(s)` +
        (cloud ? ' (cloud, in-place, --no-derived)' : '') +
        `: ${sample}${more}`,
        'manual-check');
    }
    if (errors.length) {
      sig('publication_leak_sweep_error',
        `sweep could not complete for ${errors.length} of ${publicationRepos.length} repo(s): ${errors.join('; ')}`,
        'manual-check');
    }
    // Skips are expected in cloud (every configured repo but the session's
    // own is always skipped there) and would fire every single day if
    // treated as a normal signal, so only report when the SET of skip notes
    // actually changed since the last run — a newly-added or newly-removed
    // skipped repo is worth a line; the steady state is not.
    const skipNotes = {};
    for (const r of skipped) skipNotes[r.repo] = r.note;
    next.publicationLeakSkipped = skipNotes;
    const prevSkipNotes = baseline.publicationLeakSkipped || {};
    const skipKeys = new Set([...Object.keys(skipNotes), ...Object.keys(prevSkipNotes)]);
    const skipChanged = [...skipKeys].some((k) => skipNotes[k] !== prevSkipNotes[k]);
    if (skipChanged && skipped.length) {
      sig('publication_leak_sweep_note',
        `${skipped.length} configured repo(s) not swept this run: ${skipped.map((r) => `${r.repo} (${r.note})`).join('; ')}`,
        'none');
    }
  } catch (err) {
    sig('publication_leak_sweep_error', `sweep crashed: ${err.message || err}`, 'manual-check');
  }
}

// --- 9. Main branch CI red ----------------------------------------------
// Suggestion-only: never re-runs, cancels, or fixes anything — it only reads
// gh's own view of the default branch's latest completed runs. Fails open
// (silent) whenever gh is missing, unauthenticated, or the API call errors
// (offline included) — see ci-status.mjs's checkRepoCiStatus().
//
// SCOPE DECISION (required to pick the safer of "public repos only" or "the
// current project only"): this checks the CURRENT PROJECT's own origin (cwd's
// git toplevel — whatever its visibility), PLUS any repo already confirmed
// PUBLIC by the publication-leak sweep above (`baseline.publicationKnownPublicRepos`,
// populated only when the opt-in `publication_leak_sweep` has actually run).
// No new repo-listing/discovery gh calls are made just for this feature, and
// no repo of UNKNOWN or private visibility is ever added beyond the current
// project itself. This is the current-project-only option, with free reuse of
// an already-vetted public list when that unrelated feature happens to be on.
const ciStatusOn = opt('ci_status_signal', true);
if (ciStatusOn) {
  try {
    const CI_STATUS_CACHE_MS = 10 * 60 * 1000;
    const CI_STATUS_MAX_REPOS = 5; // bound gh calls per run regardless of list size
    const ciCache = { ...(baseline.ciStatusCache || {}) };

    const currentProjectUrls = [];
    try {
      const originUrl = execSyncHidden('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 }).trim();
      if (originUrl) currentProjectUrls.push(originUrl);
    } catch { /* not a repo / no origin here: nothing to add */ }
    const knownPublicUrls = baseline.publicationKnownPublicRepos || [];

    const seenKeys = new Set();
    const targets = [];
    for (const u of currentProjectUrls) {
      const gh = githubOwnerRepoFromUrl(u, normalizeGitUrl);
      if (!gh || seenKeys.has(repoCacheKey(gh.owner, gh.repo))) continue;
      seenKeys.add(repoCacheKey(gh.owner, gh.repo));
      targets.push(gh);
    }
    for (const u of knownPublicUrls) {
      const gh = githubOwnerRepoFromUrl(u, normalizeGitUrl);
      if (!gh) continue;
      // Known public: safe to name in full in the signal text (scrub() below
      // keeps only repo references that normalize to something in this set).
      // Recorded unconditionally — even when this repo is ALSO the current
      // project (already a target from the loop above) or past the repo cap
      // below, its name must still be treated as public, not silently
      // skipped by the dedupe/cap that only governs which repos get gh calls.
      knownPublicForScrub.push(u, `${gh.owner}/${gh.repo}`);
      const key = repoCacheKey(gh.owner, gh.repo);
      if (seenKeys.has(key) || targets.length >= CI_STATUS_MAX_REPOS) continue;
      seenKeys.add(key);
      targets.push(gh);
    }

    for (const t of targets) {
      const key = repoCacheKey(t.owner, t.repo);
      const cached = ciCache[key];
      const fresh = cached && (Date.now() - Date.parse(cached.checkedAt || 0)) < CI_STATUS_CACHE_MS;
      let result = fresh ? cached : null;
      if (!result) {
        // AGENT_COMPANION_CI_STATUS_NO_GH: test/offline escape hatch, same
        // convention as AGENT_COMPANION_DISCOVERY_NO_GH above — take the "gh
        // unavailable" degrade path deterministically, with no real `gh`
        // call and no dependence on whether this machine has gh installed.
        const noGh = process.env.AGENT_COMPANION_CI_STATUS_NO_GH;
        const res = noGh
          ? { ok: false, reason: noGh === '1' ? 'gh is not installed' : String(noGh) }
          // eslint-disable-next-line no-await-in-loop
          : await checkRepoCiStatus({ owner: t.owner, repo: t.repo });
        result = res.ok
          ? { checkedAt: now, ok: true, red: res.red, workflows: res.workflows }
          : { checkedAt: now, ok: false, reason: res.reason };
        ciCache[key] = result;
      }
      if (result.ok && result.red) {
        const wfList = result.workflows
          .map((w) => `${w.name} red since ${w.redSince} (${w.latestUrl})`)
          .join('; ');
        sig('main_ci_red', `${t.owner}/${t.repo}: ${wfList}`, 'manual-check');
      }
    }
    next.ciStatusCache = ciCache;
  } catch { /* fail open: gh/network trouble here is never a reason to block the scout */ }
}

// Scrub every signal's text now that the known-public set is final.
{
  let scrub;
  try {
    const users = rawOsHandles();
    const home = homeRoot();
    const tokens = deriveTokens({
      devRoots: defaultDevRoots({ home }),
      claudeProjectsDir: join(claudeDir(), 'projects'),
      users,
      publicNames: knownPublicForScrub.flatMap((r) => [r, ...String(r).split('/')]),
    });
    scrub = makeScrubber({ users, names: tokens.names, joined: tokens.joined, publicUrls: knownPublicForScrub });
  } catch {
    // Deriving private names failed: still scrub paths/handles/URLs.
    scrub = makeScrubber({ users: rawOsHandles(), publicUrls: knownPublicForScrub });
  }
  for (const s of signals) s.detail = scrub(s.detail);
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
