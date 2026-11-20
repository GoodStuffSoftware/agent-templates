// usage/efficiency.mjs: the efficiency sections of the daily usage report ("did a change make us more efficient?").
//
// Five measurements, each computed once when a day is computed and stored in the day's result (`efficiency`):
//   landings     commits landed on each repo's default branch (or its merge target) that day, and units per landing
//   compactions  per lead (main) session: compactions that day and the median context tokens just before compacting
//   opus         Opus share of subagent cost, and the Opus-writer share
//   accounts     units and % of the week per claude.ai account (accountAt + that account's rate)
//   markers      the settings that change efficiency, with the ones that differ from the previous day's report marked
//
// Zero tokens: git (read only), the lead transcripts (read only), the settings and the state root. No model call.
// Every part is fail-soft: one that cannot be measured says why ({ gap }) and never stops the others or the run.
// Every external read has a seam in `seams` so the unit tests use fixtures (invented ids and names only).
//
// Transcript field, checked against real transcripts (2026-11): a compaction is a main-transcript record
//   { type:'system', subtype:'compact_boundary', timestamp, sessionId, version, compactMetadata:{ trigger:'auto'|'manual', preTokens, postTokens, ... } }
// `preTokens` is the context size just before the compaction. `version` is the Claude Code build on every record.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { unitsFromTokens } from './facts.mjs';
import { r4 } from './report.mjs';
import { inferRole } from '../../../hooks/lib/brief-directives.mjs';
import { accountAt, uncertainSpans } from '../../../hooks/lib/account.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (x) => (typeof x === 'string' && x.trim() !== '' ? x.trim() : null);
const HOUR_MS = 3600000;

// Roles whose deliverable is code: the spawn guard's own list (hooks/lib/opus-writer.mjs OPUS_WRITER_ROLES, which this mirrors:
// that module pulls in the whole guard, so it is not imported here).
export const WRITER_ROLES = ['writer', 'fixer', 'lander'];
export const OPUS_RE = /opus/i;
export const MAX_REPOS = 12;
export const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

