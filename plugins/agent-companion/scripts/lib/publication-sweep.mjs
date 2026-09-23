// Publication-leak sweep — the scout's after-the-fact backstop.
//
// A pre-push gate (or a person) is supposed to catch a real-name leak before
// it reaches origin. This sweep assumes that sometimes fails, and checks what
// is actually PUBLISHED: it fetches each configured repo's default branch AS
// IT SITS ON ORIGIN (never the local working tree, which may hold an
// unpushed fix or an unpushed leak that doesn't matter yet) into a throwaway
// clone, then runs THAT repo's OWN scripts/leak-check.mjs against it — not
// this plugin's copy, because the point is to sweep what a reader of the
// published repo would see, with whatever guard version that repo actually
// ships.
//
// Most swept repos have NO leak-check of their own — this plugin's own
// generic checker (leak-scan-core.mjs) ALWAYS runs against every clone, in
// addition to the target's own script when it has one. Hits from both are
// unioned and deduped by fingerprint.
//
// STRICT vs UNIVERSAL classes (measured on 8 real repos: ~90% of hits were
// exactly this false-positive shape). Derived project names/prefixes and
// git-sha-like only matter for a repo whose whole PURPOSE is to be
// anonymous/generic (agent-templates itself) — an ordinary product repo
// legitimately names the operator's own product everywhere, in its own
// README, CHANGELOG, wrangler.toml, etc. So those two classes are OPT-IN
// per repo (`isStrictRepo()` below); every other repo gets only the
// UNIVERSAL classes: private paths (every shape), the OS user handle, and
// the operator's private token file if present — see leak-scan-core.mjs's
// scanRepo() for how that split is implemented.
//
// Zero dependencies beyond `git` on PATH and Node builtins. Every repo is
// swept independently; one repo's failure (network, missing script, bad
// path) is recorded as an error and never stops the others.

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir, userInfo } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import {
  scanRepo as coreScanRepo, ownRepoNames as coreOwnRepoNames, mainCheckoutDir as coreMainCheckoutDir,
  isUnsafeDevRoot,
} from './leak-scan-core.mjs';

// A repo opts into the strict (derived-name/prefix + git-sha-like) CLASS
// GATING by shipping its own scripts/leak-check.mjs, carrying this marker
// file, or being explicitly listed (publication_leak_strict_repos). This is
// pure file-existence detection — it NEVER executes anything. Whether the
// target's own script is actually RUN is a separate, narrower decision —
// see mayExecuteTargetScript() below.
export const STRICT_MARKER_FILE = '.leak-check-strict';

export function isStrictRepo(cloneDir, repoEntry, strictRepoUrls = []) {
  if (existsSync(join(cloneDir, 'scripts', 'leak-check.mjs'))) return true;
  if (existsSync(join(cloneDir, STRICT_MARKER_FILE))) return true;
  const key = normalizeGitUrl(repoEntry);
  return strictRepoUrls.some((s) => normalizeGitUrl(s) === key);
}

// The GitHub owner of a clone source, or null. ONLY a github.com URL has an
// owner here: a local path, a bare repo, or any other host has none — its
// directory name says nothing about who controls the code in it (a checkout
// under a dir that happens to be named like a trusted owner can have any
// stranger's repo as its origin).
export function ownerOf(source) {
  const m = /^github\.com\/([^/]+)\/[^/]+$/.exec(normalizeGitUrl(source));
  return m ? m[1].toLowerCase() : null;
}

