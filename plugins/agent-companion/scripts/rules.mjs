#!/usr/bin/env node
// rules.mjs — CLI for the operator's standing rules. Reads/writes through
// hooks/lib/rules.mjs, which owns the file format and the merge-over-
// builtins semantics; this script is only argument parsing and printing.
//
// Hand-rolled has()/val() argv parsing, same shape as
// install-global-hooks.mjs — this plugin has zero dependencies, so no
// argument-parsing library either.
//
// Usage:
//   node rules.mjs list [--json]
//   node rules.mjs show <id>
//   node rules.mjs add --id <id> --scope <scope> --then <text> [--when <regex>] [--note <text>]
//   node rules.mjs add --id <id> --scope <scope> --then-file <path> [--when <regex>]
//   node rules.mjs add --id <id> --scope event-turn --then <text> --then-later <text>   # or --then-later-file <path>
//   node rules.mjs enable <id>
//   node rules.mjs disable <id>
//   node rules.mjs remove <id>            # user rules only; a built-in is disabled, not removed
//   node rules.mjs budget [--json]        # read-only: the session-start block per audience, used / cap, length of each rule
//   node rules.mjs test "<text>" [--scope user-prompt]
//   node rules.mjs test "<raw prompt>" --scope event-turn   # simulate an event turn (see skills/standing-rules)

import { readFileSync } from 'node:fs';
import {
  SCOPES, RULES_VERSION, rulesPath, readRules, appendUserRule, hasRawRuleEntry, setRuleEnabled, removeRuleEntry, matchRules, renderRules, effectiveRule, isEventTurn,
  BUDGET_AUDIENCES, sessionStartBudget, sessionStartOverflow, overflowLine,
} from '../hooks/lib/rules.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const has = (n) => rest.includes(n);
const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USAGE = 'Usage: rules.mjs list|show|add|enable|disable|remove|budget|test ...';

