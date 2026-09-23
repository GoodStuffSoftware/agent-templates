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
// generic checker (leak-scan-core.mjs: derived names/prefixes, private
// paths, machine-structure warnings) ALWAYS runs against every clone, in
// addition to the target's own script when it has one. Hits from both are
// unioned and deduped by fingerprint, so a repo with its own leak-check gets
// double coverage (its own class-1 literals PLUS this plugin's generic
// classes) and a repo with none still gets the generic classes rather than
// nothing.
//
// Zero dependencies beyond `git` on PATH and Node builtins. Every repo is
// swept independently; one repo's failure (network, missing script, bad
// path) is recorded as an error and never stops the others.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { scanRepo as coreScanRepo, ownRepoNames as coreOwnRepoNames, mainCheckoutDir as coreMainCheckoutDir } from './leak-scan-core.mjs';

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
function resolveCloneSource(entry) {
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

// Fingerprint deliberately excludes the leaked token text itself — the
// baseline that stores this is state, and a fingerprint should identify
// "this spot flagged again", not carry the leaked value around a second
// time. rel + line + label is stable across runs of the same content and
// changes if the leak moves or a different class fires at that spot.
export function fingerprintHit(repo, hit) {
  return createHash('sha256').update(`${repo}\u0000${hit.rel}\u0000${hit.line}\u0000${hit.label}`).digest('hex').slice(0, 24);
}

// hits (already fingerprinted) filtered down to ones NOT in `seen` (a Set or
// array of fingerprint strings). Pure function — no I/O — so it is usable
// identically by detect.mjs (against the real baseline) and by tests/canary
// (against a throwaway one).
export function filterNew(hits, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(seen || []);
  return hits.filter((h) => !seenSet.has(h.fingerprint));
}

// Same default dev-root formula leak-check.mjs uses, rooted at THIS
// machine/session (never the repo being scanned) — the whole point of
// running the derived-name class against a third-party repo is "does it
// contain something that looks like MY project/handle", which only makes
// sense derived from the operator's own environment.
function defaultPluginCheckerDevRoots() {
  const home = homedir();
  return [...new Set([dirname(coreMainCheckoutDir(process.cwd())), join(home, 'dev')])]
    .filter((p) => p.toLowerCase() !== home.toLowerCase());
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
// Never throws — a checker failure here should not fail the whole sweep; it
// just means this repo gets whatever the target's own script found, if any.
function runPluginChecker(cloneDir, repoEntry, { noDerived = false, tokenFile = null, devRoots, publicNames = [] } = {}) {
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
    });
    return hits.map((h) => ({
      rel: h.rel, line: h.line, label: h.label, token: h.token, text: h.text,
      fingerprint: fingerprintHit(repoEntry, h),
    }));
  } catch {
    return [];
  }
}

