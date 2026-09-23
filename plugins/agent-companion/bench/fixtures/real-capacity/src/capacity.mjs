#!/usr/bin/env node
// Machine-capacity probe -- a cheap, dependency-free estimate of how many
// concurrent subagents this machine can reasonably carry right now.
//
// This is a GUESS, not a scheduler. It reads os.totalmem()/os.freemem()
// (works on Windows too -- freemem() reports the OS "available" counter,
// not just unused pages, which is the number that matters for "can I start
// another process") plus cpu/parallelism, converts free memory into a
// concurrency budget using a per-agent memory estimate, and classifies the
// result into a short policy string the SessionStart hook (and the operator)
// can act on without doing the arithmetic themselves.
//
// Everything that touches the real machine is isolated behind two functions
// -- collectSystemStats() and countLiveAgentProcesses() -- so tests exercise
// the actual decision logic (computeBudget/buildReport) with synthetic
// inputs and never depend on the machine they happen to run on.
//
// Process counting is best-effort and OS-specific (wmic on Windows, ps
// elsewhere). It is never allowed to throw or hang the caller: a short
// timeout plus a catch-all means a failure here degrades to
// liveAgentProcesses: null, not a broken probe.

import { totalmem, freemem, cpus, availableParallelism as osAvailableParallelism } from 'node:os';
import { execFileSync } from 'node:child_process';
function opt(key, fallback) { return fallback; } // local stub: real option-resolution lives elsewhere and is out of scope here

const GB = 1024 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure math. No I/O, no os module, no process spawning -- fully unit-testable
// with synthetic numbers.
// ---------------------------------------------------------------------------

// headroomGB = max(4, 25% of total) -- always reserve at least 4GB for the OS
// and the current session own process, scaling up on bigger machines so a
// 128GB box does not get the same tiny reservation as an 8GB laptop.
export function computeHeadroomGB(totalGB, { minGB = 4, fraction = 0.25 } = {}) {
  return Math.max(minGB, totalGB * fraction);
}

// budget = floor((free - headroom) / perAgent), clamped to >= 1. A machine
// that is technically over its headroom still gets a budget of 1 -- "you can
// run one more, carefully" is a more useful answer than "zero", which reads
// as "do not spawn anything" when the real situation is "spawn cautiously".
export function computeConcurrencyBudget(freeGB, headroomGB, perAgentGB) {
  const usable = freeGB - headroomGB;
  const raw = Math.floor(usable / perAgentGB);
  return Math.max(1, raw);
}

export function computePolicy(concurrencyBudget, threshold) {
  return concurrencyBudget >= threshold
    ? {
      policy: 'idle-teammates-ok',
      reason: `budget ${concurrencyBudget} >= threshold ${threshold}: plenty of headroom, idle/named teammates are fine`,
    }
    : {
      policy: 'stop-between-rounds',
      reason: `budget ${concurrencyBudget} < threshold ${threshold}: shut teammates down between rounds instead of leaving them idle`,
    };
}

// The full computation from already-known numbers. Takes GB throughout so
// tests read naturally ("a 16GB box with 2GB free") without byte arithmetic.
export function computeBudget({
  totalGB,
  freeGB,
  cpuCount = null,
  availableParallelism = null,
  liveAgentProcesses = null,
  perAgentMB = 300,
  headroomGB = null,
  concurrencyThreshold = 12,
}) {
  const perAgentGB = perAgentMB / 1024;
  const headroom = headroomGB == null ? computeHeadroomGB(totalGB) : headroomGB;
  const concurrencyBudget = computeConcurrencyBudget(freeGB, headroom, perAgentGB);
  const { policy, reason } = computePolicy(concurrencyBudget, concurrencyThreshold);

  return {
    totalGB: round2(totalGB),
    freeGB: round2(freeGB),
    cpus: cpuCount,
    availableParallelism,
    liveAgentProcesses,
    perAgentMB,
    headroomGB: round2(headroom),
    concurrencyBudget,
    policy,
    reason,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Machine I/O. Kept separate and individually catchable so a failure in
// process-counting never takes down the memory/cpu read, and a failure in
// either never takes down the caller.
// ---------------------------------------------------------------------------

export function collectSystemStats() {
  let totalBytes = 0;
  let freeBytes = 0;
  let cpuCount = null;
  let availableParallelism = null;
  try { totalBytes = totalmem(); } catch { /* leave 0 */ }
  try { freeBytes = freemem(); } catch { /* leave 0 */ }
  try { cpuCount = cpus().length; } catch { /* leave null */ }
  try {
    // Node 19+. Accounts for cgroup/affinity limits that cpus().length does
    // not. Falls back to cpuCount below when the API is absent (older Node).
    availableParallelism = typeof osAvailableParallelism === 'function' ? osAvailableParallelism() : null;
  } catch { /* leave null */ }
  return { totalBytes, freeBytes, cpuCount, availableParallelism };
}

// Best-effort count of currently-running Claude Code agent processes.
// Windows: PowerShell + Get-CimInstance Win32_Process, filtered to node.exe,
// projecting CommandLine. Name alone (tasklist) cannot distinguish a Claude
// Code agent from any other node.exe process, so the command line is what is
// actually needed. wmic (the traditional source for this) is absent on
// current Windows builds; Get-CimInstance is its supported replacement and
// needs no elevation. If PowerShell itself is unavailable, this fails to
// null rather than guessing from Name alone.
// POSIX: `ps -eo args` grepped for a claude CLI invocation.
// Hard timeout so a slow or hung process-listing tool can never stall a
// SessionStart hook or a probe run -- this must degrade to null, never hang.
const AGENT_CMDLINE_PATTERN = /claude[-_]?code|anthropic-ai.claude-code|\bclaude\.(js|mjs|cmd|exe)\b/i;

export function countLiveAgentProcesses({ timeoutMs = 1500 } = {}) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object -ExpandProperty CommandLine',
        ],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      );
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const hits = lines.filter((l) => AGENT_CMDLINE_PATTERN.test(l));
      return hits.length;
    }
    const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: timeoutMs });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hits = lines.filter((l) => AGENT_CMDLINE_PATTERN.test(l) && !/\bps\s+-eo\b/.test(l));
    return hits.length;
  } catch {
    return null; // no tool available, timed out, or denied -- best effort only
  }
}

