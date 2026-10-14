// usage/events.mjs: window boundaries and event references (design section 3.2, "Windows").
//
// A window's `from` and `to` are an ISO time or an event reference:
//   rollout:<id>                  the instant in rollout.json (ms, M)
//   decision:<id>                 the register decision's rollout instant (M), else its decided date (E)
//   release:agent-companion@<v>   the first spawns.jsonl row stamped guard_version <v> (M)
//   cli:<ver>                     the first plan-meter or transcript row that carries version <ver> (M)
//   setting:<key>=<value>         the first instant the settings journal shows that value (M)
//   tag:<project>/<tag>           the git tag's date (M)
//   config:<scenarioId>           the latest instant that scenario's series digest changed (M)
// An ISO date or time written in config is E unless the window says otherwise.
// Every boundary is floored to the hour, because facts are hourly.
//
// Sources are injected (resolveEvent never touches the disk), so a test or the runner decides where
// they come from. Each source is an array or a function returning one, and each is optional: a
// missing source gives a gap that names it, never a guess.
//   rolloutMs(id) -> ms|null          decisions: [{id, rolloutId?, decided?}]
//   spawnRows: [{at, guard_version}]  cliVersions: [{at, version}]   (named hook: no shipped feed yet)
//   settingsRows: settings-changes.jsonl rows        tagTimeMs(project, tag) -> ms|null
//   configRows: [{at, scenario, digest}]  (the runner's per-scenario digest journal)
// loadEventSources(root) wires the file-backed ones, reading only below `root`.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { floorHour } from './days.mjs';
import { settingInstant, readJournal, JOURNAL_FILE } from '../../../hooks/lib/settings-journal.mjs';
import { gitClean } from '../git-env.mjs';

export const CONFIG_JOURNAL_FILE = 'usage-config-digests.jsonl';
export const EVENT_KINDS = ['rollout', 'decision', 'release', 'cli', 'setting', 'tag', 'config'];
const MAX_JSONL_BYTES = 32 * 1024 * 1024;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z)?$/;
const val = (x) => (typeof x === 'function' ? x() : x);
const arr = (x) => { const v = val(x); return Array.isArray(v) ? v : []; };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** ms of an ISO date (UTC midnight) or time, or null. Rejects impossible dates. */
export function parseIso(s) {
  const m = ISO_RE.exec(String(s));
  if (!m) return null;
  const ms = Date.parse(m[4] === undefined ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || (m[6] !== undefined && +m[6] > 59))) return null;
  return ms;
}

const ok = (rawMs, label, source) => ({ ms: floorHour(rawMs), rawMs, label, source });
const gap = (why) => ({ gap: true, why });
const earliest = (rows, key, pred) => {
  let best = null;
  for (const r of rows) {
    if (!isObj(r) || !pred(r)) continue;
    const ms = Date.parse(r[key]);
    if (Number.isFinite(ms) && (best === null || ms < best)) best = ms;
  }
  return best;
};

/**
 * Resolve one reference to { ms, rawMs, label, source } (ms floored to the hour) or { gap, why }.
 * `ref` is an ISO string or an event reference.
 */