// Never execute code from a swept repo by default. A target's own
// scripts/leak-check.mjs only runs when BOTH:
//   1. the repo is EXPLICITLY listed in publication_leak_strict_repos (NOT
//      merely auto-detected as strict via its own file/marker — an
//      operator has to have named it), AND
//   2. the source it is ACTUALLY cloned from (`resolvedSource`: a local
//      entry's real origin URL, see resolveCloneSource()) is a github.com
//      repo whose owner is the authenticated user or one of their orgs
//      (`allowedOwners`). The configured text is never trusted for this —
//      only the URL the code really comes from.
// This listing + verified-owner gate IS the protection. The child's
// environment is scrubbed and its HOME points at an empty temp dir (see
// sweepRepo()), but that is hygiene, not a sandbox: the script runs as the
// operator and can still read any file the operator can, credential files
// under the real home included.
export function mayExecuteTargetScript(repoEntry, { strictRepoUrls = [], allowedOwners, resolvedSource } = {}) {
  const source = resolvedSource ?? resolveCloneSource(repoEntry);
  const keys = new Set([normalizeGitUrl(repoEntry), normalizeGitUrl(source)]);
  const explicitlyListed = strictRepoUrls.some((s) => keys.has(normalizeGitUrl(s)));
  if (!explicitlyListed) return false;
  if (!allowedOwners || allowedOwners.size === 0) return false; // no verified owner set: safe default is never
  const owner = ownerOf(source);
  return !!owner && allowedOwners.has(owner);
}

// Minimal environment for executing a target repo's own script —
// PATH/TEMP/SYSTEMROOT-shaped vars and LEAK_CHECK_* only. No tokens, no
// operator-specific env carried over from this process. HOME/USERPROFILE are
// listed so a caller can see them here, but sweepRepo() overrides both with
// an empty temp dir. None of this stops the script from reading files by
// absolute path — see mayExecuteTargetScript() for what actually protects.
const MINIMAL_ENV_KEYS = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot', 'ComSpec', 'windir'];
export function scrubbedEnv(extra = {}) {
  const env = {};
  for (const k of MINIMAL_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  for (const [k, v] of Object.entries(extra)) if (k.startsWith('LEAK_CHECK_')) env[k] = v;
  return env;
}

// The operator's raw OS handle(s) — what leak-check.mjs would derive for
// itself from the real home, handed to a child whose HOME is a temp dir.
function rawOsHandles() {
  const out = [];
  try { out.push(userInfo().username); } catch { /* no passwd entry */ }
  for (const k of ['USERNAME', 'USER']) if (process.env[k]) out.push(process.env[k]);
  out.push(basename(homedir()));
  return [...new Set(out.filter(Boolean))];
}

// Interpret a target leak-check run. exit 0 = clean, 1 = hits, 2 = bad
// invocation — but a script that CRASHES also exits 1 (Node's uncaught
// exception code), so exit status alone cannot tell "found leaks" from "died
// before scanning anything". A run counts only with its closing summary
// line (`leak-check: OK` / `leak-check: FAILED`) or at least one parsed hit;
// anything else is an error, never a clean result.
export function interpretTargetScan(scan) {
  const out = `${scan.stdout || ''}\n${scan.stderr || ''}`;
  const firstErr = (scan.stderr || '').split(/\r?\n/).find((l) => l.trim()) || scan.error?.message || 'no output';
  if (scan.status !== 0 && scan.status !== 1) {
    return { hits: [], error: `target leak-check invocation failed (exit ${scan.status ?? scan.signal ?? 'none'}): ${firstErr}` };
  }
  const hits = parseHits(out);
  if (scan.status === 0 && !/^leak-check: OK\b/m.test(out)) {
    return { hits, error: `target leak-check exited 0 without its closing "leak-check: OK" line: ${firstErr}` };
  }
  if (scan.status === 1 && hits.length === 0) {
    // FAILED with nothing parseable is just as unusable as a crash: the
    // findings exist but cannot be reported, so it must not read as clean.
    return {
      hits: [],
      error: /^leak-check: FAILED\b/m.test(out)
        ? 'target leak-check reported FAILED but no hit line could be parsed'
        : `target leak-check exited 1 with no "leak-check: FAILED" summary and no parsed hit — it crashed: ${firstErr}`,
    };
  }
  return { hits, error: null };
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 60000,
    ...opts,
  });
}

