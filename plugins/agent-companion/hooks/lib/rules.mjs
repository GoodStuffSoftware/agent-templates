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

// copyable-prompt's `when`: a REQUEST for a prompt, not any mention of one.
// A bare \bprompts?\b fired on "the prompt field is empty" and "why do
// prompts time out?". Three shapes count:
//   - a verb that asks for one, then up to three words that are not a
//     preposition, then "prompt(s)": "write me a prompt", "draft a new system
//     prompt", "craft a prompt", "prepare a prompt", "make me a prompt",
//     "send me a prompt", "write up a prompt", "rewrite this prompt", "put
//     together a prompt", "I need a prompt", "I'd like a prompt" (with any
//     apostrophe: "I’d like" too), "I would like a prompt", "can I get a
//     prompt", "could I get a prompt", "turn this into a prompt" (or a
//     brief: "write me a brief for X").
//     A bare "get" does not count: "I get a UAC prompt every time" and "why
//     do I get a prompt for my passphrase?" are about a program's prompt.
//     A verb may end a longer word ("rewrite", "regenerate", "redraft"), so
//     the pattern does not start with \b; every verb must still be followed
//     by whitespace.
//     A plumbing noun after "prompt" does not count ("create a prompt field",
//     "generate the prompt cache key", "a prompts table", "the prompt template
//     loader"), and neither does "prompt(s) to a/the ..." ("write the prompts
//     to a log file"): that names a destination, not a purpose;
//   - a turn that opens with "a prompt for" / "another prompt for" / "a
//     prompt that", unless "that" is followed by I/you/we/they ("a prompt that
//     I sent timed out"), or opens with "prompt for a/the ..." ("Prompt for
//     the reviewer"), but not "Prompt for confirmation before ...";
//   - "... prompt ... write it" within one short stretch ("what should the
//     prompt say? write it out").
// Seen elsewhere in a sentence, "a prompt for/that" is usually something a
// program shows ("the CLI shows a prompt for the password"), so it does not
// count on its own. Bounded repetition only; kept under WHEN_MAX_CHARS (a
// test pins the length).
const PROMPT_VERB = '(?:write|give|[cd]raft|create|compose|generate|make|together|need|want|into|prepare|send me|c(?:an|ould) i get|(?:\\Wd|ould) like)';
const PROMPT_FILLER = '(?:(?!(?:for|to|of|[io]n)\\b)\\S+\\s+){0,3}';
const PROMPT_NOT_PLUMBING = '(?!\\s(?:field|box|input|bar|hook|cach|inject|text|table|templat|to (?:an?|the)\\b))';
export const COPYABLE_PROMPT_WHEN = [
  `${PROMPT_VERB}\\s+${PROMPT_FILLER}(?:prompts?\\b${PROMPT_NOT_PLUMBING}|brief\\sfor\\b)`,
  '^\\s*(?:an?\\S*\\sprompts?\\s(?:for|that\\s(?!(?:i|you|we|they)\\b))|prompts?\\sfor\\s(?:an?|the)\\b)',
  'prompt.{0,60}write it\\b',
].join('|');

