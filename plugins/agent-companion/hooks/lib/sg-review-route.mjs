// spawn-guard: route a review spawn to the plan's API credits (0.31.63, options api_review_route and api_review_high).
//
// Measured over a week (the usage root-cause), about 40% of reviews are lead-spawned and 60% writer-spawned, 65% of the writer
// reviews are RISK high, and the manual path in the writer's self-review text left half of the rest unrouted. So the guard routes:
// for a review spawn (a parity TYPE) it asks the credit governor in-process (scripts/lib/api-credits.mjs decide, the one call that
// advances the alternation counter), and on `api` rewrites the spawn into an ac-haiku run of scripts/api-review.mjs, with the
// original brief kept in a state file (state/review-briefs/). Rewrites go through `updatedInput`, never a deny.
//
// Passes through (the spawn runs as written, with a route_reason for the telemetry row) when:
//   - api_review_route is off (the default), or `writers` and the caller is the lead            -> off
//   - the brief carries `API: no` (the retry marker after a failed API run, or a writer that     -> caller-no
//     decided for itself; never loops)
//   - the same brief was routed and failed in the last 30 minutes (a caller that left `API: no`  -> repeat
//     off would loop)
//   - the review has no diff range in its brief (the runner needs one), or two ranges compete   -> no-range | ambiguous-range
//   - RISK is high and api_review_high is `plan` (the default), or the review runs on Opus
//     (unless the brief says `API: opus`)                                                       -> high-risk
//   - the governor answers plan (pace, balance, breaker, no key: governor-fallback; alternation, cap) -> plan-alternation | plan-cap | governor-fallback
//   - the caller is itself a reviewer (the recursion deny owns that spawn)                      -> (no row fields)
// Any error passes through (reason error; fail open). The decision uses the booked ledger only (billing: null): the guard cannot wait on
// the Admin API, so the pace cap, balance and workspace limit see booked spend (README, api_review_route).
// Denials a routed spawn skips: finishSpawn's fit, warrant and premium-cap checks for the ORIGINAL spawn. It is an ac-haiku runner now
// (never premium, nothing to fit), so they do not apply; the hard denials (foreground block, missing TYPE, recursion) ran before the
// rewrite, and notePendingRouted() records the rewritten spawn for SubagentStart pairing, as finishSpawn does for every allowed spawn. The hook never holds a key and never calls the API itself.
//
// Hooks may call scripts/ helpers (precedent: hooks/git-brief.mjs); the governor import is dynamic and inside the try block.

import { mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { opt, stateDir, telemetryDir, tailRecords } from './context.mjs';
import { declarationValue } from './brief-directives.mjs';
import { isParityType } from './self-review.mjs';

const PLUGIN_ROOT = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/'); } catch { return '.'; }
})();

const RANGE_G = /(?:^|[\s`'"(=])((?!\.)[\w./~^@{}-]+\.{2,3}(?!\.)[\w./~^@{}-]+)/g;
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

// The `API:` marker line of a brief: `no` (do not route) or `opus` (an Opus review may be routed).
export function apiMarker(brief) {
  const m = /^[ \t>*_`-]*API[ \t]*:[ \t]*\**[ \t]*(no|opus)\b/im.exec(String(brief || ''));
  return m ? m[1].toLowerCase() : null;
}

// The range the brief means: tokens on a line that names the review's range (`Diff:`, `diff range`, `range`) win over the same shape
// anywhere else (a tag range in prose, `tests...pass`); two different candidates at the winning level are ambiguous (no route).
export function diffRangeInfo(brief) {
  const tokens = (text) => [...new Set([...String(text).matchAll(RANGE_G)].map((m) => m[1].replace(/\.+$/, '')))]; // a sentence-ending period is not part of the ref
  const lines = String(brief || '').split(/\r?\n/);
  const labelled = tokens(lines.filter((l) => /\b(?:diff|range)\b/i.test(l)).join('\n'));
  const found = labelled.length ? labelled : tokens(lines.join('\n'));
  if (found.length > 1) return { range: null, ambiguous: true };
  return { range: found[0] || null, ambiguous: false };
}
export function diffRangeOf(brief) { return diffRangeInfo(brief).range; }