// A repo entry is either a local path to a checkout (which must have an
// `origin` remote — we read ITS url so we clone from the real origin, never
// from the possibly-ahead-of-origin local branch) or a git URL / local bare
// repo path used directly as the clone source.
export function resolveCloneSource(entry) {
  const looksLocal = existsSync(entry);
  if (looksLocal && statSync(entry).isDirectory()) {
    const originUrl = run('git', ['-C', entry, 'remote', 'get-url', 'origin']);
    if (originUrl.status === 0 && originUrl.stdout.trim()) {
      return originUrl.stdout.trim();
    }
    // No origin remote readable (e.g. the path IS a bare "origin" itself, as
    // in the canary): use the path directly as the clone source.
    return entry;
  }
  return entry; // a URL (https://, git@, ssh://, …)
}

// Parse leak-check's human-readable hit lines. Exact format, from
// scripts/leak-check.mjs: `  ${rel}:${line}  [${label}]  ${token}  ::  ${text}`
const HIT_RE = /^ {2}(\S.*?):(\d+) {2}\[([^\]]+)\] {2}(.*?) {2}:: {2}(.*)$/;

function parseHits(output) {
  const hits = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const m = HIT_RE.exec(rawLine);
    if (!m) continue;
    const [, rel, line, label, token, text] = m;
    hits.push({ rel, line: Number(line), label, token, text });
  }
  return hits;
}

// Fingerprint = HMAC(key, repo + file + label + token + occurrence) —
// deliberately NOT the line number, so a hit that merely SHIFTED LINE (an
// unrelated edit earlier in the file) still dedupes against its prior
// acceptance instead of firing again as "new".
//
// KEYED, not a bare hash: the baseline that stores fingerprints is state on
// disk, and an unkeyed sha256 of (repo, file, label, token) can be confirmed
// by anyone holding the baseline and a candidate list of names ("is
// <name> in this repo's accepted hits?"). The key is a per-machine random
// secret — loadFingerprintKey() creates it once in the state dir. Callers
// that pass no key (tests, the canary) get a per-PROCESS random key:
// stable within one run, never persisted.
//
// `occurrence` (0, 1, 2 … — the Nth hit of the same file+label+token, in
// line order): a SECOND occurrence of an already-accepted token in the same
// file is a distinct fingerprint, so it fires as new instead of silently
// riding on the first one's acceptance. Line shifts keep the ordinal stable;
// if a new copy lands ABOVE the accepted one, the ordinals swap and exactly
// one hit (the count went up by one) fires — the right number either way.
const PROCESS_FINGERPRINT_KEY = randomBytes(32);
export function fingerprintHit(repo, hit, { key = PROCESS_FINGERPRINT_KEY, occurrence = 0 } = {}) {
  return createHmac('sha256', key)
    .update(`${repo}\u0000${hit.rel}\u0000${hit.label}\u0000${String(hit.token || '')}\u0000${occurrence}`)
    .digest('hex').slice(0, 24);
}

// Fingerprint a hit list, numbering repeat occurrences per file+label+token
// in line order (see fingerprintHit()).
export function fingerprintHits(repo, hits, { key } = {}) {
  const order = hits.map((h, i) => ({ h, i })).sort((a, b) => (a.h.rel < b.h.rel ? -1 : a.h.rel > b.h.rel ? 1 : a.h.line - b.h.line || a.i - b.i));
  const seen = new Map();
  const out = new Array(hits.length);
  for (const { h, i } of order) {
    const k = `${h.rel}\u0000${h.label}\u0000${h.token}`;
    const occurrence = seen.get(k) || 0;
    seen.set(k, occurrence + 1);
    out[i] = { ...h, fingerprint: fingerprintHit(repo, h, { key, occurrence }) };
  }
  return out;
}

// The per-machine fingerprint key: `<dir>/leak-fingerprint.key` (64 hex
// chars), created with owner-only permissions on first use.
export function loadFingerprintKey(dir) {
  const file = join(dir, 'leak-fingerprint.key');
  try {
    const hex = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* first use */ }
  const key = randomBytes(32);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, key.toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch {
    // Lost a creation race (or the file exists but is malformed): use
    // whatever is on disk if valid, so two runs never disagree.
    const hex = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
    throw new Error(`fingerprint key file ${file} is malformed; delete it to regenerate`);
  }
  return key;
}

