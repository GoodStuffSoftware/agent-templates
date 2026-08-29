// Features 2 + 3 — Premium fan-out cap and warrant, on the Agent tool.
//
// Fable is deliberately NOT banned. The lesson from the four-Fable incident is
// that nobody CHOSE Fable four times — subagents inherit the lead's model when
// nothing specifies one, so the default did the choosing. This guard therefore
// targets the two things that were actually missing: a stated justification,
// and a ceiling on how many run at once.

import {
  readStdin, noteAgentType, isPremium, opt, stateFile, readJson, writeJson,
  appendLog, allow, deny, passthrough, recordDenial, agentDefinition,
} from './lib/context.mjs';

const WINDOW_MS = 10 * 60 * 1000; // rolling window used to approximate concurrency

try {
  const p = readStdin();
  noteAgentType(p);

  const input = p.tool_input || {};
  const sid = p.session_id || 'unknown';

  // Model resolution order is: env override -> spawn parameter -> the agent's
  // own frontmatter -> the lead's model. Reading only the spawn parameter
  // conflates the last two, so a correctly-configured named agent looked
  // identical to an unexamined inheritance — and, worse, a definition pinned to
  // a premium tier slipped past the warrant and the cap entirely, because the
  // spawn itself named no model.
  const declared = input.model || '';
  const def = agentDefinition(input.subagent_type, p.cwd);
  const fromDef = def?.model || '';
  const model = declared || fromDef;            // what will actually run, when knowable
  const trulyInherited = !declared && !fromDef; // nobody chose: the real hazard

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

  // The routing table is downstream of a number nobody currently records: the
  // doctrine says to score task weight 1-5 *silently*, so the judgement that
  // chose the tier leaves no trace and can never be compared against what the
  // task turned out to need. Capture it whenever it IS stated, so the data
  // starts accumulating before anyone decides how to grade it.
  const brief = String(input.prompt || '');
  const wm = brief.match(/\b(?:WARRANT|WEIGHT)\s*:\s*(?:weight\s*)?([1-5])\b/i);
  const declaredWeight = wm ? Number(wm[1]) : null;
  const km = brief.match(/\bKIND\s*:\s*(mechanical|bounded|diagnostic|novel-design)\b/i);
  const declaredKind = km ? km[1].toLowerCase() : null;
  if (opt('spawn_telemetry', true) && !isCanary) {
    appendLog('spawns.jsonl', {
      at: new Date().toISOString(),
      session_id: sid,
      spawned_by_agent_type: p.agent_type,
      model: model || '(inherited)',      // effective model, when knowable
      model_declared: declared || null,   // named at the spawn site
      model_definition: fromDef || null,  // named in the agent's frontmatter
      inherited: trulyInherited,          // true only when NEITHER named one
      subagent_type: input.subagent_type,
      effort: p.effort?.level,
      effort_definition: def?.effort || null,
      declared_weight: declaredWeight,   // null when the brief did not say
      declared_kind: declaredKind,
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
