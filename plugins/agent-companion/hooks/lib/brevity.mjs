// Feature: the reporting contract injected into every spawn brief, plus the
// operator's on/off/per-agent switches that control it.
//
// This module is PURE FUNCTIONS AND CONFIG I/O — it is NOT a second
// PreToolUse hook on ^Agent$. hooks/spawn-guard.mjs already owns the single
// PreToolUse response for that matcher (it fills in a blank `model` from the
// routing table, then appends the memory brief/nudge into that SAME
// updatedInput). A second hook on the same matcher returning its own
// updatedInput would silently clobber spawn-guard's — exactly one
// PreToolUse response wins per tool call, the other's updatedInput is simply
// dropped, and a live cost-control feature goes quiet with no error anywhere.
// That is the same failure lib/memory-brief.mjs's own banner documents as its
// reason to be pure functions rather than a hook, and the same fix applies
// here: spawn-guard.mjs calls buildContract() and merges the text into the
// updatedInput it is already building.
//
// Precedence is BIDIRECTIONAL by design, and that is the operator's headline
// requirement, not an incidental detail: a per-agent 'on' wins over a global
// 'off', and a per-agent 'off' wins over a global 'on'. "Brevity everywhere
// except the one agent type that still needs to narrate" (or its mirror,
// "brevity nowhere except this one noisy type") cannot be expressed by a
// switch where the global setting can only ever mute — so the per-agent
// entry is checked FIRST and short-circuits the rest of the chain in both
// directions, before the global override, before the plugin option default.
//
// Every read fails open to the plugin option default: a missing config file,
// an unparseable one, or one with the wrong shape (wrong types, unknown
// fields, not an object at all) all resolve exactly as if no file existed —
// never a throw. The contract defaults to ON (opt('brevity', true)), so
// failing open here means MORE brevity is asked for, not less, which is the
// safe direction for a feature whose entire purpose is capping what a
// subagent is allowed to say back to its caller.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, opt, readJson } from './context.mjs';

export const CONTRACT_MARKER = '[agent-companion: reporting contract]';
export const PEER_MARKER = '[agent-companion: peer brevity]';

// Verbatim text — paid for on every single spawn it applies to, so the
// wording stays exactly as specified and is not reassembled or paraphrased
// at call sites. See hooks/subagent-brevity.mjs for the other half of the
// contract: the marker text below is also what that hook checks for to
// decide whether the PreToolUse rewrite already landed.
const CONTRACT_BODY = [
  CONTRACT_MARKER,
  'Your final assistant message is the only thing your caller reads, and it costs them context.',
  '- Open with STATUS: done | blocked | partial.',
  '- BLOCKERS come next and are never compressed: what is blocked, what you already tried, and the one thing you need in order to proceed.',
  '- Then the outcome: files changed, commands that matter, results stated as facts.',
  '- Leave out progress narration, dead ends you resolved yourself, tool-by-tool recaps, restatements of this brief, and accounts of what you chose not to do.',
  '- Long output goes in a file: give the path and a summary, never the body inline.',
  'Messages to other agents are a decision or a fact — one screen at most, no recap of context they already have.',
  '[end contract]',
].join('\n');

// The peer-brevity sentence also appears inside CONTRACT_BODY above, so the
// two blocks are never both emitted for the same spawn — buildContract()
// below returns one or the other, never both.
const PEER_LINE = `${PEER_MARKER} Messages to other agents are a decision or a fact — one screen at most, no recap of context they already have.`;

// USER-AUTHORED config, not derived state — lives under configDir() (see
// context.mjs), which survives a plugin uninstall and is never treated as
// "safe to delete to reset history" the way telemetry/state are.
export function brevityConfigPath() {
  return join(configDir(), 'brevity.json');
}

function normalizeGlobal(v) {
  return v === 'on' || v === 'off' ? v : null;
}

// Keeps only string keys mapped to the literal 'on'/'off' — anything else
// (a number, a boolean, a typo'd value) is dropped rather than trusted, so a
// hand-edited config with a mistake in it degrades to "no override" for that
// entry instead of doing something unexpected.
function normalizeAgents(v) {
  const out = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [key, val] of Object.entries(v)) {
      if (typeof key === 'string' && key && (val === 'on' || val === 'off')) out[key] = val;
    }
  }
  return out;
}

// Never throws: readJson() already falls back on a missing/unparseable file,
// and normalizeGlobal/normalizeAgents fall back on a wrong-shaped one (a
// string, a number, an array, or an object with the wrong field types).
export function readBrevityConfig() {
  const raw = readJson(brevityConfigPath(), {});
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  return {
    version: 1,
    global: normalizeGlobal(obj.global),
    agents: normalizeAgents(obj.agents),
  };
}

// Returns false rather than throwing on an unwritable config directory, so
// the CLI can report the failure instead of crashing.
export function writeBrevityConfig(cfg) {
  try {
    const safe = {
      version: 1,
      global: normalizeGlobal(cfg?.global),
      agents: normalizeAgents(cfg?.agents),
    };
    writeFileSync(brevityConfigPath(), `${JSON.stringify(safe, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// The decision for one spawn. subagentType may be null/undefined (main
// thread has no per-agent entry to match). Agent-key matching is
// case-insensitive against the stored config keys, not against a
// canonicalised list — the operator's file can spell an agent type however
// the spawn actually spells it.
export function resolveBrevity(subagentType) {
  const cfg = readBrevityConfig();
  const key = subagentType ? String(subagentType).toLowerCase() : '';

  if (key) {
    for (const [agentKey, val] of Object.entries(cfg.agents)) {
      if (agentKey.toLowerCase() === key) {
        return { on: val === 'on', source: 'agent', agent: agentKey };
      }
    }
  }

  if (cfg.global === 'on' || cfg.global === 'off') {
    return { on: cfg.global === 'on', source: 'file', agent: null };
  }

  return { on: opt('brevity', true), source: 'option', agent: null };
}

// The text to append to a spawn brief. '' means nothing to add — callers
// (spawn-guard.mjs's withBrief(), subagent-brevity.mjs) must not append an
// empty string, though doing so would be harmless.
export function buildContract(subagentType) {
  const { on } = resolveBrevity(subagentType);
  if (on) return `\n\n${CONTRACT_BODY}`;
  if (opt('brevity_peer', true)) return `\n\n${PEER_LINE}`;
  return '';
}
