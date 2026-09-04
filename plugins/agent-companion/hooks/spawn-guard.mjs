// Features 2 + 3 — Premium fan-out cap and warrant, on the Agent tool — and
// best fit: the routing table applied at the spawn, in both directions.
//
// Fable is deliberately NOT banned. The lesson from the four-Fable incident is
// that nobody CHOSE Fable four times — subagents inherit the lead's model when
// nothing specifies one, so the default did the choosing. This guard therefore
// targets what was actually missing: a stated justification, a ceiling on how
// many run at once, and — when the brief declares a weight — the table's own
// answer, filled in where the spawn left the model blank and enforced where
// the spawn named a premium tier its own declared weight does not support.

import {
  readStdin, noteAgentType, isPremium, opt, stateFile, readJson, writeJson,
  appendLog, deny, passthrough, recordDenial, agentDefinition, evaluateFit, effortFor,
} from './lib/context.mjs';

const WINDOW_MS = 10 * 60 * 1000; // rolling window used to approximate concurrency

// Allow — optionally saying something to the user, and/or rewriting the tool
// input (`updatedInput` is how a PreToolUse hook fills in a model the spawn
// left blank). The guard never blocks the cheap direction, but neither
// direction passes in silence once the brief has declared a weight.
function allowWith(systemMessage, updatedInput) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      ...(updatedInput ? { updatedInput } : {}),
    },
  }));
  process.exit(0);
}

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
  let model = declared || fromDef;              // what will actually run, when knowable
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

  // The routing table is downstream of a number nobody used to record: the
  // doctrine says to score task weight 1-5 *silently*, so the judgement that
  // chose the tier left no trace and could never be compared against what the
  // task turned out to need. Capture it whenever it IS stated.
  const brief = String(input.prompt || '');
  const wm = brief.match(/\b(?:WARRANT|WEIGHT)\s*:\s*(?:weight\s*)?([1-5])\b/i);
  const declaredWeight = wm ? Number(wm[1]) : null;
  const km = brief.match(/\bKIND\s*:\s*(mechanical|bounded|diagnostic|novel-design)\b/i);
  const declaredKind = km ? km[1].toLowerCase() : null;
  const cm = brief.match(/\bCONSEQUENCE\s*:\s*(routine|elevated|critical)\b/i);
  const declaredConsequence = cm ? cm[1].toLowerCase() : null;

  // --- Best fit ----------------------------------------------------------
  // The table's answer for the declared weight, used two ways: filled in where
  // the spawn left the model blank (the inheritance hazard, closed at its
  // source), and as the yardstick for a model the spawn did name.
  const fitOn = opt('fit_guard', true) && !!declaredWeight;
  let route = null;
  if (fitOn) {
    try { route = effortFor(declaredWeight, declaredKind || 'bounded', declaredConsequence || 'routine'); } catch { /* table unreadable */ }
  }
  const routeLabel = route?.model ? `${route.model}${route.effort ? '/' + route.effort : ''}` : '';

  let autofilled = false;
  let updatedInput = null;
  if (fitOn && trulyInherited && route?.model && opt('fit_autofill', true)) {
    model = route.model;
    autofilled = true;
    updatedInput = { ...input, model };
  }

  let fit = null;
  if (fitOn && model && !autofilled) {
    try {
      fit = evaluateFit({
        model, effort: def?.effort || '', weight: declaredWeight,
        kind: declaredKind || 'bounded', consequence: declaredConsequence || 'routine',
      });
    } catch { /* table unreadable: the audit reports that separately */ }
  }

  if (opt('spawn_telemetry', true) && !isCanary) {
    appendLog('spawns.jsonl', {
      at: new Date().toISOString(),
      session_id: sid,
      spawned_by_agent_type: p.agent_type,
      model: model || '(inherited)',      // effective model, when knowable (autofilled counts)
      model_declared: declared || null,   // named at the spawn site
      model_definition: fromDef || null,  // named in the agent's frontmatter
      model_autofilled: autofilled,       // the guard set it from the table
      inherited: trulyInherited,          // true when NEITHER the spawn nor the definition named one
      subagent_type: input.subagent_type,
      effort: p.effort?.level,
      effort_definition: def?.effort || null,
      declared_weight: declaredWeight,   // null when the brief did not say
      declared_kind: declaredKind,
      declared_consequence: declaredConsequence,
      fit: autofilled ? 'fit' : fit ? fit.verdict : null, // over | under | fit | unknown, when a weight was declared
      fit_expected: routeLabel || null,
    });
  }

  const who = input.subagent_type || 'an agent';
  let note = null;
  if (autofilled) {
    note = `agent-companion: spawn of ${who} named no model; set model=${model} from the routing table for declared weight ${declaredWeight} (${routeLabel}).`;
  } else if (fit?.verdict === 'under') {
    // The cheap direction is never blocked, but a weight-4 task on haiku is
    // the failure that ships wrong code, so it is said out loud.
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is under-provisioned — ${fit.reason}. ${fit.action}.`;
  } else if (fit?.verdict === 'over' && !isPremium(model)) {
    note = `agent-companion: spawning ${who} at ${model} for declared weight ${declaredWeight} is over-provisioned — ${fit.reason}; the table says ${routeLabel}. Re-spawn there unless the weight is understated.`;
  }

  if (!isPremium(model)) allowWith(note, updatedInput);

  // --- Best fit, premium: deny ------------------------------------------
  // A premium tier for a declared weight the table sends elsewhere is the
  // over-provisioning this plugin exists to stop, stated by the spawner
  // itself. Deny with the exact correction rather than a nudge.
  if (fit?.verdict === 'over') {
    recordDenial('fit', p, `${model} requested for declared weight ${declaredWeight}; table says ${routeLabel}`);
    deny(
      `Best fit: this spawn requests "${model}" but declares weight ${declaredWeight}` +
      (declaredKind ? ` (${declaredKind})` : '') +
      (declaredConsequence ? `, ${declaredConsequence} consequence` : '') +
      `, which the routing table sends to ${routeLabel}. ${fit.reason}.\n\n` +
      `Either re-spawn at ${routeLabel}, or restate the brief honestly: a higher WEIGHT if the task ` +
      `is heavier than declared, or CONSEQUENCE: critical if a mistake would be expensive or ` +
      `irreversible (that raises the model floor). A warrant that contradicts its own weight is ` +
      `exactly the over-provisioning this guard exists to stop.`
    );
  }

  // --- Warrant -----------------------------------------------------------
  if (opt('warrant_required', true)) {
    if (!/WARRANT\s*:/i.test(brief)) {
      recordDenial('warrant', p, `premium tier ${model} requested with no warrant`);
      deny(
        (autofilled
          ? `Premium warrant: the routing table sends declared weight ${declaredWeight} to "${model}", a premium tier, and the brief states no justification.\n\n`
          : `Premium warrant: this spawn requests "${model}", a premium tier, with no stated justification.\n\n`) +
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
    if (!isCanary) writeJson(f, [...recent, now]); // a probe must not consume the cap
  }

  allowWith(note, updatedInput);
} catch {
  passthrough(); // never break a session
}
