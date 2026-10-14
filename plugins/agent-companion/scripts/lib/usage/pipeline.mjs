// The checkup's pipeline (design section 4; 0.31.18 batch 5b). The session-start checkup, started
// detached by hooks/scout-surface.mjs and the scout through launchCheckup, runs these stages in this
// order, all inside the one lock the CLI holds:
//
//   1. scan      runCheckup: transcripts -> history line, facts files (incremental, bounded by the files' growth)
//   2. analysis  runAnalysis: every settled day that has no result yet, deferred days included (a day
//                that was deferred before is retried), oldest first, bounded by `maxSeconds` between days
//   3. status    the analysis status file
//   4. register  the decision register (reads the day records and the results written above)
//
// No model call, no network, no waiter: a day that is not settled yet is recorded "deferred" and the
// next run (the next session start, or the scout at 04:10) picks it up. The budget is checked between
// days, and the first day always runs, so a run always makes progress and never stalls a session.
import { ANALYSIS_BUDGET_SECONDS, runCheckup, checkupOptions, nowMs } from '../daily-checkup.mjs';
import { runAnalysis, writeStatus } from './runner.mjs';
import { runRegister } from '../decision-register.mjs';
import { opt, stateRootPath } from '../../../hooks/lib/context.mjs';

export const PIPELINE_ORDER = Object.freeze(['scan', 'analysis', 'status', 'register']);

const msg = (e) => String((e && e.message) || e).slice(0, 300);

/**
 * Run the pipeline once. Never throws. Returns { out, order, errors }:
 *   out    the scan result (written, factsWritten, filesRead, bytesRead, ...) plus `analysis`
 *          ({ computed, unchanged, deferred, remaining, partial, durationMs }) when the stage ran
 *   order  the stages that ran, in order (the pipeline-order test reads this)
 * Test seams: `deps` replaces any stage function (and `stateRoot`, the analysis root).
 */
export function runPipeline({
  root, nowT = nowMs(), holdMs, maxSeconds = ANALYSIS_BUDGET_SECONDS, scheduled = false, reportDir = null, deps = {},
} = {}) {
  const d = {
    scan: runCheckup, analysis: runAnalysis, status: writeStatus, register: runRegister, ...deps,
  };
  const stateRoot = deps.stateRoot || stateRootPath();
  const order = [];
  const errors = [];
  let out;

  order.push('scan');
  try {
    out = d.scan({ ...(root ? { root } : {}), nowT, ...(holdMs !== undefined ? { holdMs } : {}) });
  } catch (e) {
    out = { error: msg(e) };
    errors.push(`scan: ${out.error}`);
  }

  if (opt('usage_analysis', true)) {
    order.push('analysis');
    const analysis = d.analysis({
      root: stateRoot,
      nowT,
      limitUnits: checkupOptions().limit,
      maxSeconds,
      reportDir: reportDir || opt('usage_analysis_report_dir', '') || null,
    });
    if (analysis && analysis.error) errors.push(`analysis: ${analysis.error}`);
    if (analysis && !analysis.error) {
      out.analysis = {
        computed: analysis.computed || [],
        unchanged: analysis.skipped || [],
        deferred: analysis.deferred || [],
        remaining: analysis.remaining || 0,
        partial: !!analysis.partial,
        durationMs: analysis.durationMs ?? null,
      };
      if (analysis.persisted !== false) {
        order.push('status');
        try {
          d.status(stateRoot, {
            out: analysis,
            run: {
              scheduled,
              scanned: !out.error,
              bytesRead: Number.isFinite(out.bytesRead) ? out.bytesRead : null,
              durationMs: analysis.durationMs,
              peakRssMb: Math.round(process.memoryUsage().rss / 1048576),
            },
            nowT,
            errors,
          });
        } catch (e) { errors.push(`status: ${msg(e)}`); }
      }
    }
  }

  // The decision register reads the day records the scan just wrote and the results above.
  // runRegister never throws, and no register means no work.
  if (!out.error) {
    order.push('register');
    try { if (opt('decision_register', true)) d.register({ nowT }); } catch { /* advisory */ }
  }
  if (errors.length && !out.error) out.errors = errors;
  return { out, order, errors };
}