// ---------------------------------------------------------------------------
// Full report: real machine stats + options/CLI overrides. This is what the
// CLI and the SessionStart hook both call.
// ---------------------------------------------------------------------------

export function buildReport({
  perAgentMB,
  headroomGB,
  concurrencyThreshold,
  includeProcessCount = true,
  processTimeoutMs = 1500,
} = {}) {
  const stats = collectSystemStats();
  const liveAgentProcesses = includeProcessCount
    ? countLiveAgentProcesses({ timeoutMs: processTimeoutMs })
    : null;

  const optHeadroom = opt('capacity_headroom_gb', 0);
  const resolvedPerAgentMB = perAgentMB ?? opt('capacity_per_agent_mb', 300);
  const resolvedHeadroomGB = headroomGB ?? (optHeadroom > 0 ? optHeadroom : null);
  const resolvedThreshold = concurrencyThreshold ?? opt('capacity_concurrency_threshold', 12);

  return computeBudget({
    totalGB: stats.totalBytes / GB,
    freeGB: stats.freeBytes / GB,
    cpuCount: stats.cpuCount,
    availableParallelism: stats.availableParallelism ?? stats.cpuCount,
    liveAgentProcesses,
    perAgentMB: resolvedPerAgentMB,
    headroomGB: resolvedHeadroomGB,
    concurrencyThreshold: resolvedThreshold,
  });
}

export function formatText(report) {
  const agents = report.liveAgentProcesses == null ? 'unknown' : String(report.liveAgentProcesses);
  return `${report.totalGB} GB total, ${report.freeGB} GB free, ${report.cpus ?? '?'} cpus, `
    + `${agents} live agent process(es) -> budget ${report.concurrencyBudget} concurrent agents `
    + `(${report.policy})`;
}

// Short line for the SessionStart context, matching the style of the other
// "[agent-companion] ..." lines the plugin already injects (scout-surface,
// memory-budget). Deliberately compact -- this shares an instruction budget
// with the other hooks firing at the same event.
export function formatHookLine(report) {
  const policyLabel = report.policy === 'idle-teammates-ok' ? 'idle teammates OK' : 'stop teammates between rounds';
  return `[agent-companion] capacity: ${report.totalGB} GB total, ${report.freeGB} GB free `
    + `-> budget ${report.concurrencyBudget} concurrent agents; ${policyLabel}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function isMain() {
  try {
    const argPath = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
    return import.meta.url === `file://${argPath}` || import.meta.url === `file:///${argPath}`;
  } catch {
    return false;
  }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

  const perAgentMB = val('--per-agent-mb') != null ? Number(val('--per-agent-mb')) : undefined;
  const headroomGB = val('--headroom-gb') != null ? Number(val('--headroom-gb')) : undefined;
  const concurrencyThreshold = val('--threshold') != null ? Number(val('--threshold')) : undefined;
  const noProcs = has('--no-process-count');

  const report = buildReport({
    perAgentMB,
    headroomGB,
    concurrencyThreshold,
    includeProcessCount: !noProcs,
  });

  if (has('--text')) {
    console.log(formatText(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
