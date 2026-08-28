// Features 2 + 3 — Premium fan-out cap and warrant, on the Agent tool.
//
// Fable is deliberately NOT banned. The lesson from the four-Fable incident is
// that nobody CHOSE Fable four times — subagents inherit the lead's model when
// nothing specifies one, so the default did the choosing. This guard therefore
// targets the two things that were actually missing: a stated justification,
// and a ceiling on how many run at once.

import {
  readStdin, noteAgentType, isPremium, opt, stateFile, readJson, writeJson,
  appendLog, allow, deny, passthrough, recordDenial,
} from './lib/context.mjs';

const WINDOW_MS = 10 * 60 * 1000; // rolling window used to approximate concurrency

try {
  const p = readStdin();
  noteAgentType(p);

  const input = p.tool_input || {};
  const model = input.model;
  const sid = p.session_id || 'unknown';

  // A spawn means delegation happened — clear the main-thread streak.
  try {
    const df = stateFile('delegation-streak.json');
    const dst = readJson(df, {});
    if (dst[sid]) writeJson(df, { ...dst, [sid]: { ...dst[sid], streak: 0 } });
  } catch { /* fail open */ }

  // The canary deliberately provokes this guard, so it must not be recorded as
  // real activity — otherwise the probe pollutes the very telemetry the audit
  // then reads back, and every canary run inflates the premium spawn count.
  const isCanary = String(sid).startsWith('canary');

  if (opt('spawn_telemetry', true) && !isCanary) {
    appendLog('spawns.jsonl', {
      at: new Date().toISOString(),
      session_id: sid,
      spawned_by_agent_type: p.agent_type,
      model: model || '(inherited)',
      subagent_type: input.subagent_type,
      effort: p.effort?.level,
    });
  }

  if (!isPremium(model)) allow();

  // --- Warrant -----------------------------------------------------------
  if (opt('warrant_required', true)) {
    const brief = String(input.prompt || '');
    if (!/WARRANT\s*:/i.test(brief)) {
      recordDenial('warrant', p, `premium tier ${model} requested with no warrant`);
      deny(
        `Premium warrant: this spawn requests "${model}", a premium tier, with no stated ` +
        `justification.\n\n` +
        `Add a line to the agent's brief in the form:\n` +
        `  WARRANT: weight <1-5> — <why a cheaper tier cannot do this>\n\n` +
        `If you cannot write that line honestly, the task does not warrant the tier — ` +
        `re-spawn at sonnet (or haiku for reads and searches). These warrants are logged ` +
        `and audited, so a weak one is worse than a downgrade.`
      );
    }
  }

  // --- Concurrency cap ---------------------------------------------------
  if (opt('premium_cap', true)) {
    const cap = Math.max(1, opt('premium_max_concurrent', 2));
    const f = stateFile('premium-window.json');
    const now = Date.now();
    const all = readJson(f, []);
    const recent = all.filter((t) => now - t < WINDOW_MS);

    if (recent.length >= cap) {
      writeJson(f, recent);
      recordDenial('premium-cap', p, `${recent.length} premium agents in window, cap ${cap}`);
      deny(
        `Premium fan-out cap: ${recent.length} premium-tier agents already started in the last ` +
        `${WINDOW_MS / 60000} minutes and the cap is ${cap}.\n\n` +
        `This is the exact shape of the four-Fable incident: each spawn looked reasonable ` +
        `alone, and nothing was counting them together. Run this one at sonnet, or wait for ` +
        `the in-flight premium agents to finish.\n\n` +
        `(Concurrency is approximated by a rolling window, so a batch of genuinely-warranted ` +
        `premium work may need the cap raised in settings rather than worked around.)`
      );
    }
    writeJson(f, [...recent, now]);
  }

  allow();
} catch {
  passthrough(); // never break a session
}
