// Release watch: has Claude Code shipped releases this machine has not seen,
// and do any of their changelog items touch what this plugin steers?
//
// Why it exists. The scout noticed only that the INSTALLED version changed; it
// never looked upstream. One machine ran 13 releases behind, and nobody saw the
// features that matter to a routing plugin (per-spawn effort, a subagent
// auto-compact window, resume-cache fixes) because nothing read the changelog.
//
// Shape, from cheap to dear:
//   - the throttle: at most one network attempt per 24 hours, tracked in
//     state/release-watch.json (success or failure alike);
//   - the fetch: ONE ranged GET of the head of the public changelog (newest
//     release first), a hard 3 s budget, no child process (so no console
//     window). Offline, a bad status, a timeout: silent, nothing thrown;
//   - the fallback: the changelog Claude Code itself caches under
//     <config dir>/cache/changelog.md, read when the fetch failed;
//   - the filter: only items that mention agents/subagents, hooks, cache,
//     compaction, effort, SendMessage, worktrees, workflows, Monitor, desktop
//     or plugins are kept;
//   - the seen-set: a release is surfaced once. The scout reports unseen
//     releases; the SessionStart hook marks them seen when it shows the line.
//
// The scout (scripts/detect.mjs) calls runReleaseWatch(); the SessionStart hook
// (hooks/scout-surface.mjs) calls readPending() and markSeen(). Both fail open.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions, parseSemver } from '../../hooks/lib/context.mjs';

export const CHANGELOG_URL = 'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 3000;
// The changelog is about 1 MB, newest release first; the head covers the
// releases between "installed" and "latest" for any realistic gap.
export const FETCH_MAX_BYTES = 262144;
const MAX_RELEASES_KEPT = 40;
const MAX_ITEMS_PER_RELEASE = 30;
const MAX_ITEM_CHARS = 400;
const MAX_SEEN = 200;

// Topic label -> pattern. The label is what the details file and the hook line
// name. "Monitor" is case-sensitive on purpose: the tool is capitalised, and a
// lower-case "monitoring" in a telemetry item is not about it.
export const TOPICS = [
  ['agents', /\b(?:sub-?)?agents?\b/i],
  ['hooks', /\bhooks?\b/i],
  ['cache', /\bcach(?:e|es|ed|ing)\b/i],
  ['compaction', /\bcompact(?:s|ed|ing|ion|ions)?\b/i],
  ['effort', /\beffort\b/i],
  ['SendMessage', /\bSendMessage\b/i],
  ['worktree', /\bworktrees?\b/i],
  ['workflow', /\bworkflows?\b/i],
  ['Monitor', /\bMonitors?\b/],
  ['desktop', /\bdesktop\b/i],
  ['plugins', /\bplugins?\b/i],
];

export function topicsOf(text) {
  const t = String(text || '');
  return TOPICS.filter(([, re]) => re.test(t)).map(([label]) => label);
}

// "## 2.1.296" headers, "- item" bullets (an indented non-bullet line continues
// the previous bullet). Order is the file's: newest first.
export function parseChangelog(text) {
  const releases = [];
  let cur = null;
  let lastItem = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const h = /^##\s+v?(\d+\.\d+\.\d+)\b/.exec(raw);
    if (h) {
      cur = { version: h[1], items: [] };
      releases.push(cur);
      lastItem = null;
      continue;
    }
    if (!cur) continue;
    const b = /^[-*]\s+(.*\S)\s*$/.exec(raw);
    if (b) {
      lastItem = b[1];
      cur.items.push(lastItem);
      continue;
    }
    if (lastItem && /^\s{2,}\S/.test(raw)) {
      cur.items[cur.items.length - 1] = `${cur.items[cur.items.length - 1]} ${raw.trim()}`;
      lastItem = cur.items[cur.items.length - 1];
    }
  }
  return releases;
}

// Releases strictly newer than `installed`, with only the topic-matching items
// kept (each tagged with its topics), newest first.
export function newerMatching(releases, installed) {
  return (releases || [])
    .filter((r) => compareVersions(r.version, installed) === 1)
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, MAX_RELEASES_KEPT)
    .map((r) => ({
      version: r.version,
      items: r.items
        .map((text) => ({ text: String(text).slice(0, MAX_ITEM_CHARS), topics: topicsOf(text) }))
        .filter((i) => i.topics.length > 0)
        .slice(0, MAX_ITEMS_PER_RELEASE),
    }));
}

