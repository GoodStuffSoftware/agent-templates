#!/usr/bin/env node
// Machine-capacity probe -- a cheap, dependency-free estimate of how many
// concurrent Claude Code SESSIONS this machine can reasonably carry right
// now.
//
// What the budget counts, precisely: OS-level Claude Code session processes
// -- the top-level `claude` process for each running session (main threads,
// and split-pane teammates, which are each "a full, independent Claude Code
// session" per code.claude.com/docs/en/agent-teams.md). It does NOT count
// in-process teammates or ordinary subagents individually: per that same
// doc, in-process teammates "run inside your main terminal" and a teammate's
// own subagents "run in the foreground, because a teammate's background work
// can't outlive the lead's process" -- i.e. they share their parent
// session's OS process and its memory footprint rather than costing a
// process of their own. So perAgentMB is calibrated against, and the whole
// budget describes, concurrent SESSION processes; fanning out many in-process
// subagents/teammates inside one session shows up as that one session's RSS
// growing, not as additional counted processes.
//
// This is a GUESS, not a scheduler. It reads os.totalmem()/os.freemem()
// (works on Windows too -- freemem() reports the OS "available" counter,
// not just unused pages, which is the number that matters for "can I start
// another process") plus cpu/parallelism, converts free memory into a
// concurrency budget using a per-session memory estimate, and classifies the
// result into a short policy string the SessionStart hook (and the operator)
// can act on without doing the arithmetic themselves.
//
// Everything that touches the real machine is isolated behind two functions
// -- collectSystemStats() and countLiveAgentProcesses() -- so tests exercise
// the actual decision logic (computeBudget/buildReport) with synthetic
// inputs and never depend on the machine they happen to run on. The process
// MATCHER (isClaudeCodeSessionProcess/isElectronDesktopProcess) is exported
// separately so it too can be tested with synthetic path/command-line
// strings for both platforms without touching the real process table.
//
// perAgentMB default: measured on a live desktop machine running 10 real
// Claude Code sessions (2026-09-23) via WorkingSetSize -- min 219MB, median
// 346MB, max 679MB. 350 (rounded up from the median) replaces the earlier
// 300MB placeholder; see the commit that introduced this comment for the
// full measurement. Session RSS varies a lot with context size and how much
// in-process subagent/teammate work that session is carrying, so this stays
// a rough default, overridable via capacity_per_agent_mb / --per-agent-mb.
//
// Process counting is best-effort and OS-specific (PowerShell + WMI on
// Windows, ps elsewhere). It is never allowed to throw or hang the caller: a
// short timeout plus a catch-all means a failure here degrades to
// liveAgentProcesses: null, not a broken probe.

import { totalmem, freemem, cpus, availableParallelism as osAvailableParallelism } from 'node:os';
import { execFileSync } from 'node:child_process';
import { opt } from '../hooks/lib/context.mjs';

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

// budget = floor((free - headroom) / perSession), clamped to >= 1. A machine
// that is technically over its headroom still gets a budget of 1 -- "you can
// run one more, carefully" is a more useful answer than "zero", which reads
// as "do not start anything" when the real situation is "start cautiously".
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
  perAgentMB = 350,
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

// ---------------------------------------------------------------------------
// Process matcher. A Claude Code SESSION process vs. the Claude desktop
// (Electron) app and its helper processes -- measured against this machine's
// real process table (2026-09-23):
//
//   - Session:  <home>\AppData\Roaming\Claude\claude-code\<version>\claude.exe
//               (Windows), or a `claude` CLI / `@anthropic-ai/claude-code`
//               invocation on POSIX.
//   - Desktop:  <install>\WindowsApps\Claude_<version>...\app\Claude.exe on
//               Windows, or a `*.app/Contents/...` bundle on macOS, PLUS its
//               Electron helper processes (crashpad-handler, gpu-process,
//               utility, renderer, ...), all of which carry a `--type=...`
//               flag and none of which are session processes.
//
// Both matchers take {executablePath, commandLine} so a caller with only one
// of the two (POSIX `ps` gives a command line but no separate executable
// path) still works -- exported separately from countLiveAgentProcesses so
// tests can exercise them with synthetic strings for both platforms without
// touching the real process table.
export function isElectronDesktopProcess({ executablePath = '', commandLine = '' } = {}) {
  const path = String(executablePath || '');
  const cmd = String(commandLine || '');
  if (/[\\/]WindowsApps[\\/]Claude_/i.test(path)) return true; // Windows Store install path
  if (/\.app[\\/]Contents[\\/]/i.test(path) || /\.app[\\/]Contents[\\/]/i.test(cmd)) return true; // macOS bundle
  if (/--type=/.test(cmd)) return true; // Electron helper flag: crashpad-handler/gpu-process/utility/renderer/...
  return false;
}

