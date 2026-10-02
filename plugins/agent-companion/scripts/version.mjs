#!/usr/bin/env node
// version.mjs — which agent-companion is running, and is every copy current?
//
// Claude Code keeps more than one copy of this plugin and they drift apart:
//   - the CLI plugin cache (~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/),
//     the copy recorded in installed_plugins.json. CLI sessions run from it.
//   - the desktop app's own copy, one per account/org:
//     <desktop data>/local-agent-mode-sessions/<acct>/<org>/rpm/plugin_<id>/
//     (the app's RemotePluginManager syncs it from claude.ai, not from the CLI
//     cache). Desktop Code-tab sessions run their hooks and skills from it.
//     When the app has none (e.g. after the plugin was disabled and re-enabled
//     in its plugin manager), desktop sessions load the CLI cache copy instead.
//   - the marketplace clone (~/.claude/plugins/marketplaces/<marketplace>/),
//     which is what `claude plugin update` installs FROM.
// On 2026-10-02 the desktop copy was 0.29.22 while the CLI copy was 0.29.24:
// desktop sessions kept the old routing and nothing said so. This script says so.
//
// Usage:
//   node version.mjs              human-readable report
//   node version.mjs --json       the same, as JSON
//   node version.mjs --remote     also read origin/main's version (gh api, else
//                                 git ls-remote for the commit); optional, time-boxed
//   node version.mjs --timeout N  per-network-call limit in ms (default 8000)
//
// Exits 0 whatever the verdict (it is a report, not a gate); 2 on a bad flag.
// The functions are exported: scripts/detect.mjs reuses them for the scout's
// `plugin_copy_stale` signal. Nothing here prints a token or a credential:
// the only secrets in reach are gh's own, which this never reads, and any
// error text from a child process is redacted before it is kept.

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  claudeDir, homeRoot, readInstalledPlugins, pluginEntries, compareVersions, versionBelow, normalizePath,
} from '../hooks/lib/context.mjs';
import { spawnSyncHidden, execFileSyncHidden } from './lib/proc.mjs';
import { cleanGitEnv } from './lib/git-env.mjs';
import { isMain } from './lib/is-main.mjs';

export const PLUGIN_NAME = 'agent-companion';
// A copy that has lagged the marketplace for longer than this is a finding
// (a release needs a while to reach every copy; the scout signal waits it out).
export const STALE_GRACE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_NET_TIMEOUT_MS = 8000;

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const isoOrNull = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const MANIFEST_REL = join('.claude-plugin', 'plugin.json');

export function readManifest(root) {
  const j = readJson(join(root, MANIFEST_REL));
  return j && typeof j === 'object' ? j : null;
}

