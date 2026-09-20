// Standing rules — "always do X if Y" without a code change.
//
// A rule is a TEXT condition (`when`, tested against whatever is happening —
// the user's prompt, or a spawn brief) plus an optional STATE condition
// (`gate` — is the session in a shape where the rule is worth its tokens?)
// plus a directive (`then`) injected as context when both hold. Built-ins
// ship in code (defaultRules()) so wording improves with a plugin update;
// the operator's file overrides or disables any of them by id, or adds their
// own. See standing-rules.json's shape below and readRules()'s merge rule.
//
// The operator's file is UNTRUSTED INPUT, same status as any other hand-
// edited JSON this plugin reads: it will contain bad JSON, bare strings,
// rules with no `then`, scopes that do not exist, and regexes an author
// pasted in without measuring. None of that may break a turn. Every one of
// those shapes is handled in compileRule() below by being dropped or
// disabled, never thrown — see the three-line summary in the module's own
// test file for exactly which shape gets which treatment.
//
// A `when` regex is operator-authored and runs inside a hook with a 5-10
// second timeout; a pathological pattern (catastrophic backtracking) can
// hang that hook for everyone downstream of it, forever, on every turn. The
// cheap defence used here is a hard cap on the SOURCE length (400 chars) —
// it does not stop a short pathological pattern, but it stops the file from
// growing one by pasting in something enormous, and it is O(1) to check
// before ever handing the string to `new RegExp()`.
//
// gate:'brevity' reads Workstream 1's resolveBrevity() from ./brevity.mjs.
// That file is owned by a different workstream and may not exist on disk
// yet (concurrent development), or could be broken by an in-flight edit.
// Two things follow from that: the import must not be a static top-level
// `import` (an unresolvable static import throws during module LINKING,
// before any of this module's own code — including its try/catch — has a
// chance to run, which would take every export in this file down with it);
// and matchRules() below has a frozen SYNCHRONOUS signature, while dynamic
// `import()` is unavoidably async. Those two constraints are reconciled by
// resolving the dynamic import exactly once, via top-level await, into a
// module-level binding that gateSatisfied() then reads synchronously — a
// missing or throwing brevity.mjs leaves that binding null and the gate
// degrades to "not gated" (excluded), never a throw. (A synchronous
// `require()` of an ES module was considered and rejected: it only works
// without a flag from Node 20.19/22.12 onward, and this plugin's own CI
// contract just says "Node 20" — depending on the exact patch release would
// make the gate silently inert on whichever build actually runs it.)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, opt, stateFile, readJson } from './context.mjs';

export const RULES_VERSION = 1;
export const SCOPES = ['user-prompt', 'always', 'session-start', 'spawn'];

const WHEN_MAX_CHARS = 400;
const DEFAULT_MAX_CHARS = 2000;

let resolveBrevity = null;
try {
  ({ resolveBrevity } = await import('./brevity.mjs'));
} catch {
  // Workstream 1's module is absent or broken: the 'brevity' gate below
  // degrades to "not satisfied" for every rule that declares it. Fail open
  // for the HOOK (nothing throws); fail closed for the RULE (it just does
  // not fire) — the safer direction for a feature whose entire job is to
  // stop tokens being spent, not to start spending them unexpectedly.
}

export function rulesPath() {
  return join(configDir(), 'standing-rules.json');
}