export const median = (xs) => {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Units of one facts row (kind 'm' main thread, 's' subagents, else both) under the day file's recorded weights.
export function rowUnits(row, used, kind = null) {
  let u = 0;
  for (const [model, mt] of Object.entries((row && row.tok) || {})) {
    const spec = used[model];
    if (!spec || !isObj(mt)) continue;
    if (kind !== 's') u += unitsFromTokens(mt.m || [0, 0, 0, 0, 0, 0], spec);
    if (kind !== 'm') u += unitsFromTokens(mt.s || [0, 0, 0, 0, 0, 0], spec);
  }
  return u;
}

// ---------------------------------------------------------------- landings --

function defaultGit(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch { return null; }
}

const normPath = (p) => (process.platform === 'win32' ? String(p).replace(/\\/g, '/').toLowerCase() : String(p).replace(/\\/g, '/'));

/** { root, key } of the repository that owns `cwd` (a linked worktree resolves to its main repository), or null. */
export function repoOf(cwd, git = defaultGit) {
  if (!nonEmpty(cwd)) return null;
  const common = nonEmpty(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  let root = null;
  if (common) root = basename(common) === '.git' ? dirname(common) : common;
  else {
    // a worktree folder that is gone: the main repository is the part before .claude/worktrees
    const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]/.exec(String(cwd));
    if (m && nonEmpty(git(m[1], ['rev-parse', '--git-dir']))) root = m[1];
  }
  return root ? { root, key: normPath(root) } : null;
}

/** The ref whose first-parent commits are the landings: the merge target (git config guard.mergeTarget) or the default branch. */
export function landingRef(root, git = defaultGit) {
  let name = nonEmpty(git(root, ['config', '--get', 'guard.mergeTarget']));
  if (!name) {
    const head = nonEmpty(git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']));
    if (head) name = head.replace(/^origin\//, '');
  }
  if (!name) name = ['main', 'master'].find((b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null) || null;
  if (!name) return null;
  name = name.replace(/^origin\//, '');
  for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) if (git(root, ['rev-parse', '--verify', '--quiet', ref]) !== null) return { name, ref };
  return null;
}

/** First-parent commits of `ref` whose committer time is in [fromMs, toMs): the day's landings in that repository. null: unreadable. */
export function countLandings(root, ref, fromMs, toMs, git = defaultGit) {
  const since = new Date(fromMs - 86400000).toISOString();
  const out = git(root, ['log', ref, '--first-parent', '--format=%ct', `--since=${since}`, '--max-count=5000']);
  if (out === null) return null;
  let n = 0;
  for (const line of out.split('\n')) {
    const t = Number(line.trim()) * 1000;
    if (Number.isFinite(t) && t >= fromMs && t < toMs) n += 1;
  }
  return n;
}

/**
 * The day's landings for the repos its sessions worked in. `rows` are the facts rows; a row counts for the repo that owns its cwd.
 * Units per landing = the units of the sessions that worked in that repo / its landings (n/a with no landing, never zero).
 */
export function landingsOf({ rows, used, fromMs, toMs, git = defaultGit, repoCache = new Map() }) {
  const byRepo = new Map();
  let unattributed = 0;
  for (const r of rows || []) {
    const u = rowUnits(r, used);
    let repo = null;
    if (nonEmpty(r.cwd)) {
      const ck = String(r.cwd);
      if (!repoCache.has(ck)) repoCache.set(ck, repoOf(r.cwd, git));
      repo = repoCache.get(ck);
    }
    if (!repo) { unattributed += u; continue; }
    const e = byRepo.get(repo.key) || { root: repo.root, label: basename(repo.root), sids: new Set(), units: 0 };
    e.sids.add(r.sid); e.units += u;
    byRepo.set(repo.key, e);
  }
  const all = [...byRepo.values()].sort((a, b) => b.units - a.units);
  const out = [];
  let skipped = 0;
  for (const e of all) {
    if (out.length >= MAX_REPOS) { skipped += 1; continue; }
    const ref = landingRef(e.root, git);
    const landings = ref ? countLandings(e.root, ref.ref, fromMs, toMs, git) : null;
    out.push({
      label: e.label, branch: ref ? ref.name : null, sessions: e.sids.size, units: r4(e.units), landings,
      unitsPerLanding: landings > 0 ? r4(e.units / landings) : null,
    });
  }
  const counted = out.filter((x) => Number.isFinite(x.landings));
  const totalLandings = counted.reduce((a, x) => a + x.landings, 0);
  const countedUnits = counted.reduce((a, x) => a + x.units, 0);
  return {
    repos: out, skippedRepos: skipped, unattributedUnits: r4(unattributed), totalLandings,
    countedUnits: r4(countedUnits), unitsPerLanding: totalLandings > 0 ? r4(countedUnits / totalLandings) : null,
  };
}

// ------------------------------------------------------------- compactions --

// The lines of `buf` that hold a compact_boundary record, parsed. Cheap: a substring search first, JSON.parse only on those lines.
export function compactionRecords(buf) {
  const needle = Buffer.from('"subtype":"compact_boundary"');
  const out = [];
  let from = 0;
  for (;;) {
    const i = buf.indexOf(needle, from);
    if (i < 0) break;
    let a = buf.lastIndexOf(10, i); a = a < 0 ? 0 : a + 1;
    let b = buf.indexOf(10, i); if (b < 0) b = buf.length;
    from = b + 1;
    try {
      const j = JSON.parse(buf.toString('utf8', a, b));
      if (j && j.type === 'system' && j.subtype === 'compact_boundary') out.push(j);
    } catch { /* torn line */ }
  }
  return out;
}

// The Claude Code build named by the last record of the transcript that carries one (read from the tail).
export function buildVersionOfTail(path) {
  let fd;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = [...buf.toString('utf8').matchAll(/"version":"(\d+(?:\.\d+){1,3}[^"]{0,12})"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } catch { return null; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * Lead (main-thread) sessions of the day: those with main-thread requests. For each, its compactions inside [fromMs, toMs) and the
 * median context tokens just before compacting (compactMetadata.preTokens). Also the Claude Code builds the sessions ran on.
 * `transcriptsRoot/<proj>/<sid>.jsonl` is read; a missing file is counted as unreadable, never as zero compactions.
 */
export function leadCompactionsOf({ rows, fromMs, toMs, transcriptsRoot }) {
  const sess = new Map();
  for (const r of rows || []) {
    const mainReq = Object.values(r.tok || {}).reduce((a, mt) => a + ((mt && mt.m && mt.m[5]) || 0), 0);
    if (mainReq <= 0) continue;
    const e = sess.get(r.sid) || { sid: r.sid, proj: null };
    if (!e.proj && r.proj) e.proj = r.proj;
    sess.set(r.sid, e);
  }
  const out = [];
  const versions = {};
  let unreadable = 0;
  let noFigure = 0;
  for (const e of [...sess.values()].sort((a, b) => (a.sid < b.sid ? -1 : 1))) {
    const path = e.proj && transcriptsRoot ? join(transcriptsRoot, e.proj, `${e.sid}.jsonl`) : null;
    let st = null;
    try { st = path ? statSync(path) : null; } catch { st = null; }
    if (!st || st.size > MAX_TRANSCRIPT_BYTES) { unreadable += 1; continue; }
    const v = buildVersionOfTail(path);
    if (v) versions[v] = (versions[v] || 0) + 1;
    if (st.mtimeMs < fromMs) continue; // nothing was written to it on or after the day's start
    let recs = [];
    try { recs = compactionRecords(readFileSync(path)); } catch { unreadable += 1; continue; }
    const mine = [];
    for (const j of recs) {
      const t = Date.parse(j.timestamp);
      if (!(t >= fromMs && t < toMs)) continue;
      const cm = isObj(j.compactMetadata) ? j.compactMetadata : {};
      mine.push({ trigger: cm.trigger === 'manual' ? 'manual' : 'auto', pre: Number.isFinite(cm.preTokens) ? cm.preTokens : null });
    }
    if (!mine.length) continue;
    noFigure += mine.filter((c) => c.pre === null).length;
    out.push({
      sid: String(e.sid).slice(0, 8), n: mine.length, auto: mine.filter((c) => c.trigger === 'auto').length,
      manual: mine.filter((c) => c.trigger === 'manual').length, medianPreTokens: median(mine.map((c) => c.pre)),
      pre: mine.map((c) => c.pre).filter((x) => x !== null),
    });
  }
  const all = out.flatMap((s) => s.pre);
  return {
    leadSessions: sess.size, unreadable, sessionsWithCompaction: out.length,
    total: out.reduce((a, s) => a + s.n, 0), withoutTokenFigure: noFigure, medianPreTokens: median(all),
    rows: out.map(({ pre, ...rest }) => rest), versions,
  };
}

// --------------------------------------------------------------- opus share --

// Is this spawn a writer? Role from the spawn guard's declared_role (spawns.jsonl). With no ROLE line the guard inserted one from the
// TYPE (silent_fixes "role_inserted:<role>": a plan leg reads "other"), else the TYPE decides (inferRole). With no telemetry row at all
// the role the transcript's own brief carried (the facts spawn's `role`) stands in, then the type.
export function isWriterSpawn(spawn, row) {
  if (row) {
    const role = nonEmpty(row.declared_role);
    if (role) return WRITER_ROLES.includes(role.toLowerCase());
    const ins = (Array.isArray(row.silent_fixes) ? row.silent_fixes : []).map((x) => /^role_inserted:([a-z]+)$/.exec(String(x))).find(Boolean);
    if (ins) return WRITER_ROLES.includes(ins[1]);
    return inferRole(nonEmpty(row.declared_type_resolved) || nonEmpty(row.declared_type) || spawn.type) === 'writer';
  }
  const r = nonEmpty(spawn.role);
  if (r && r !== 'none') return WRITER_ROLES.includes(r.toLowerCase());
  return inferRole(spawn.type) === 'writer';
}

const spawnUnits = (s, used) => {
  const spec = used[s.model];
  if (!spec) return 0;
  const t = [0, 0, 0, 0, 0, 0];
  for (const b of (s.ctx && s.ctx.buckets) || []) for (let i = 0; i < 6; i += 1) t[i] += (b && b[i]) || 0;
  return unitsFromTokens(t, spec);
};

/**
 * Opus share of subagent cost (rows: the subagent tokens of every Opus model / all subagent tokens) and the Opus-writer share
 * (the units of spawns that ran on Opus AND are writers / the same total). `spawnRows`: Map(tool_use_id -> spawns.jsonl row).
 * A spawn record carries its own units; they can differ a little from the rows (a spawn lands on its start day).
 */
export function opusSharesOf({ rows, spawns, used, spawnRows = new Map() }) {
  let sub = 0; let opus = 0;
  for (const r of rows || []) {
    for (const [model, mt] of Object.entries(r.tok || {})) {
      const spec = used[model];
      if (!spec || !mt) continue;
      const u = unitsFromTokens(mt.s || [0, 0, 0, 0, 0, 0], spec);
      sub += u;
      if (OPUS_RE.test(model)) opus += u;
    }
  }
  let writer = 0; let writerSpawns = 0; let opusSpawns = 0; let noRow = 0;
  for (const s of spawns || []) {
    if (!OPUS_RE.test(String(s.model || ''))) continue;
    opusSpawns += 1;
    const row = s.id ? spawnRows.get(s.id) : null;
    if (!row) noRow += 1;
    if (isWriterSpawn(s, row || null)) { writer += spawnUnits(s, used); writerSpawns += 1; }
  }
  return {
    subagentUnits: r4(sub), opusUnits: r4(opus), opusPct: sub > 0 ? r4((opus / sub) * 100) : null,
    opusSpawns, writerSpawns, writerUnits: r4(writer), writerPct: sub > 0 ? r4((writer / sub) * 100) : null, spawnsWithoutGuardRow: noRow,
  };
}

// ----------------------------------------------------------------- accounts --

const UNATTRIBUTED = Symbol('unattributed');

/**
 * Units per account. Each facts row (one session in one UTC hour) goes to the account active at the START of its hour (accountAt):
 * the hour is the finest the facts keep. `history` is accountHistory()'s result; `rateFor(acct)` the account's units per 1% of its
 * week ({ value, ...}). One distinct account (or none known): { single: true } and nothing else. An hour that starts inside a span
 * whose switch time is unknown (the account was seen as A, then as B, nothing dated in between) is not given to either: it is
 * 'unattributed'. An hour before the first known account is 'unknown'.
 */
export function accountsOf({ rows, used, history, rateFor }) {
  const distinct = new Set((Array.isArray(history) ? history : []).map((h) => h.acct));
  if (distinct.size < 2) return { single: true };
  const spans = uncertainSpans(history);
  const by = new Map();
  for (const r of rows || []) {
    const t = Date.parse(r.hour);
    let acct = (Number.isFinite(t) ? accountAt(history, t) : null) || null;
    if (!acct && Number.isFinite(t) && spans.some((x) => t > x.from && t < x.to)) acct = UNATTRIBUTED;
    by.set(acct, (by.get(acct) || 0) + rowUnits(r, used));
  }
  const noAcct = (k) => k === null || k === UNATTRIBUTED;
  const list = [...by.entries()].sort((a, b) => (noAcct(a[0]) !== noAcct(b[0]) ? (noAcct(a[0]) ? 1 : -1) : b[1] - a[1]));
  return {
    single: false,
    rows: list.map(([acct, units]) => {
      const rate = acct && acct !== UNATTRIBUTED ? rateFor(acct) : null;
      const per = rate && rate.value > 0 ? rate.value : null;
      return {
        account: acct === UNATTRIBUTED ? 'unattributed' : acct ? String(acct).slice(0, 8) : 'unknown', units: r4(units),
        unitsPerPercent: per, rateBasis: rate ? rate.basis : null, pctOfWeek: per ? r4(units / per) : null,
      };
    }),
  };
}

// ------------------------------------------------------------------ markers --

export const MARKER_KEYS = ['claudeCode', 'agentCompanion', 'autoCompactWindow', 'mainCompactFloorTokens'];
export const MARKER_LABELS = {
  claudeCode: 'Claude Code', agentCompanion: 'agent-companion', autoCompactWindow: 'autoCompactWindow', mainCompactFloorTokens: 'main_compact_floor_tokens',
};

// "2.1.326" or "2.1.326 (5 sessions), 2.1.330 (1 session)" (most used first); null for none.
const versionsText = (counts) => {
  const e = Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (!e.length) return null;
  return e.length === 1 ? e[0][0] : e.map(([v, n]) => `${v} (${n})`).join(', ');
};

/**
 * The four values for a day as display strings. `claudeCode`: the builds the day's lead transcripts name; `guardVersions`: the
 * guard_version counts of the day's spawn rows (the plugin copy that was loaded), else `pluginVersion`; `window` and `floor` are the
 * values read when the day was computed (null window = Claude Code's own default).
 */
export function markerValues({ cc, guardVersions, pluginVersion, window, floor }) {
  return {
    claudeCode: versionsText(cc) || 'n/a',
    agentCompanion: versionsText(guardVersions) || nonEmpty(pluginVersion) || 'n/a',
    autoCompactWindow: Number.isInteger(window) ? String(window) : 'default',
    mainCompactFloorTokens: Number.isFinite(floor) ? (floor === 0 ? '0 (off)' : String(floor)) : 'n/a',
  };
}

/** The keys whose value differs from the previous day's report: { key: previous value }. {} when there is no previous report. */
export function changedMarkers(prev, cur) {
  const out = {};
  if (!isObj(prev)) return out;
  for (const k of MARKER_KEYS) if (typeof prev[k] === 'string' && prev[k] !== cur[k]) out[k] = prev[k];
  return out;
}

// ------------------------------------------------------------------ the day --

const safe = (fn) => { try { return fn(); } catch (e) { return { gap: `could not be measured: ${String((e && e.message) || e).slice(0, 80)}` }; } };

/**
 * The efficiency block of one day's result. `f` is the day's facts, `seams` the injectable readers:
 *   git, transcriptsRoot, accountHistory (array), rateFor(acct), spawnRows (Map), settings() -> { window, floor }, pluginVersion,
 *   prev (the previous day's stored markers or null), prior (this day's earlier stored markers or null), nowT, lateAfterMs.
 * `markers` already stored for the day are kept (a recompute must not stamp today's settings on an old day).
 */
export function computeEfficiency({ f, fromMs, toMs, seams = {} }) {
  const used = f.weightsUsed || {};
  const rows = f.rows || [];
  const spawns = f.spawns || [];
  const comp = safe(() => (seams.transcriptsRoot ? leadCompactionsOf({ rows, fromMs, toMs, transcriptsRoot: seams.transcriptsRoot })
    : { gap: 'no transcripts folder' }));
  const landings = safe(() => landingsOf({ rows, used, fromMs, toMs, git: seams.git || defaultGit, repoCache: seams.repoCache || new Map() }));
  const opus = safe(() => opusSharesOf({ rows, spawns, used, spawnRows: seams.spawnRows || new Map() }));
  const accounts = safe(() => (Array.isArray(seams.accountHistory)
    ? accountsOf({ rows, used, history: seams.accountHistory, rateFor: seams.rateFor || (() => null) }) : { single: true }));
  const markers = safe(() => {
    if (seams.prior && isObj(seams.prior.values)) return { ...seams.prior, changed: changedMarkers(seams.prev, seams.prior.values), prevDay: seams.prev ? seams.prevDay || null : null };
    const guard = {};
    for (const s of spawns) { const r = s.id && seams.spawnRows ? seams.spawnRows.get(s.id) : null; const v = r && nonEmpty(r.guard_version); if (v) guard[v] = (guard[v] || 0) + 1; }
    const set = (seams.settings && seams.settings()) || {};
    const values = markerValues({ cc: comp && comp.versions, guardVersions: guard, pluginVersion: seams.pluginVersion, window: set.window, floor: set.floor });
    const late = Number.isFinite(seams.nowT) && seams.nowT - toMs > (seams.lateAfterMs ?? 36 * HOUR_MS);
    return { values, changed: changedMarkers(seams.prev, values), prevDay: seams.prev ? seams.prevDay || null : null, late };
  });
  return { landings, compactions: comp, opus, accounts, markers };
}