export function resolveEvent(ref, sources = {}) {
  const s = String(ref ?? '').trim();
  const lit = parseIso(s);
  if (lit !== null) return ok(lit, 'E', 'literal');
  const m = /^([a-z]+):(.+)$/.exec(s);
  if (!m || !EVENT_KINDS.includes(m[1])) return gap(`"${s.slice(0, 60)}" is neither an ISO time nor a known event reference`);
  const [, kind, rest] = m;
  try {
    switch (kind) {
      case 'rollout': {
        const ms = typeof sources.rolloutMs === 'function' ? sources.rolloutMs(rest) : null;
        return Number.isFinite(ms) ? ok(ms, 'M', `rollout ${rest}`) : gap(`no rollout instant for "${rest}"`);
      }
      case 'decision': {
        const d = arr(sources.decisions).find((x) => isObj(x) && x.id === rest);
        if (!d) return gap(`decision "${rest}" is not in the register`);
        if (typeof d.rolloutId === 'string' && typeof sources.rolloutMs === 'function') {
          const ms = sources.rolloutMs(d.rolloutId);
          if (Number.isFinite(ms)) return ok(ms, 'M', `decision ${rest} (rollout ${d.rolloutId})`);
        }
        const dec = typeof d.decided === 'string' ? parseIso(d.decided) : null;
        return dec !== null ? ok(dec, 'E', `decision ${rest} (decided date)`) : gap(`decision "${rest}" has no rollout instant or decided date`);
      }
      case 'release': {
        const at = rest.lastIndexOf('@');
        const name = at > 0 ? rest.slice(0, at) : null;
        const ver = at > 0 ? rest.slice(at + 1) : null;
        if (!name || !ver) return gap('release references look like release:agent-companion@<version>');
        if (name !== 'agent-companion') return gap(`only agent-companion releases are stamped in spawns.jsonl, not "${name}"`);
        const rows = arr(sources.spawnRows);
        if (!rows.length) return gap('no spawns.jsonl rows to find the release in');
        const ms = earliest(rows, 'at', (r) => r.guard_version === ver);
        return ms !== null ? ok(ms, 'M', `first spawn on ${ver}`) : gap(`no spawn row stamped guard_version ${ver}`);
      }
      case 'cli': {
        const rows = arr(sources.cliVersions);
        if (!rows.length) return gap('no CLI version feed (hook: sources.cliVersions)');
        const ms = earliest(rows, 'at', (r) => r.version === rest);
        return ms !== null ? ok(ms, 'M', `first row on CLI ${rest}`) : gap(`CLI version ${rest} was not seen`);
      }
      case 'setting': {
        const rows = arr(sources.settingsRows);
        if (!rows.length) return gap('the settings journal is empty or absent');
        const ms = settingInstant(rows, `setting:${rest}`);
        return Number.isFinite(ms) ? ok(ms, 'M', `settings journal ${rest}`) : gap(`the settings journal never shows ${rest}`);
      }
      case 'tag': {
        const slash = rest.indexOf('/');
        const project = slash > 0 ? rest.slice(0, slash) : null;
        const tag = slash > 0 ? rest.slice(slash + 1) : null;
        if (!project || !tag) return gap('tag references look like tag:<project>/<tag>');
        if (typeof sources.tagTimeMs !== 'function') return gap('no git tag source');
        const ms = sources.tagTimeMs(project, tag);
        return Number.isFinite(ms) ? ok(ms, 'M', `tag ${tag}`) : gap(`tag "${tag}" not found in project "${project}"`);
      }
      case 'config': {
        const ms = configChangeMs(arr(sources.configRows), rest);
        return ms !== null ? ok(ms, 'M', `config of ${rest}`) : gap(`no journaled change of the config of "${rest}"`);
      }
      default: return gap(`unknown event kind ${kind}`);
    }
  } catch (e) {
    return gap(`${kind} source failed: ${String((e && e.message) || e).slice(0, 80)}`);
  }
}

/**
 * Resolve a window definition { from, to?, label? } to { fromMs, toMs|null, label, sources } or
 * { gap, why }. An open window (no `to`) has toMs null: the caller clamps it to the day it evaluates.
 * `label` is E when the definition says E or either end is E.
 */
export function resolveWindow(def, sources = {}) {
  if (!isObj(def) || typeof def.from !== 'string') return gap('window has no from');
  const from = resolveEvent(def.from, sources);
  if (from.gap) return gap(`from: ${from.why}`);
  let to = null;
  if (def.to !== undefined) {
    to = resolveEvent(def.to, sources);
    if (to.gap) return gap(`to: ${to.why}`);
    if (to.ms <= from.ms) return gap('window ends before it starts');
  }
  const label = def.label === 'E' || from.label === 'E' || (to && to.label === 'E') ? 'E' : 'M';
  return { fromMs: from.ms, toMs: to ? to.ms : null, label, sources: [from.source, to ? to.source : null].filter(Boolean) };
}

// ---------------------------------------------------------------- config digests --

const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
};

/**
 * Digest of what defines a scenario's SERIES: the metric, its params, the cohort, the exclusion
 * definitions it applies and the grouping. Thresholds, severity, cadence and title do not break a
 * series, so changing them does not change the digest. `def` is a resolved scenario
 * ({ metric, def }) and `exclusions` the resolved exclusion table.
 */
