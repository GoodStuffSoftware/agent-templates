// SubagentStop — flag a runaway spawn.
//
// A subagent that ran past `runaway_turns` API turns (default 300) or
// `runaway_usd` price-derived dollars (default 40; either <= 0 turns that half
// off) gets (a) one row in runaway.jsonl beside spawns.jsonl, and (b) a
// one-line notice QUEUED for the lead session, which hooks/runaway-notice.mjs
// drains into the lead's context on its next prompt (a background worker's
// task notification included) or right after a foreground Agent call
// returns. See lib/runaway.mjs for why the notice is not emitted from this
// event, and for the bounded read (tail window, assistant lines only) that
// keeps this hook cheap on every subagent end.
//
// Transcript path, first found wins (lib/runaway.mjs resolveAgentTranscript):
// the payload's agent_transcript_path; the path derived from the lead's
// transcript_path, <dir>/<session_id>/subagents/agent-<agent_id>.jsonl; this
// agent's SubagentStart row in subagent-starts.jsonl.
//
// The same event also closes the subagent-context notice (lib/subagent-context.mjs):
// a worker that was told mid-run its context passed `subagent_context_notice_tokens`
// or that it compacted gets one more line in the lead's notice here, next to
// the runaway flag. A worker the PreToolUse hook never caught (it crossed on
// its last turn, or made no tool call) is read once more and recorded with
// phase "stop".
//
// Silent on every path except one: a worker past the soft limit that ends with no completed STATUS and no handoff file gets ONE
// `decision: block` asking it to write the handoff first (handoffStopGuard below; once per agent id). Fails open.

import { readStdin, opt, passthrough, appendLog } from './lib/context.mjs';
import {
  HANDOFF_LOG, handoffThreshold, handoffConfig, handoffActive, handoffReturnPath, handoffContinueText, finalIsComplete, handoffFileWritten, endGuardText, handoffRow,
} from './lib/handoff-limit.mjs';
import { noticeVariant } from './lib/subagent-context.mjs';
import { readBrief } from './lib/step-budget.mjs';
import {
  measureTranscript, runawayReasons, claimAgentOnce, queueNotice, resolveAgentTranscript, pruneRunawayState,
  RUNAWAY_DEFAULT_TURNS, RUNAWAY_DEFAULT_USD,
} from './lib/runaway.mjs';
import {
  CONTEXT_DEFAULT_TOKENS, readContextSignal, claimSignals, claimOnce, recordEvent, readEvents, fmtTokens,
} from './lib/subagent-context.mjs';

function runawayCheck(p, path) {
  const turns = opt('runaway_turns', RUNAWAY_DEFAULT_TURNS);
  const usd = opt('runaway_usd', RUNAWAY_DEFAULT_USD);
  if (!(turns > 0) && !(usd > 0)) return;

  const m = measureTranscript(path);
  const reasons = runawayReasons(m, { turns, usd });
  if (!reasons.length) return;
  if (!claimAgentOnce(p.agent_id || path)) return;

  appendLog('runaway.jsonl', {
    at: new Date().toISOString(),
    session_id: p.session_id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    model: m.model || null,
    turns: m.turns,
    usd: Math.round(m.usd * 100) / 100,
    usd_basis: 'price-derived',
    unpriced_turns: m.unpricedTurns,
    partial: m.partial,
    transcript_bytes: m.bytes,
    thresholds: { turns, usd },
    reasons,
  });

  // No session id: no lead to deliver to (an `unknown` queue would be drained
  // by whichever other session also lacked one). The row above still stands.
  if (p.session_id) {
    const who = `${p.agent_type || 'subagent'}${p.agent_id ? ` (${String(p.agent_id).slice(0, 12)})` : ''}`;
    const unpriced = m.unpricedTurns ? `; ${m.unpricedTurns} turn(s) on a model with no price, so no dollar figure for them` : '';
    queueNotice(p.session_id, `[agent-companion] runaway spawn: ${who} was at ${reasons.join(', ')} when it stopped`
      + `${m.partial ? ' (lower bound: transcript tail only)' : ''}${unpriced}. Check it was not looping or mis-sized before resuming or re-spawning it; row in runaway.jsonl.`);
  }
  pruneRunawayState();
}