export function newestVersion(releases) {
  let best = null;
  for (const r of releases || []) if (!best || compareVersions(r.version, best) === 1) best = r.version;
  return best;
}

// --- state ----------------------------------------------------------------

export function readState(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* fail open: a missed write only means one more check */ }
}

// Due unless an attempt was made inside the window. A timestamp in the future
// (clock moved back) counts as due, so a bad clock cannot disable the watch.
export function checkDue(state, nowMs, intervalMs = CHECK_INTERVAL_MS) {
  const last = Date.parse(state && state.lastAttemptAt);
  if (!Number.isFinite(last)) return true;
  if (last > nowMs) return true;
  return nowMs - last >= intervalMs;
}

// --- fetch ----------------------------------------------------------------

// One GET with a hard total budget (connect and body together, via abort).
// Asks for the head of the file; a server that ignores Range and streams the
// whole body is cut off at maxBytes. Never throws.
export async function fetchChangelogHead({
  url = CHANGELOG_URL, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = FETCH_MAX_BYTES, fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'fetch unavailable' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': 'agent-companion-release-watch' },
    });
    if (!res || !res.ok) return { ok: false, reason: `http ${res ? res.status : 'none'}` };
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return { ok: true, text: String(await res.text()).slice(0, maxBytes), truncated: false };
    const dec = new TextDecoder();
    let text = '';
    let bytes = 0;
    let truncated = false;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += dec.decode(value, { stream: true });
      if (bytes >= maxBytes) { truncated = true; try { await reader.cancel(); } catch { /* closing anyway */ } break; }
    }
    // A cut body ends mid-release; the last block may be incomplete, so drop it.
    if (truncated) {
      const i = text.lastIndexOf('\n## ');
      if (i > 0) text = text.slice(0, i);
    }
    return { ok: true, text, truncated };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

export function readLocalChangelog(claudeDirPath) {
  try {
    const f = join(claudeDirPath, 'cache', 'changelog.md');
    return existsSync(f) ? readFileSync(f, 'utf8') : null;
  } catch {
    return null;
  }
}

// --- the check --------------------------------------------------------------

export function unseenOf(state, installed) {
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  return (Array.isArray(state.releases) ? state.releases : [])
    .filter((r) => r && compareVersions(r.version, installed) === 1 && !seen.has(r.version)
      && Array.isArray(r.items) && r.items.length > 0); // a release with nothing on our topics is not news
}

export function detailsMarkdown({ installed, latest, releases, seen, checkedAt, source }) {
  const seenSet = new Set(seen || []);
  const out = [];
  out.push(`# Claude Code releases newer than ${installed}`);
  out.push('');
  out.push(`Latest known: ${latest}. Checked ${checkedAt} (source: ${source}). Only changelog items that mention agents, hooks, cache, compaction, effort, SendMessage, worktrees, workflows, Monitor, desktop or plugins are listed. Releases marked NEW have not been surfaced before.`);
  for (const r of releases) {
    out.push('');
    out.push(`## ${r.version}${seenSet.has(r.version) ? '' : ' (NEW)'}`);
    if (!r.items.length) out.push('- (no matching items)');
    for (const i of r.items) out.push(`- [${i.topics.join(', ')}] ${i.text}`);
  }
  out.push('');
  return out.join('\n');
}

