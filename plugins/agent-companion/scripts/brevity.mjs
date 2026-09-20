#!/usr/bin/env node
// brevity.mjs — the operator's front door to the reporting-contract toggle.
//
// hooks/lib/brevity.mjs's resolveBrevity() is the one place precedence is
// decided (per-agent beats the runtime global override, which beats the
// plugin option default); this CLI never re-derives that logic, only reads
// and writes the config file it resolves against. That is also why `status`
// prints the resolved answer directly rather than leaving the operator to
// reconstruct it from three separate settings — "is this on?" should never
// require reading a file by hand.
//
// Usage:
//   node brevity.mjs                          status (human-readable)
//   node brevity.mjs --json                   status as JSON
//   node brevity.mjs on                       global on
//   node brevity.mjs off                      global off
//   node brevity.mjs default                  clear the runtime global override
//   node brevity.mjs on  --agent <type>       per-agent on  (beats a global off)
//   node brevity.mjs off --agent <type>       per-agent off (beats a global on)
//   node brevity.mjs clear --agent <type>     drop that agent's override
//   node brevity.mjs show [--agent <type>]    print the exact text that would be injected

import {
  brevityConfigPath, readBrevityConfig, writeBrevityConfig, resolveBrevity, buildContract,
} from '../hooks/lib/brevity.mjs';
import { opt } from '../hooks/lib/context.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

const USAGE = 'valid commands: (status|--json) | on|off|default [--agent <type>] | clear --agent <type> | show [--agent <type>]';

function fail(msg) {
  console.error(`brevity: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

// Hand-rolled positional-plus-flags parsing, same style as
// install-global-hooks.mjs: the first token that is not a recognised flag
// (or a flag's own value) is the command.
const FLAGS_WITH_VALUE = new Set(['--agent']);
let command = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (FLAGS_WITH_VALUE.has(a)) i++; continue; }
  if (command === null) command = a;
}
const agent = val('--agent');
if (has('--agent') && !agent) fail('--agent requires a value');

function requireWrite(cfg, doneMessage) {
  const ok = writeBrevityConfig(cfg);
  if (!ok) {
    console.error(`brevity: failed to write ${brevityConfigPath()}`);
    process.exit(1);
  }
  console.log(doneMessage);
  process.exit(0);
}

function cmdSetGlobal(state) {
  const cfg = readBrevityConfig();
  requireWrite(
    { ...cfg, global: state },
    `brevity: global set to ${state} (${brevityConfigPath()})`,
  );
}

function cmdDefault() {
  const cfg = readBrevityConfig();
  requireWrite(
    { ...cfg, global: null },
    `brevity: runtime global override cleared; falling back to the plugin option ` +
    `(currently ${opt('brevity', true) ? 'on' : 'off'}).`,
  );
}

function cmdSetAgent(state, agentType) {
  const cfg = readBrevityConfig();
  requireWrite(
    { ...cfg, agents: { ...cfg.agents, [agentType]: state } },
    `brevity: agent "${agentType}" set to ${state} (beats a global ${state === 'on' ? 'off' : 'on'}).`,
  );
}

function cmdClearAgent(agentType) {
  const cfg = readBrevityConfig();
  const next = { ...cfg.agents };
  // Case-insensitive delete: resolveBrevity() matches agent keys
  // case-insensitively, so a leftover differently-cased key would silently
  // keep overriding after "clear" claims to have dropped it.
  const lowered = agentType.toLowerCase();
  let removed = false;
  for (const k of Object.keys(next)) {
    if (k.toLowerCase() === lowered) { delete next[k]; removed = true; }
  }
  requireWrite(
    { ...cfg, agents: next },
    removed
      ? `brevity: cleared the override for "${agentType}".`
      : `brevity: "${agentType}" had no override to clear.`,
  );
}

function cmdShow(agentType) {
  const text = buildContract(agentType || null);
  if (!text) {
    console.log('(nothing would be injected — brevity and peer-brevity are both off)');
    process.exit(0);
  }
  console.log(text.trim());
  process.exit(0);
}

function printStatus(asJson) {
  const cfg = readBrevityConfig();
  const optDefault = opt('brevity', true);
  const peerDefault = opt('brevity_peer', true);
  const resolvedMain = resolveBrevity(null);
  const out = {
    configPath: brevityConfigPath(),
    option: optDefault,
    globalOverride: cfg.global,
    agents: cfg.agents,
    peer: peerDefault,
    resolved: resolvedMain,
  };
  if (agent) out.resolvedForAgent = { agent, ...resolveBrevity(agent) };

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`config file:              ${out.configPath}`);
  console.log(`plugin option "brevity":  ${out.option ? 'on' : 'off'}`);
  console.log(`runtime global override:  ${out.globalOverride ?? '(not set)'}`);
  const agentKeys = Object.keys(out.agents);
  if (agentKeys.length) {
    console.log('per-agent overrides:');
    for (const k of agentKeys) console.log(`  ${k}: ${out.agents[k]}`);
  } else {
    console.log('per-agent overrides:      (none)');
  }
  console.log(`peer-brevity (brevity_peer): ${out.peer ? 'on' : 'off'}`);
  console.log(`--`);
  console.log(`resolved (no per-agent match): ${out.resolved.on ? 'ON' : 'OFF'}  [winning layer: ${out.resolved.source}]`);
  if (out.resolvedForAgent) {
    const r = out.resolvedForAgent;
    console.log(`resolved for "${agent}":${' '.repeat(Math.max(1, 15 - agent.length))}${r.on ? 'ON' : 'OFF'}  [winning layer: ${r.source}]`);
  }
}

switch (command) {
  case null:
  case undefined:
  case 'status':
    printStatus(has('--json'));
    break;
  case 'on':
    if (agent) cmdSetAgent('on', agent); else cmdSetGlobal('on');
    break;
  case 'off':
    if (agent) cmdSetAgent('off', agent); else cmdSetGlobal('off');
    break;
  case 'default':
    if (agent) fail('"default" applies only to the global toggle; use "clear --agent <type>" to drop a per-agent override');
    cmdDefault();
    break;
  case 'clear':
    if (!agent) fail('"clear" requires --agent <type>');
    cmdClearAgent(agent);
    break;
  case 'show':
    cmdShow(agent);
    break;
  default:
    fail(`unknown command "${command}"`);
}
