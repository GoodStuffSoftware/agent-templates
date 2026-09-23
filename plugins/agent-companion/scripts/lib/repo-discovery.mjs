// repo-discovery.mjs — find WHICH public repos the publication-leak sweep
// should cover, so nobody has to hand-maintain a list.
//
// Two sources, unioned:
//   (a) gh — every repo the authenticated GitHub user can publish to (owned +
//       org-member), via `gh api`. Archived repos and forks are dropped: a
//       fork is normally the same content as its upstream (sweeping both
//       wastes the time/clone budget for the same hits), and an archived
//       repo cannot be pushed to again, so a leak found there cannot be
//       fixed by a push anyway — surfacing it daily would just be noise. An
//       operator who genuinely pushes original commits to a fork can still
//       cover it via the `publication_leak_repos` EXTRA list, which is never
//       filtered. Optional, on by default (attempted; degrades quietly if
//       gh is missing/unauthenticated) — catches a public repo no local
//       Claude Code session has ever opened, e.g. one only a cloud agent
//       pushes to.
//   (b) PRIMARY local source: every path in `~/.claude.json`'s `projects`
//       map — real absolute paths Claude Code itself has actually worked
//       in, not a derivation. Each candidate is resolved to a git toplevel
//       (non-repo paths, like a game install dir or a drive root, simply
//       drop out) and worktrees collapse to their main checkout via
//       --git-common-dir. Kept ONLY if origin is github.com and visibility
//       resolves to public. FALLBACK (only when ~/.claude.json is missing
//       or unparseable): walk the dev root the same way leak-check.mjs
//       derives it — see discoverLocalCheckouts()'s own header for why that
//       is the fallback and not a decode of ~/.claude/projects/<encoded>
//       directory names.
// A repo reachable by neither, with a non-GitHub remote, is never swept
// unless explicitly listed — this module has no generic way to ask an
// arbitrary git host "is this public" without a fetch.
//
// Every network/process call is INJECTABLE (exec/fetch/path functions) so
// this module is fully testable offline — see repo-discovery.test.mjs. NO
// discovered path or repo name is ever written to a committed file; results
// live only in the operator's own state root (baseline.json) or this run's
// process output.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { normalizeGitUrl } from './publication-sweep.mjs';
import { isUnsafeDevRoot } from './leak-scan-core.mjs';

function defaultExec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: opts.timeout ?? 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// --- (a) gh-based discovery --------------------------------------------------

// Returns { ok, repos: [{fullName, htmlUrl}], reason }. `ok: false` means
// gh is missing/unauthenticated/errored — the caller degrades to (b) and
// notes it (once, not daily — that's the caller's job via the baseline).
export function discoverViaGh({ exec = defaultExec, timeout = 60000 } = {}) {
  let out;
  try {
    out = exec('gh', [
      'api', '--paginate',
      'user/repos?affiliation=owner,organization_member&visibility=public&per_page=100',
      '--jq', '.[] | {full_name, archived, fork, html_url}',
    ], { timeout, windowsHide: true });
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).split('\n')[0];
    const missing = err.code === 'ENOENT' || /command not found|not recognized/i.test(msg);
    return { ok: false, repos: [], reason: missing ? 'gh is not installed' : `gh api failed: ${msg}` };
  }
  const repos = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.archived || row.fork) continue;
    if (!row.full_name) continue;
    repos.push({ fullName: row.full_name, htmlUrl: row.html_url || `https://github.com/${row.full_name}` });
  }
  return { ok: true, repos, reason: null };
}

// The authenticated user's login + every org they belong to (lowercased) —
// the trusted-owner set that gates BOTH which locally-discovered repos are
// even considered, and (in publication-sweep.mjs) whether a target repo's
// own script may ever be executed. `orgs` needs a scope gh may not have
// (fine — the login alone still narrows things); a total gh failure
// degrades to `{ ok: false, owners: [] }`, never throws.
export function discoverOwners({ exec = defaultExec } = {}) {
  let login;
  try {
    login = exec('gh', ['api', 'user', '--jq', '.login'], { windowsHide: true }).trim();
  } catch (err) {
    const msg = (err.stderr || err.message || String(err)).split('\n')[0];
    const missing = err.code === 'ENOENT' || /command not found|not recognized/i.test(msg);
    return { ok: false, owners: [], reason: missing ? 'gh is not installed' : `gh api user failed: ${msg}` };
  }
  const owners = new Set();
  if (login) owners.add(login.toLowerCase());
  try {
    const orgsOut = exec('gh', ['api', 'user/orgs', '--jq', '.[].login'], { windowsHide: true }).trim();
    for (const line of orgsOut.split(/\r?\n/)) if (line.trim()) owners.add(line.trim().toLowerCase());
  } catch { /* org membership scope may be absent — login alone is still valid */ }
  return { ok: owners.size > 0, owners: [...owners], reason: owners.size ? null : 'gh returned no usable login' };
}