// What the scout calls. Returns { signal, ...} where signal is null or
// { detail, releases, items, latest }. All I/O failures are swallowed.
export async function runReleaseWatch({
  installed, stateFilePath, detailsFilePath, claudeDirPath, nowMs = Date.now(), noNet = false,
  url, timeoutMs, maxBytes, fetchImpl,
}) {
  try {
    if (!parseSemver(installed)) return { signal: null, skipped: 'installed version unreadable' };
    const inst = parseSemver(installed).join('.');
    const state = readState(stateFilePath);
    let checked = false;

    if (checkDue(state, nowMs)) {
      checked = true;
      state.lastAttemptAt = new Date(nowMs).toISOString();
      let parsed = null;
      let source = null;
      if (noNet) {
        state.lastOk = false;
        state.lastReason = 'network disabled';
      } else {
        const r = await fetchChangelogHead({ url, timeoutMs, maxBytes, fetchImpl });
        state.lastOk = !!r.ok;
        state.lastReason = r.ok ? null : r.reason;
        if (r.ok) { parsed = parseChangelog(r.text); source = 'github'; }
      }
      if (parsed && parsed.length) {
        state.latest = newestVersion(parsed);
        state.installedAtCheck = inst;
        state.source = source;
        state.checkedAt = state.lastAttemptAt;
        state.releases = newerMatching(parsed, inst);
      } else if (!state.lastOk) {
        // The fetch failed: fall back to the changelog Claude Code caches. It
        // can be old (the cache is only as fresh as the last time Claude Code
        // refreshed it), so it only ever adds releases, never removes any.
        const local = readLocalChangelog(claudeDirPath);
        const lp = local ? parseChangelog(local) : [];
        const lnewer = newerMatching(lp, inst);
        if (lnewer.length) {
          state.latest = newestVersion(lp);
          state.installedAtCheck = inst;
          state.source = 'local-cache';
          state.checkedAt = state.lastAttemptAt;
          state.releases = lnewer;
        }
      }
      writeState(stateFilePath, state);
    }

    const unseen = unseenOf(state, inst);
    if (!unseen.length) return { signal: null, checked };

    const releasesNow = (state.releases || []).filter((r) => compareVersions(r.version, inst) === 1);
    try {
      mkdirSync(dirname(detailsFilePath), { recursive: true });
      writeFileSync(detailsFilePath, detailsMarkdown({
        installed: inst, latest: state.latest || unseen[0].version, releases: releasesNow, seen: state.seen,
        checkedAt: state.checkedAt || new Date(nowMs).toISOString(), source: state.source || 'unknown',
      }));
    } catch { /* the signal still goes out; the hook line names the path regardless */ }

    const items = unseen.reduce((n, r) => n + r.items.length, 0);
    const latest = state.latest || unseen[0].version;
    return {
      checked,
      signal: {
        latest, releases: unseen.length, items,
        detail: `Claude Code ${latest} is out; installed ${inst}. ${unseen.length} unseen release(s) newer, ${items} changelog item(s) on agents/hooks/cache/compaction/effort/SendMessage/worktree/workflow/Monitor/desktop/plugins. Details: ${detailsFilePath}`,
      },
    };
  } catch {
    return { signal: null, skipped: 'error' };
  }
}

// --- the hook's side ---------------------------------------------------------

// Unseen newer releases for the SessionStart line, or null. `runningVersion` is
// the newest version the scout last saw installed (baseline.json), used only to
// drop the line once the machine has caught up. Reads one small file.
export function readPending(stateFilePath, runningVersion) {
  try {
    const state = readState(stateFilePath);
    // The higher of what the check ran against and what the scout last saw
    // installed: upgrading drops the line, and nothing ever lowers the floor.
    const cands = [state.installedAtCheck, runningVersion].filter((v) => parseSemver(v)).map((v) => parseSemver(v).join('.'));
    if (!cands.length) return null;
    const inst = cands.reduce((m, v) => (compareVersions(v, m) === 1 ? v : m));
    const unseen = unseenOf(state, inst);
    if (!unseen.length) return null;
    const items = unseen.reduce((n, r) => n + r.items.length, 0);
    return {
      installed: inst, latest: state.latest || unseen[0].version,
      versions: unseen.map((r) => r.version), releases: unseen.length, items,
    };
  } catch {
    return null;
  }
}

// Marks versions surfaced. Read-modify-write on a tiny file; two sessions
// starting together can at worst both show the line once.
export function markSeen(stateFilePath, versions) {
  try {
    const state = readState(stateFilePath);
    const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
    for (const v of versions) seen.add(v);
    state.seen = [...seen].slice(-MAX_SEEN);
    writeState(stateFilePath, state);
  } catch { /* fail open */ }
}