function builtinRules() {
  return [
    {
      id: 'copyable-prompt',
      enabled: true,
      builtin: true,
      scope: 'user-prompt',
      when: COPYABLE_PROMPT_WHEN,
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
      // Guard (a)'s own doctrine (CACHE-ADVISOR-HANDOFF.md deliverable 6;
      // hooks/resume-guard.mjs is the enforcement — this rule is the
      // standing reminder that applies even where the hook cannot see far
      // enough, e.g. a cross-session peer).
      id: 'resume-doctrine',
      enabled: true,
      builtin: true,
      scope: 'session-start',
      when: null,
      then: 'Resume only while a worker\'s cache is warm; past its TTL, spawn fresh from a file handoff instead of resuming it with SendMessage.',
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
// A UserPromptSubmit "prompt" is not always the user's own words: the
// harness delivers cross-session messages, background-task notifications,
// agent messages and system reminders as tagged wrapper blocks in the same
// field. Their text (another agent's brief, a task summary) routinely says
// "prompt", which fired copyable-prompt on turns where the user asked for
// nothing. A user-prompt rule therefore matches only what is left once those
// blocks are removed (nested blocks included), an unterminated opening tag
// swallows the rest of the text, and a stray closing tag is dropped.
//
// Slash-command and teammate turns arrive the same way: <teammate-message>
// carries another agent's text, and <command-message>, <command-name>,
// <command-args>, <local-command-stdout> and <local-command-caveat> are the
// harness's record of a slash command and its output. None of them is the
// user asking for something in their own words.
const WRAPPER_TAGS = [
  'cross-session-message', 'task-notification', 'agent-message', 'system-reminder',
  'teammate-message', 'command-message', 'command-name', 'command-args',
  'local-command-stdout', 'local-command-caveat',
].join('|');
// A candidate tag: "<name" or "</name" followed by whitespace or ">". An
// opening tag runs to the next ">", unless another candidate starts before
// that ">": then it is not a tag but the user's own text, typed about one
// ("the <command-args flag is ignored"), and the ">" belongs to the real tag
// that follows (a harness <system-reminder>, say). A closing tag allows only
// whitespace before its ">".
const WRAPPER_TAG_RE = new RegExp(`<(/?)(${WRAPPER_TAGS})(?=[\\s>])`, 'gi');
const SPACES_RE = /\s*/y;

// An odd number of '"' in s[from, to). Only ever called on a stretch the scan
// then moves past, so it keeps userOwnText linear.
function oddQuotes(s, from, to) {
  let odd = false;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 34) odd = !odd;
  return odd;
}

// One left-to-right pass with a stack of open wrappers, so the cost is
// linear in the length of the text whatever the nesting. (It used to repeat
// a regex replace until nothing changed, removing one level of nesting per
// pass: about 30 s on 1 MB of nested tags, inside a UserPromptSubmit hook.)
// Same rules as before:
//   - a closing tag that matches the innermost open wrapper closes it; when
//     that empties the stack, the whole outermost block becomes one space;
//   - a closing tag for any other name, inside a wrapper, is part of that
//     wrapper's text;
//   - a closing tag outside every wrapper is dropped (one space);
//   - a wrapper still open at the end swallows the rest of the text.
// The output matches the old replace-until-stable on every input where each
// opening tag's ">" comes before the next "<". On malformed input it does
// not: the old passes replaced a removed block with a space, which could
// turn a preceding "<system-reminder" (no ">") into an opening tag. Given
// `<system-reminder<command-args>x</command-args>>write me a prompt</system-reminder>`,
// the old code removed the inner block, found a whole <system-reminder>
// block where the text had none, and was silent; this code removes only the
// <command-args> block, and the ask counts. Here a tag is only what the text
// itself spells.
export function userOwnText(text) {
  const s = String(text ?? '');
  const stack = [];
  let out = '';
  let copied = 0; // s[copied..] is not yet in `out`
  let blockStart = 0; // where the outermost open wrapper began
  let gt = -2; // cached s.indexOf('>', ...): the scan only moves forward
  WRAPPER_TAG_RE.lastIndex = 0;
  let m = WRAPPER_TAG_RE.exec(s);
  while (m) {
    const nameEnd = m.index + m[0].length;
    const name = m[2].toLowerCase();
    if (m[1]) {
      SPACES_RE.lastIndex = nameEnd;
      SPACES_RE.exec(s);
      if (s[SPACES_RE.lastIndex] === '>') {
        const end = SPACES_RE.lastIndex + 1;
        if (stack.length === 0) {
          out += `${s.slice(copied, m.index)} `;
          copied = end;
        } else if (stack[stack.length - 1] === name) {
          stack.pop();
          if (stack.length === 0) {
            out += `${s.slice(copied, blockStart)} `;
            copied = end;
          }
        }
        WRAPPER_TAG_RE.lastIndex = end;
      } else {
        WRAPPER_TAG_RE.lastIndex = nameEnd;
      }
      m = WRAPPER_TAG_RE.exec(s);
      continue;
    }
    if (gt !== -1 && gt < nameEnd) gt = s.indexOf('>', nameEnd);
    if (gt === -1) break; // no ">" left: nothing after this can be a tag
    // The next candidate, found once and then processed in turn, so the scan
    // still only moves forward. If it starts before this tag's ">", this is
    // not a tag, unless the candidate sits inside a quoted attribute value
    // (an odd number of '"' since the tag name): a teammate's
    // summary="fixed the <system-reminder> parsing" is part of its tag.
    WRAPPER_TAG_RE.lastIndex = nameEnd;
    let next = WRAPPER_TAG_RE.exec(s);
    if (next && next.index < gt) {
      if (!oddQuotes(s, nameEnd, next.index)) { m = next; continue; }
      WRAPPER_TAG_RE.lastIndex = gt + 1;
      next = WRAPPER_TAG_RE.exec(s);
    }
    if (stack.length === 0) blockStart = m.index;
    stack.push(name);
    m = next;
  }
  if (stack.length > 0) return `${out}${s.slice(copied, blockStart)} `;
  return out + s.slice(copied);
}

export function matchRules({ scope, text, sessionId } = {}) {
  const { rules } = readRules();
  const subject = scope === 'user-prompt' ? userOwnText(text) : String(text ?? '');
  return rules.filter((r) => {
    if (!r.enabled) return false;
    if (r.scope !== scope) return false;
    if (!gateSatisfied(r.gate, sessionId)) return false;
    if (scope === 'always' || scope === 'session-start') return true;
    if (typeof r.when !== 'string' || !r.when) return false;
    let re;
    try { re = new RegExp(r.when, 'i'); } catch { return false; }
    return re.test(subject);
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
