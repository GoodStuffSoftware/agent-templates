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
import { userInfo } from 'node:os';
import { modelTiers, telemetryDir as resolveTelemetryDir, stateFile, claudeDir, opt, homeRoot, stateRoot } from '../hooks/lib/context.mjs';
import { syncLegacy } from '../hooks/lib/state-sync.mjs';
import { telemetryCoverage } from './lib/coverage.mjs';
import { sweepAll, sweepAllCloud, filterNewOrStale, normalizeGitUrl } from './lib/publication-sweep.mjs';
import {
  discoverViaGh, discoverOwners, discoverFromClaudeProjects, discoverLocalCheckouts,
  defaultDevRoots, parseExtraSpec, publicNameTokens, defaultCheckVisibility,
} from './lib/repo-discovery.mjs';

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
const now = new Date().toISOString();
const next = { checkedAt: now };

// Scrub local absolute paths and the real OS user handle out of signal text
// before it ever lands in a signal/notification — a git error message (e.g.
// a clone failure) or a locally-configured repo path can otherwise leak the
// operator's own machine layout into a push notification or scout-surface
// line. Applied to EVERY signal, not just publication-leak ones, since any
// detail string could in principle carry a local path.
const REAL_USER = (() => { try { return userInfo().username; } catch { return null; } })();
function scrubText(text) {
  let s = String(text ?? '');
  s = s.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+(?:[\\/][^\s"']*)?/gi, '<home>');
  s = s.replace(/\/(?:home|Users)\/[^/\s"']+(?:\/[^\s"']*)?/g, '<home>');
  if (REAL_USER && REAL_USER.length >= 3) {
    s = s.replace(new RegExp(`\\b${REAL_USER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '<user>');
  }
  return s;
}

function sig(kind, detail, dispatch) {
  signals.push({ kind, detail: scrubText(detail), dispatch });
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

// --- 8. Publication-leak sweep -----------------------------------------
// OFF BY DEFAULT (publication_leak_sweep) — this feature clones/fetches
// repos and, locally, calls the GitHub API, so it needs an explicit opt-in
// even though the sweep list itself is auto-discovered.
//
// LOCAL: auto-discovers every public repo the operator can push to (gh api,
// owned + org-member, skipping archived/forks) UNIONED with local checkouts
// under the dev root whose origin is a public GitHub repo — see
// repo-discovery.mjs. The gh LIST is cached for 24h (baseline) since it can
// span dozens of repos and gh is rate-limited; each LOCAL CHECKOUT's
// visibility is rechecked every run regardless (cheap, one call each) so a
// repo newly turned public is never delayed by the cache. publication_leak_repos
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
if (publicationSweepOn && cloud) {
  publicationRepos = parseExtraSpec(opt('publication_leak_repos', '')).include;
  publicationAllowedOwners = new Set(splitListLocal(opt('publication_leak_owners', '')).map((s) => s.toLowerCase()));
  // Default (no include list): sweep the session's own checkout, but ONLY
  // if it is actually public — no discovery needed for that, cwd's own
  // origin is right there. Never defaults to sweeping a private repo.
  if (publicationRepos.length === 0) {
    try {
      const originUrl = execSync('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8', timeout: 15000 }).trim();
      const norm = normalizeGitUrl(originUrl); // "github.com/owner/repo"
      const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(norm);
      if (m) {
        const isPublic = await defaultCheckVisibility(m[1], m[2]);
        if (isPublic === true) publicationRepos = [originUrl];
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

    // Local visibility is cheap and ALWAYS rechecked fresh (never cached) —
    // this is what guarantees a repo newly turned public is covered on the
    // very next run, not delayed by the gh-list TTL.
    //
    // PRIMARY: ~/.claude.json's `projects` map — real paths Claude Code has
    // actually worked in. AGENT_COMPANION_DISCOVERY_CLAUDE_JSON overrides the
    // path (tests point this at a synthetic fixture file; production leaves
    // it unset and gets homeRoot()/.claude.json, honouring a test fixture's
    // isolated home the same as every other resolver in this plugin).
    const claudeJsonPath = process.env.AGENT_COMPANION_DISCOVERY_CLAUDE_JSON || join(homeRoot(), '.claude.json');
    // AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY: test-only escape hatch —
    // when set, every candidate is treated as public without a real network
    // call, so a test can deterministically exercise "this repo IS public"
    // (including the newly-public signal below) offline.
    const mockVisibility = process.env.AGENT_COMPANION_DISCOVERY_MOCK_VISIBILITY === '1'
      ? async () => true
      : undefined;
    const primary = await discoverFromClaudeProjects({ claudeJsonPath, checkVisibility: mockVisibility });
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
      localRepos = await discoverLocalCheckouts({ devRoots, checkVisibility: mockVisibility });
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
if (publicationRepos.length) {
  try {
    const { results } = cloud
      ? await sweepAllCloud(publicationRepos, { cwd: process.cwd(), tokenFile: publicationTokenFile(), publicNames: publicationPublicNames })
      : await sweepAll(publicationRepos, {
        publicNames: publicationPublicNames,
        strictRepoUrls: splitListLocal(opt('publication_leak_strict_repos', '')),
        allowedOwners: publicationAllowedOwners,
        tokenFile: publicationTokenFile(),
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
      if (r.error) { errors.push(`${r.repo}: ${r.error}`); continue; }
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
    for (const r of results) if ((r.error || r.skipped) && seenByRepo[r.repo]) nextSeenByRepo[r.repo] = seenByRepo[r.repo];
    next.publicationLeakSeen = nextSeenByRepo;

    if (allNewHits.length) {
      const sample = allNewHits.slice(0, 5)
        .map((h) => `${h.repo}:${h.rel}:${h.line} [${h.label}]`).join('; ');
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