export function isClaudeCodeSessionProcess({ executablePath = '', commandLine = '' } = {}) {
  if (isElectronDesktopProcess({ executablePath, commandLine })) return false;
  const path = String(executablePath || '');
  const cmd = String(commandLine || '');
  // Windows: .../claude-code/<version>/claude.exe (forward or back slashes).
  if (/[\\/]claude-code[\\/][^\\/]+[\\/]claude\.exe$/i.test(path.trim())) return true;
  // POSIX / any platform: an @anthropic-ai/claude-code install path anywhere
  // in the executable path or command line ...
  if (/claude-code/i.test(path) || /claude-code/i.test(cmd)) return true;
  // ... or the bare `claude` CLI binary/shim as the invoked command (first
  // path segment before the first space/EOL is exactly "claude").
  if (/(^|[\\/])claude(\s|$)/i.test(cmd.trim())) return true;
  return false;
}

// Best-effort count of currently-running Claude Code SESSION processes (see
// the matcher block above for exactly what counts). Excludes the Claude
// desktop app and its Electron helper processes.
//
// Windows: PowerShell + Get-CimInstance Win32_Process, filtered to
// Name='claude.exe' (matches the session binary AND the desktop app's
// Claude.exe -- WMI name matching is case-insensitive on Windows -- so the
// matcher above does the real discrimination), projecting both
// ExecutablePath and CommandLine as JSON. `wmic` (the traditional source for
// this) is absent on current Windows builds; Get-CimInstance is its
// supported replacement and needs no elevation. If PowerShell itself is
// unavailable, this fails to null rather than guessing from Name alone.
//
// POSIX: `ps -eo args` grepped through the same matcher (command line only;
// there is no separate ExecutablePath column here).
//
// Hard timeout so a slow or hung process-listing tool can never stall a
// SessionStart hook or a probe run -- this must degrade to null, never hang.
export function countLiveAgentProcesses({ timeoutMs = 1500 } = {}) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" "
          + '| Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      );
      const trimmed = out.trim();
      if (!trimmed) return 0;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { return null; } // malformed output: do not guess
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.filter((r) => isClaudeCodeSessionProcess({
        executablePath: r?.ExecutablePath, commandLine: r?.CommandLine,
      })).length;
    }
    const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: timeoutMs });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const hits = lines.filter((l) => !/^COMMAND$/i.test(l) && !/\bps\s+-eo\b/.test(l)
      && isClaudeCodeSessionProcess({ commandLine: l }));
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
  const resolvedPerAgentMB = perAgentMB ?? opt('capacity_per_agent_mb', 350);
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
  const sessions = report.liveAgentProcesses == null ? 'unknown' : String(report.liveAgentProcesses);
  return `${report.totalGB} GB total, ${report.freeGB} GB free, ${report.cpus ?? '?'} cpus, `
    + `${sessions} live Claude Code session process(es) -> budget ${report.concurrencyBudget} concurrent sessions `
    + `(${report.policy})`;
}

// Short line for the SessionStart context, matching the style of the other
// "[agent-companion] ..." lines the plugin already injects (scout-surface,
// memory-budget). Deliberately compact -- this shares an instruction budget
// with the other hooks firing at the same event. Says "sessions", not
// "agents": the budget counts OS-level Claude Code session processes, not
// in-process subagents/teammates, which share their parent session's process
// and memory instead of costing one of their own -- see the file header.
export function formatHookLine(report) {
  const policyLabel = report.policy === 'idle-teammates-ok' ? 'idle teammates OK' : 'stop teammates between rounds';
  return `[agent-companion] capacity: ${report.totalGB} GB total, ${report.freeGB} GB free `
    + `-> budget ${report.concurrencyBudget} concurrent Claude Code sessions; ${policyLabel}`;
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