// hits (already fingerprinted) filtered down to ones NOT in `seen` (a Set or
// array of fingerprint strings). Pure function — no I/O — so it is usable
// identically by detect.mjs (against the real baseline) and by tests/canary
// (against a throwaway one).
export function filterNew(hits, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(seen || []);
  return hits.filter((h) => !seenSet.has(h.fingerprint));
}

// Weekly re-fire (default 7 days): a hit is treated as "new" again if either
// it was never seen, OR the baseline's record of it is older than
// `maxAgeDays`. This bounds how long a missed/dismissed notification can
// stay permanently silent — an accepted finding gets re-surfaced at most
// once a week, not never again. `seenMap` is `{ fingerprint: lastSeenISO }`
// (not a flat array/Set — it needs the timestamp). Returns the hits to
// treat as new/re-fired; the caller is expected to refresh `seenMap[fp]` to
// "now" for every hit reported this run (new, re-fired, or unchanged),
// which is what makes the 7-day clock restart on each sighting.
export function filterNewOrStale(hits, seenMap, { maxAgeDays = 7, now = Date.now() } = {}) {
  const map = seenMap || {};
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return hits.filter((h) => {
    const lastSeen = map[h.fingerprint];
    if (!lastSeen) return true; // never seen: new
    const age = now - Date.parse(lastSeen);
    return !Number.isFinite(age) || age >= maxAgeMs; // stale record: re-fire
  });
}

// Same default dev-root formula leak-check.mjs uses, rooted at THIS
// machine/session (never the repo being scanned) — the whole point of
// running the derived-name class against a third-party repo is "does it
// contain something that looks like MY project/handle", which only makes
// sense derived from the operator's own environment.
function defaultPluginCheckerDevRoots() {
  const home = homedir();
  return [...new Set([dirname(coreMainCheckoutDir(process.cwd())), join(home, 'dev')])]
    .filter((p) => !isUnsafeDevRoot(p, home));
}

// Dedupe hits that fingerprint identically (the target's own leak-check and
// this plugin's generic checker both flagging the exact same spot).
function dedupeByFingerprint(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.fingerprint)) continue;
    seen.add(h.fingerprint);
    out.push(h);
  }
  return out;
}

// Run the PLUGIN's own generic checker (leak-scan-core.mjs) against a clone.
// Returns { hits, error }. A checker EXCEPTION is reported as `error` — it
// must never read as "clean": a repo whose checker crashed and one that is
// genuinely spotless are different outcomes, and collapsing them into an
// empty hit list would hide the failure from the operator entirely.
function runPluginChecker(cloneDir, repoEntry, {
  noDerived = false, tokenFile = null, devRoots, publicNames = [], strict = false, fingerprintKey,
} = {}) {
  try {
    const { hits } = coreScanRepo({
      root: cloneDir,
      devRoots: devRoots || defaultPluginCheckerDevRoots(),
      tokenFile,
      // Every discovered-PUBLIC name is exempt here too, same as the
      // clone's own name — a public repo mentioning another public repo by
      // name is not a leak (see repo-discovery.mjs's publicNameTokens()).
      ownNames: [...new Set([...coreOwnRepoNames(cloneDir), ...publicNames])],
      noDerived,
      strict,
    });
    const plain = hits.map((h) => ({ rel: h.rel, line: h.line, label: h.label, token: h.token, text: h.text }));
    return { hits: fingerprintHits(repoEntry, plain, { key: fingerprintKey }), error: null };
  } catch (err) {
    return { hits: [], error: err.message || String(err) };
  }
}