function usageError(msg) {
  console.error(`rules: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function findRule(rules, id) {
  return rules.find((r) => r.id === id) || null;
}

// Every write goes through the raw-file editors in hooks/lib/rules.mjs, which touch only
// the one rule being added/changed/removed and carry everything else over as authored.
function persist(ok, label) {
  if (!ok) {
    console.error(`rules ${label}: not changed. Could not write ${rulesPath()}: the existing file must be valid JSON with a top-level "rules" array (no BOM), or be empty or missing. It was left untouched; fix or remove it, then retry. (Otherwise check that the folder is writable.)`);
    process.exit(1);
  }
}

// After an edit that can add to the session-start block (add, enable, disable): render the block as the hook would for each
// audience and warn when a rule would drop. The edit is never refused; the warning goes to stderr.
function warnOverflow() {
  let over = [];
  try { over = sessionStartOverflow(); } catch { return; }
  if (!over.length) return;
  console.error('rules: WARNING: the session-start block is over its budget, so a rule will not reach the model:');
  for (const b of over) console.error(`  ${overflowLine(b)}`);
  console.error('  Fix: shorten a rule and keep its long form in a spec or doc file the rule points to, or raise the standing_rules_max_chars option (at most 9500). `rules.mjs budget` shows the length of every rule.');
}

try {
  switch (cmd) {
    case undefined:
    case 'list': {
      const { rules } = readRules();
      if (has('--json')) {
        console.log(JSON.stringify({ version: RULES_VERSION, rules }, null, 2));
        break;
      }
      console.log(`Standing rules (${rulesPath()}):`);
      for (const r of rules) {
        const cond = (r.scope === 'always' || r.scope === 'session-start') ? '(unconditional)' : r.scope === 'event-turn' ? '(every event turn)' : (r.when || '(none)');
        // The state it has RIGHT NOW: a rule scheduled for later shows off (or
        // its stored state, with an `after`) until its activeFrom is reached.
        console.log(
          `  ${effectiveRule(r).enabled ? 'on ' : 'off'}  ${r.id.padEnd(24)} scope=${r.scope.padEnd(13)} `
          + `builtin=${r.builtin ? 'yes' : 'no '} ${r.gate ? `gate=${r.gate} ` : ''}${r.scheduleInvalid ? 'activeFrom=(unusable value: rule held off) ' : ''}${r.activeFrom ? `activeFrom=${r.activeFrom}${r.after ? '(+after)' : ''} ` : ''}`
          + `when=${truncate(cond, 40)}  then="${truncate(r.then, 60)}"`
          + (r.superseded && !effectiveRule(r).enabled ? '  [superseded by the built-in knowledge check: ignored; remove it]' : ''),
        );
      }
      break;
    }

    case 'show': {
      const id = rest[0];
      if (!id) usageError('show requires an id');
      const { rules } = readRules();
      const r = findRule(rules, id);
      if (!r) { console.error(`rules show: no rule "${id}"`); process.exit(1); }
      console.log(JSON.stringify(r, null, 2));
      break;
    }

    case 'add': {
      const id = val('--id');
      const scope = val('--scope');
      const when = val('--when');
      const note = val('--note');
      const thenFile = val('--then-file');
      let thenText = val('--then');
      const thenLaterFile = val('--then-later-file');
      let thenLaterText = val('--then-later');

      if (thenFile) {
        try {
          thenText = readFileSync(thenFile, 'utf8');
        } catch (e) {
          usageError(`cannot read --then-file ${thenFile}: ${e.message}`);
        }
      }

      if (thenLaterFile) {
        try {
          thenLaterText = readFileSync(thenLaterFile, 'utf8');
        } catch (e) {
          usageError(`cannot read --then-later-file ${thenLaterFile}: ${e.message}`);
        }
      }

      if (!id) usageError('add requires --id');
      if (!KEBAB.test(id)) usageError(`--id "${id}" must be kebab-case (lowercase letters, digits, hyphens)`);
      if (!scope) usageError('add requires --scope');
      if (!SCOPES.includes(scope)) usageError(`--scope must be one of ${SCOPES.join(', ')}`);
      if (!thenText || !thenText.trim()) usageError('add requires --then <text> or --then-file <path> with non-empty content');

      const laterGiven = thenLaterText !== undefined;
      if (laterGiven && scope !== 'event-turn') usageError('--then-later / --then-later-file apply to scope "event-turn" only');
      if (laterGiven && !thenLaterText.trim()) usageError('--then-later / --then-later-file needs non-empty text');

      const { rules } = readRules();
      if (findRule(rules, id)) usageError(`id "${id}" already exists — use enable/disable, or edit ${rulesPath()} directly to override a built-in`);
      if (hasRawRuleEntry(id)) usageError(`${rulesPath()} already holds an entry with id "${id}" that rules ignores (malformed); fix or remove that entry first`);

      if ((scope === 'user-prompt' || scope === 'spawn') && !when) {
        usageError(`scope "${scope}" requires --when (use --when '.' to mean "every time")`);
      }
      if (when !== undefined) {
        if (when.length > 400) usageError('--when must be 400 characters or fewer');
        try { new RegExp(when, 'i'); } catch (e) { usageError(`--when does not compile as a regex: ${e.message}`); }
      }
      if (scope === 'always') {
        console.error('rules add: WARNING — scope "always" is injected on every single UserPromptSubmit turn. That is paid for constantly; add a gate or use a narrower scope if you can.');
      }

      persist(appendUserRule({
        id, enabled: true, scope, when: when ?? null, then: thenText.trim(), ...(laterGiven ? { thenLater: thenLaterText.trim() } : {}), gate: null, note: note ?? null, added: new Date().toISOString(),
      }), 'add');
      console.log(`rules add: added "${id}" (${scope}).`);
      warnOverflow();
      break;
    }

    case 'enable':
    case 'disable': {
      const id = rest[0];
      if (!id) usageError(`${cmd} requires an id`);
      const { rules } = readRules();
      const r = findRule(rules, id);
      if (!r) { console.error(`rules ${cmd}: no rule "${id}"`); process.exit(1); }
      persist(setRuleEnabled(id, cmd === 'enable'), cmd);
      console.log(`rules ${cmd}: "${id}" is now ${cmd === 'enable' ? 'enabled' : 'disabled'}.`);
      if (r.superseded) console.log(`rules ${cmd}: "${id}" is superseded by the built-in knowledge check (option knowledge_check): it stays off while that is on. Remove it with "remove ${id}".`);
      warnOverflow();
      break;
    }

    case 'remove': {
      const id = rest[0];
      if (!id) usageError('remove requires an id');
      const { rules } = readRules();
      const r = findRule(rules, id);
      if (!r) { console.error(`rules remove: no rule "${id}"`); process.exit(1); }
      if (r.builtin) {
        console.error(`rules remove: "${id}" is a built-in; use "disable ${id}" instead.`);
        process.exit(1);
      }
      persist(removeRuleEntry(id), 'remove');
      console.log(`rules remove: removed "${id}".`);
      break;
    }

    case 'budget': {
      // Read-only: the session-start block as the hook renders it, per audience, with each rule's length.
      const budgets = BUDGET_AUDIENCES.map((a) => sessionStartBudget(a));
      if (has('--json')) {
        console.log(JSON.stringify({ audiences: budgets }, null, 2));
        break;
      }
      console.log('Session-start block budget (characters; the cap is standing_rules_session_start_max_chars, else standing_rules_max_chars):');
      for (const b of budgets) {
        const note = b.audience === 'lead-child' ? ' (a lead started by another session: the worst case)' : b.audience === 'subagent' ? ' (a worker that compacts)' : '';
        console.log(`\n${b.audience}${note}: used ${b.used} / cap ${b.cap} (${b.capOption}), ${b.headroom >= 0 ? `headroom ${b.headroom}` : `OVER by ${-b.headroom}`}`);
        for (const r of b.rules) console.log(`  ${String(r.chars).padStart(5)}  ${r.id}${r.dropped ? '  (DROPPED)' : ''}`);
        if (b.dropped.length) console.log(`  ${overflowLine(b)}`);
      }
      break;
    }

    case 'test': {
      const text = rest.find((a) => !a.startsWith('--')) || '';
      const scope = val('--scope') || 'user-prompt';
      if (!SCOPES.includes(scope)) usageError(`--scope must be one of ${SCOPES.join(', ')}`);

      const { rules } = readRules();
      const relevantScopes = scope === 'user-prompt' ? ['user-prompt', 'always'] : [scope];
      const candidates = rules.filter((r) => relevantScopes.includes(r.scope));

      const matchedIds = new Set();
      for (const s of relevantScopes) {
        for (const r of matchRules({ scope: s, text })) matchedIds.add(r.id);
      }

      console.log(`Testing against: ${JSON.stringify(text)}  (scope: ${scope})`);
      const notEvent = scope === 'event-turn' && !isEventTurn(text);
      if (notEvent) console.log('This text is NOT an event turn: it must be non-empty, carry a known event wrapper (task-notification, cross-session-message, side-sessions-event, ci-monitor-event, or an automated system-notification reminder) and hold no operator-typed text outside the wrappers.');
      console.log('(run with no --sessionId flag: a state gate like delegation-drift always reads as not-yet-drifted here — this is deliberate, see hooks/lib/rules.mjs)');
      for (const r of candidates) {
        let verdict;
        if (!effectiveRule(r).enabled) verdict = 'disabled';
        else if (notEvent) verdict = 'not an event turn'; // as of now: a scheduled rule is judged by its activeFrom/after
        else if (matchedIds.has(r.id)) verdict = 'MATCH';
        else if (r.scope === 'user-prompt' || r.scope === 'spawn') verdict = 'no text match (or gated off)';
        else verdict = 'gated off';
        console.log(`  ${verdict.padEnd(24)} ${r.id}`);
      }

      const rendered = renderRules(rules.filter((r) => matchedIds.has(r.id)));
      console.log('\n--- rendered ---');
      console.log(rendered || '(nothing would be injected)');
      break;
    }

    default:
      usageError(`unknown command "${cmd}"`);
  }
} catch (e) {
  console.error(`rules: unexpected error: ${e.message}`);
  process.exit(1);
}
