// Hook-process timing report: reads telemetry/hook-timing.jsonl (written by every
// hook process as it exits; see hooks/lib/context.mjs) and answers "what does one
// Node process per registered hook cost, and what would one process per event save?".
// Read-only. No model call, no network.
//
// Vocabulary.
//   process    one row: one hook script start-to-exit.
//   event      one hook event of one tool call (PreToolUse, PostToolUse ...): the
//              processes sharing session_id + call id + event name. The harness
//              waits for all of them before the tool runs (Pre) or the turn goes on.
//   tool call  every process sharing session_id + call id (tool_use_id): its Pre
//              event plus its Post event.
//
// Wall time of an event is judged from the recorded start and end times (t0, t1):
//   parallel    all processes share one instant (latest start before earliest end):
//               the event's wall is its span, latest end minus earliest start.
//   sequential  no two overlap (each starts at or after the previous one ended):
//               the event's wall is the SUM of the process walls (the gaps between
//               them are harness time, not process time).
//   mixed       anything else: the span.
// A tool call's wall is the sum of its events' walls.
//
// Estimate E (what one process per event would save). A dispatcher still pays the
// shared floor of a Node process (startup plus loading context.mjs) once per event,
// and still does each hook's own work. The floor is the cheapest hook's median CPU
// and wall in the window, taken as "a process that does nothing". For an event of n
// processes:
//   processes saved  n - 1
//   CPU saved        (n - 1) x floor CPU, at most the event's CPU
//   wall saved       event wall now - (floor wall + sum of each process's wall above
//                    the floor); negative means the dispatcher would be slower
//                    (a parallel event with little work per hook)
// It is an estimate: it assumes in-process hooks cost what their out-of-process
// work costs, no extra cost for loading all the hook code in one process, and the
// same harness spawn cost per process. Everything it produces is labelled E.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { telemetryDir, HOOK_TIMING_FILE, HOOK_TIMING_ROTATED } from '../../hooks/lib/context.mjs';

const num = (x) => typeof x === 'number' && Number.isFinite(x);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Nearest-rank percentile (p in 0..100).
export function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const stat = (xs) => ({ median: round1(median(xs)), p90: round1(percentile(xs, 90)) });

// Rows from the rotated file (older) then the live file. A malformed line is skipped.
export function readTimingRows({ dir = telemetryDir(), files } = {}) {
  const paths = files || [join(dir, HOOK_TIMING_ROTATED), join(dir, HOOK_TIMING_FILE)];
  const rows = [];
  for (const f of paths) {
    if (!existsSync(f)) continue;
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && num(r.cpu_ms) && num(r.wall_ms) && num(r.t0) && num(r.t1)) rows.push(r);
      } catch { /* torn or foreign line */ }
    }
  }
  return rows;
}

// Rows whose end time falls in [sinceMs, untilMs).
export function inWindow(rows, { sinceMs = -Infinity, untilMs = Infinity } = {}) {
  return rows.filter((r) => r.t1 >= sinceMs && r.t1 < untilMs);
}

// How one event's processes ran, and the event's wall time under that reading.
export function judgeEvent(procs) {
  if (procs.length === 1) return { kind: 'single', wallMs: procs[0].wall_ms };
  const s = [...procs].sort((a, b) => a.t0 - b.t0);
  const spanMs = Math.max(...s.map((p) => p.t1)) - s[0].t0;
  const maxStart = Math.max(...s.map((p) => p.t0));
  const minEnd = Math.min(...s.map((p) => p.t1));
  if (maxStart < minEnd) return { kind: 'parallel', wallMs: spanMs };
  let seq = true;
  for (let i = 1; i < s.length; i += 1) if (s[i].t0 < s[i - 1].t1) { seq = false; break; }
  if (seq) return { kind: 'sequential', wallMs: sum(s.map((p) => p.wall_ms)) };
  return { kind: 'mixed', wallMs: spanMs };
}

// The shared per-process floor: the lowest per-hook median (hooks with at least
// MIN_FLOOR_ROWS rows), CPU and wall separately; with no such hook, the lowest row.
const MIN_FLOOR_ROWS = 5;
export function processFloor(rows) {
  if (!rows.length) return { cpuMs: 0, wallMs: 0, hook: null, basis: 'none' };
  const byHook = new Map();
  for (const r of rows) {
    if (!byHook.has(r.hook)) byHook.set(r.hook, []);
    byHook.get(r.hook).push(r);
  }
  let cpu = null; let wall = null; let hook = null;
  for (const [h, rs] of byHook) {
    if (rs.length < MIN_FLOOR_ROWS) continue;
    const c = median(rs.map((r) => r.cpu_ms));
    const w = median(rs.map((r) => r.wall_ms));
    if (cpu === null || c < cpu) { cpu = c; hook = h; }
    if (wall === null || w < wall) wall = w;
  }
  if (cpu !== null) return { cpuMs: cpu, wallMs: wall, hook, basis: `lowest per-hook median over hooks with at least ${MIN_FLOOR_ROWS} rows` };
  return {
    cpuMs: Math.min(...rows.map((r) => r.cpu_ms)), wallMs: Math.min(...rows.map((r) => r.wall_ms)),
    hook: null, basis: 'lowest single row (no hook has enough rows)',
  };
}