// Sweep ONE repo entry. Returns { repo, hits: [{rel,line,label,token,text,fingerprint}], error, strict }.
// ALWAYS runs the plugin's OWN generic checker against the clone — this is
// the only checker that runs by default.
//
// The target's OWN scripts/leak-check.mjs is NEVER executed unless
// `mayExecuteTargetScript()` says so: the repo must be EXPLICITLY listed in
// `strictRepoUrls` (publication_leak_strict_repos) AND the source it is
// really cloned from must be a github.com repo owned by the authenticated
// user or one of their orgs (`allowedOwners`). That gate is the protection.
// When it passes, the script runs with a scrubbed env and HOME/USERPROFILE
// pointed at an empty temp dir — hygiene against a script that reads "~"
// naively, NOT a sandbox (it still runs as the operator and can read any
// file by absolute path). The operator's real dev roots, projects dir and
// OS handle are handed over explicitly via LEAK_CHECK_*, so the derived-name
// coverage is the same as a run under the real HOME.
//
// `isStrictRepo` (own script present / marker file / listed) only decides
// CLASS GATING — whether the plugin checker's derived-name/prefix +
// git-sha-like classes apply — and is pure file-existence detection, never
// execution.
//
// `reduced`: pass --no-derived to the plugin checker (no dev root here to
// derive real project names from — the cloud routine's situation; kept as
// an option here too for a local operator who wants the same restriction).
// `tokenFile`: private token file for the PLUGIN's own checker.
// `publicNames`: every OTHER repo discovery found to be public — exempt via
// the plugin checker's exact-name subtraction (see leak-scan-core.mjs).
// `fingerprintKey`: the per-machine HMAC key (see fingerprintHit()).
export async function sweepRepo(repoEntry, {
  reduced = false, timeout = 120000, tokenFile = null, devRoots, publicNames = [],
  strictRepoUrls = [], allowedOwners, env = {}, fingerprintKey,
} = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-pubsweep-'));
  const cloneDir = join(tmpRoot, 'repo');
  try {
    const source = resolveCloneSource(repoEntry);
    // `--` before the positional args: `source` is caller/config-derived
    // (a repo URL or path from an option), so it must never be interpretable
    // as a git flag (e.g. an entry starting with "--upload-pack=...").
    const clone = run('git', ['clone', '--quiet', '--depth', '1', '--', source, cloneDir], { timeout });
    if (clone.status !== 0) {
      return { repo: repoEntry, hits: [], error: `clone failed: ${(clone.stderr || clone.error?.message || 'unknown error').split('\n')[0]}` };
    }
    const strict = isStrictRepo(cloneDir, repoEntry, strictRepoUrls);
    const mayExecute = mayExecuteTargetScript(repoEntry, { strictRepoUrls, allowedOwners, resolvedSource: source });

    let ownHits = [];
    let ownError = null;
    const leakCheck = join(cloneDir, 'scripts', 'leak-check.mjs');
    if (mayExecute && existsSync(leakCheck)) {
      const args = [leakCheck, '--root', cloneDir];
      if (reduced) args.push('--no-derived');
      const childHome = join(tmpRoot, 'home');
      mkdirSync(childHome, { recursive: true });
      const leakCheckEnv = {
        LEAK_CHECK_DEV_ROOT: (devRoots || defaultPluginCheckerDevRoots()).join(','),
        LEAK_CHECK_CLAUDE_PROJECTS: join(homedir(), '.claude', 'projects'),
        LEAK_CHECK_USER: rawOsHandles().join(','),
        // Only LEAK_CHECK_* keys from `env` survive scrubbing (test/canary
        // use this to point at an isolated fixture — never a way to pass
        // arbitrary env through to the target script).
        ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('LEAK_CHECK_'))),
      };
      if (publicNames.length) leakCheckEnv.LEAK_CHECK_OWN_NAMES = publicNames.join(',');
      const childEnv = { ...scrubbedEnv(leakCheckEnv), HOME: childHome, USERPROFILE: childHome };
      const scan = run(process.execPath, args, { timeout, env: childEnv });
      // A failed/crashed target run is recorded as an error but does NOT
      // stop the plugin checker below — one checker failing must never
      // suppress the other's coverage.
      const own = interpretTargetScan(scan);
      ownError = own.error;
      ownHits = fingerprintHits(repoEntry, own.hits, { key: fingerprintKey });
    }
    const plugin = runPluginChecker(cloneDir, repoEntry, { noDerived: reduced, tokenFile, devRoots, publicNames, strict, fingerprintKey });
    if (plugin.error) {
      // The plugin checker is the one that ALWAYS runs — its failure must
      // never read as "repo is clean". Report it and stop; ownHits (if any)
      // are still real findings and are included.
      const combinedError = [ownError, `plugin checker crashed: ${plugin.error}`].filter(Boolean).join('; ');
      return { repo: repoEntry, hits: dedupeByFingerprint(ownHits), error: combinedError, strict };
    }
    const hits = dedupeByFingerprint([...ownHits, ...plugin.hits]);
    return { repo: repoEntry, hits, error: ownError, strict };
  } catch (err) {
    return { repo: repoEntry, hits: [], error: err.message || String(err) };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort cleanup */ }
  }
}

