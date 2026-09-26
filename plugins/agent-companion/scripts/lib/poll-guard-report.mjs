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
import { evaluate, POLL_TOOLS } from '../../hooks/lib/poll-guard.mjs';

export function transcriptsRoot(explicit) {
  return sharedTranscriptsRoot(explicit);
}

// Every ScheduleWakeup/Monitor tool_use call in one file, in file order,
// each carrying the context size of the request it was made FROM (what had
// to be reread to make that wake call at all) — contextTokensOf() of that
// same assistant line's own usage.
async function collectCalls(path) {
  const out = [];
  const prefilter = (line) => line.includes('"type":"assistant"')
    && (line.includes('"ScheduleWakeup"') || line.includes('"Monitor"'));
  for await (const rec of readRecords(path, { prefilter })) {
    if (rec.type !== 'assistant') continue;
    const msg = rec.message || {};
    if (msg.model === SYNTHETIC_MODEL) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const contextTokens = contextTokensOf(usageOf(msg.usage));
    for (const block of content) {
      if (block && block.type === 'tool_use' && POLL_TOOLS.includes(block.name)) {
        out.push({
          toolName: block.name, input: block.input || {}, ts: rec.timestamp || null, contextTokens, model: msg.model || null,
        });
      }
    }
  }
  return out;
}

// Every point in one file's call history where evaluate() (the SAME
// function the live hook calls) would have hinted, using only calls
// strictly BEFORE it as history — exactly what the hook itself would have
// seen at that moment. Each episode's `wakes` is streak+1 (the triggering
// call plus the no-new-work run behind it); `contextTokens` sums the
// triggering call's own context plus each of those prior calls' — the
// re-read cost of the whole run, not just its last tick.
function episodesOf(calls, opts) {
  const episodes = [];
  const history = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = evaluate({ toolName: call.toolName, input: call.input, records: history, opts });
    if (result) {
      const wakes = result.streak + 1;
      let contextTokens = call.contextTokens || 0;
      for (let k = 1; k <= result.streak; k++) {
        const prior = calls[i - k];
        if (prior) contextTokens += prior.contextTokens || 0;
      }
      episodes.push({
        toolName: call.toolName, ts: call.ts, model: call.model, kind: result.kind, wakes, contextTokens,
      });
    }
    history.push({
      type: 'assistant',
      timestamp: call.ts,
      message: { content: [{ type: 'tool_use', name: call.toolName, input: call.input }] },
    });
  }
  return episodes;
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
