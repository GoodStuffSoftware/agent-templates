#!/usr/bin/env node
// bash-tail-report.mjs — what the Bash output tail (hooks/bash-tail.mjs) did,
// for the 10-16 routing review. Reads telemetry/bash-tail.jsonl only; never
// writes anything and never reads a transcript.
//
// Rows: `wrapped` (the hook rewrote a command), `skipped` (a known runner left
// alone, with the reason), `result` (written by the wrapper when the command
// finished: exit code, lines and bytes produced, characters returned).
//
// The number the review wants: bytes produced vs characters returned, i.e.
// what stayed out of context. Characters, not tokens: the context cost of a
// returned character is a property of the model, so convert with the
// operator's own measured ratio rather than a constant here.
//
// Usage:
//   node bash-tail-report.mjs                # last 30 days, human report
//   node bash-tail-report.mjs --days 7
//   node bash-tail-report.mjs --json

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { telemetryDir } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const days = Number(val('--days')) || 30;
const asJson = argv.includes('--json');
const since = Date.now() - days * 24 * 60 * 60 * 1000;

export function summarize(rows) {
  const s = {
    wrapped: 0, results: 0, truncated: 0, passedWhole: 0,
    failedRuns: 0, bytesProduced: 0, charsReturned: 0, charsSaved: 0,
    skipped: {}, byRunner: {}, subagentWraps: 0,
  };
  for (const r of rows) {
    if (r.event === 'wrapped') {
      s.wrapped++;
      if (r.caller_is_subagent) s.subagentWraps++;
      s.byRunner[r.runner] = (s.byRunner[r.runner] || 0) + 1;
    } else if (r.event === 'skipped') {
      for (const why of String(r.reason || 'unknown').split(',')) s.skipped[why] = (s.skipped[why] || 0) + 1;
    } else if (r.event === 'result') {
      s.results++;
      if (r.truncated) s.truncated++; else s.passedWhole++;
      if (Number(r.rc) !== 0) s.failedRuns++;
      s.bytesProduced += Number(r.bytes) || 0;
      s.charsReturned += Number(r.shown_chars) || 0;
    }
  }
  s.charsSaved = Math.max(0, s.bytesProduced - s.charsReturned);
  return s;
}

export function readRows(file, sinceMs) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const t = Date.parse(r.at);
      if (Number.isFinite(t) && t < sinceMs) continue;
      rows.push(r);
    } catch { /* a torn line: skip */ }
  }
  return rows;
}

if (String(process.argv[1] || '').replace(/\\/g, '/').endsWith('/bash-tail-report.mjs')) {
  const file = join(telemetryDir(), 'bash-tail.jsonl');
  const s = summarize(readRows(file, since));
  if (asJson) {
    console.log(JSON.stringify({ windowDays: days, file, ...s }, null, 2));
    process.exit(0);
  }
  console.log(`bash-tail-report: Bash output tail (last ${days}d)`);
  console.log(`file: ${file}${existsSync(file) ? '' : ' (does not exist)'}`);
  console.log('');
  console.log(`commands wrapped      : ${s.wrapped} (${s.subagentWraps} from subagents)`);
  console.log(`runs finished         : ${s.results} (${s.truncated} tailed, ${s.passedWhole} printed whole, ${s.failedRuns} non-zero exit)`);
  console.log(`output produced       : ${s.bytesProduced.toLocaleString()} bytes`);
  console.log(`returned to context   : ${s.charsReturned.toLocaleString()} chars`);
  console.log(`kept out of context   : ${s.charsSaved.toLocaleString()} chars`);
  const skipped = Object.entries(s.skipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length) {
    console.log('');
    console.log('-- known runners left alone, by reason --');
    for (const [why, n] of skipped) console.log(`  ${String(n).padStart(5)}  ${why}`);
  }
  const runners = Object.entries(s.byRunner).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (runners.length) {
    console.log('');
    console.log('-- wrapped, by runner --');
    for (const [r, n] of runners) console.log(`  ${String(n).padStart(5)}  ${r}`);
  }
  console.log('');
  console.log('A wrapped command with no result row was still running, was killed, or ran in a fixture session.');
}