function builtinRules() {
  return [
    {
      id: 'copyable-prompt',
      enabled: true,
      builtin: true,
      scope: 'user-prompt',
      when: '\\bprompts?\\b|\\bwrite (?:me )?a prompt\\b|\\bbrief for\\b',
      then: 'The user is asking for a prompt. Put the complete prompt in ONE fenced code block with nothing else inside the fence — no commentary, no ellipses, no placeholder text unless the user asked for placeholders. Anything you want to say about the prompt goes outside the fence.',
      gate: null,
      note: null,
    },
    {
      id: 'lead-brevity',
      enabled: true,
      builtin: true,
      scope: 'session-start',
      gate: 'brevity',
      when: null,
      then: 'Report to the user at outcome level: what happened, what is next, what needs them. State blockers in full. Keep troubleshooting narrative, resolved dead ends and tool-by-tool recaps out of the reply — put detail in a file and link it.',
      note: null,
    },
    {
      // Disabled by default — this rule is documentation-by-example, not an
      // active directive. It exists so `rules list` shows an operator that
      // the 'spawn' scope exists at all; the real per-spawn reporting
      // contract is injected by hooks/lib/brevity.mjs (Workstream 1), not by
      // this rule. Enabling it would double up the wording brevity.mjs
      // already injects.
      id: 'agent-brevity',
      enabled: false,
      builtin: true,
      scope: 'spawn',
      gate: 'brevity',
      when: '.',
      then: '(reserved — the reporting contract is injected by hooks/lib/brevity.mjs; this rule exists so an operator can see the spawn scope in `rules list` and add their own spawn-scoped rules alongside it)',
      note: null,
    },
    {
      id: 'delegate-first',
      enabled: true,
      builtin: true,
      scope: 'session-start',
      when: null,
      then: 'You are an orchestrator. File reads, searches, shell commands, test runs and self-contained edits go to subagents; this session holds planning, interpretation and decisions. Never chain more than three execution-class tool calls here without delegating. Give every spawn an explicit model — an omitted model inherits this session\'s tier and is a decision to pay it.',
      gate: null,
      note: null,
    },
    {
      // The only shipped 'always'-scope rule, deliberately: it is the reason
      // gates exist at all. Silent (free) in a session that never drifts;
      // repeats on EVERY turn once delegation-guard.mjs has fired for this
      // session — a behaviour a document read once cannot have, because it
      // competes with everything that follows it. See gate:'delegation-drift'
      // below for how "already drifted" is decided.
      id: 'delegate-reminder',
      enabled: true,
      builtin: true,
      scope: 'always',
      gate: 'delegation-drift',
      when: null,
      then: 'Delegation reminder: this session has already run execution work on the main thread. Route the next read, search, command, test run or edit to a subagent rather than doing it here.',
      note: null,
    },
  ];
}

export function defaultRules() {
  return builtinRules().map((r) => ({ ...r }));
}

// Normalise + validate ONE rule into the frozen Rule shape, or null to drop
// it. Never throws: a bad `when` regex or an over-long source DISABLES the
// rule (it stays visible in `rules list`, just inert) rather than dropping
// it outright, so an operator can see and fix what they typed; a rule with
// no usable identity at all (not an object, no id, no `then`, unknown scope)
// is dropped silently because there is nothing to show them.
function compileRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  if (typeof rule.id !== 'string' || !rule.id) return null;
  if (typeof rule.then !== 'string' || !rule.then.trim()) return null;
  if (!SCOPES.includes(rule.scope)) return null;

  let enabled = rule.enabled !== false;
  let when = rule.when === undefined || rule.when === null ? null : String(rule.when);
  if (when !== null) {
    if (when.length > WHEN_MAX_CHARS) {
      enabled = false; // pathological source: never compiled, rule just goes inert
    } else {
      try { new RegExp(when, 'i'); } catch { enabled = false; }
    }
  }

  return {
    id: rule.id,
    enabled,
    scope: rule.scope,
    when,
    then: rule.then,
    builtin: !!rule.builtin,
    gate: rule.gate || null,
    note: rule.note ?? null,
  };
}

function readUserEntries() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(rulesPath(), 'utf8'));
  } catch {
    return []; // missing file, or unparseable: defaults only — never throw
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.rules)) return parsed.rules;
  return [];
}

// Built-ins, merged with the operator's file. For a user entry whose `id`
// matches a built-in, the entry is SHALLOW-MERGED over the built-in default
// (so `{"id":"copyable-prompt","enabled":false}` is a complete, minimal
// disable — every other field keeps its shipped value) and `builtin` stays
// true. An entry with an id nobody shipped is appended as a new user rule.
// Garbage — not an object, no id, no `then`, an unknown scope — is dropped
// silently at the compileRule() step; it must never break a turn.
export function readRules() {
  const builtins = defaultRules();
  const byId = new Map(builtins.map((r) => [r.id, r]));
  const order = builtins.map((r) => r.id);

  for (const raw of readUserEntries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = raw.id;
    if (typeof id !== 'string' || !id) continue;

    if (byId.has(id)) {
      byId.set(id, { ...byId.get(id), ...raw, id, builtin: true });
    } else {
      byId.set(id, { enabled: true, gate: null, note: null, when: null, ...raw, id, builtin: false });
      if (!order.includes(id)) order.push(id);
    }
  }

  const rules = order.map((id) => byId.get(id)).filter(Boolean).map(compileRule).filter(Boolean);
  return { version: RULES_VERSION, rules };
}

