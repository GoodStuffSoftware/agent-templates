#!/usr/bin/env node
// long-runs.mjs - lists the subagent runs that crossed the step threshold (150, then every +100) in the last 24 h.
//
//   node long-runs.mjs [--since 24h|90m|2d|<ISO time>] [--now <ISO time>]
//
// Reads <state>/long-runs.jsonl (one JSON line per threshold crossing, written by the long-run hook:
// {ts, sessionId, agentId, agentType, steps, startedAt, durationMin, description, transcriptPath}), keeps the highest
// crossing per agent, and enriches each run from its transcript when that is readable: model, total tokens,
// compactions, final steps and whether it finished. A worker that passed the first mark and then ended also left one
// {kind:"summary"} row (name, type, rung, steps, minutes, toolCounts, failedCommands, briefChars; hooks/lib/long-run.mjs): the listing
// adds it to that run, so the question "why was it long" has data. Prints JSON { line, runs: [...] }. A missing file means none.
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
    if (!r || typeof r !== 'object' || r.kind === 'summary' || !Number.isFinite(t) || t < since || !Number.isFinite(r.steps)) continue;
    const key = r.agentId || `session:${r.sessionId}`;
    const cur = best.get(key);
    if (!cur || r.steps > cur.steps || (r.steps === cur.steps && t > Date.parse(cur.ts))) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => b.steps - a.steps);
}

// The summary row per agent (the latest), from the same log. Empty map when there is none.
export function readSummaries(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.includes('"summary"')) continue;
    let r;
    try { r = JSON.parse(ln); } catch { continue; }
    if (r && r.kind === 'summary' && r.agentId) out.set(r.agentId, r);
  }
  return out;
}

const toolsText = (tc) => Object.entries(tc || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ');

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
  const sums = from == null ? new Map() : readSummaries(path);
  const runs = from == null ? [] : readCrossings(path, from).map((r) => {
    const e = enrich(r.transcriptPath);
    const sm = sums.get(r.agentId) || null;
    return {
      summary: sm ? {
        name: sm.name ?? null, type: sm.type ?? null, rung: sm.rung ?? null, steps: sm.steps ?? null, minutes: sm.minutes ?? null,
        toolCounts: sm.toolCounts ?? {}, failedCommands: sm.failedCommands ?? null, briefChars: sm.briefChars ?? null,
      } : null,
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
    const sm = r.summary ? `\n    why: ${r.summary.name || 'unnamed'}, TYPE ${r.summary.type || '?'}, rung ${r.summary.rung ?? '?'}, ${r.summary.steps} steps in ${r.summary.minutes != null ? Math.round(r.summary.minutes) : '?'} min; tools: ${toolsText(r.summary.toolCounts) || 'none'}; ${r.summary.failedCommands ?? '?'} failed commands; brief ${r.summary.briefChars ?? '?'} chars` : '';
    return `- ${r.type || 'agent'}, ${r.model || 'model ?'}, ${r.steps} steps${f}, ${mins}, ${r.compactions ?? '?'} compactions: ${short(r.description, 80) || '(no description)'}${sm}`;
  });
  return { line: `Long runs (24h): ${runs.length} past the long-run mark (150 steps, then every further 100; a marker, not a limit)\n${items.join('\n')}`, runs };
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