// A short stable hash of the brief text: the repeat guard's key (api-review.mjs writes it on its failed rows).
export function briefHash(brief) { return createHash('sha1').update(String(brief || '')).digest('hex').slice(0, 16); }

const REPEAT_WINDOW_MS = 30 * 60000;
const PRUNE_AFTER_MS = 7 * 86400000;
// Did the API runner already fail on this very brief in the last 30 minutes? (A caller that left `API: no` off would loop.)
export function failedRecently(hash, file, now) {
  try {
    return tailRecords(file, { bytes: 1024 * 1024, filter: (l) => l.includes(hash) })
      .some((r) => r && r.source === 'api-review' && r.ok === false && r.brief_hash === hash && now - Date.parse(r.at) <= REPEAT_WINDOW_MS);
  } catch { return false; }
}
// Brief and review files older than 7 days (the full brief text is kept on disk for the runner and the relay).
export function pruneBriefs(dir, now) {
  try {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      try { if (now - statSync(f).mtimeMs > PRUNE_AFTER_MS) rmSync(f, { force: true }); } catch { /* best effort */ }
    }
  } catch { /* none yet */ }
}

// A routed spawn still joins the session's pending list (what finishSpawn's notePending does for every allowed spawn), as the
// ac-haiku run it now is, so SubagentStart pairs the start with this spawn and consumes no other spawn's entry.
export async function notePendingRouted({ input, sid, isCanary, rewriteState, rewriteModule }) {
  try {
    if (isCanary || (input && input.team_name)) return;
    if (rewriteState && rewriteState.ignored) return;
    const armed = !!rewriteState && (typeof rewriteState.armedAt === 'number' || rewriteState.pending.length > 0);
    if (!armed) return;
    const { notePendingSpawn } = await rewriteModule();
    notePendingSpawn(sid, { type: 'agent-companion:ac-haiku', from: (input && input.subagent_type) || 'general-purpose', rewrite: false, arm: false });
  } catch { /* fail open */ }
}

