// Guard (a) — resuming a stopped worker after its cache has expired
// (deliverable 6, CACHE-ADVISOR-HANDOFF.md). Doctrine: "Resume only while
// the cache is warm; otherwise spawn fresh from a file handoff." Measured:
// re-messaging a stopped worker past its TTL rewrites its whole context
// (150-280K tokens observed; ~318K average per the subagent-cache-ttl-
// measured memory; the real corpus backs this up too — see
// scripts/lib/transcript-report.mjs's resumeAfterIdle.idleExpiryRewriteTokens/Usd).
//
// PreToolUse on SendMessage. ADVISORY ONLY, never blocks — a false block on
// a message tool would stop legitimate coordination, and this plugin's
// design rule (hooks/lib/context.mjs banner) is that a hook must never break
// a session. Fails open on every unreadable or unexpected shape.
//
// Scope: a target this SESSION itself spawned as a background subagent (a
// teammate, a cross-session peer by name, or anything resolveTarget() cannot
// find in this session's own subagents/ directory is out of scope — the
// brief's "STOPPED agent of THIS session"). A currently-running target is
// never flagged: its own last activity is necessarily recent (still writing
// tool calls/output), so the same idle-time check that finds a stale target
// also excludes a live one without needing a separate running/stopped signal
// this hook has no way to read directly (see resolveTarget/lastActivityOf's
// own header in lib/resume-guard.mjs for why a passive mtime/meta check is
// enough here).

import { readStdin, opt, passthrough } from './lib/context.mjs';
import { resolveTarget, lastActivityOf, ttlFor, cacheTtlFromDefinition, TTL_MS } from './lib/resume-guard.mjs';

function allow(systemMessage) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  }));
  process.exit(0);
}

try {
  if (!opt('resume_guard', true)) passthrough();

  const p = readStdin();
  const input = p.tool_input || {};
  const to = input.to || input.recipient || '';
  if (!to) passthrough();

  const target = resolveTarget(to, p.transcript_path);
  if (!target) passthrough();

  const last = lastActivityOf(target.transcriptPath);
  if (!last) passthrough();

  let ttl = ttlFor(last);
  // No record anywhere in the read-tail carried a split write (0/0): the
  // default alone would silently assume 5m even for a target whose
  // definition declares a real 1h TTL. Try that before accepting the
  // default — fixes REVIEW FINDING 1's root cause for the case the tail
  // walk itself cannot see (the write happened further back than the tail
  // window reaches).
  if (!last.cacheWrite1h && !last.cacheWrite5m) {
    const fromDef = cacheTtlFromDefinition(target.agentType, p.cwd);
    if (fromDef) ttl = fromDef;
  }
  const idleMs = Date.now() - last.ts;
  if (!(idleMs > TTL_MS[ttl])) passthrough(); // still warm (or clock skew): nothing to say

  // "large" is configurable; default picked from this operator's own corpus
  // (scripts/transcript-report.mjs: idle-expiry via-message resumes average
  // well over 100K tokens — see guard-a-report.md's data note), set well
  // below that average so the hint fires on nearly every real idle-expiry
  // resume while still staying quiet on a genuinely small worker.
  const minTokens = Math.max(0, opt('resume_guard_min_tokens', 50000));
  if (last.contextTokens < minTokens) passthrough();

  const idleMin = Math.round(idleMs / 60000);
  const sizeK = Math.round(last.contextTokens / 1000);
  allow(
    `agent-companion (resume guard): "${to}" has been idle ${idleMin}m, past its ${ttl} cache TTL — messaging it now ` +
    `will likely rewrite its whole context (~${sizeK}K tokens, not read from cache). Doctrine: resume only while the ` +
    'cache is warm; otherwise spawn a fresh ladder worker briefed from a file handoff (its branch, report, or a ' +
    'written state file) instead of resuming it with SendMessage. Set resume_guard: false to turn this off.'
  );
} catch {
  passthrough();
}
