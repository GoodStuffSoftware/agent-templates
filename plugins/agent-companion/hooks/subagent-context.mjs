// PreToolUse (no matcher), inside a SUBAGENT only — tell it, mid-run, that its
// own context is past `subagent_context_notice_tokens` (default 300000; 0 turns
// the notice off) or that it just compacted. See lib/subagent-context.mjs for
// what is measured, why PreToolUse can reach a subagent, and the once-only
// claims.
//
// A subagent payload carries agent_id (the main thread's carries none:
// callerIsSubagent, lib/context.mjs), so the lead exits at once. Never blocks
// or denies: the only output is additionalContext.
//
// Each firing writes one row to telemetry subagent-context.jsonl (phase
// "mid-run") and to the agent's events file, which hooks/runaway-check.mjs
// reads at SubagentStop to tell the lead.

import { readStdin, opt, passthrough, callerIsSubagent, appendLog } from './lib/context.mjs';
import { resolveAgentTranscript } from './lib/runaway.mjs';
import {
  CONTEXT_DEFAULT_TOKENS, readContextSignal, claimSignals, recordEvent, subagentNoticeText, pruneContextState,
} from './lib/subagent-context.mjs';

try {
  const p = readStdin();
  if (!callerIsSubagent(p)) passthrough();
  const threshold = opt('subagent_context_notice_tokens', CONTEXT_DEFAULT_TOKENS);
  if (!(threshold > 0)) passthrough();

  const sig = readContextSignal(resolveAgentTranscript(p));
  const kinds = claimSignals(p.agent_id, sig, threshold, { fresh: true });
  if (!kinds.length) passthrough();

  const at = new Date().toISOString();
  for (const kind of kinds) {
    const row = {
      at, session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type, model: sig.model || null,
      kind, phase: 'mid-run', tokens: sig.ctx, threshold,
      ...(kind === 'compaction' ? { trigger: sig.boundary.trigger, pre_tokens: sig.boundary.preTokens } : {}),
    };
    appendLog('subagent-context.jsonl', row);
    recordEvent(p.agent_id, row);
  }
  pruneContextState();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: subagentNoticeText(kinds, threshold) },
  }));
  process.exit(0);
} catch { /* fail open */ }
passthrough();