export function scenarioDigest(scenario, exclusions = {}) {
  const d = scenario.def || {};
  const used = {};
  for (const n of d.excludeSets || []) used[n] = exclusions[n] === undefined ? null : exclusions[n];
  const body = canon({ metric: scenario.metric, params: d.params || {}, cohort: d.cohort || {}, excludeSets: d.excludeSets || [], exclusions: used, groupBy: d.groupBy || null });
  return createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}

/**
 * Rows the runner should append to the digest journal: one for each scenario whose digest differs
 * from its last journaled one, or that has none (the first row is a baseline, not a change).
 * `prior` is the existing journal rows; `now` the instant of the run.
 */
export function diffConfigDigests(prior, scenarios, exclusions, now) {
  const last = new Map();
  for (const r of prior || []) if (isObj(r) && typeof r.scenario === 'string') last.set(r.scenario, r.digest);
  const at = new Date(now).toISOString();
  const out = [];
  for (const sc of scenarios) {
    const digest = scenarioDigest(sc, exclusions);
    if (last.get(sc.id) !== digest) out.push({ at, scenario: sc.id, digest });
  }
  return out;
}

/** The latest instant at which `scenario`'s digest changed (the first journaled row is a baseline). */
export function configChangeMs(rows, scenario) {
  const mine = rows
    .filter((r) => isObj(r) && r.scenario === scenario && typeof r.digest === 'string' && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let last = null;
  let prev = null;
  for (const r of mine) {
    if (prev !== null && r.digest !== prev) last = Date.parse(r.at);
    prev = r.digest;
  }
  return last;
}

// -------------------------------------------------------------- file-backed sources --

function readJsonl(file) {
  try {
    if (statSync(file).size > MAX_JSONL_BYTES) return [];
    return readFileSync(file, 'utf8').split('\n').filter((l) => l[0] === '{').flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  } catch { return []; }
}

function readJsonFile(file) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** tagTimeMs(project, tag) over the project paths of environment.projects (user layer only). */
export function makeGitTagTime(environment = {}, { git = gitClean } = {}) {
  return (project, tag) => {
    const entry = environment.projects && environment.projects[project];
    const dir = entry && Array.isArray(entry.paths) ? entry.paths[0] : null;
    if (!dir || !SAFE_TAG.test(tag)) return null;
    try {
      const out = String(git(['-C', dir, 'for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`], { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
      const ms = Date.parse(out);
      return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
  };
}

/**
 * Event sources read from files below `root` (the state root): rollout.json, telemetry/spawns.jsonl,
 * telemetry/settings-changes.jsonl, config/decision-register.json and state/usage-config-digests.jsonl.
 * Every file is read lazily, once, and only when a reference needs it. Nothing is written.
 */
export function loadEventSources(root, { environment = {}, git } = {}) {
  const memo = {};
  const once = (k, fn) => () => (k in memo ? memo[k] : (memo[k] = fn()));
  const rolloutTable = once('rollout', () => {
    const raw = readJsonFile(join(root, 'rollout.json'));
    const t = {};
    if (isObj(raw)) for (const [id, v] of Object.entries(raw)) { const ms = typeof v === 'string' ? parseIso(v.trim()) ?? Date.parse(v) : NaN; if (Number.isFinite(ms)) t[id] = ms; }
    return t;
  });
  return {
    rolloutMs: (id) => (Object.prototype.hasOwnProperty.call(rolloutTable(), id) ? rolloutTable()[id] : null),
    decisions: once('decisions', () => { const r = readJsonFile(join(root, 'config', 'decision-register.json')); return isObj(r) && Array.isArray(r.decisions) ? r.decisions : []; }),
    spawnRows: once('spawns', () => readJsonl(join(root, 'telemetry', 'spawns.jsonl'))),
    settingsRows: once('settings', () => readJournal(join(root, 'telemetry', JOURNAL_FILE))),
    configRows: once('config', () => readJsonl(join(root, 'state', CONFIG_JOURNAL_FILE))),
    cliVersions: [],
    tagTimeMs: makeGitTagTime(environment, { git }),
  };
}
