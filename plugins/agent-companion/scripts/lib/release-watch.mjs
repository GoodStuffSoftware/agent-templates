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
//   - the filter: only items that mention subagents, hooks, cache,
//     compaction, effort, models, transcripts, SendMessage, worktrees,
//     workflows or plugins (the narrow patterns in TOPICS) are kept;
//   - the seen-set: a release is surfaced once. The scout reports unseen
//     releases; the SessionStart hook marks them seen when it shows the line.
//
// The scout (scripts/detect.mjs) calls runReleaseWatch(); the SessionStart hook
// (hooks/scout-surface.mjs) calls readPending() and markSeen(). Both fail open.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
// name. The patterns are narrow on purpose: a bare "agents", "plugins", "hooks",
// "cache" or "compact" matched the `claude agents` view, plugin folder caches
// and chart labels, so about four items in five did not bear on routing,
// caching, models, effort, subagents, hooks or transcripts (M, last 12
// releases at the 0.31.12 measurement).
//
// MODS_NOISE names the mods runtime and other plugin-UI items; it suppresses
// only the plugins, hooks and subagents labels, so an item about the mods
// runtime stops matching on the word "hook" or "plugin" alone.
const MODS_NOISE = /\bmods?\b|\$\.[a-z]|plugin hooks worker|\bui\.render|\bplugin panes?\b|\[Claude Tag\]|\bManage plugins\b|\bClaude apps gateway\b|\bplugin (?:validate|test|eval)\b/i;
const MODS_SUPPRESSED = new Set(['plugins', 'hooks', 'subagents']);
export const TOPICS = [
  ['subagents', /\bsub-?agents?\b|\bAgent tool\b|\bagent[_ ](?:id|type)\b|\bcustom agents?\b|\bagent definitions?\b|\bteammates?\b|\bworkflow agents?\b|\bforked? agents?\b|\bClaude Mods\b/i],
  ['hooks', /\b(?:Pre|Post)ToolUse\b|\bSessionStart\b|\bSessionEnd\b|\bSubagent(?:Start|Stop)\b|\bStop hooks?\b|\bUserPromptSubmit\b|\bPreCompact\b|\bInstructionsLoaded\b|\bPermissionRequest\b|\bTeammateIdle\b|\bCLAUDE_ENV_FILE\b|\bonFailure\b|\basyncRewake\b|\bhook output\b|\b(?:command|prompt|agent|async) hooks?\b/i],
  ['cache', /\bprompt[- ]cach(?:e|ing)\b|\bcache (?:reads?|writes?|TTL|clock)\b|\b(?:1-hour|5-minute)\b[^.]*\bcach/i],
  ['compaction', /\bauto-?compact\w*|\bautoCompactWindow\b|\bcompaction\b|\bcompacted\b|\bcompacting\b|\/compact\b/i],
  ['effort', /\beffort\b/i],
  ['models', /\bCLAUDE_CODE_[A-Z_]*MODEL\b|\bSonnet 5\.5\b|\bOpus 5\b|\bset_model\b|\bmodel switch\w*|\bfallback model\b/i],
  ['transcripts', /\bsaved transcripts?\b|\btranscript files?\b|\.jsonl\b|\bCLAUDE_CODE_TRANSCRIPT\w*|\bsubagent transcripts?\b/i],
  ['SendMessage', /\bSendMessage\b/i],
  ['worktree', /\bworktrees?\b(?=[^.]*\b(?:sub-?agents?|isolation|agents?)\b)|\b(?:sub-?agents?|isolation)\b[^.]*\bworktrees?\b/i],
  ['workflow', /\bWorkflow (?:tool|subagents?|agents?)\b/i],
  ['plugins', /\bplugins?\b(?=[^.]*\b(?:hooks?|SessionStart|subagents?|agents?|skills?|reload|hot reload|auto-?update|update|cache|CLAUDE_PLUGIN)\b)|\b(?:hooks?|agents?|skills?)\b[^.]*\bplugins?\b/i],
];

export function topicsOf(text) {
  const t = String(text || '');
  const noisy = MODS_NOISE.test(t);
  return TOPICS.filter(([label, re]) => !(noisy && MODS_SUPPRESSED.has(label)) && re.test(t)).map(([label]) => label);
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
  out.push(`Latest known: ${latest}. Checked ${checkedAt} (source: ${source}). Only changelog items that mention subagents, hooks, cache, compaction, effort, models, transcripts, SendMessage, worktrees, workflows or plugins are listed. Releases marked NEW have not been surfaced before.`);
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
// `onParsed(releases)` is optional: called once with the full parseChangelog() output (every
// item, not the topic-filtered ones) when the fetch parsed, or when the fetch failed and the
// local cache parsed; never on a network failure with nothing to parse, and never when the
// check was not due. A throw from it is swallowed.
export async function runReleaseWatch({
  installed, stateFilePath, detailsFilePath, claudeDirPath, nowMs = Date.now(), noNet = false,
  url, timeoutMs, maxBytes, fetchImpl, onParsed,
}) {
  const notify = (releases) => {
    if (typeof onParsed !== 'function') return;
    try { onParsed(releases); } catch { /* the consumer's failure is not ours */ }
  };
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
        if (r.ok) {
          parsed = parseChangelog(r.text);
          source = 'github';
          if (!parsed.length) {
            // A 200 that is not a changelog (a captive portal, an error page) is a failure.
            state.lastOk = false;
            state.lastReason = 'unreadable changelog';
          }
        }
      }
      if (parsed && parsed.length) {
        state.latest = newestVersion(parsed);
        state.installedAtCheck = inst;
        state.source = source;
        state.checkedAt = state.lastAttemptAt;
        state.releases = newerMatching(parsed, inst);
        notify(parsed);
      } else if (!state.lastOk) {
        // The fetch failed: fall back to the changelog Claude Code caches. It
        // can be old (the cache is only as fresh as the last time Claude Code
        // refreshed it), so it only ever ADDS releases to what an earlier
        // successful check stored, never removes any.
        const local = readLocalChangelog(claudeDirPath);
        const lp = local ? parseChangelog(local) : [];
        if (lp.length) notify(lp);
        const lnewer = newerMatching(lp, inst);
        if (lnewer.length) {
          const byVersion = new Map();
          for (const r of Array.isArray(state.releases) ? state.releases : []) if (r && r.version) byVersion.set(r.version, r);
          let added = false;
          for (const r of lnewer) if (!byVersion.has(r.version)) { byVersion.set(r.version, r); added = true; }
          if (added || !state.releases) {
            state.releases = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
            const lv = newestVersion(lp);
            state.latest = state.latest && compareVersions(state.latest, lv) === 1 ? state.latest : lv;
            state.installedAtCheck = inst;
            state.source = state.source ? state.source : 'local-cache';
            state.checkedAt = state.lastAttemptAt;
          }
        }
      }
      // The SessionStart hook may have marked releases seen while the request was
      // in flight; keep its marks rather than overwrite them with the older set.
      const fresh = readState(stateFilePath);
      if (Array.isArray(fresh.seen)) state.seen = [...new Set([...(Array.isArray(state.seen) ? state.seen : []), ...fresh.seen])].slice(-MAX_SEEN);
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
        detail: `Claude Code ${latest} is out; installed ${inst}. ${unseen.length} unseen release(s) newer, ${items} changelog item(s) on subagents/hooks/cache/compaction/effort/models/transcripts/SendMessage/worktree/workflow/plugins. Details: ${basename(detailsFilePath)} in the scout state dir.`,
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