// Estimate E for one event of n >= 2 processes.
function eventSaving(procs, ev, floor) {
  const n = procs.length;
  if (n < 2) return { procs: 0, cpuMs: 0, wallMs: 0 };
  const cpuNow = sum(procs.map((p) => p.cpu_ms));
  const dispatcherWall = floor.wallMs + sum(procs.map((p) => Math.max(0, p.wall_ms - floor.wallMs)));
  return {
    procs: n - 1,
    cpuMs: Math.min((n - 1) * floor.cpuMs, cpuNow),
    wallMs: ev.wallMs - dispatcherWall,
  };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

export function analyze(rowsIn) {
  const rows = rowsIn.filter((r) => r && num(r.cpu_ms) && num(r.wall_ms) && num(r.t0) && num(r.t1));
  const floor = processFloor(rows);

  // Events and tool calls (rows with a call id) versus the rest.
  const events = new Map(); // sid|call|event -> procs
  const other = [];
  for (const r of rows) {
    if (!r.call) { other.push(r); continue; }
    const k = `${r.session_id}\u0000${r.call}\u0000${r.event ?? ''}`;
    if (!events.has(k)) events.set(k, []);
    events.get(k).push(r);
  }
  const calls = new Map(); // sid|call -> { tool, events: [...] }
  for (const [k, procs] of events) {
    const [sid, call, event] = k.split('\u0000');
    const ck = `${sid}\u0000${call}`;
    if (!calls.has(ck)) calls.set(ck, { tool: null, events: [] });
    const c = calls.get(ck);
    c.tool = c.tool || procs.find((p) => p.tool)?.tool || null;
    const j = judgeEvent(procs);
    c.events.push({ event, procs, ...j, saving: eventSaving(procs, j, floor) });
  }

  const callRows = [];
  for (const c of calls.values()) {
    const procs = c.events.flatMap((e) => e.procs);
    callRows.push({
      tool: c.tool || '(unknown)',
      processes: procs.length,
      events: c.events.length,
      cpuMs: sum(procs.map((p) => p.cpu_ms)),
      wallMs: sum(c.events.map((e) => e.wallMs)),
      savedProcs: sum(c.events.map((e) => e.saving.procs)),
      savedCpuMs: sum(c.events.map((e) => e.saving.cpuMs)),
      savedWallMs: sum(c.events.map((e) => e.saving.wallMs)),
      endMs: Math.max(...procs.map((p) => p.t1)),
    });
  }

  // By tool.
  const byToolMap = new Map();
  for (const c of callRows) {
    if (!byToolMap.has(c.tool)) byToolMap.set(c.tool, []);
    byToolMap.get(c.tool).push(c);
  }
  const byTool = [...byToolMap].map(([tool, cs]) => ({
    tool,
    calls: cs.length,
    processesPerCall: { mean: round1(sum(cs.map((c) => c.processes)) / cs.length), median: median(cs.map((c) => c.processes)), max: Math.max(...cs.map((c) => c.processes)) },
    eventsPerCall: round1(sum(cs.map((c) => c.events)) / cs.length),
    cpuMsPerCall: stat(cs.map((c) => c.cpuMs)),
    wallMsPerCall: stat(cs.map((c) => c.wallMs)),
    estimate: {
      label: 'E',
      processesSavedPerCall: round1(sum(cs.map((c) => c.savedProcs)) / cs.length),
      cpuMsSavedPerCall: round1(median(cs.map((c) => c.savedCpuMs))),
      wallMsSavedPerCall: round1(median(cs.map((c) => c.savedWallMs))),
    },
  })).sort((a, b) => b.calls - a.calls);

  // Parallel or sequential, per event name (events of two or more processes).
  const parMap = new Map();
  for (const c of calls.values()) {
    for (const e of c.events) {
      if (e.procs.length < 2) continue;
      if (!parMap.has(e.event)) parMap.set(e.event, { event: e.event || '(unknown)', multiProcessEvents: 0, parallel: 0, sequential: 0, mixed: 0, spanMs: [], sumMs: [] });
      const g = parMap.get(e.event);
      g.multiProcessEvents += 1;
      g[e.kind] += 1;
      g.spanMs.push(Math.max(...e.procs.map((p) => p.t1)) - Math.min(...e.procs.map((p) => p.t0)));
      g.sumMs.push(sum(e.procs.map((p) => p.wall_ms)));
    }
  }
  const parallelism = [...parMap.values()].map((g) => {
    const verdict = g.parallel >= g.sequential && g.parallel >= g.mixed ? 'parallel'
      : g.sequential >= g.mixed ? 'sequential' : 'mixed';
    return {
      event: g.event, multiProcessEvents: g.multiProcessEvents, parallel: g.parallel, sequential: g.sequential, mixed: g.mixed, verdict,
      medianSpanMs: round1(median(g.spanMs)), medianSumOfWallsMs: round1(median(g.sumMs)),
    };
  }).sort((a, b) => b.multiProcessEvents - a.multiProcessEvents);

  // Each hook's own cost.
  const hookMap = new Map();
  for (const r of rows) {
    if (!hookMap.has(r.hook)) hookMap.set(r.hook, []);
    hookMap.get(r.hook).push(r);
  }
  const byHook = [...hookMap].map(([hook, rs]) => ({
    hook, processes: rs.length, cpuMs: stat(rs.map((r) => r.cpu_ms)), wallMs: stat(rs.map((r) => r.wall_ms)),
  })).sort((a, b) => b.processes - a.processes);

  // Processes with no call id: session events, prompt events, and any hook that
  // read no input (no event name either).
  const otherMap = new Map();
  for (const r of other) {
    const k = r.event || '(no event recorded)';
    if (!otherMap.has(k)) otherMap.set(k, []);
    otherMap.get(k).push(r);
  }
  const otherEvents = [...otherMap].map(([event, rs]) => ({
    event, processes: rs.length, cpuMs: stat(rs.map((r) => r.cpu_ms)), wallMs: stat(rs.map((r) => r.wall_ms)),
  })).sort((a, b) => b.processes - a.processes);

  // Per-day totals. A process counts on the day it ended; a call on the day its last process ended.
  const dayMap = new Map();
  const dayOfRow = (ms) => {
    const d = dayOf(ms);
    if (!dayMap.has(d)) dayMap.set(d, { day: d, processes: 0, toolCalls: 0, cpuMs: 0, processWallMs: 0, toolCallWallMs: 0, estimate: { label: 'E', processesSaved: 0, cpuMsSaved: 0, wallMsSaved: 0 } });
    return dayMap.get(d);
  };
  for (const r of rows) {
    const d = dayOfRow(r.t1);
    d.processes += 1; d.cpuMs += r.cpu_ms; d.processWallMs += r.wall_ms;
  }
  for (const c of callRows) {
    const d = dayOfRow(c.endMs);
    d.toolCalls += 1; d.toolCallWallMs += c.wallMs;
    d.estimate.processesSaved += c.savedProcs; d.estimate.cpuMsSaved += c.savedCpuMs; d.estimate.wallMsSaved += c.savedWallMs;
  }
  const perDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((d) => ({
    ...d, cpuMs: round1(d.cpuMs), processWallMs: round1(d.processWallMs), toolCallWallMs: round1(d.toolCallWallMs),
    estimate: { ...d.estimate, cpuMsSaved: round1(d.estimate.cpuMsSaved), wallMsSaved: round1(d.estimate.wallMsSaved) },
  }));

  const tot = {
    processes: rows.length,
    toolCalls: callRows.length,
    cpuMs: round1(sum(rows.map((r) => r.cpu_ms))),
    estimate: {
      label: 'E',
      processesSaved: sum(callRows.map((c) => c.savedProcs)),
      cpuMsSaved: round1(sum(callRows.map((c) => c.savedCpuMs))),
      wallMsSaved: round1(sum(callRows.map((c) => c.savedWallMs))),
    },
  };

  return {
    from: rows.length ? new Date(Math.min(...rows.map((r) => r.t0))).toISOString() : null,
    to: rows.length ? new Date(Math.max(...rows.map((r) => r.t1))).toISOString() : null,
    floor: { cpuMs: round1(floor.cpuMs), wallMs: round1(floor.wallMs), hook: floor.hook, basis: floor.basis },
    totals: tot,
    byTool,
    parallelism,
    byHook,
    otherEvents,
    perDay,
  };
}

const f1 = (x) => (x === null || x === undefined ? '-' : String(round1(x)));
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

export function renderText(res, windowLabel = '') {
  const L = [];
  L.push(`hook-timing${windowLabel ? ` — ${windowLabel}` : ''}`);
  if (!res.totals.processes) {
    L.push('no hook-timing rows in this window (option hook_timing_telemetry on? file: telemetry/hook-timing.jsonl)');
    return L.join('\n');
  }
  L.push(`rows: ${res.totals.processes} processes, ${res.totals.toolCalls} tool calls, ${res.from} to ${res.to}`);
  L.push('Time is process start to exit, Node startup included (OS process creation not counted).');
  L.push('');
  L.push('Processes and cost per tool call, by tool (a call = its Pre and Post events together)');
  L.push(`${pad('tool', 22)}${rpad('calls', 7)}${rpad('proc/call', 11)}${rpad('events', 8)}${rpad('cpu med', 9)}${rpad('cpu p90', 9)}${rpad('wall med', 10)}${rpad('wall p90', 10)}`);
  for (const t of res.byTool) {
    L.push(`${pad(t.tool, 22)}${rpad(t.calls, 7)}${rpad(`${f1(t.processesPerCall.mean)}`, 11)}${rpad(f1(t.eventsPerCall), 8)}${rpad(f1(t.cpuMsPerCall.median), 9)}${rpad(f1(t.cpuMsPerCall.p90), 9)}${rpad(f1(t.wallMsPerCall.median), 10)}${rpad(f1(t.wallMsPerCall.p90), 10)}`);
  }
  L.push('(cpu and wall in ms per call)');
  L.push('');
  L.push('Did an event\'s hooks run in parallel or in sequence? (judged from recorded start and end times)');
  if (!res.parallelism.length) L.push('  no event had two or more processes in this window');
  for (const p of res.parallelism) {
    L.push(`  ${pad(p.event, 20)}${p.verdict.toUpperCase()}: of ${p.multiProcessEvents} multi-hook events, ${p.parallel} parallel, ${p.sequential} sequential, ${p.mixed} mixed; median span ${f1(p.medianSpanMs)} ms, sum of process walls ${f1(p.medianSumOfWallsMs)} ms`);
  }
  L.push('  Wall rule: parallel = span (latest end - earliest start); sequential = sum of process walls; mixed = span.');
  L.push('');
  L.push(`Estimate E: one process per event instead of one per hook (per call, median; floor = ${f1(res.floor.cpuMs)} ms CPU / ${f1(res.floor.wallMs)} ms wall${res.floor.hook ? `, from ${res.floor.hook}` : ''})`);
  L.push(`${pad('tool', 22)}${rpad('procs saved', 13)}${rpad('cpu ms saved', 14)}${rpad('wall ms saved', 15)}`);
  for (const t of res.byTool) {
    L.push(`${pad(t.tool, 22)}${rpad(f1(t.estimate.processesSavedPerCall), 13)}${rpad(f1(t.estimate.cpuMsSavedPerCall), 14)}${rpad(f1(t.estimate.wallMsSavedPerCall), 15)}   (E)`);
  }
  L.push('  E assumes a dispatcher pays the floor once per event plus each hook\'s work above the floor; negative wall = slower.');
  L.push('');
  L.push('Per-day totals (UTC)');
  L.push(`${pad('day', 12)}${rpad('processes', 10)}${rpad('calls', 8)}${rpad('cpu ms', 11)}${rpad('proc wall ms', 14)}${rpad('call wall ms', 14)}${rpad('E procs', 9)}${rpad('E cpu ms', 11)}${rpad('E wall ms', 11)}`);
  for (const d of res.perDay) {
    L.push(`${pad(d.day, 12)}${rpad(d.processes, 10)}${rpad(d.toolCalls, 8)}${rpad(f1(d.cpuMs), 11)}${rpad(f1(d.processWallMs), 14)}${rpad(f1(d.toolCallWallMs), 14)}${rpad(d.estimate.processesSaved, 9)}${rpad(f1(d.estimate.cpuMsSaved), 11)}${rpad(f1(d.estimate.wallMsSaved), 11)}`);
  }
  L.push('');
  L.push('Per hook');
  L.push(`${pad('hook', 22)}${rpad('processes', 10)}${rpad('cpu med', 9)}${rpad('cpu p90', 9)}${rpad('wall med', 10)}${rpad('wall p90', 10)}`);
  for (const h of res.byHook) {
    L.push(`${pad(h.hook, 22)}${rpad(h.processes, 10)}${rpad(f1(h.cpuMs.median), 9)}${rpad(f1(h.cpuMs.p90), 9)}${rpad(f1(h.wallMs.median), 10)}${rpad(f1(h.wallMs.p90), 10)}`);
  }
  if (res.otherEvents.length) {
    L.push('');
    L.push('Processes with no tool-call id (session, prompt and subagent events)');
    for (const o of res.otherEvents) {
      L.push(`  ${pad(o.event, 24)}${rpad(o.processes, 7)} processes, cpu med ${f1(o.cpuMs.median)} ms, wall med ${f1(o.wallMs.median)} ms`);
    }
  }
  return L.join('\n');
}
