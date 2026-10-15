#!/usr/bin/env node
// usage-analysis.mjs: the daily usage analysis runner (design section 4; 0.31.18 batch 5a).
//
//   node scripts/usage-analysis.mjs [run] [--scheduled] [flags]    scan, then compute every settled day not yet computed
//   node scripts/usage-analysis.mjs status [--json]               the status file (last run, deferred days)
//   node scripts/usage-analysis.mjs report --day <YYYY-MM-DD>     re-render a stored result's report (no scan, no compute)
//   node scripts/usage-analysis.mjs init --from-register [--register FILE] [--dry-run]
//                                                                 propose the user config from the decision register: written only when
//                                                                 <root>/config/usage-analysis.json is absent, otherwise a diff is printed
//
// Flags (run):
//   --scheduled          unattended: no prompts; it waits (sleeping, up to --lock-wait-seconds, default 100) only for a lock another run holds; a day that is not settled is
//                        recorded "deferred" in the status file and picked up by the next run; exit 0.
//                        Bounded by default: --max-seconds 120 and --max-days 14 unless you pass your own.
//                        Honours the plugin option usage_analysis: when it is off, prints one line and exits 0.
//   --root DIR           state root (default: the plugin state root); every path below it follows
//   --transcripts DIR    transcripts to scan (default: AGENT_COMPANION_TRANSCRIPTS_ROOT or ~/.claude/projects)
//   --now ISO            the clock (also AGENT_COMPANION_FAKE_NOW)
//   --hold-ms N          the scan leaves files modified within the last N ms for the next run (default 120000)
//   --max-seconds N      stop starting new days after N seconds of analysis; the rest resumes on the next run (the first day
//                        always runs; the transcript scan before it is not counted). Default with --scheduled: 120; otherwise none
//   --max-days N         compute at most N days per run; the rest resumes on the next run. Default with --scheduled: 14 (not applied
//                        to --day or --from/--to, which name the days to compute); otherwise none
//   --day D | --from D --to D   compute these days only (not limited to the default per-run count)
//   --scenario A,B       restrict to these scenario ids (a dry look: nothing is persisted)
//   --force              recompute days whose inputs are unchanged (the output is byte-identical)
//   --dry-run            compute, write nothing at all under --root: no transcript scan (so no scan state and no facts), no lock,
//                        no status, no reports; it analyses the facts already on disk
//   --no-scan            skip the transcript scan (analyse the facts already on disk)
//   --no-register        skip the decision register after the analysis
//   --report-dir DIR     where the dated reports go (default <root>/reports/usage; plugin option usage_analysis_report_dir)
//   --json               machine output     --quiet   print nothing
//
// The run holds the checkup's lock (state/daily-checkup.lock) for the scan and the analysis, so it never
// overlaps a checkup; a hand-typed run that finds the lock taken prints { skipped } and exits 0; a --scheduled run waits for it (see above) and, if it is still held at the bound, prints { skipped, lockTimeout: true } and exits 3. No model call, no
// network, no child process of its own. Exit 0 whatever happens when --scheduled (except 3, lock still held after the wait); otherwise 1 on an error, 2 on bad usage.

import { isMain } from './lib/is-main.mjs';
import { runAnalysis, writeStatus, readStatus, readLatest, rerenderReport, usagePaths } from './lib/usage/runner.mjs';
import { isDayKey } from './lib/usage/days.mjs';

const VALUE_FLAGS = new Set(['root', 'transcripts', 'now', 'hold-ms', 'max-seconds', 'max-days', 'day', 'from', 'to', 'scenario', 'report-dir', 'register', 'lock-wait-seconds', 'lock-poll-ms']);
// The scout calls `--scheduled` in a foreground step, so the run is bounded unless the caller says otherwise.
export const SCHEDULED_MAX_SECONDS = 120;
export const SCHEDULED_MAX_DAYS = 14;
// A --scheduled run that meets a live lock waits this long for the holder (inside the ~120 s budget), then gives up with exit 3.
export const SCHEDULED_LOCK_WAIT_SECONDS = 100;
export const SCHEDULED_LOCK_POLL_MS = 1000;
export const EXIT_LOCK_TIMEOUT = 3;

const BOOL_FLAGS = new Set(['scheduled', 'force', 'dry-run', 'no-scan', 'no-register', 'json', 'quiet', 'from-register']);

export function parseArgs(argv) {
  const o = { cmd: 'run', flags: {}, rest: [] };
  let first = true;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) o.flags[k] = true;
      else if (VALUE_FLAGS.has(k)) {
        if (i + 1 >= argv.length) return { error: `--${k} needs a value` };
        o.flags[k] = argv[i + 1]; i += 1;
      } else return { error: `unknown flag ${a}` };
    } else if (first && ['run', 'status', 'report', 'init'].includes(a)) { o.cmd = a; first = false; } else { o.rest.push(a); first = false; }
  }
  return o;
}

