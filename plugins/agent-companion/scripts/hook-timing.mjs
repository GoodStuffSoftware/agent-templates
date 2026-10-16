#!/usr/bin/env node
// hook-timing.mjs — what the plugin's hook processes cost, from the rows every hook
// process appends to telemetry/hook-timing.jsonl (option hook_timing_telemetry).
// Processes per tool call by tool, CPU and wall ms per call (median, p90), per-day
// totals, whether an event's hooks ran in parallel or in sequence (judged from the
// recorded start and end times, and used for the wall figure), and an estimate,
// labelled E, of what one process per event would save. Method: scripts/lib/hook-timing.mjs.
//
// Read-only. Never writes anything.
//
// Usage:
//   node hook-timing.mjs                       # last 7 days
//   node hook-timing.mjs --day 2026-10-16      # one UTC day
//   node hook-timing.mjs --days 3
//   node hook-timing.mjs --since 2026-10-14 --until 2026-10-17   # [since, until)
//   node hook-timing.mjs --json
//   node hook-timing.mjs --file <path>         # read this file only

import { readTimingRows, inWindow, analyze, renderText } from './lib/hook-timing.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes(n);

function fail(msg) {
  process.stderr.write(`hook-timing: ${msg}\n`);
  process.exit(2);
}

// A bare date is a UTC midnight.
function parseTime(s, label) {
  if (!s) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s);
  if (!Number.isFinite(ms)) fail(`${label}: not a date or time: ${s}`);
  return ms;
}

let sinceMs; let untilMs; let label;
if (val('--day')) {
  sinceMs = parseTime(val('--day'), '--day');
  untilMs = sinceMs + 24 * 60 * 60 * 1000;
  label = `UTC day ${val('--day')}`;
} else if (val('--since') || val('--until')) {
  sinceMs = parseTime(val('--since'), '--since') ?? -Infinity;
  untilMs = parseTime(val('--until'), '--until') ?? Infinity;
  label = `${val('--since') || 'start'} to ${val('--until') || 'now'}`;
} else {
  const days = Number(val('--days')) || 7;
  sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  untilMs = Infinity;
  label = `last ${days} day${days === 1 ? '' : 's'}`;
}

const file = val('--file');
const rows = inWindow(readTimingRows(file ? { files: [file] } : {}), { sinceMs, untilMs });
const result = analyze(rows);

if (has('--json')) {
  process.stdout.write(`${JSON.stringify({ window: label, ...result }, null, 2)}\n`);
} else {
  process.stdout.write(`${renderText(result, label)}\n`);
}
