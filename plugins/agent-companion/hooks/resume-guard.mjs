// Guard (a) — a note on SendMessage to a background subagent this session
// spawned. Doctrine (operator decision 2026-10-06): REUSE BY DEFAULT. A
// message to a stopped worker costs far less than a fresh spawn, warm cache or
// cold: measured, a message to a cache-cold worker was about 0.2 plan units, a
// fresh spawn's first load about 0.6, plus re-reading what the old worker
// already knew. Subagents compact at about 217K (autoCompactWindow 250000), so
// a reused worker stays bounded. This hook therefore NEVER discourages a cold
// resume. It adds a note in two cases only:
//   - the worker's context is large (resume_guard_min_tokens, default 200000):
//     reuse still wins for related work, but an unrelated or much smaller task
//     does better on a fresh worker;
//   - the worker's model tier is above the tier the message's own `TYPE:` line
//     routes to: a cheaper tier does that task for less.
// Idle time and the cache TTL play no part. (Before 0.31.1 this guard warned
// on every resume past the TTL and told the lead to spawn fresh from a file
// handoff; that assumption was wrong.)
//
// PreToolUse on SendMessage. ADVISORY ONLY, never blocks — a false block on
// a message tool would stop legitimate coordination, and this plugin's
// design rule (hooks/lib/context.mjs banner) is that a hook must never break
// a session. Fails open on every unreadable or unexpected shape.
//
// Scope: a target this SESSION itself spawned as a background subagent (a
// teammate, a cross-session peer by name, or anything resolveTarget() cannot
// find in this session's own subagents/ directory is out of scope).

import { readStdin, opt, passthrough, routedRung } from './lib/context.mjs';
import { resolveTarget, lastActivityOf, modelRank, modelTierOf, declaredTypeOf } from './lib/resume-guard.mjs';

// The note, and NO permissionDecision: "allow" would also skip the permission
// prompt for the SendMessage, which advice has no business deciding. Without
// a decision the normal permission flow applies.
function hint(systemMessage) {
  process.stdout.write(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'PreToolUse' },
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

  const notes = [];

  // Large context: from the target's own last request.
  const minTokens = Math.max(0, opt('resume_guard_min_tokens', 200000));
  const last = lastActivityOf(target.transcriptPath);
  if (last && minTokens > 0 && last.contextTokens >= minTokens) {
    notes.push(`"${to}" holds ~${Math.round(last.contextTokens / 1000)}K tokens of context. Reuse is still the default for related follow-on work; ` +
      'spawn fresh only if this task is unrelated to what it holds or needs far less context than that.');
  }

  // Tier above the new task's: only when the message declares a TYPE the table routes.
  const type = declaredTypeOf(input.message);
  if (type) {
    const have = modelTierOf(target);
    const want = routedRung(type)?.model || null;
    if (have && want && modelRank(have) > modelRank(want)) {
      notes.push(`"${to}" runs ${have}, and TYPE: ${type} routes to ${want}. A ${want} worker does this task for less; ` +
        'reuse this one only if the context it holds is what the task needs.');
    }
  }

  if (!notes.length) passthrough();
  hint(`agent-companion (resume note): ${notes.join(' ')} Set resume_guard: false to turn this off.`);
} catch {
  passthrough();
}