// Writes ONLY what the operator actually authored: a built-in that was never
// touched is not restated in the file at all (so a plugin update can still
// improve its wording), and a built-in that WAS touched is written as a
// minimal diff against defaultRules() — the same shape `readRules()` already
// accepts as a valid override. New (non-builtin) rules are written in full.
export function writeRules(cfg) {
  try {
    const rules = Array.isArray(cfg?.rules) ? cfg.rules : [];
    const builtinById = new Map(defaultRules().map((r) => [r.id, r]));
    const DIFF_KEYS = ['enabled', 'scope', 'when', 'then', 'gate', 'note'];
    const out = [];

    for (const r of rules) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue;
      const base = builtinById.get(r.id);
      if (base) {
        const diff = { id: r.id };
        let changed = false;
        for (const key of DIFF_KEYS) {
          const a = base[key] ?? null;
          const b = r[key] ?? null;
          if (a !== b) { diff[key] = b; changed = true; }
        }
        if (changed) out.push(diff);
      } else {
        out.push({
          id: r.id,
          enabled: r.enabled !== false,
          scope: r.scope,
          when: r.when ?? null,
          then: r.then,
          gate: r.gate ?? null,
          note: r.note ?? null,
        });
      }
    }

    writeFileSync(rulesPath(), `${JSON.stringify({ version: RULES_VERSION, rules: out }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// gate:'brevity' asks whether the brevity feature resolves ON GLOBALLY —
// deliberately not per-agent-type: matchRules() never carries a
// subagent_type (a session-start or user-prompt rule has no spawn to key
// on), so this reads the same layer resolveBrevity(null) would give the
// main thread: file `global` override, then the plugin's `brevity` option.
//
// gate:'delegation-drift' asks whether THIS session has already tripped
// delegation-guard.mjs — `fired > 0` in its delegation-streak.json entry.
// That file's shape is delegation-guard.mjs's to define; the `fired` field
// is landing there concurrently with this work, so its absence (old file,
// or a session that never fired) must read as 0, not as missing/undefined
// breaking a comparison. No sessionId at all (CLI usage with no live
// session) resolves to NOT satisfied — a drift rule must never claim to be
// active when there is no session to have drifted.
function gateSatisfied(gate, sessionId) {
  if (!gate) return true;

  if (gate === 'brevity') {
    if (typeof resolveBrevity !== 'function') return false;
    try {
      return !!(resolveBrevity(null) || {}).on;
    } catch {
      return false;
    }
  }

  if (gate === 'delegation-drift') {
    if (!sessionId) return false;
    try {
      const st = readJson(stateFile('delegation-streak.json'), {});
      const fired = (st && st[sessionId] && st[sessionId].fired) || 0;
      return fired > 0;
    } catch {
      return false;
    }
  }

  // An unrecognised gate name is an authoring mistake, not a green light —
  // silence (excluded) is the safer default for a feature whose purpose is
  // to spend fewer tokens, not more.
  return false;
}

// Enabled, in-scope, condition-satisfied rules, in the order readRules()
// returns them (built-ins first in their shipped order, then user rules in
// file order). `when` is ignored for 'always' and 'session-start' per the
// scope semantics documented in the spec; for 'user-prompt' and 'spawn' a
// missing/invalid `when` simply never matches rather than throwing.
export function matchRules({ scope, text, sessionId } = {}) {
  const { rules } = readRules();
  return rules.filter((r) => {
    if (!r.enabled) return false;
    if (r.scope !== scope) return false;
    if (!gateSatisfied(r.gate, sessionId)) return false;
    if (scope === 'always' || scope === 'session-start') return true;
    if (typeof r.when !== 'string' || !r.when) return false;
    let re;
    try { re = new RegExp(r.when, 'i'); } catch { return false; }
    return re.test(String(text ?? ''));
  });
}

// '' for an empty list — silence is the default state throughout this
// plugin. Otherwise a small header plus one bullet per rule's `then`,
// stopping once maxChars would be exceeded and naming how many were left
// out, so an operator who set the cap too low sees that instead of quietly
// losing rules with no trace.
export function renderRules(rules, { maxChars } = {}) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return '';

  const cap = typeof maxChars === 'number' ? maxChars : opt('standing_rules_max_chars', DEFAULT_MAX_CHARS);
  const header = '\n\n[agent-companion: standing rules]';
  let body = '';
  let used = header.length;
  let dropped = 0;

  for (const r of list) {
    const line = `\n- ${String((r && r.then) || '').trim()}`;
    if (used + line.length > cap) { dropped += 1; continue; }
    body += line;
    used += line.length;
  }

  let out = header + body;
  if (dropped > 0) {
    out += `\n- (${dropped} more rule${dropped === 1 ? '' : 's'} dropped: over the ${cap}-char limit)`;
  }
  return out;
}
