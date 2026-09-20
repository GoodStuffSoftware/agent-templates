// Feature: the reporting-contract tie-in on SubagentStart, and its
// measurement (and optional gate) on SubagentStop.
//
// This is a SECOND, separate hook on SubagentStart, alongside spawn-log.mjs —
// safe, because SubagentStart is a plain informational event with no single
// shared response to clobber (unlike PreToolUse's updatedInput; see the
// banner in lib/brevity.mjs for that constraint and why it does not apply
// here). It serves two unrelated events, `start` and `stop`, selected by
// argv (`--event start` / `--event stop`) rather than sniffed from the
// payload shape, so the branch taken is deterministic and testable without
// guessing at what a given payload implies.
//
// --- start: the self-heal, and why it must never double-inject ------------
// spawn-guard.mjs is the primary delivery mechanism: it appends the contract
// text to the spawn's prompt via updatedInput at PreToolUse time. But that is
// one hook's opinion among several possible outcomes — another PreToolUse
// hook's updatedInput could win instead, an older cached copy of this plugin
// could be the one that actually ran, or some spawn path could skip
// PreToolUse rewriting entirely. SubagentStart fires after the subagent
// already has its real prompt, so this is the one place that can check
// whether the rewrite actually took and top it up via additionalContext if
// not.
//
// The check is exact-marker containment, not "did brevity resolve on" —
// because if the marker is ALREADY in agent_prompt, the rewrite worked, and
// injecting the same text again would double the token cost of a feature
// whose only job is reducing token cost. A brevity mechanism that pays its
// tax twice is self-refuting, so this is the one behaviour in this file that
// is checked before anything else about the current config.
//
// --- stop: measure by default, gate only if asked --------------------------
// Every SubagentStop appends one row to telemetry/brevity.jsonl (when
// brevity_telemetry is on, which is the default) — this is what makes the
// feature auditable: which agent types actually write long reports, and
// whether the contract moved the number. The BLOCKING gate
// (brevity_stop_gate) is a separate, default-OFF behaviour layered on top of
// that measurement, and it is expensive in a way telemetry is not: a
// SubagentStop `decision: block` feeds its `reason` back to the SAME
// subagent as its next instruction. If it fired on every over-long report it
// would cost a whole extra turn each time (the subagent re-reads its own
// report and rewrites it) — worse, an ungated gate could in principle loop
// forever if the rewritten report is still judged too long. So it fires
// AT MOST ONCE per agent_id, enforced by an exclusive-create (`wx`) marker
// file under stateDir()/brevity-gated/ — the same atomic-marker pattern
// context.mjs's noteAgentType() uses for its own dedup, for the same reason:
// two racing processes must not both think they were first.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, opt, passthrough, appendLog, stateDir } from './lib/context.mjs';
import { buildContract, resolveBrevity, CONTRACT_MARKER, PEER_MARKER } from './lib/brevity.mjs';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const EVENT = val('--event');

function emitAdditionalContext(hookEventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: text },
  }));
  process.exit(0);
}

function emitBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// agent_id is harness-generated and expected to already be a safe token, but
// this hook must never throw on a hostile or malformed one, so it is
// sanitised the same way context.mjs sanitises an agent_type for its own
// marker filenames.
function safeMarkerName(id) {
  return `${String(id || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_')}.seen`;
}

function logBrevity(row) {
  if (!opt('brevity_telemetry', true)) return;
  appendLog('brevity.jsonl', row);
}

function runStart(p) {
  if (!opt('brevity_reinforce', true)) passthrough();

  const text = buildContract(p.agent_type);
  if (!text) passthrough(); // brevity and brevity_peer both off: nothing to reinforce

  const { on, source } = resolveBrevity(p.agent_type);
  const marker = on ? CONTRACT_MARKER : PEER_MARKER;
  const promptSoFar = String(p.agent_prompt || '');

  // The whole point: if the PreToolUse rewrite already landed, the marker is
  // already in the prompt the subagent received. Emit nothing — see the
  // module banner for why this check comes before any telemetry write.
  if (promptSoFar.includes(marker)) passthrough();

  logBrevity({
    at: new Date().toISOString(),
    session_id: p.session_id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    event: 'reinforced',
    report_chars: 0,
    contract_on: on,
    contract_source: source,
    gated: false,
  });
  emitAdditionalContext('SubagentStart', text.trim());
}

function runStop(p) {
  const msg = typeof p.last_assistant_message === 'string' ? p.last_assistant_message : '';
  const reportChars = msg.length;
  const { on, source } = resolveBrevity(p.agent_type);

  let gated = false;
  const gateEnabled = opt('brevity_stop_gate', false);
  const overLimit = reportChars > opt('brevity_report_max_chars', 4000);
  if (gateEnabled && on && overLimit) {
    try {
      const dir = join(stateDir(), 'brevity-gated');
      mkdirSync(dir, { recursive: true });
      // Exclusive create: the ONE process whose create wins is the one that
      // gates. A second SubagentStop for the same agent_id (this hook can be
      // invoked more than once) hits EEXIST and falls through ungated.
      writeFileSync(join(dir, safeMarkerName(p.agent_id)), '', { flag: 'wx' });
      gated = true;
    } catch {
      gated = false; // EEXIST (already gated) or any other fs error: never gate twice
    }
  }

  logBrevity({
    at: new Date().toISOString(),
    session_id: p.session_id,
    agent_id: p.agent_id,
    agent_type: p.agent_type,
    event: 'report',
    report_chars: reportChars,
    contract_on: on,
    contract_source: source,
    gated,
  });

  if (!gated) passthrough();

  emitBlock(
    `This report is ${reportChars} characters. Restate it in the contract shape — a STATUS line, ` +
    'blockers in full, then the outcome stated as facts, with any long content moved to a file — ' +
    'and nothing else.'
  );
}

try {
  const p = readStdin();
  if (EVENT === 'start') runStart(p);
  else if (EVENT === 'stop') runStop(p);
  else passthrough(); // no/unknown --event: deterministic no-op, never guessed from the payload
} catch {
  passthrough(); // never break a session
}
