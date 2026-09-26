// Adversarial review of guard (b) — findings from wip/ac-cache-guard-b-review.
//
// Two failing tests, each backed by a real-transcript spot-check (numbers,
// not content, in guard-b-review.md — real transcripts stay read-only and
// out of this repo per BRIEF.md rule 3). Both prove a false-positive class
// against SANCTIONED patterns named explicitly in ScheduleWakeup's and
// Monitor's own tool docs — the guard-b-review-brief.md's item 1, "the most
// important question."
//
// FINDING 1 — ScheduleWakeup: no signal distinguishes "polling external
// state the harness cannot track" (sanctioned: "pick a delay matched to how
// fast that state actually changes") from "polling harness-tracked work"
// (banned). The guard only looks at delaySeconds + a noop streak, so a CI /
// merge-gate watch checked every ~5-8 min while a long external run is in
// flight trips the hint purely because the delay happens to be <= 600s and
// the run took more than two checks. Reproduced against real operator data:
// an operator transcript (14-day poll-guard-report.mjs sample, spot-checked
// by hand) shows a CI/merge-gate watch ("still running its full suite ...
// next step follows once it lands", delaySeconds:300, noop:true x5) flagged
// as 4 separate escalating "episodes" (3/4/5/6 wakes, 2.4M-4.8M re-read
// tokens each) — a textbook instance of the doctrine's own external-polling
// exception, not the banned pattern.
//
// FINDING 2 — Monitor: trailingSameDescriptionStreak has NO elapsed-time
// gate at all (unlike ScheduleWakeup's delaySeconds check), so it cannot
// tell a short-interval re-arm apart from a persistent stream re-armed only
// after its own timeout_ms naturally expired — exactly the workflow Monitor's
// own tool doc prescribes ("for a long watch ... set timeout_ms to the
// maximum and re-arm on each expiry"). Reproduced against the same sample: a
// `persistent:true`, `timeout_ms:3600000` completion-mail watch re-armed
// with the identical description across a multi-day span (observed gap:
// days, not minutes) was flagged as a "monitor-rearm-streak" episode
// (2.5M re-read tokens) by the live hook logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../hooks/lib/poll-guard.mjs';

function assistantToolUse(name, input, ts) {
  return { type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name, input }] } };
}

test('FINDING 1 (currently fails): a ~480s CI/merge-gate watch on external state the harness cannot track must not fire the same hint as a short-interval poll on harness-tracked work', () => {
  // Doctrine (ScheduleWakeup's own tool description): "Actively polling
  // external state the harness can't notify you about (a CI run, a deploy,
  // a remote queue): pick the delay from how fast that state actually
  // changes." A merge gate taking ~20+ minutes, checked every 480s, is
  // exactly this case -- not the banned "polling harness-tracked work".
  const records = [
    assistantToolUse('ScheduleWakeup', { delaySeconds: 480, noop: true, reason: 'Merge gate ~13 min in (full suite takes ~23); release cut follows.' }, 't1'),
    assistantToolUse('ScheduleWakeup', { delaySeconds: 480, noop: true, reason: 'Merge gate ~17 min in; release cut follows.' }, 't2'),
  ];
  const result = evaluate({
    toolName: 'ScheduleWakeup',
    input: { delaySeconds: 480, noop: true, reason: 'Merge gate ~21 min in, near the expected ~23; release cut follows.' },
    records,
  });
  assert.equal(result, null, 'expected no hint (or a demonstrably softer one) for a watch on external, harness-untracked state; guard-b\'s evaluate() cannot distinguish this from a banned harness-tracked poll and fires the same hint');
});

test('FINDING 2 (currently fails): re-arming a persistent Monitor watch only after its own timeout_ms naturally expired must not read as a short-interval poll', () => {
  // Monitor's own tool doc: "for a long watch (PR monitoring, log tails) set
  // timeout_ms to the maximum and re-arm on each expiry." Two re-arms of an
  // identical description ~1 hour apart (matching timeout_ms:3600000) are
  // this sanctioned pattern, not per-item polling.
  const HOUR_MS = 3600000;
  const t0 = Date.parse('2026-08-25T00:13:44.846Z');
  const t1 = new Date(t0 + HOUR_MS).toISOString(); // re-armed right after the first watch's own timeout expired
  const t2 = new Date(t0 + 2 * HOUR_MS).toISOString();
  const records = [
    assistantToolUse('Monitor', { description: 'new bus mail for X', persistent: true, timeout_ms: HOUR_MS }, new Date(t0).toISOString()),
    assistantToolUse('Monitor', { description: 'new bus mail for X', persistent: true, timeout_ms: HOUR_MS }, t1),
  ];
  const result = evaluate({
    toolName: 'Monitor',
    input: { description: 'new bus mail for X', persistent: true, timeout_ms: HOUR_MS },
    records,
  });
  assert.equal(result, null, 'expected no hint: each re-arm only followed the PRIOR watch\'s own timeout_ms expiring, matching Monitor\'s own documented long-watch pattern; guard-b\'s trailingSameDescriptionStreak has no elapsed-time gate at all and fires regardless of the gap between re-arms');
});
