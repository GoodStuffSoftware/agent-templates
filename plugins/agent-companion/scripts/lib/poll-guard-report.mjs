// Measurement half of cache-advisor guard (b), deliverable 7: "the advisor
// report lists polling-wake episodes with wake count x context size."
//
// window's scripts/cache-advisor.mjs (deliverable 2) is the eventual home
// for this — see CACHE-ADVISOR-HANDOFF.md "Also in the advisor report" — but
// it does not exist on this branch's base yet, so this ships as its own
// small module + CLI (scripts/poll-guard-report.mjs) and is flagged as a
// fold-in candidate in the guard-b report rather than blocking on it.
//
// Reuses the shared reader (discoverTranscripts/readRecords/usageOf/
// contextTokensOf from ./transcripts.mjs — no new parser) and the EXACT
// same evaluate() the live hooks/poll-guard.mjs PreToolUse hook calls, so
// "what the hook would have hinted on" and "what this report counts" can
// never drift apart into two different definitions of "polling episode".
//
// Read-only. Never writes a setting or anything under ~/.claude.

import {
  discoverTranscripts, transcriptsRoot as sharedTranscriptsRoot, readRecords, usageOf, contextTokensOf, SYNTHETIC_MODEL,
} from './transcripts.mjs';
import { evaluate, POLL_TOOLS, LAUNCH_TOOLS } from '../../hooks/lib/poll-guard.mjs';

export function transcriptsRoot(explicit) {
  return sharedTranscriptsRoot(explicit);
}

// Tool names this report needs to see in a file's call history: the two
// evaluated wake tools (POLL_TOOLS), plus the background-launch tools
// (LAUNCH_TOOLS: Agent, Bash, PowerShell) evaluate()'s hasInFlightLaunch()
// corroborating-evidence check (guard-b fix, finding 1) needs present in
// `records` to ever fire on a ScheduleWakeup call. A launch entry is never
// itself an episode trigger — only POLL_TOOLS calls are evaluated below —
// it is carried purely as history.
const COLLECT_TOOLS = [...POLL_TOOLS, ...LAUNCH_TOOLS];

// Every POLL_TOOLS/LAUNCH_TOOLS tool_use call in one file, in file order,
// each carrying the context size of the request it was made FROM (what had
// to be reread to make that call at all) — contextTokensOf() of that same
// assistant line's own usage — PLUS every task-notification `user` record
// (a launch's completion signal: hooks/lib/poll-guard.mjs's
// hasInFlightLaunch() pairs the two). The substring prefilter stays cheap
// (skips JSON.parse on lines mentioning none of these tool names, or
// looking like neither a notification nor an isMeta record).
async function collectCalls(path) {
  const out = [];
  const prefilter = (line) => (line.includes('"type":"assistant"') && COLLECT_TOOLS.some((name) => line.includes(`"${name}"`)))
    || (line.includes('"type":"user"') && (line.includes('task-notification') || line.includes('"isMeta":true')));
  for await (const rec of readRecords(path, { prefilter })) {
    if (rec.type === 'user') {
      out.push({ toolName: null, notification: rec, ts: rec.timestamp || null, contextTokens: 0, model: null });
      continue;
    }
    if (rec.type !== 'assistant') continue;
    const msg = rec.message || {};
    if (msg.model === SYNTHETIC_MODEL) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const contextTokens = contextTokensOf(usageOf(msg.usage));
    for (const block of content) {
      if (block && block.type === 'tool_use' && COLLECT_TOOLS.includes(block.name)) {
        out.push({
          toolName: block.name, input: block.input || {}, ts: rec.timestamp || null, contextTokens, model: msg.model || null,
        });
      }
    }
  }
  return out;
}

// The raw transcript-record shape hasInFlightLaunch()/priorCallsOf() expect,
// for one collected entry (a tool_use call, or a passed-through notification).
function toRawRecord(call) {
  if (call.notification) return call.notification;
  return {
    type: 'assistant',
    timestamp: call.ts,
    message: { content: [{ type: 'tool_use', name: call.toolName, input: call.input }] },
  };
}