// Sweep every configured repo. Returns { results: [sweepRepo() result, …] }.
// Never throws — a bad entry becomes that entry's `.error`, and the caller
// decides what a non-empty error list means (detect.mjs turns it into its
// own signal; the canary turns it into a hard failure).
export async function sweepAll(repos, opts = {}) {
  const results = [];
  for (const repo of repos) {
    // Sequential on purpose: this runs once a day from a scout, not a hot
    // path, and sequential clones are far easier to reason about (and to
    // bound with a single overall timeout budget) than parallel ones.
    // eslint-disable-next-line no-await-in-loop
    results.push(await sweepRepo(repo, opts));
  }
  return { results };
}

// --- Cloud path: scan the SESSION'S OWN CHECKOUT in place, never clone ----
//
// A claude.ai cloud routine already runs from a fresh checkout of one repo
// (its `source: git_repository`) — that IS the cwd. Cloning a SECOND copy of
// that same repo into a temp dir and executing a script from it is exactly
// the "code from external" shape the harness's cloud classifier denies, even
// though the source is the repo's own origin. There is no reason to clone at
// all here: the checkout already sits on disk, already at the commit the
// session started from. So the cloud sweep never calls sweepRepo(); it scans
// the checkout directory directly, and only for the ONE configured repo
// entry that actually names this checkout — any other configured repo is a
// DIFFERENT repo the cloud sandbox does not have on disk, and the cloud path
// does not fetch it (that would be exactly the clone the classifier denies).
// It is reported as skipped, not swept, and does not fire daily.

// git@host:owner/repo(.git) | ssh://git@host/owner/repo(.git) | https://host/owner/repo(.git)
// all normalize to "host/owner/repo" (lowercase, no .git, no trailing slash),
// so the same repo configured either way compares equal.
export function normalizeGitUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  u = u.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u); // git@host:owner/repo
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  u = u.replace(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?/i, ''); // strip scheme://[user@]
  return u.toLowerCase();
}

function originUrlOf(dir) {
  const r = run('git', ['-C', dir, 'remote', 'get-url', 'origin']);
  return r.status === 0 ? r.stdout.trim() : null;
}

// Does `repoEntry` (a configured path or URL) identify the SAME repo as the
// git checkout at `cwd`? Compared by normalized origin URL, so a local path,
// an ssh URL and an https URL for the same repo all match.
export function isSessionCheckout(repoEntry, cwd) {
  const cwdOrigin = originUrlOf(cwd);
  if (!cwdOrigin) return false;
  const target = cwdOrigin;
  const looksLocal = existsSync(repoEntry) && statSync(repoEntry).isDirectory();
  const candidate = looksLocal ? (originUrlOf(repoEntry) || repoEntry) : repoEntry;
  return normalizeGitUrl(candidate) === normalizeGitUrl(target) || normalizeGitUrl(repoEntry) === normalizeGitUrl(target);
}

