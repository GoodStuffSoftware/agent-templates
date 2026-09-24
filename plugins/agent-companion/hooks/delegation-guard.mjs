// Feature 1 — Delegation guard.
//
// Target: the MAIN thread doing execution work that belongs in a subagent.
// It is inert inside every subagent (see isMainThread: positive confirmation
// only), so workers are never blocked no matter how much they read or edit.
//
// Behaviour is a nudge with a cooldown, not a wall: it fires once when the
// streak crosses the threshold, then resets. Denying every subsequent call
// would be unusable, and an unusable guard gets disabled.

import {
  readStdin, isMainThread, noteAgentType, opt, stateFile, readJson, writeJson,
  allow, deny, passthrough, recordDenial,
} from './lib/context.mjs';

try {
  const p = readStdin();
  noteAgentType(p);

  if (!opt('delegation_guard', true)) passthrough();
  if (!isMainThread(p)) passthrough();

  const threshold = Math.max(2, opt('delegation_threshold', 4));
  const f = stateFile('delegation-streak.json');
  const st = readJson(f, {});
  const sid = p.session_id || 'unknown';
  const prev = st[sid]?.streak || 0;
  const streak = prev + 1;

  if (streak >= threshold) {
    // `fired` is a COUNT, not a flag, and it is why this hook writes it at all:
    // the standing-rules engine reads it as the 'delegation-drift' gate, so a
    // session that has actually drifted starts getting a one-line reminder on
    // every prompt, while a session that never drifted pays nothing. A rule
    // written in a document is read once and then competes with everything
    // that follows it; this one arrives exactly when it has been earned.
    const fired = (st[sid]?.fired || 0) + 1;
    writeJson(f, { ...st, [sid]: { streak: 0, firedAt: Date.now(), fired } });
    recordDenial('delegation', p, `${streak} consecutive ${p.tool_name} calls on the main thread`);
    deny(
      `Delegation guard: that is ${streak} execution-class tool calls in a row on the MAIN thread ` +
      `(${p.tool_name}). This is the pattern the orchestrator rules exist to prevent — the main ` +
      `session holds decisions, workers hold token volume.\n\n` +
      `Spawn a subagent for this instead, sized to the task — run \`node scripts/recommend.mjs ` +
      `--type <task-type>\` (or --weight 1-5) rather than assuming a tier by hand, since the ` +
      `routing table (and any staged tier retirement) can change which model that resolves to. ` +
      `If this genuinely belongs on the main thread — a one-off read you need in order to decide ` +
      `what to delegate — simply repeat the call and it will pass; the counter has been reset.`
    );
  }

  writeJson(f, { ...st, [sid]: { streak, firedAt: st[sid]?.firedAt, fired: st[sid]?.fired || 0 } });
  allow();
} catch {
  passthrough(); // never break a session
}