// Subagent context events -> one lead notice line. Events recorded mid-run by
// hooks/subagent-context.mjs are reported here; a signal nobody caught yet is
// read from the transcript now and recorded with phase "stop". Each event is
// reported to the lead once, however often the worker stops (SendMessage
// continues it and it stops again).
function contextCheck(p, path) {
  const threshold = handoffThreshold(p.agent_type);
  if (!(threshold > 0) || !p.agent_id) return;

  const sig = readContextSignal(path);
  const hc = handoffConfig(threshold); // switch off or an exempt agent type: no size notice (the compaction note stays)
  const kinds = claimSignals(p.agent_id, sig, handoffActive(hc, p.agent_type) ? threshold : 0, { fresh: false });
  const at = new Date().toISOString();
  for (const kind of kinds) {
    const row = {
      at, session_id: p.session_id, agent_id: p.agent_id, agent_type: p.agent_type, model: sig.model || null,
      kind, phase: 'stop', tokens: sig.ctx, threshold,
      ...(kind === 'compaction' ? { trigger: sig.boundary.trigger, pre_tokens: sig.boundary.preTokens } : {}),
    };
    appendLog('subagent-context.jsonl', row);
    recordEvent(p.agent_id, row);
  }

  const fresh = readEvents(p.agent_id).filter((e) => claimOnce(`reported-${p.agent_id}-${e.kind}-${e.at}`));
  if (!fresh.length || !p.session_id) return;
  const who = `${p.agent_type || 'subagent'}${p.agent_id ? ` (${String(p.agent_id).slice(0, 12)})` : ''}`;
  const parts = [];
  if (fresh.some((e) => e.kind === 'compaction')) parts.push('compacted');
  const size = fresh.find((e) => e.kind === 'size');
  if (size) parts.push(`passed ${fmtTokens(size.threshold)} tokens of context (${fmtTokens(size.tokens)} at its last call)`);
  if (!size) { // a compaction alone is routine (workers compact and keep going): say so, advise nothing
    queueNotice(p.session_id, `[agent-companion] subagent context: ${who} ${parts.join(' and ')}; row in subagent-context.jsonl.`);
    return;
  }
  const told = fresh.every((e) => e.phase === 'mid-run') ? 'it was told mid-run to hand off' : 'it was not reached mid-run';
  queueNotice(p.session_id, `[agent-companion] subagent context: ${who} ${parts.join(' and ')}; ${told}. `
    + 'If it returned "DONE: partial, handoff at <path>", start a fresh worker on the same rung from that file (not a resume); otherwise brief ONE fresh same-rung worker with the whole remaining build scope (code, tests, fixes, landing), told to read only what the handoff or brief names; never split the remaining build across several writers. Review stays its own separate agent. Row in subagent-context.jsonl.');
}

// A worker that ended with "DONE: partial, handoff at <path>" (the handoff the context notice and the hard limit ask for): tell the lead,
// once, to spawn a fresh worker of the same agent type and model at once with that file as its brief. Same delivery as the lines above
// (queued here, drained into the lead's context on its next prompt, a background worker's task notification included, or right after a
// foreground Agent call returns: hooks/runaway-notice.mjs). Never blocks the worker's own end.
function handoffReturnCheck(p, path) {
  if (!p.agent_id || !p.session_id) return;
  const file = handoffReturnPath(p.last_assistant_message, p.cwd);
  if (!file || !claimOnce(`handoff-return-${p.agent_id}`)) return;
  let model = null; let sig = null;
  try { sig = readContextSignal(path); model = (sig || {}).model || null; } catch { /* the type alone is enough */ }
  try { // one row per continuation the lead is told to spawn (action `return`; tokens null when the transcript has no reading)
    appendLog(HANDOFF_LOG, handoffRow(p, sig || {}, 'soft', 'return', handoffThreshold(p.agent_type)));
  } catch { /* logging never blocks the notice */ }
  queueNotice(p.session_id, handoffContinueText(p.agent_type, p.agent_id, file, model));
}

// The one thing this hook can say to a worker: a worker past the soft limit that ends with no completed STATUS and no handoff file is
// asked ONCE to write the handoff first (decision: block, then it ends again). The claim per agent id means a second end is never blocked.
function handoffStopGuard(p, path) {
  const soft = handoffThreshold(p.agent_type);
  const hc = handoffConfig(soft);
  if (!p.agent_id || !(soft > 0) || !handoffActive(hc, p.agent_type)) return null;
  const msg = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  if (finalIsComplete(msg) || handoffReturnPath(msg, p.cwd)) return null;
  const sig = readContextSignal(path);
  if (!sig || typeof sig.ctx !== 'number' || sig.ctx < soft) return null;
  if (handoffFileWritten(path) || !claimOnce(`handoff-end-block-${p.agent_id}`)) return null;
  appendLog(HANDOFF_LOG, handoffRow(p, sig, 'soft', 'end-block', soft));
  return { decision: 'block', reason: endGuardText(noticeVariant(readBrief(path), p.agent_type)) };
}

try {
  const p = readStdin();
  const path = resolveAgentTranscript(p);
  try { handoffReturnCheck(p, path); } catch { /* fail open */ }
  try { runawayCheck(p, path); } catch { /* fail open */ }
  try { contextCheck(p, path); } catch { /* fail open */ }
  try {
    const blockOut = handoffStopGuard(p, path);
    if (blockOut) { process.stdout.write(JSON.stringify(blockOut)); process.exit(0); }
  } catch { /* fail open */ }
} catch { /* fail open */ }
passthrough();