// Scan `cwd` (the session's own checkout) in place. Always reduced
// (--no-derived): a fresh cloud sandbox has no dev root to derive real
// project names from, so that class is not runnable here regardless.
// Refuses to scan if HEAD does not match origin's default branch after a
// fetch — that would mean scanning something not actually published (a
// mid-run rebase, a detached commit, a shallow oddity), which is worse than
// reporting nothing this run.
export async function sweepRepoInPlace(repoEntry, cwd, { timeout = 60000, tokenFile = null, publicNames = [], fingerprintKey } = {}) {
  try {
    const fetch = run('git', ['-C', cwd, 'fetch', '--quiet', 'origin'], { timeout });
    if (fetch.status !== 0) {
      return { repo: repoEntry, hits: [], error: `git fetch origin failed: ${(fetch.stderr || fetch.error?.message || 'unknown error').split('\n')[0]}` };
    }
    let defaultBranch = null;
    const symref = run('git', ['-C', cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (symref.status === 0) defaultBranch = symref.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (!defaultBranch) {
      const ls = run('git', ['-C', cwd, 'ls-remote', '--symref', 'origin', 'HEAD'], { timeout });
      const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(ls.stdout || '');
      defaultBranch = m ? m[1] : null;
    }
    if (!defaultBranch) return { repo: repoEntry, hits: [], error: 'could not resolve origin default branch' };
    const head = run('git', ['-C', cwd, 'rev-parse', 'HEAD']).stdout.trim();
    const originHead = run('git', ['-C', cwd, 'rev-parse', `origin/${defaultBranch}`]).stdout.trim();
    if (!head || !originHead || head !== originHead) {
      return {
        repo: repoEntry,
        hits: [],
        error: `checkout HEAD (${head ? head.slice(0, 10) : '?'}) does not match origin/${defaultBranch} `
          + `(${originHead ? originHead.slice(0, 10) : '?'}) — sweep skipped rather than scan something unpublished`,
      };
    }
    // The cloud path never clones a third-party repo (sweepAllCloud only
    // ever scans the session's OWN checkout in place — see its header), so
    // the owner-gating item 2 requires for a CLONE never applies here: this
    // is inherently the operator's own repo already. Its own script (if
    // any) still runs, same as before.
    let ownHits = [];
    let ownError = null;
    const leakCheck = join(cwd, 'scripts', 'leak-check.mjs');
    if (existsSync(leakCheck)) {
      const scan = run(process.execPath, [leakCheck, '--root', cwd, '--no-derived'], { timeout });
      // Same rule as sweepRepo(): no summary line and no parsed hit = the
      // script crashed, which is an error, never "clean plus plugin hits".
      const own = interpretTargetScan(scan);
      ownError = own.error;
      ownHits = fingerprintHits(repoEntry, own.hits, { key: fingerprintKey });
    }
    // Always ALSO run the plugin's own generic checker, --no-derived (no dev
    // root in the cloud), same as sweepRepo()'s local path. Its failure must
    // never read as clean (item 6) — report it rather than swallow it.
    const plugin = runPluginChecker(cwd, repoEntry, { noDerived: true, tokenFile, publicNames, fingerprintKey });
    if (plugin.error) {
      const combinedError = [ownError, `plugin checker crashed: ${plugin.error}`].filter(Boolean).join('; ');
      return { repo: repoEntry, hits: dedupeByFingerprint(ownHits), error: combinedError };
    }
    const hits = dedupeByFingerprint([...ownHits, ...plugin.hits]);
    return { repo: repoEntry, hits, error: ownError };
  } catch (err) {
    return { repo: repoEntry, hits: [], error: err.message || String(err) };
  }
}

// Cloud entry point. Never clones: a configured repo that IS the session
// checkout (cwd) is scanned in place; any other configured repo is reported
// `skipped` with a one-line note — never fetched, never cloned.
export async function sweepAllCloud(repos, { cwd = process.cwd(), timeout, tokenFile = null, publicNames = [], fingerprintKey } = {}) {
  const results = [];
  for (const repo of repos) {
    // eslint-disable-next-line no-await-in-loop
    if (isSessionCheckout(repo, cwd)) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await sweepRepoInPlace(repo, cwd, { timeout, tokenFile, publicNames, fingerprintKey }));
    } else {
      results.push({
        repo, hits: [], error: null, skipped: true,
        note: 'not this cloud session\'s own checkout — the cloud sweep never clones another repo, only scans the one it already has',
      });
    }
  }
  return { results };
}
