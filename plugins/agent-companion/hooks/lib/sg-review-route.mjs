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
//   - the brief carries `API: no` (the retry marker after a failed API run; never loops)        -> fallback
//   - the review has no diff range in its brief (the runner needs one)                          -> no-range
//   - RISK is high and api_review_high is `plan` (the default), or the review runs on Opus
//     (unless the brief says `API: opus`)                                                       -> high-risk
//   - the governor answers plan (pace, balance, breaker, no key: fallback; alternation, cap)    -> plan-alternation | plan-cap | fallback
//   - the caller is itself a reviewer (the recursion deny owns that spawn)                      -> (no row fields)
// Any error passes through (fail open). The hook never holds a key and never calls the API itself.
//
// Hooks may call scripts/ helpers (precedent: hooks/git-brief.mjs); the governor import is dynamic and inside the try block.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { opt, stateDir } from './context.mjs';
import { declarationValue } from './brief-directives.mjs';
import { isParityType } from './self-review.mjs';

const PLUGIN_ROOT = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/'); } catch { return '.'; }
})();

const RANGE = /(?:^|[\s`'"(=])((?!\.)[\w./~^@{}-]+\.{2,3}(?!\.)[\w./~^@{}-]+)/;
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

// The `API:` marker line of a brief: `no` (do not route) or `opus` (an Opus review may be routed).
export function apiMarker(brief) {
  const m = /^[ \t>*_`-]*API[ \t]*:[ \t]*\**[ \t]*(no|opus)\b/im.exec(String(brief || ''));
  return m ? m[1].toLowerCase() : null;
}

export function diffRangeOf(brief) {
  const m = RANGE.exec(String(brief || ''));
  return m ? m[1] : null;
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
export function runnerPrompt({ briefFile, reviewFile, range, writer, risk, cwd, reviewModel = 'sonnet', reviewEffort = 'high' }) {
  const cmd = `node ${q(`${PLUGIN_ROOT}/scripts/api-review.mjs`)} run --brief-file ${q(briefFile)} --diff-ref ${q(range)} --model ${reviewModel} --effort ${reviewEffort}${writer ? ` --writer ${writer}` : ''}${risk ? ` --risk ${risk}` : ''} --review-file ${q(reviewFile)} --cwd ${q(cwd)}`;
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
    '2. When it finishes, if the exit code is 0, reply with its stdout exactly as printed, nothing added or removed (it starts with a review and has a VERDICT line).',
    '3. If the exit code is nonzero (stdout starts `API review unavailable` or `API review failed`): when the stdout ends with `(review id: <id>)`, first run',
    `   node ${q(`${PLUGIN_ROOT}/scripts/api-credits.mjs`)} record-fallback <id> --reason "<the reason printed>"`,
    '   then reply with exactly this sentence and nothing else: API review failed; spawn the review again with the line `API: no` added to the brief.',
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
    if (marker === 'no') return row('subagent', 'fallback');
    const range = diffRangeOf(brief);
    if (!range) return row('subagent', 'no-range');
    const rm = declarationValue(decls || {}, 'RISK', '(low|mid|high)\\b');
    const risk = rm ? rm[1].toLowerCase() : null;
    const highMode = String((deps.opt || opt)('api_review_high', 'plan') || 'plan').toLowerCase();
    if ((risk === 'high' && highMode !== 'api') || (/opus/i.test(String(model || '')) && marker !== 'opus')) return row('subagent', 'high-risk');
    let d;
    if (deps.decide) d = deps.decide('review', { billing: null, env: process.env });
    else {
      const mod = await import(pathToFileURL(join(PLUGIN_ROOT, 'scripts', 'lib', 'api-credits.mjs')).href);
      d = mod.decide('review', { billing: null, env: process.env });
    }
    if (!d || d.decision !== 'api') {
      const why = String((d && d.reason) || '');
      if (/^alternation/.test(why)) return row('subagent', 'plan-alternation');
      if (/^(no API key|failed closed|API runs failed)/.test(why) || !d) return row('subagent', 'fallback');
      return row('subagent', 'plan-cap');
    }
    const id = String(p && p.tool_use_id || '').replace(/[^\w-]/g, '') || randomUUID();
    const dir = join(deps.stateDir ? deps.stateDir() : stateDir(), 'review-briefs');
    mkdirSync(dir, { recursive: true });
    const briefFile = join(dir, `${id}.md`).replace(/\\/g, '/');
    const reviewFile = join(dir, `${id}-review.md`).replace(/\\/g, '/');
    writeFileSync(briefFile, String(brief || ''));
    const out = {
      ...(updatedInput || input),
      subagent_type: 'agent-companion:ac-haiku',
      model: 'haiku',
      prompt: runnerPrompt({ briefFile, reviewFile, range, writer: writerOf(decls || {}), risk, cwd: worktreeOf(brief, p && p.cwd), reviewModel: marker === 'opus' ? 'opus' : 'sonnet' }),
    };
    delete out.effort;
    return { route: 'api', route_reason: 'api', updatedInput: out };
  } catch {
    return row('subagent', 'fallback'); // fail open: the spawn runs as written
  }
}