function statMs(p) {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

// Redact anything token-shaped from text that came from a child process, and
// keep it to one short line.
export function redact(text) {
  return String(text ?? '')
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\b(authorization|bearer|token)\b[:=\s]+\S+/gi, '$1 [redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .split(/\r?\n/)[0]
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// THIS copy: the plugin directory this script runs from.
// ---------------------------------------------------------------------------

export function ownRoot() {
  return resolve(import.meta.dirname, '..');
}

// What kind of copy a directory is, from its path alone:
//   cli-cache         under <claude dir>/plugins/cache
//   desktop-rpm       a .../rpm/plugin_<id> directory of the desktop app
//   marketplace-clone under <claude dir>/plugins/marketplaces
//   checkout          inside a git work tree (a source tree, or --plugin-dir)
//   unknown           anything else
export function classifyPath(root, claudeDirPath = claudeDir()) {
  const under = (child, parent) => {
    const a = normalizePath(child);
    const b = normalizePath(parent);
    return !!a && !!b && (a === b || a.startsWith(`${b}/`));
  };
  const candidates = (p) => {
    const out = [p];
    try { out.push(realpathSync(p)); } catch { /* not resolvable: use as given */ }
    return out;
  };
  for (const c of candidates(root)) {
    if (/(^|[\\/])rpm[\\/]plugin_[^\\/]+([\\/]|$)/.test(c)) return 'desktop-rpm';
  }
  for (const base of candidates(claudeDirPath)) {
    for (const c of candidates(root)) {
      if (under(c, join(base, 'plugins', 'cache'))) return 'cli-cache';
      if (under(c, join(base, 'plugins', 'marketplaces'))) return 'marketplace-clone';
    }
  }
  try {
    let dir = resolve(root);
    for (let i = 0; i < 12; i += 1) {
      if (existsSync(join(dir, '.git'))) return 'checkout';
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fall through */ }
  return 'unknown';
}

export function thisCopy(root = ownRoot(), claudeDirPath = claudeDir()) {
  const m = readManifest(root);
  return {
    kind: classifyPath(root, claudeDirPath),
    version: (m && typeof m.version === 'string' && m.version) || null,
    path: root,
  };
}

// ---------------------------------------------------------------------------
// The CLI copy (installed_plugins.json) and the marketplace clone.
// ---------------------------------------------------------------------------

export function cliCopies(claudeDirPath = claudeDir(), name = PLUGIN_NAME) {
  const entries = pluginEntries(readInstalledPlugins(claudeDirPath), name);
  return entries.map((e) => ({
    kind: 'cli-cache',
    key: e.key,
    scope: e.scope || 'user',
    version: e.version,
    path: typeof e.installPath === 'string' ? e.installPath : null,
    gitCommitSha: typeof e.gitCommitSha === 'string' ? e.gitCommitSha : null,
    lastUpdated: typeof e.lastUpdated === 'string' ? e.lastUpdated : null,
    ...(e.projectPath ? { projectScoped: true } : {}),
  }));
}

function gitOut(args, cwd, timeout = 5000) {
  try {
    return String(execFileSyncHidden('git', args, {
      cwd, env: cleanGitEnv(), encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch { return null; }
}

// The marketplace clone's view of the plugin: its version, the commit it is
// at, and WHEN that version was published (the release commit's date, else the
// file's mtime) — the clock a copy's lag is measured from.
export function marketplaceInfo(claudeDirPath = claudeDir(), marketplace = 'agent-templates', name = PLUGIN_NAME) {
  const known = readJson(join(claudeDirPath, 'plugins', 'known_marketplaces.json')) || {};
  const rec = known[marketplace] && typeof known[marketplace] === 'object' ? known[marketplace] : null;
  const loc = (rec && typeof rec.installLocation === 'string' && rec.installLocation)
    || join(claudeDirPath, 'plugins', 'marketplaces', marketplace);
  if (!existsSync(loc)) return { marketplace, found: false };
  let pluginDir = join(loc, 'plugins', name);
  let listed = null;
  const mj = readJson(join(loc, '.claude-plugin', 'marketplace.json'));
  const ent = Array.isArray(mj?.plugins) ? mj.plugins.find((x) => x && x.name === name) : null;
  if (ent) {
    if (typeof ent.source === 'string' && ent.source.startsWith('./')) pluginDir = join(loc, ent.source);
    if (typeof ent.version === 'string') listed = ent.version;
  }
  const manifestFile = join(pluginDir, MANIFEST_REL);
  const pj = readJson(manifestFile);
  const version = (pj && typeof pj.version === 'string' && pj.version) || listed || null;
  // git is asked only about a clone that IS a repository: `git -C` on a plain
  // directory would answer for whatever repository encloses it.
  const isRepo = existsSync(join(loc, '.git'));
  const commit = isRepo ? gitOut(['rev-parse', 'HEAD'], loc) : null;
  // A shallow clone (what `claude plugin marketplace add` makes) keeps only the
  // newest commit, so its history cannot date an older release.
  const shallow = isRepo && gitOut(['rev-parse', '--is-shallow-repository'], loc) !== 'false';
  let publishedMs = null;
  let publishedFrom = null;
  const relManifest = manifestFile.slice(loc.length + 1).split(sep).join('/');
  const commitDate = isRepo ? gitOut(['log', '-1', '--format=%cI', '--', relManifest], loc) : null;
  if (commitDate && Number.isFinite(Date.parse(commitDate))) {
    publishedMs = Date.parse(commitDate);
    publishedFrom = 'release-commit';
  } else {
    const m = statMs(manifestFile);
    if (m !== null) { publishedMs = m; publishedFrom = 'file-mtime'; }
  }
  return {
    marketplace,
    found: true,
    version,
    path: loc,
    pluginDir,
    manifestRel: relManifest,
    isRepo,
    shallow,
    commit: commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit : null,
    publishedAt: isoOrNull(publishedMs),
    publishedFrom,
    lastUpdated: rec && typeof rec.lastUpdated === 'string' ? rec.lastUpdated : null,
    // Credentials a user typed into the source URL are never carried.
    sourceUrl: rec?.source && typeof rec.source.url === 'string' ? safeUrl(rec.source.url) : null,
  };
}

// A URL with any userinfo (user:password@) removed.
export function safeUrl(url) {
  const s = String(url ?? '');
  try {
    const u = new URL(s);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return s.replace(/\/\/[^/@\s]*@/, '//');
  }
}

// Release dates from the plugin's own CHANGELOG ("## 0.29.23 — 2026-10-02"):
// version -> the END of that UTC day (a day is all the file says, so the lag it
// implies is a lower bound: "at least this long"). A shallow marketplace clone
// has this file even though it has no history.
export function changelogDates(pluginDir) {
  const out = new Map();
  let text = '';
  try { text = readFileSync(join(pluginDir, 'CHANGELOG.md'), 'utf8'); } catch { return out; }
  const re = /^##\s+v?(\d+\.\d+\.\d+)\s+[—–-]+\s+(\d{4}-\d{2}-\d{2})/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = Date.parse(`${m[2]}T23:59:59Z`);
    if (Number.isFinite(t) && !out.has(m[1])) out.set(m[1], t);
  }
  return out;
}

// When a copy at `copyVersion` started to lag: the publication time of the
// OLDEST release newer than it (a copy stuck on 0.29.22 lags from 0.29.23, not
// from the latest). Three sources, best first; each returns { ms, basis }:
//   release-commit  a clone with full git history: the commit date of the oldest
//                   release commit newer than the copy (walks the commits that
//                   touched the manifest, reading the version each carried);
//   changelog       any clone, shallow or not: the date in the CHANGELOG heading
//                   of the oldest newer release (end of that UTC day, so a lower
//                   bound). A shallow clone (what `plugin marketplace add` makes)
//                   has no older commits, so this is the source that works there;
//   latest-release  the fallback: when the latest version itself was published.
// Returns { ms, basis } or null.
export function lagStart(market, copyVersion, fallbackMs = null) {
  const fallback = fallbackMs === null ? null : { ms: fallbackMs, basis: 'latest-release' };
  if (!market?.found || !market.version || !copyVersion) return fallback;
  if (market.isRepo && !market.shallow && market.manifestRel) {
    const log = gitOut(['log', '-n', '40', '--format=%H %cI', '--', market.manifestRel], market.path);
    let oldestNewer = null;
    for (const line of (log || '').split(/\r?\n/)) {
      const [hash, date] = line.trim().split(' ');
      if (!hash || !date) continue;
      const raw = gitOut(['show', `${hash}:${market.manifestRel}`], market.path);
      let v = null;
      try { v = JSON.parse(raw).version; } catch { /* unreadable at that commit */ }
      if (!v || compareVersions(v, v) === null) continue;
      if (compareVersions(v, copyVersion) === 1) {
        const t = Date.parse(date);
        if (Number.isFinite(t)) oldestNewer = t;
      } else {
        break;
      }
    }
    if (oldestNewer !== null) return { ms: oldestNewer, basis: 'release-commit' };
  }
  if (market.pluginDir) {
    let oldest = null;
    for (const [v, t] of changelogDates(market.pluginDir)) {
      if (compareVersions(v, copyVersion) === 1 && compareVersions(v, market.version) !== 1 && (oldest === null || t < oldest)) oldest = t;
    }
    if (oldest !== null) return { ms: oldest, basis: 'changelog' };
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// The desktop app's copies.
// ---------------------------------------------------------------------------

// Where the desktop app keeps local-agent-mode-sessions. With the home
// redirected (tests, a sandboxed run), never the real app data: a test (or a sandboxed run) must not
// see the operator's real desktop copies.
export function desktopSessionRoots({ env = process.env, platform = process.platform, home = homeRoot() } = {}) {
  if (env.AGENT_COMPANION_DESKTOP_DIR) return [env.AGENT_COMPANION_DESKTOP_DIR];
  const redirected = resolve(home) !== resolve(homedir());
  if (platform === 'win32') {
    const appData = (!redirected && env.APPDATA) || join(home, 'AppData', 'Roaming');
    return [join(appData, 'Claude', 'local-agent-mode-sessions')];
  }
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')];
  }
  const xdg = (!redirected && env.XDG_CONFIG_HOME) || join(home, '.config');
  return [join(xdg, 'Claude', 'local-agent-mode-sessions')];
}

function subdirs(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
}

// Every rpm/plugin_<id> directory whose manifest names `name`. The layout is
// <root>/<acct>/<org>/rpm/plugin_<id>; looked for at depth 0-2 so a layout
// change of one level does not blind it. Directories are only listed, never
// descended into past the rpm folder.
export function desktopCopies(roots = desktopSessionRoots(), name = PLUGIN_NAME) {
  const out = [];
  const rpmDirs = new Set();
  for (const root of roots) {
    const level = [root];
    for (let depth = 0; depth <= 2; depth += 1) {
      const next = [];
      for (const d of level) {
        if (existsSync(join(d, 'rpm'))) rpmDirs.add(join(d, 'rpm'));
        if (depth < 2) for (const s of subdirs(d)) if (s !== 'rpm') next.push(join(d, s));
      }
      level.splice(0, level.length, ...next);
    }
  }
  for (const rpm of [...rpmDirs].sort()) {
    for (const id of subdirs(rpm)) {
      if (!id.startsWith('plugin_')) continue;
      const p = join(rpm, id);
      const m = readManifest(p);
      if (!m || m.name !== name) continue;
      out.push({
        kind: 'desktop-rpm',
        id,
        version: typeof m.version === 'string' && m.version ? m.version : null,
        path: p,
        mtime: isoOrNull(statMs(p)),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// origin/main (optional, time-boxed).
// ---------------------------------------------------------------------------

export function ownerRepoFromUrl(url) {
  const m = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Read origin/main's plugin.json version. `gh api` first (it can read a
// private repo and returns the version itself); `git ls-remote` as a fallback
// returns only the commit, which says whether the marketplace clone is at
// origin/main but not what version origin/main holds. Never throws; every
// failure (no gh, no network, a timeout) comes back as { ok: false, error }.
// `run(cmd, args, {timeout, env})` is the seam tests use.
export function remoteInfo({
  sourceUrl, marketplaceCommit = null, timeoutMs = DEFAULT_NET_TIMEOUT_MS, env = process.env,
  run = (cmd, args, o) => spawnSyncHidden(cmd, args, { encoding: 'utf8', ...o }),
  manifestPath = `plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`,
} = {}) {
  const or = ownerRepoFromUrl(sourceUrl);
  if (!or) return { ok: false, error: 'no GitHub source url known for the marketplace' };
  const failure = (res, what) => {
    if (res.error && (res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM')) return `${what} timed out after ${timeoutMs} ms`;
    if (res.error) return `${what} could not run (${redact(res.error.code || res.error.message)})`;
    return `${what} failed${res.stderr ? `: ${redact(res.stderr)}` : ''}`;
  };
  const notes = [];
  const gh = env.AGENT_COMPANION_GH_BIN || 'gh';
  const viaGh = run(gh, [
    'api', `repos/${or.owner}/${or.repo}/contents/${manifestPath}?ref=main`,
    '-H', 'Accept: application/vnd.github.raw',
  ], { timeout: timeoutMs, env: { ...env, GH_PROMPT_DISABLED: '1' } });
  if (!viaGh.error && viaGh.status === 0) {
    let m = null;
    try { m = JSON.parse(String(viaGh.stdout)); } catch { /* not json */ }
    if (m && typeof m.version === 'string') return { ok: true, via: 'gh api', version: m.version, sha: null };
    notes.push('gh api answered with something that is not a plugin.json');
  } else {
    notes.push(failure(viaGh, 'gh api'));
  }
  const url = `https://github.com/${or.owner}/${or.repo}.git`;
  const viaGit = run('git', ['ls-remote', url, 'refs/heads/main'], {
    timeout: timeoutMs, env: { ...cleanGitEnv(env), GIT_TERMINAL_PROMPT: '0' },
  });
  if (!viaGit.error && viaGit.status === 0) {
    const sha = (/^([0-9a-f]{40,64})\s/i.exec(String(viaGit.stdout)) || [])[1] || null;
    if (sha) {
      return {
        ok: true,
        via: 'git ls-remote',
        version: null,
        sha,
        sameCommitAsMarketplace: marketplaceCommit ? sha.toLowerCase() === marketplaceCommit.toLowerCase() : null,
        note: `${notes.join('; ')}; the version is not readable without gh, only the commit`,
      };
    }
    notes.push('git ls-remote returned no main branch');
  } else {
    notes.push(failure(viaGit, 'git ls-remote'));
  }
  return { ok: false, error: notes.join('; ') };
}

// ---------------------------------------------------------------------------
// The fix, per kind of copy.
// ---------------------------------------------------------------------------

const CLI_FIX = 'run `claude plugin marketplace update agent-templates`, then `claude plugin update agent-companion@agent-templates`, then restart the session (or /reload-plugins)';
const SESSION_FIX = 'this session loaded an older copy than the one now installed: restart the session (or /reload-plugins)';
// What refreshes a desktop copy (verified 2026-10-02): the desktop app may keep
// its own copy, synced from claude.ai, which `claude plugin update` never
// touches. Disabling and re-enabling the plugin in the DESKTOP plugin manager
// removed a stuck copy (0.29.22) and desktop Code-tab sessions then loaded the
// CLI cache copy, so a later `claude plugin update` covers them. `claude plugin
// uninstall` is not the way: it wipes the plugin options. Earlier incidents
// (2026-09-12, 2026-09-24) used remove-and-re-add in the same manager.
const DESKTOP_FIX = "the desktop app keeps its own copy of this plugin and `claude plugin update` does not touch it. Fix (verified 2026-10-02): disable, then re-enable, agent-companion in the DESKTOP plugin manager (not `claude plugin uninstall`, which wipes the plugin options), then idle desktop sessions pick up the current copy on their next turn, and a session that is mid-turn picks it up after that turn; confirm with /ac version. Afterwards the desktop session runs the CLI cache copy, so a later `claude plugin update` covers it";
const DESKTOP_FIX_SHORT = 'fix: disable, then re-enable, agent-companion in the desktop plugin manager, then idle desktop sessions pick up the current copy on their next turn; confirm with /ac version';
const MARKETPLACE_FIX = 'run `claude plugin marketplace update agent-templates`';

const KIND_LABEL = {
  'cli-cache': 'CLI cache copy',
  'desktop-rpm': 'desktop copy',
  'marketplace-clone': 'marketplace clone',
  checkout: 'source checkout',
  unknown: 'copy',
};
const KIND_SESSIONS = {
  'cli-cache': 'CLI sessions',
  'desktop-rpm': 'Desktop Code-tab sessions',
};
const KIND_FIX = { 'cli-cache': CLI_FIX, 'desktop-rpm': DESKTOP_FIX };

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

// Same directory, by normalised path or by real path (a symlinked cache folder).
const sameDir = (a, b) => {
  if (!a || !b) return false;
  if (normalizePath(a) === normalizePath(b)) return true;
  try { return normalizePath(realpathSync(a)) === normalizePath(realpathSync(b)); } catch { return false; }
};

// Is there a desktop copy of its own? With none (the app never synced the
// plugin, or its stale copy was removed), desktop Code-tab sessions load the
// CLI cache copy, so there is nothing separate to go stale.
export function desktopSummary(desktop) {
  const present = desktop.length > 0;
  return { present, count: desktop.length, usesCliCache: !present };
}

// Gather everything. Options are all seams for tests; the defaults read the
// machine. `remote` runs the optional network read.
export function collect({
  root = ownRoot(),
  claudeDirPath = claudeDir(),
  desktopRoots = desktopSessionRoots(),
  remote = false,
  timeoutMs = DEFAULT_NET_TIMEOUT_MS,
  run,
  now = Date.now(),
} = {}) {
  const cli = cliCopies(claudeDirPath);
  const marketplaceName = (cli[0]?.key.split('@')[1]) || 'agent-templates';
  const market = marketplaceInfo(claudeDirPath, marketplaceName);
  const desktop = desktopCopies(desktopRoots);
  const self = thisCopy(root, claudeDirPath);
  const remoteInfoResult = remote
    ? remoteInfo({ sourceUrl: market.sourceUrl, marketplaceCommit: market.commit, timeoutMs, ...(run ? { run } : {}) })
    : null;

  // Latest = the highest version seen at the source: the marketplace clone,
  // and origin/main when it was read.
  let latest = null;
  let latestFrom = null;
  const consider = (v, from) => {
    if (!v || compareVersions(v, v) === null) return;
    if (latest === null || compareVersions(v, latest) === 1) { latest = v; latestFrom = from; }
  };
  consider(market.version, 'marketplace clone');
  consider(remoteInfoResult?.version, 'origin/main');

  // The lag clock's fallback: when the marketplace's latest version was
  // published. Only meaningful when `latest` came from the marketplace clone.
  const sinceMs = latestFrom === 'marketplace clone' && market.publishedAt ? Date.parse(market.publishedAt) : null;

  const copies = [];
  for (const c of cli) copies.push({ ...c, label: `CLI cache copy (${c.scope} scope)`, sessions: KIND_SESSIONS['cli-cache'], fix: CLI_FIX });
  for (const d of desktop) copies.push({ ...d, label: `desktop copy (${d.id})`, sessions: KIND_SESSIONS['desktop-rpm'], fix: DESKTOP_FIX });
  // THIS copy is one of the above when its path matches; mark it. Otherwise it
  // is listed on its own: a CLI cache or desktop folder that is not the
  // installed one is an OLD copy this session loaded before an update, and is
  // judged (a session that predates `claude plugin update` is exactly the case
  // where "current" would be a lie); a checkout or --plugin-dir copy is shown,
  // never judged.
  const match = copies.find((c) => sameDir(c.path, self.path));
  if (match) match.isThis = true;
  else {
    const judged = self.kind === 'cli-cache' || self.kind === 'desktop-rpm';
    copies.push({
      ...self,
      label: judged ? `this session's copy (${KIND_LABEL[self.kind]})` : `this copy (${KIND_LABEL[self.kind] || 'copy'})`,
      isThis: true,
      sessionCopy: judged,
      judged,
      sessions: judged ? 'this session' : null,
      fix: judged ? (self.kind === 'cli-cache' ? SESSION_FIX : DESKTOP_FIX) : null,
    });
  }

  for (const c of copies) {
    const judge = c.judged !== false && (c.kind === 'cli-cache' || c.kind === 'desktop-rpm');
    c.stale = !!(judge && latest && c.version && versionBelow(c.version, latest));
    if (c.stale && latestFrom === 'marketplace clone') {
      const start = lagStart(market, c.version, sinceMs);
      if (start) {
        c.behindMs = Math.max(0, now - start.ms);
        c.behindSince = isoOrNull(start.ms);
        c.behindBasis = start.basis;
      }
    }
  }

  const marketBehindRemote = !!(market.found && remoteInfoResult?.ok && remoteInfoResult.version
    && market.version && versionBelow(market.version, remoteInfoResult.version));
  // An installed copy newer than the marketplace clone: the clone is behind.
  const copyAhead = !!(market.version && copies.some((c) => c.judged !== false && (c.kind === 'cli-cache' || c.kind === 'desktop-rpm')
    && c.version && versionBelow(market.version, c.version)));

  return {
    schema: 1,
    checkedAt: new Date(now).toISOString(),
    this: self,
    cli,
    desktop,
    desktopCopy: desktopSummary(desktop),
    marketplace: market,
    remote: remoteInfoResult,
    latest: latest ? { version: latest, from: latestFrom } : null,
    marketplaceBehindRemote: marketBehindRemote,
    copies,
    verdict: verdictFor({ copies, latest, latestFrom, market, marketBehindRemote, remoteInfoResult, copyAhead }),
  };
}

export function verdictFor({ copies, latest, market, marketBehindRemote, remoteInfoResult, copyAhead = false }) {
  const stale = copies.filter((c) => c.stale);
  if (!latest) {
    return {
      ok: null,
      stale: [],
      line: market.found
        ? 'CANNOT JUDGE: the marketplace clone lists no readable plugin version'
        : 'CANNOT JUDGE: no marketplace clone found, so the latest version is unknown (try --remote)',
    };
  }
  const clause = (c) => {
    if (c.kind === 'desktop-rpm') return DESKTOP_FIX_SHORT;
    return c.sessionCopy ? 'fix: restart the session (or /reload-plugins)' : 'fix: run claude plugin update';
  };
  const parts = stale.map((c) => `${c.label} is ${c.version}, latest is ${latest} (${c.sessions ? `${c.sessions} ${c.sessionCopy ? 'runs' : 'run'} the older plugin` : 'older'}) - ${clause(c)}`);
  if (marketBehindRemote) {
    parts.push(`marketplace clone is ${market.version}, origin/main is ${remoteInfoResult.version} - fix: run claude plugin marketplace update agent-templates`);
  }
  // What the verdict rests on, when that is not the whole story. Kept out of
  // `line` so the line stays exactly "all copies current" / "STALE: ...".
  const notes = [];
  if (!remoteInfoResult) notes.push('latest is the local marketplace clone; origin/main was not checked (add --remote)');
  if (copyAhead) notes.push('an installed copy is newer than the marketplace clone, so the clone is behind: run claude plugin marketplace update agent-templates');
  const note = notes.length ? notes.join('; ') : null;
  if (!parts.length) {
    return { ok: true, stale: [], line: 'all copies current', ...(note ? { note } : {}) };
  }
  return { ok: false, stale: stale.map((c) => c.label), line: `STALE: ${parts.join('; ')}`, ...(note ? { note } : {}) };
}

// The stale CLI/desktop copies that have lagged the marketplace for longer
// than `graceMs` - the scout signal's set. Needs a lag clock: a stale copy
// with no known publication time is not returned (the caller cannot say how
// long it has lagged). THIS session's own old copy is not an installed copy:
// that is an old session, which the scout's session_outdated covers.
export function staleBeyondGrace(report, graceMs = STALE_GRACE_MS) {
  return report.copies.filter((c) => c.stale && !c.sessionCopy && typeof c.behindMs === 'number' && c.behindMs > graceMs);
}

// ---------------------------------------------------------------------------
// Text rendering.
// ---------------------------------------------------------------------------

function ago(ms) {
  if (typeof ms !== 'number') return '';
  const h = ms / 3600000;
  return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} d`;
}

const BASIS = {
  'release-commit': 'by release commit',
  'latest-release': 'since the latest release',
};

export function renderText(r) {
  const L = [];
  const flag = (c) => (c.stale ? '  <- STALE' : '');
  const self = r.copies.find((x) => x.isThis);
  L.push(`THIS copy:      ${r.this.version || '?'}  (${KIND_LABEL[r.this.kind] || r.this.kind})  ${r.this.path}${self ? flag(self) : ''}`);
  if (r.cli.length) {
    for (const c of r.cli) {
      const cp = r.copies.find((x) => x.kind === 'cli-cache' && x.key === c.key && x.path === c.path);
      L.push(`CLI cache:      ${c.version}  ${c.scope} scope  updated ${c.lastUpdated || '?'}  commit ${c.gitCommitSha ? c.gitCommitSha.slice(0, 7) : '?'}  ${c.path || ''}${cp ? flag(cp) : ''}`);
    }
  } else {
    L.push('CLI cache:      no agent-companion entry in installed_plugins.json');
  }
  if (r.desktop.length) {
    for (const d of r.desktop) {
      const cp = r.copies.find((x) => x.kind === 'desktop-rpm' && x.path === d.path);
      L.push(`Desktop copy:   ${d.version || '?'}  ${d.id}  modified ${d.mtime || '?'}  ${d.path}${cp ? flag(cp) : ''}`);
    }
  } else {
    L.push('Desktop copy:   no separate desktop copy; desktop sessions load the CLI cache copy');
  }
  const m = r.marketplace;
  L.push(m.found
    ? `Marketplace:    ${m.version || '?'}  ${m.marketplace} clone  published ${m.publishedAt || '?'}${m.commit ? `  commit ${m.commit.slice(0, 7)}` : ''}`
    : `Marketplace:    no local clone of ${m.marketplace}`);
  if (r.remote === null) L.push('origin/main:    not checked (add --remote)');
  else if (!r.remote.ok) L.push(`origin/main:    unavailable - ${r.remote.error}`);
  else if (r.remote.version) L.push(`origin/main:    ${r.remote.version}  (via ${r.remote.via})`);
  else L.push(`origin/main:    commit ${r.remote.sha.slice(0, 7)}${r.remote.sameCommitAsMarketplace === true ? ' (same as the marketplace clone)' : r.remote.sameCommitAsMarketplace === false ? ' (differs from the marketplace clone)' : ''}  (via ${r.remote.via}; version not readable)`);
  L.push(`Verdict:        ${r.verdict.line}`);
  if (r.verdict.note) L.push(`Note:           ${r.verdict.note}`);
  for (const c of r.copies.filter((x) => x.stale)) {
    let lag = '';
    if (c.behindSince && c.behindBasis === 'changelog') lag = ` [a newer release is dated ${c.behindSince.slice(0, 10)} in the CHANGELOG]`;
    else if (c.behindSince) lag = ` [behind since ${c.behindSince.slice(0, 16).replace('T', ' ')}Z, ${BASIS[c.behindBasis] || c.behindBasis}: ${ago(c.behindMs)}]`;
    L.push(`Fix (${c.kind === 'desktop-rpm' ? 'desktop' : 'CLI'}):    ${c.fix}${lag}`);
  }
  if (r.marketplaceBehindRemote) L.push(`Fix (marketplace): ${MARKETPLACE_FIX}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { json: false, remote: false, timeoutMs: DEFAULT_NET_TIMEOUT_MS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--remote') o.remote = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--timeout') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout needs a positive number of milliseconds');
      o.timeoutMs = n;
      i += 1;
    } else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

if (isMain(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`version: ${e.message}\nusage: node version.mjs [--json] [--remote] [--timeout <ms>]`);
    process.exit(2);
  }
  if (opts.help) {
    console.log('usage: node version.mjs [--json] [--remote] [--timeout <ms>]');
    process.exit(0);
  }
  const report = collect({ remote: opts.remote, timeoutMs: opts.timeoutMs });
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderText(report));
}
