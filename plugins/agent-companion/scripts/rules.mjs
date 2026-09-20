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
//   node rules.mjs enable <id>
//   node rules.mjs disable <id>
//   node rules.mjs remove <id>            # user rules only; a built-in is disabled, not removed
//   node rules.mjs test "<text>" [--scope user-prompt]

import { readFileSync } from 'node:fs';
import {
  SCOPES, RULES_VERSION, rulesPath, readRules, writeRules, matchRules, renderRules,
} from '../hooks/lib/rules.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const has = (n) => rest.includes(n);
const val = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USAGE = 'Usage: rules.mjs list|show|add|enable|disable|remove|test ...';

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

function persist(rules, label) {
  const ok = writeRules({ version: RULES_VERSION, rules });
  if (!ok) {
    console.error(`rules ${label}: failed to write ${rulesPath()}`);
    process.exit(1);
  }
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
        const cond = (r.scope === 'always' || r.scope === 'session-start') ? '(unconditional)' : (r.when || '(none)');
        console.log(
          `  ${r.enabled ? 'on ' : 'off'}  ${r.id.padEnd(24)} scope=${r.scope.padEnd(13)} `
          + `builtin=${r.builtin ? 'yes' : 'no '} ${r.gate ? `gate=${r.gate} ` : ''}`
          + `when=${truncate(cond, 40)}  then="${truncate(r.then, 60)}"`,
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

      if (thenFile) {
        try {
          thenText = readFileSync(thenFile, 'utf8');
        } catch (e) {
          usageError(`cannot read --then-file ${thenFile}: ${e.message}`);
        }
      }

      if (!id) usageError('add requires --id');
      if (!KEBAB.test(id)) usageError(`--id "${id}" must be kebab-case (lowercase letters, digits, hyphens)`);
      if (!scope) usageError('add requires --scope');
      if (!SCOPES.includes(scope)) usageError(`--scope must be one of ${SCOPES.join(', ')}`);
      if (!thenText || !thenText.trim()) usageError('add requires --then <text> or --then-file <path> with non-empty content');

      const { rules } = readRules();
      if (findRule(rules, id)) usageError(`id "${id}" already exists — use enable/disable, or edit ${rulesPath()} directly to override a built-in`);

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

      const next = [...rules, {
        id, enabled: true, scope, when: when ?? null, then: thenText.trim(), gate: null, note: note ?? null, builtin: false,
      }];
      persist(next, 'add');
      console.log(`rules add: added "${id}" (${scope}).`);
      break;
    }

    case 'enable':
    case 'disable': {
      const id = rest[0];
      if (!id) usageError(`${cmd} requires an id`);
      const { rules } = readRules();
      const r = findRule(rules, id);
      if (!r) { console.error(`rules ${cmd}: no rule "${id}"`); process.exit(1); }
      const next = rules.map((x) => (x.id === id ? { ...x, enabled: cmd === 'enable' } : x));
      persist(next, cmd);
      console.log(`rules ${cmd}: "${id}" is now ${cmd === 'enable' ? 'enabled' : 'disabled'}.`);
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
      const next = rules.filter((x) => x.id !== id);
      persist(next, 'remove');
      console.log(`rules remove: removed "${id}".`);
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
      console.log('(run with no --sessionId flag: a state gate like delegation-drift always reads as not-yet-drifted here — this is deliberate, see hooks/lib/rules.mjs)');
      for (const r of candidates) {
        let verdict;
        if (!r.enabled) verdict = 'disabled';
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