function worktreeOf(brief, fallback) {
  const m = /^[ \t>*_`-]*(?:WORKTREE|CWD)[ \t]*:[ \t]*\**[ \t]*`?([^`\r\n]+?)`?[ \t]*$/im.exec(String(brief || ''));
  return (m && m[1].trim()) || fallback || process.cwd();
}

// `sonnet/high` from a WRITER line, or null.
function writerOf(decls) {
  const m = decls.WRITER ? /^[ \t*_`]*([a-z][a-z0-9.-]*(?:\/[a-z]+)?)/i.exec(decls.WRITER.rest) : null;
  return m ? m[1].toLowerCase() : null;
}

// The ac-haiku prompt that runs the API review and hands its stdout back unchanged.
export function runnerPrompt({ briefFile, reviewFile, range, writer, risk, cwd, sid, tu, reviewModel = 'sonnet', reviewEffort = 'high' }) {
  // --session-id and --tool-use-id are the ORIGINAL spawn's: the runner writes them on its verdict row so the reviewer-quality readers join it.
  const cmd = `node ${q(`${PLUGIN_ROOT}/scripts/api-review.mjs`)} run --brief-file ${q(briefFile)} --diff-ref ${q(range)} --model ${reviewModel} --effort ${reviewEffort}${writer ? ` --writer ${writer}` : ''}${risk ? ` --risk ${risk}` : ''}${sid && tu ? ` --session-id ${q(sid)} --tool-use-id ${q(tu)}` : ''} --review-file ${q(reviewFile)} --cwd ${q(cwd)}`;
  return [
    'TYPE: operate',
    'ROLE: other',
    '',
    'Run one command and return its output. Do nothing else: read no files, change nothing.',
    '',
    `1. Run this in the background (run_in_background: true) and wait for its completion notice; a review takes several minutes and a foreground call is cut at 10 minutes:`,
    '',
    `   ${cmd}`,
    '',
    `2. When it finishes, if the exit code is 0, reply with its stdout exactly as printed, nothing added or removed from it (it starts with a review and has a VERDICT line), then add one last line: (full review file: ${reviewFile})`,
    '3. If the exit code is nonzero (stdout starts `API review unavailable` or `API review failed`): when the stdout ends with `(review id: <id>)`, first run',
    `   node ${q(`${PLUGIN_ROOT}/scripts/api-credits.mjs`)} record-fallback <id> --reason "<the reason printed>"`,
    '   then reply with exactly this sentence and nothing else, with <reason> the reason printed after `API review failed: ` or `API review unavailable: ` (without the review id): API review failed (<reason>); spawn the review again with the line `API: no` added to the brief.',
  ].join('\n');
}

const row = (route, route_reason) => ({ route, route_reason, updatedInput: null });

export async function routeReview({
  typeIsParity, declaredType, brief, decls, p, input, subagentCaller, model, isCanary, sid, recursionDeny,
  callerDeclaredType, updatedInput, deps = {},
}) {
  try {
    if (!typeIsParity && !(declaredType && isParityType(declaredType))) return null; // not a review
    if (isCanary || recursionDeny) return null;
    if (callerDeclaredType && isParityType(callerDeclaredType)) return null; // a reviewer spawning a reviewer: the recursion rule's, never routed
    const mode = String((deps.opt || opt)('api_review_route', 'off') || 'off').toLowerCase();
    if (mode !== 'writers' && mode !== 'all') return row('subagent', 'off');
    if (mode === 'writers' && !subagentCaller) return row('subagent', 'off');
    const marker = apiMarker(brief);
    if (marker === 'no') return row('subagent', 'caller-no');
    const info = diffRangeInfo(brief);
    if (!info.range) return row('subagent', info.ambiguous ? 'ambiguous-range' : 'no-range');
    const range = info.range;
    const rm = declarationValue(decls || {}, 'RISK', '(low|mid|high)\\b');
    const risk = rm ? rm[1].toLowerCase() : null;
    const highMode = String((deps.opt || opt)('api_review_high', 'plan') || 'plan').toLowerCase();
    if ((risk === 'high' && highMode !== 'api') || (/opus/i.test(String(model || '')) && marker !== 'opus')) return row('subagent', 'high-risk');
    const tdir = deps.telemetryDir ? deps.telemetryDir() : telemetryDir();
    if (failedRecently(briefHash(brief), join(tdir, 'review-verdicts.jsonl'), Date.now())) return row('subagent', 'repeat');
    let d;
    if (deps.decide) d = deps.decide('review', { billing: null, env: process.env });
    else {
      const mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'scripts', 'lib', 'api-credits.mjs')).href);
      d = mod.decide('review', { billing: null, env: process.env });
    }
    if (!d || d.decision !== 'api') {
      const why = String((d && d.reason) || '');
      if (/^alternation/.test(why)) return row('subagent', 'plan-alternation');
      if (/^(no API key|failed closed|API runs failed)/.test(why) || !d) return row('subagent', 'governor-fallback');
      return row('subagent', 'plan-cap');
    }
    const id = String(p && p.tool_use_id || '').replace(/[^\w-]/g, '') || randomUUID();
    const dir = join(deps.stateDir ? deps.stateDir() : stateDir(), 'review-briefs');
    mkdirSync(dir, { recursive: true });
    pruneBriefs(dir, Date.now());
    const briefFile = join(dir, `${id}.md`).replace(/\\/g, '/');
    const reviewFile = join(dir, `${id}-review.md`).replace(/\\/g, '/');
    writeFileSync(briefFile, String(brief || ''));
    const out = {
      ...(updatedInput || input),
      subagent_type: 'agent-companion:ac-haiku',
      model: 'haiku',
      prompt: runnerPrompt({ briefFile, reviewFile, range, writer: writerOf(decls || {}), risk, cwd: worktreeOf(brief, p && p.cwd), sid: (p && p.session_id) || sid, tu: p && p.tool_use_id, reviewModel: marker === 'opus' ? 'opus' : 'sonnet' }),
    };
    delete out.effort;
    delete out.isolation; // a worktree for a command runner is wasted, and the runner must see the brief's own worktree path
    delete out.team_name;
    return { route: 'api', route_reason: 'api', updatedInput: out };
  } catch {
    return row('subagent', 'error'); // fail open: the spawn runs as written
  }
}