// Sweep ONE repo entry. Returns { repo, hits: [{rel,line,label,token,text,fingerprint}], error }.
// Always runs the plugin's OWN generic checker against the clone; ALSO runs
// the target's own scripts/leak-check.mjs when it has one (not having one is
// normal, not an error — most repos don't ship their own).
// `reduced`: pass --no-derived to both checkers (no dev root here to derive
// real project names from — the cloud routine's situation; kept as an
// option here too for a local operator who wants the same restriction).
// `env`: extra env vars merged over process.env for the CHILD leak-check
// process only (LEAK_CHECK_DEV_ROOT / LEAK_CHECK_TOKEN_FILE overrides,
// used by tests/canary; production passes none and lets the target script
// derive from THIS machine as usual).
// `tokenFile`: private token file for the PLUGIN's own checker (never the
// target repo's — that one reads its own LEAK_CHECK_TOKEN_FILE via `env`).
// `publicNames`: every OTHER repo discovery found to be public (repo name,
// owner, "owner/repo") — exempt here and forwarded to the target's own
// script via LEAK_CHECK_OWN_NAMES, so a public repo naming a sibling public
// repo is never flagged as a private-name leak by either checker.
export async function sweepRepo(repoEntry, { reduced = false, env = {}, timeout = 120000, tokenFile = null, devRoots, publicNames = [] } = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ac-pubsweep-'));
  const cloneDir = join(tmpRoot, 'repo');
  try {
    const source = resolveCloneSource(repoEntry);
    const clone = run('git', ['clone', '--quiet', '--depth', '1', source, cloneDir], { timeout });
    if (clone.status !== 0) {
      return { repo: repoEntry, hits: [], error: `clone failed: ${(clone.stderr || clone.error?.message || 'unknown error').split('\n')[0]}` };
    }
    let ownHits = [];
    const leakCheck = join(cloneDir, 'scripts', 'leak-check.mjs');
    if (existsSync(leakCheck)) {
      const args = [leakCheck, '--root', cloneDir];
      if (reduced) args.push('--no-derived');
      const childEnv = { ...process.env, ...env };
      if (publicNames.length) childEnv.LEAK_CHECK_OWN_NAMES = publicNames.join(',');
      const scan = run(process.execPath, args, { timeout, env: childEnv });
      // exit 0 = clean, 1 = hits, 2 = bad invocation (treat as error, not hits).
      if (scan.status !== 0 && scan.status !== 1) {
        return { repo: repoEntry, hits: [], error: `leak-check invocation failed (exit ${scan.status}): ${(scan.stderr || '').split('\n')[0] || 'unknown error'}` };
      }
      ownHits = parseHits(`${scan.stdout || ''}\n${scan.stderr || ''}`)
        .map((h) => ({ ...h, fingerprint: fingerprintHit(repoEntry, h) }));
    }
    const pluginHits = runPluginChecker(cloneDir, repoEntry, { noDerived: reduced, tokenFile, devRoots, publicNames });
    const hits = dedupeByFingerprint([...ownHits, ...pluginHits]);
    return { repo: repoEntry, hits, error: null };
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
export async function sweepRepoInPlace(repoEntry, cwd, { timeout = 60000 } = {}) {
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
    let ownHits = [];
    const leakCheck = join(cwd, 'scripts', 'leak-check.mjs');
    if (existsSync(leakCheck)) {
      const scan = run(process.execPath, [leakCheck, '--root', cwd, '--no-derived'], { timeout });
      if (scan.status !== 0 && scan.status !== 1) {
        return { repo: repoEntry, hits: [], error: `leak-check invocation failed (exit ${scan.status}): ${(scan.stderr || '').split('\n')[0] || 'unknown error'}` };
      }
      ownHits = parseHits(`${scan.stdout || ''}\n${scan.stderr || ''}`)
        .map((h) => ({ ...h, fingerprint: fingerprintHit(repoEntry, h) }));
    }
    // Always ALSO run the plugin's own generic checker, --no-derived (no dev
    // root in the cloud), same as sweepRepo()'s local path.
    const pluginHits = runPluginChecker(cwd, repoEntry, { noDerived: true });
    const hits = dedupeByFingerprint([...ownHits, ...pluginHits]);
    return { repo: repoEntry, hits, error: null };
  } catch (err) {
    return { repo: repoEntry, hits: [], error: err.message || String(err) };
  }
}

// Cloud entry point. Never clones: a configured repo that IS the session
// checkout (cwd) is scanned in place; any other configured repo is reported
// `skipped` with a one-line note — never fetched, never cloned.
export async function sweepAllCloud(repos, { cwd = process.cwd(), timeout } = {}) {
  const results = [];
  for (const repo of repos) {
    // eslint-disable-next-line no-await-in-loop
    if (isSessionCheckout(repo, cwd)) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await sweepRepoInPlace(repo, cwd, { timeout }));
    } else {
      results.push({
        repo, hits: [], error: null, skipped: true,
        note: 'not this cloud session\'s own checkout — the cloud sweep never clones another repo, only scans the one it already has',
      });
    }
  }
  return { results };
}
