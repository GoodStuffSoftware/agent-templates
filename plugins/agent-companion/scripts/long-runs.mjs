#!/usr/bin/env node
// long-runs.mjs - lists the subagent runs that crossed the step threshold (150, then every +100) in the last 24 h.
//
//   node long-runs.mjs [--since 24h|90m|2d|<ISO time>] [--now <ISO time>]
//
// Reads <state>/long-runs.jsonl (one JSON line per threshold crossing, written by the step-warning hook:
// {ts, sessionId, agentId, agentType, steps, startedAt, durationMin, description, transcriptPath}), keeps the highest
// crossing per agent, and enriches each run from its transcript when that is readable: model, total tokens,
// compactions, final steps and whether it finished. Prints JSON { line, runs: [...] }. A missing file means none.
// A long run is a signal to evaluate, not a failure (subagents auto-compact). No network.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { stateRootPath } from '../hooks/lib/context.mjs';

export const LONG_RUNS_FILE = 'long-runs.jsonl';
const UNITS = { m: 60e3, h: 3600e3, d: 24 * 3600e3 };

export function parseSince(s, now) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(String(s ?? '24h').trim());
  if (m) return now - Number(m[1]) * UNITS[m[2].toLowerCase()];
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// Highest crossing per agent (agentId, else sessionId) at or after `since`.
export function readCrossings(path, since) {
  if (!existsSync(path)) return [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  const best = new Map();
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let r;
    try { r = JSON.parse(ln); } catch { continue; }
    const t = Date.parse(r?.ts);
    if (!r || typeof r !== 'object' || !Number.isFinite(t) || t < since || !Number.isFinite(r.steps)) continue;
    const key = r.agentId || `session:${r.sessionId}`;
    const cur = best.get(key);
    if (!cur || r.steps > cur.steps || (r.steps === cur.steps && t > Date.parse(cur.ts))) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => b.steps - a.steps);
}

// Facts from a transcript jsonl: model, tokens, compactions, steps, finished. null when unreadable.
export function enrich(path) {
  if (!path) return null;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const byId = new Map();
  const models = new Map();
  let compactions = 0;
  let last = null;
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o;
    try { o = JSON.parse(ln); } catch { continue; }
    if (o?.type === 'system' && o.subtype === 'compact_boundary') { compactions++; continue; }
    if (o?.type === 'assistant' && o.message) {
      const m = o.message;
      const id = m.id || o.requestId || o.uuid;
      const u = m.usage || {};
      const tot = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      byId.set(id, Math.max(byId.get(id) || 0, tot)); // streamed copies share an id: the max, never a sum
      if (m.model && m.model !== '<synthetic>') models.set(m.model, (models.get(m.model) || 0) + 1);
      last = m;
    } else if (o?.type === 'user') last = null;
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const finished = !!last && last.stop_reason === 'end_turn';
  return { model, tokens: [...byId.values()].reduce((a, b) => a + b, 0), compactions, finalSteps: byId.size, finished };
}

const short = (s, n) => (s && s.length > n ? `${s.slice(0, n - 3)}...` : s || '');

export function longRuns({ since = '24h', now = Date.now(), file } = {}) {
  const from = parseSince(since, now);
  const path = file || join(stateRootPath(), 'state', LONG_RUNS_FILE);
  const runs = from == null ? [] : readCrossings(path, from).map((r) => {
    const e = enrich(r.transcriptPath);
    return {
      agentId: r.agentId ?? null, sessionId: r.sessionId ?? null, type: r.agentType ?? null,
      steps: r.steps, minutes: r.durationMin ?? null, description: r.description ?? null, ts: r.ts,
      model: e?.model ?? null, tokens: e?.tokens ?? null, compactions: e?.compactions ?? null,
      finalSteps: e?.finalSteps ?? null, finished: e ? e.finished : null,
    };
  });
  if (!runs.length) return { line: 'Long runs (24h): none', runs };
  const items = runs.map((r) => {
    const f = r.finalSteps != null ? ` (final ${r.finalSteps}${r.finished ? ', finished' : ', not finished'})` : '';
    const mins = r.minutes != null ? `${Math.round(r.minutes)} min` : '? min';
    return `- ${r.type || 'agent'}, ${r.model || 'model ?'}, ${r.steps} steps${f}, ${mins}, ${r.compactions ?? '?'} compactions: ${short(r.description, 80) || '(no description)'}`;
  });
  return { line: `Long runs (24h): ${runs.length} past a step threshold (150, the step-budget stop, every further 100)\n${items.join('\n')}`, runs };
}

export function main(argv, { out = (s) => process.stdout.write(`${s}\n`), ...inject } = {}) {
  let since = '24h';
  let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') since = argv[++i];
    else if (argv[i] === '--now') { now = Date.parse(argv[++i]); if (!Number.isFinite(now)) { out('bad --now'); return 2; } }
    else { out('usage: long-runs.mjs [--since 24h] [--now <ISO>]'); return 2; }
  }
  if (parseSince(since, now) == null) { out('bad --since'); return 2; }
  out(JSON.stringify(longRuns({ since, now, ...inject })));
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));