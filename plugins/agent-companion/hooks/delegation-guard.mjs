// Feature 1 — Delegation guard.
//
// Target: the MAIN thread doing execution work that belongs in a subagent.
// Inert inside every subagent: isMainThread() is the shared test
// (lib/context.mjs, agent_id absent — the same one the spawn guard's gates
// use), so a worker's calls are never counted and never blocked, however
// much it reads or edits.
//
// Two events (argv, like the other multi-event hooks):
//   (none)          PreToolUse on EXECUTION_TOOLS: count the call; at the
//                   threshold, fire.
//   --event reset   PostToolUse on Agent / SendMessage: the lead delegated,
//                   so its streak ends. PostToolUse, not PreToolUse, so a
//                   spawn another guard denied does not count as delegating.
//
// delegation_guard (lib/delegation.mjs delegationMode):
//   "off"    nothing is counted.
//   "warn"   (shipped default) at the threshold the guard lets the call go on
//            (it is not the guard that stops it, if anything does), and the model
//            gets the same instructions as additionalContext.
//   "block"  at the threshold the call is denied with those instructions.
// Either way the streak restarts at 0 when the guard fires, so a denied call
// repeated once runs — the escape hatch for the one read a lead needs in
// order to decide what to delegate. It is a speed bump per threshold calls,
// not a wall: a guard that stopped every later call would get turned off.
//
// delegation_guard_scope (lib/delegation.mjs delegationScope):
//   "attended" (default)  a session whose hooks see CLAUDE_CODE_SESSION_ATTENDED
//                         exactly "0" (`claude -p`, SDK, woken/dispatched and
//                         background workers, separate-process teammates) is
//                         neither counted nor blocked: it IS the delegate. An
//                         absent variable counts, as before the option existed.
//   "all"                 every main thread counts, headless ones included.
// Calls a remote session had this machine run (session_id "served:...") are
// never counted: they are not this machine's lead.
//
// A call that does not fire gets NO decision (passthrough), never "allow":
// "allow" skips the permission prompt, and this hook runs on every main-thread
// Bash, Edit and Write.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readStdin, isMainThread, noteAgentType, deny, passthrough, recordDenial, routedRung,
} from './lib/context.mjs';
import {
  guardSettings, isExecutionTool, isResetTool, recordExecutionCall, resetStreak, EXECUTION_TOOLS,
  outOfScope, isServedCall, attendedValue,
} from './lib/delegation.mjs';

const argv = process.argv.slice(2);
const eventIdx = argv.indexOf('--event');
const EVENT = eventIdx >= 0 ? argv[eventIdx + 1] : '';

// Task types whose rungs the instructions list: the ones main-thread
// execution work usually is. Grouped by rung, read from the routing table at
// fire time, so the advice follows the table.
const ROUTE_TYPES = ['explore', 'mechanical-edit', 'verify', 'bounded-feature', 'debug-root-cause'];
const FALLBACK_RUNG = 'agent-companion:ac-opus-low';

function recommendScript() {
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'recommend.mjs'); } catch { return 'scripts/recommend.mjs'; }
}

function rungsByType() {
  const by = new Map();
  for (const t of ROUTE_TYPES) {
    const r = routedRung(t);
    if (!r) continue;
    if (!by.has(r.type)) by.set(r.type, []);
    by.get(r.type).push(t);
  }
  return [...by].map(([rung, types]) => `${rung} for ${types.join(', ')}`).join('; ');
}

function instructions({ mode, streak, threshold, tool }) {
  const example = routedRung('explore')?.type || FALLBACK_RUNG;
  const rungs = rungsByType();
  const head = mode === 'block'
    ? `Delegation guard (delegation_guard: block): this ${tool} call was NOT run. It is main-thread execution-class ` +
      `call ${streak} in a row with no delegation in between; the threshold is ${threshold} (delegation_threshold).`
    : `Delegation guard (delegation_guard: warn): that ${tool} call is main-thread execution-class call ${streak} ` +
      `in a row with no delegation in between; the threshold is ${threshold} (delegation_threshold). ` +
      'This guard did not stop the call.';
  return `${head}\n\n` +
    'Next: delegate the work with the Agent tool, naming a ladder rung so model and effort are explicit, backgrounded, ' +
    'with the task type on its own line in the brief:\n' +
    `  subagent_type: "${example}", run_in_background: true, prompt: "TYPE: <task type>\\n<brief>"\n` +
    (rungs ? `Rungs now: ${rungs}. ` : '') +
    `Other types: node "${recommendScript()}" --type <task-type>. Do not spawn general-purpose, Explore or Plan ` +
    'without a model: it inherits the lead\'s model and effort, and inherit_guard: block refuses that from a premium lead.' +
    // Warn blocks nothing, so it skips the lists that only matter to a lead
    // that has just been stopped (it fires every `threshold` calls on the
    // shipped default, and every word is paid for each time).
    (mode === 'block'
      ? `\n\nCounted: ${EXECUTION_TOOLS.join(', ')}. An Agent spawn or SendMessage that runs resets the count. Agent, ` +
        'SendMessage, ToolSearch, AskUserQuestion, TaskStop and mcp__ tools are never counted or blocked.\n' +
        'Only if this one call truly belongs on the main thread (a read you need in order to decide what to ' +
        'delegate): repeat it. The count has been reset, so it will run.'
      : ' An Agent spawn or SendMessage that runs resets the count.');
}

try {
  const p = readStdin();
  noteAgentType(p);

  const { mode, scope, threshold } = guardSettings();
  if (mode === 'off') passthrough();
  if (isServedCall(p)) passthrough();
  if (!isMainThread(p)) passthrough();
  if (outOfScope(scope)) passthrough();

  if (EVENT === 'reset') {
    if (isResetTool(p.tool_name)) resetStreak(p.session_id);
    passthrough();
  }

  if (!isExecutionTool(p.tool_name)) passthrough();
  const attended = attendedValue();
  const v = recordExecutionCall(p.session_id, threshold, { attended });
  if (!v.fires) passthrough();

  const detail = `${v.streak} consecutive execution-class calls on the main thread (threshold ${threshold}), ` +
    `last ${p.tool_name}; scope ${scope}, attended ${attended}`;
  const text = instructions({ mode, streak: v.streak, threshold, tool: p.tool_name });
  if (mode === 'block') {
    recordDenial('delegation', p, detail);
    deny(text);
  }
  recordDenial('delegation', p, detail, 'warn');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  }));
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