// Every point in one file's call history where evaluate() (the SAME
// function the live hook calls) would have hinted, using only calls
// strictly BEFORE it as history — exactly what the hook itself would have
// seen at that moment (LAUNCH_TOOLS calls ride along in `history` purely as
// hasInFlightLaunch() evidence; only POLL_TOOLS calls are ever evaluated or
// produce an episode). Each episode's `wakes` is streak+1 (the triggering
// call plus the no-new-work run behind it); `contextTokens` sums the
// triggering call's own context plus each of those prior SAME-TOOL calls' —
// found by walking back through `calls` and matching on toolName rather
// than by raw position, so a LAUNCH_TOOLS call (or the other POLL_TOOLS
// tool) sitting between two flagged calls can never misalign the sum.
//
// FIX (lead decision 1, second half): a continuous watch — the SAME kind
// firing on consecutive triggering calls with no break in between — is one
// episode, not one per escalating tick (the review's own complaint: a
// single CI watch checked 5x was reported as 4 separate "episodes"). Two
// flagged calls are the SAME continuous watch when the later one's streak
// is exactly the earlier one's streak + 1 — evaluate()'s own streak only
// grows that way when nothing broke the run (a noop:false, a stop:true, a
// different description, or — for Monitor — a natural-expiry rearm all
// reset it to 0, per hooks/lib/poll-guard.mjs); a fresh, unrelated run
// restarts at the threshold value instead of continuing to climb.
function episodesOf(calls, opts) {
  const episodes = [];
  const history = [];
  let open = null; // { kind, toolName, streak, wakes, contextTokens, ts, model }
  const closeOpen = () => { if (open) episodes.push(open); open = null; };
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (POLL_TOOLS.includes(call.toolName)) {
      const nowTs = call.ts ? Date.parse(call.ts) : undefined;
      const result = evaluate({
        toolName: call.toolName, input: call.input, records: history,
        opts: { ...opts, now: Number.isFinite(nowTs) ? nowTs : undefined },
      });
      if (result) {
        let contextTokens = call.contextTokens || 0;
        let remaining = result.streak;
        for (let k = i - 1; k >= 0 && remaining > 0; k--) {
          if (calls[k].toolName !== call.toolName) continue;
          contextTokens += calls[k].contextTokens || 0;
          remaining -= 1;
        }
        if (open && open.kind === result.kind && open.toolName === call.toolName && result.streak === open.streak + 1) {
          open.streak = result.streak;
          open.wakes += 1;
          open.contextTokens += call.contextTokens || 0; // the continuation only adds ITS OWN new tick's re-read
          open.ts = call.ts;
        } else {
          closeOpen();
          open = {
            toolName: call.toolName, ts: call.ts, model: call.model, kind: result.kind,
            streak: result.streak, wakes: result.streak + 1, contextTokens,
          };
        }
        history.push(toRawRecord(call));
        continue;
      }
      closeOpen(); // this call broke the run: whatever was open is done
    }
    history.push(toRawRecord(call));
  }
  closeOpen();
  return episodes.map(({ streak, ...e }) => e);
}

// Scan the corpus for polling-wake episodes.
//
// opts: passed straight to evaluate() as its detection thresholds
//   (noopStreak, shortDelaySeconds, monitorRearmStreak) — pass the live
//   plugin-option values so this report matches what the hook is actually
//   configured to flag.
//
// Returns { root, exists, filesFound, filesRead, truncated, episodeCount,
// totalWakes, totalContextTokens, byFile[], episodes[] }.
export async function scanPollGuardEpisodes({
  root, sinceMs = -Infinity, maxFiles, maxBytes, maxMs = null, main = true, subagents = true, opts = {},
} = {}) {
  const dir = transcriptsRoot(root);
  const disc = discoverTranscripts(dir, { sinceMs, maxFiles, maxBytes, main, subagents });
  let truncated = disc.truncated;
  const started = Date.now();
  const byFile = [];
  let filesRead = 0;
  for (const f of disc.files) {
    if (maxMs != null && Date.now() - started > maxMs) { truncated = true; break; }
    filesRead += 1;
    let calls;
    try { calls = await collectCalls(f.path); } catch { continue; }
    if (!calls.length) continue;
    const episodes = episodesOf(calls, opts);
    if (episodes.length) {
      byFile.push({
        path: f.path, kind: f.kind, agentType: f.agentType || null, agentName: f.agentName || null, episodes,
      });
    }
  }
  const episodes = byFile.flatMap((f) => f.episodes.map((e) => ({
    ...e, path: f.path, fileKind: f.kind, agentType: f.agentType,
  })));
  const totalWakes = episodes.reduce((s, e) => s + e.wakes, 0);
  const totalContextTokens = episodes.reduce((s, e) => s + (e.contextTokens || 0), 0);
  return {
    root: dir,
    exists: disc.exists,
    filesFound: disc.files.length,
    filesRead,
    truncated,
    episodeCount: episodes.length,
    totalWakes,
    totalContextTokens,
    byFile: byFile.map((f) => ({
      path: f.path, kind: f.kind, agentType: f.agentType, agentName: f.agentName, episodeCount: f.episodes.length,
    })),
    episodes,
  };
}