// --- (b) local-checkout discovery -------------------------------------------

// Same default dev-root formula leak-check.mjs uses: the main checkout's
// parent dir, plus ~/dev — never the home dir itself.
export function defaultDevRoots({ cwd = process.cwd(), home = homedir() } = {}) {
  let mainCheckout = cwd;
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    mainCheckout = dirname(common);
  } catch { /* not a repo: fall back to cwd itself */ }
  const roots = [...new Set([dirname(mainCheckout), join(home, 'dev')])];
  // Never home, a filesystem root, a temp dir (or inside one) or a system
  // dir — a cwd directly under %TEMP% must not make all of %TEMP% a dev root.
  return roots.filter((r) => !isUnsafeDevRoot(r, home));
}

function originUrlOf(dir, exec) {
  try { return exec('git', ['-C', dir, 'remote', 'get-url', 'origin'], { windowsHide: true }).trim(); } catch { return null; }
}

// owner/repo for a github.com URL, or null for any other host.
function githubOwnerRepo(url) {
  const norm = normalizeGitUrl(url); // "github.com/owner/repo"
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(norm);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// checkVisibility(owner, repo) -> Promise<boolean|null> (null = could not
// determine, e.g. network error — treated as "skip", never as public).
// Default: the unauthenticated REST API (no token needed to READ public
// repo metadata; a private repo 404s to an anonymous caller).
export async function defaultCheckVisibility(owner, repo, { fetchFn = globalThis.fetch, timeout = 10000 } = {}) {
  if (!fetchFn) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetchFn(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agent-companion-leak-sweep' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return res.status === 404 ? false : null; // 404 to an anon caller = not visibly public
    const json = await res.json();
    return json.private === false;
  } catch {
    return null;
  }
}

// Wrap a checkVisibility function with a cache (`cache` is a plain object,
// persisted by the caller — detect.mjs keeps it in baseline.json):
//   * ONLY a PUBLIC answer (true) is cached, and reused for `ttlMs`
//     (default 24h) — a warm run makes no API call for a repo already known
//     public, which keeps an unauthenticated run under 60 requests/hour;
//   * a NOT-PUBLIC answer (false) is never cached: a repo that is not known
//     public is rechecked on EVERY run, so a repo the operator makes public
//     is swept on the very next run, not up to a day later. A false answer
//     also drops any cached true for that repo (it went private);
//   * an UNKNOWN answer (null: offline, rate-limited, API error) is never
//     cached either — it is retried next run — and is counted in
//     `stats.unknown` so the caller can say how many candidates went
//     unswept. If an expired cached true exists, it is returned instead of
//     null (a repo last seen public keeps being swept through a transient
//     outage), but the lookup still counts as unknown.
//
// Known residue (reviewed, accepted): detect.mjs caches the gh repo LIST
// itself for 24h. A repo that only gh discovery would find (no local
// checkout, not in ~/.claude.json) and that turns public inside that window
// is picked up when the list next refreshes — up to a day — not on the
// very next run. Local checkouts are unaffected (rechecked every run).
// Returns { check(owner, repo) -> Promise<boolean|null>, stats }.
export function cachedVisibility(checkFn = defaultCheckVisibility, cache = {}, { ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const stats = { unknown: 0, cached: 0, fetched: 0 };
  const check = async (owner, repo) => {
    const key = `${owner}/${repo}`.toLowerCase();
    const prev = cache[key];
    const knownPublic = !!prev && prev.public === true;
    if (knownPublic && now() - Date.parse(prev.at) < ttlMs) { stats.cached++; return true; }
    const v = await checkFn(owner, repo);
    stats.fetched++;
    if (v === true) {
      cache[key] = { public: true, at: new Date(now()).toISOString() };
      return true;
    }
    if (v === false) {
      delete cache[key]; // never cache not-public; drop a stale true
      return false;
    }
    stats.unknown++;
    return knownPublic ? true : null;
  };
  return { check, stats };
}

// --- (b) primary local source: paths Claude Code itself has worked in -----
//
// `~/.claude.json`'s top-level `projects` map is keyed by every absolute
// path Claude Code has opened as a project — real paths, not a derivation,
// and far more precise than guessing a dev root: it also includes checkouts
// outside any dev-root convention. It is NOT filtered to git repos (a game
// install dir, a drive root, anything the operator ever pointed a session
// at can appear), so every candidate is verified by actually resolving a
// git toplevel from it — a non-repo path simply drops out.
export function readClaudeJsonProjectPaths({ claudeJsonPath, existsFn = existsSync, readFn = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!claudeJsonPath || !existsFn(claudeJsonPath)) return null; // "missing" — caller falls back
  let json;
  try { json = JSON.parse(readFn(claudeJsonPath)); } catch { return null; } // "unparseable" — caller falls back
  const projects = json && typeof json === 'object' ? json.projects : null;
  if (!projects || typeof projects !== 'object') return [];
  return Object.keys(projects);
}

// Resolve a candidate path to { mainCheckout, origin } or null (not a git
// repo, or no origin). Worktrees collapse to their MAIN checkout via
// --git-common-dir, so three worktrees of the same repo dedupe to one entry.
function resolveRepoAt(candidatePath, exec) {
  let top;
  try { top = exec('git', ['-C', candidatePath, 'rev-parse', '--show-toplevel'], { windowsHide: true }).trim(); } catch { return null; }
  if (!top) return null;
  let mainCheckout = top;
  try {
    const common = exec('git', ['-C', top, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { windowsHide: true }).trim();
    mainCheckout = dirname(common);
  } catch { /* not a worktree, or git too old for --path-format: top is fine */ }
  const origin = originUrlOf(mainCheckout, exec) || originUrlOf(top, exec);
  if (!origin) return null;
  return { mainCheckout, origin };
}

// Primary local-discovery entry point. `claudeJsonPath` is REQUIRED to be
// passed explicitly by the caller (detect.mjs resolves it from homeRoot(),
// so a test fixture's isolated home is honoured); this module has no
// built-in notion of "the real machine's home" for this source, on purpose
// — a missing/undefined path always takes the fallback below, which is the
// safe default for a test that forgets to pass one.
export async function discoverFromClaudeProjects({
  claudeJsonPath, exec = defaultExec, checkVisibility = defaultCheckVisibility, existsFn = existsSync, readFn,
} = {}) {
  const paths = readClaudeJsonProjectPaths({ claudeJsonPath, existsFn, readFn });
  if (paths === null) return { ok: false, repos: [] }; // missing/unparseable: caller falls back

  const seenCheckouts = new Set();
  const found = [];
  for (const p of paths) {
    if (!existsFn(p)) continue;
    const resolved = resolveRepoAt(p, exec);
    if (!resolved) continue;
    if (seenCheckouts.has(resolved.mainCheckout)) continue;
    seenCheckouts.add(resolved.mainCheckout);
    const gh = githubOwnerRepo(resolved.origin);
    if (!gh) continue; // non-GitHub remote: not auto-discoverable
    // eslint-disable-next-line no-await-in-loop
    const isPublic = await checkVisibility(gh.owner, gh.repo);
    if (isPublic === true) {
      found.push({ fullName: `${gh.owner}/${gh.repo}`, htmlUrl: `https://github.com/${gh.owner}/${gh.repo}`, checkoutPath: resolved.mainCheckout });
    }
  }
  return { ok: true, repos: found };
}

// --- (b-fallback) dev-root walk --------------------------------------------
// Used ONLY when ~/.claude.json is missing or unparseable. Walking a dev
// root finds real checkouts directly (no lossy reconstruction needed), which
// is why this is the fallback implementation rather than decoding
// ~/.claude/projects/<encoded> directory names back into guessed paths: that
// encoding is lossy (every `:\/.` character became `-`), so "decoding" it
// can only ever produce a GUESSED path to then verify — exactly what walking
// a dev root already does, without the guessing step. Same dev-root formula
// leak-check.mjs uses (defaultDevRoots(), above).
//
// Returns [{fullName, htmlUrl, checkoutPath}]. `exec` and `checkVisibility`
// are both injectable — tests never touch the network or a real dev root.
export async function discoverLocalCheckouts({
  devRoots = defaultDevRoots(), exec = defaultExec, checkVisibility = defaultCheckVisibility,
} = {}) {
  const found = [];
  for (const root of devRoots) {
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = join(root, e.name);
      if (!existsSync(join(dir, '.git'))) continue;
      const origin = originUrlOf(dir, exec);
      if (!origin) continue;
      const gh = githubOwnerRepo(origin);
      if (!gh) continue; // non-GitHub remote: not auto-discoverable
      // eslint-disable-next-line no-await-in-loop
      const isPublic = await checkVisibility(gh.owner, gh.repo);
      if (isPublic === true) {
        found.push({ fullName: `${gh.owner}/${gh.repo}`, htmlUrl: `https://github.com/${gh.owner}/${gh.repo}`, checkoutPath: dir });
      }
    }
  }
  return found;
}

// A name that is itself PUBLIC is not a leak — the derived-name class exists
// to catch someone's REAL, otherwise-unpublished project names/handles, not
// to flag one public repo for mentioning another by name (siblings
// referencing each other in a README/CHANGELOG/wrangler.toml is completely
// normal). Turns a discovered-repo list into the flat token set the sweep's
// EXACT public-name subtraction expects: each repo's bare name, its owner,
// and the full "owner/repo". Matched by EXACT normalized equality only (see
// deriveTokens()'s `publicNames` handling in leak-scan-core.mjs) — NEVER by
// segment or prefix: a private agent-file prefix that happens to share a
// segment with a public name (e.g. both start "acme-") must stay flagged,
// not be silently exempted.
export function publicNameTokens(discovered) {
  const out = new Set();
  for (const r of discovered || []) {
    const full = r.fullName || r;
    if (!full || typeof full !== 'string') continue;
    out.add(full);
    const parts = full.split('/');
    if (parts.length === 2) { out.add(parts[0]); out.add(parts[1]); }
  }
  return [...out];
}

// --- union / dedupe / extra+exclude ----------------------------------------

// `extraSpec`: the publication_leak_repos option value — a comma/semicolon
// list where a plain entry is ADDED and a `!`-prefixed entry is EXCLUDED
// (matched by normalized URL, so `!owner/name`, a full URL, or a local path
// all work as an exclusion key).
export function parseExtraSpec(spec) {
  const include = [];
  const exclude = [];
  for (const raw of String(spec || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith('!')) exclude.push(raw.slice(1).trim());
    else include.push(raw);
  }
  return { include, exclude };
}

function toEntry(fullNameOrUrlOrPath) {
  // Discovery already deals in full GitHub identities; a plain "owner/repo"
  // from the option is expanded to an https URL so it clones like any other.
  if (/^[\w.-]+\/[\w.-]+$/.test(fullNameOrUrlOrPath) && !existsSync(fullNameOrUrlOrPath)) {
    return `https://github.com/${fullNameOrUrlOrPath}.git`;
  }
  return fullNameOrUrlOrPath;
}

// Combines gh + local discovery + the extra/exclude option into ONE deduped
// list of clone sources (what sweepRepo()/sweepAll() expect). Returns
// { repos: [url,...], discovered: [{fullName, htmlUrl, source}], ghNote }.
export async function discoverRepos({
  extraSpec = '', exec = defaultExec, checkVisibility = defaultCheckVisibility, devRoots,
} = {}) {
  const { include, exclude } = parseExtraSpec(extraSpec);
  const gh = discoverViaGh({ exec });
  const local = await discoverLocalCheckouts({ devRoots, exec, checkVisibility });

  const discovered = [];
  const seen = new Set();
  const add = (fullName, htmlUrl, source) => {
    const key = normalizeGitUrl(htmlUrl);
    if (seen.has(key)) return;
    seen.add(key);
    discovered.push({ fullName, htmlUrl, source });
  };
  if (gh.ok) for (const r of gh.repos) add(r.fullName, r.htmlUrl, 'gh');
  for (const r of local) add(r.fullName, r.htmlUrl, 'local-checkout');

  const excludeKeys = new Set(exclude.map((e) => normalizeGitUrl(toEntry(e))));
  const kept = discovered.filter((r) => !excludeKeys.has(normalizeGitUrl(r.htmlUrl)));

  const repos = kept.map((r) => r.htmlUrl);
  const extraKeys = new Set();
  for (const raw of include) {
    const entry = toEntry(raw);
    const key = normalizeGitUrl(entry);
    if (excludeKeys.has(key) || extraKeys.has(key) || seen.has(key)) continue;
    extraKeys.add(key);
    repos.push(entry);
    kept.push({ fullName: raw, htmlUrl: entry, source: 'extra' });
  }

  return {
    repos,
    discovered: kept,
    ghNote: gh.ok ? null : gh.reason,
  };
}