function human(out, latest, run) {
  const lines = [];
  if (out.skipped) return [`usage analysis skipped: ${out.skipped}`];
  if (out.error) return [`usage analysis failed: ${out.error}`];
  lines.push(`usage analysis: computed ${out.computed.length}, unchanged ${out.skipped_days ?? 0}, deferred ${out.deferred.length}${out.partial ? ' (more days remain; the next run resumes)' : ''}`);
  for (const d of out.deferred) lines.push(`  deferred ${d.day}: ${d.kind}: ${d.reason}`);
  if (latest) for (const l of latest.lines) lines.push(l);
  return lines;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const o = parseArgs(argv);
  if (o.error) { out(o.error); return 2; }
  const f = o.flags;
  const scheduled = !!f.scheduled;
  if (f.root) process.env.AGENT_COMPANION_STATE_DIR = f.root;
  if (f.transcripts) process.env.AGENT_COMPANION_TRANSCRIPTS_ROOT = f.transcripts;
  for (const k of ['day', 'from', 'to']) if (f[k] !== undefined && !isDayKey(f[k])) { out(`--${k} must be a day like 2026-10-12`); return 2; }
  if (f['max-seconds'] !== undefined && !(Number(f['max-seconds']) >= 0)) { out('--max-seconds must be a number of seconds'); return 2; }

  if (f['max-days'] !== undefined && !(Number.isInteger(Number(f['max-days'])) && Number(f['max-days']) > 0)) { out('--max-days must be a whole number of days, at least 1'); return 2; }

  // Library imports come after the environment is set: every state path is resolved lazily from it.
  const ctx = await import('../hooks/lib/context.mjs');
  const dc = await import('./lib/daily-checkup.mjs');
  const stateRoot = ctx.stateRootPath();

  if (o.cmd === 'status') {
    const s = readStatus(stateRoot);
    const latest = readLatest(stateRoot);
    if (f.json) out(JSON.stringify({ status: s, latest }, null, 2));
    else if (!s) out('no usage analysis has run yet');
    else {
      out(`last run ${s.lastRun.at}: computed ${s.lastRun.computed.length}, deferred ${s.deferred.length}${s.lastRun.partial ? ', more days remain' : ''}`);
      for (const d of s.deferred) out(`  deferred ${d.day}: ${d.kind}: ${d.reason}`);
      if (latest) for (const l of latest.lines) out(l);
    }
    return 0;
  }
  if (o.cmd === 'init') {
    if (!f['from-register']) { out('init needs --from-register'); return 2; }
    const { runInit } = await import('./lib/usage/init.mjs');
    const r = runInit({ root: stateRoot, ...(f.register ? { registerFile: f.register } : {}), dryRun: !!f['dry-run'] });
    const shown = r.path.replace(/\\/g, '/');
    if (r.action === 'no-register') { out(r.error); return 1; }
    if (r.action === 'wrote') out(`wrote ${shown}`);
    else if (r.action === 'would-write') { out(`would write ${shown}`); out(r.text.replace(/\n$/, '')); }
    else if (r.action === 'identical') out(`${shown} already matches the proposal`);
    else { out(`${shown} exists and was not changed; diff (- yours, + proposal):`); for (const l of r.diff) out(l); }
    for (const p of r.problems || []) out(`proposal problem: ${p}`);
    return 0;
  }
  if (o.cmd === 'report') {
    if (!f.day) { out('report needs --day <YYYY-MM-DD>'); return 2; }
    const r = rerenderReport(stateRoot, f.day, { reportDir: f['report-dir'] || null, dryRun: !!f['dry-run'] });
    if (r.error) { out(r.error); return 1; }
    out(f['dry-run'] ? r.text : `${r.written ? 'wrote' : 'unchanged'}: ${r.path.replace(/\\/g, '/')}`);
    return 0;
  }

  // The plugin option usage_analysis ("Off: neither the stage nor the summary runs") holds on this path too: the scout
  // calls `--scheduled` every morning, and an operator who turned the analysis off must not get it from there.
  // A run typed by hand (no --scheduled) is the operator asking for it and still runs.
  if (scheduled && !ctx.opt('usage_analysis', true)) {
    if (!f.quiet) out('usage analysis is off (plugin option usage_analysis=false); nothing was run');
    return 0;
  }

  const nowArg = f.now ? Date.parse(f.now) : NaN;
  if (f.now && !Number.isFinite(nowArg)) { out('--now must be an ISO time'); return 2; }
  const nowT = Number.isFinite(nowArg) ? nowArg : dc.nowMs();
  const result = { };
  const run = { scheduled };
  let code = 0;
  // A dry run reads only: it takes no lock, because it writes nothing under the root.
  const dry = !!f['dry-run'];
  let locked = dry ? true : dc.takeLock();
  // A --scheduled run waits for a live holder (the session-start checkup's detached run, say), sleeping between checks and
  // bounded by the lock-wait budget, then runs: the holder's day is found already computed and recorded as unchanged.
  // A stale lock never reaches this loop (takeLock removes it). A run typed by hand keeps the old skip-at-once behaviour.
  let lockTimeout = false;
  if (!locked && scheduled) {
    const waitS = f['lock-wait-seconds'] !== undefined && Number(f['lock-wait-seconds']) >= 0 ? Number(f['lock-wait-seconds']) : SCHEDULED_LOCK_WAIT_SECONDS;
    const pollMs = f['lock-poll-ms'] !== undefined && Number(f['lock-poll-ms']) > 0 ? Number(f['lock-poll-ms']) : SCHEDULED_LOCK_POLL_MS;
    const until = Date.now() + waitS * 1000;
    while (!locked && Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
      locked = dc.takeLock();
    }
    lockTimeout = !locked;
  }
  if (!locked) {
    Object.assign(result, { skipped: lockTimeout ? 'lock still held after the wait' : 'another run holds the lock', computed: [], deferred: [], ...(lockTimeout ? { lockTimeout: true } : {}) });
  } else {
    const errors = [];
    try {
      let scan = null;
      if (!f['no-scan'] && !dry) {
        try { scan = dc.runCheckup({ root: f.transcripts || undefined, nowT, ...(f['hold-ms'] !== undefined && Number.isFinite(Number(f['hold-ms'])) ? { holdMs: Number(f['hold-ms']) } : {}) }); } catch (e) { errors.push(`scan: ${String((e && e.message) || e).slice(0, 200)}`); }
      }
      run.scanned = scan;
      run.bytesRead = scan ? scan.bytesRead : null;
      const reportDir = f['report-dir'] || ctx.opt('usage_analysis_report_dir', '') || null;
      const days = f.day ? [f.day] : null;
      const explicitDays = !!(f.day || f.from || f.to);
      const analysis = runAnalysis({
        root: stateRoot,
        nowT,
        limitUnits: dc.checkupOptions().limit,
        days,
        from: f.from, to: f.to,
        scenarios: f.scenario ? f.scenario.split(',').map((s) => s.trim()).filter(Boolean) : null,
        maxSeconds: f['max-seconds'] !== undefined ? Number(f['max-seconds']) : (scheduled ? SCHEDULED_MAX_SECONDS : undefined),
        maxDays: f['max-days'] !== undefined ? Number(f['max-days']) : (scheduled && !explicitDays ? SCHEDULED_MAX_DAYS : undefined),
        force: !!f.force,
        dryRun: !!f['dry-run'],
        reportDir,
      });
      if (analysis.error) errors.push(`analysis: ${analysis.error}`);
      Object.assign(result, analysis, { skipped_days: (analysis.skipped || []).length });
      delete result.skipped; delete result.results;
      result.unchanged = analysis.skipped || [];
      if (!f['dry-run'] && analysis.persisted !== false) {
        run.durationMs = analysis.durationMs;
        run.peakRssMb = Math.round(process.memoryUsage().rss / 1048576);
        run.scanned = !!scan;
        try { writeStatus(stateRoot, { out: analysis, run, nowT, errors }); } catch (e) { errors.push(`status: ${String((e && e.message) || e).slice(0, 200)}`); }
      }
      if (!f['no-register'] && !f['dry-run'] && ctx.opt('decision_register', true)) {
        try { (await import('./lib/decision-register.mjs')).runRegister({ nowT }); } catch { /* advisory */ }
      }
      if (errors.length) { result.errors = errors; code = 1; }
    } catch (e) {
      Object.assign(result, { error: String((e && e.message) || e).slice(0, 300), computed: [], deferred: [] });
      code = 1;
    } finally {
      if (!dry) dc.dropLock();
    }
  }
  if (!f.quiet) {
    if (f.json || scheduled) out(JSON.stringify({ computed: result.computed, unchanged: result.unchanged || [], deferred: result.deferred, remaining: result.remaining || 0, skipped: result.skipped, lockTimeout: result.lockTimeout, error: result.error, errors: result.errors }));
    else {
      const latest = readLatest(stateRoot);
      for (const l of human({ ...result, skipped: result.skipped }, latest, run)) out(l);
    }
  }
  if (scheduled) return result.lockTimeout ? EXIT_LOCK_TIMEOUT : 0;
  return code;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${String((e && e.message) || e)}\n`); process.exitCode = 1; });
}

export { usagePaths };
