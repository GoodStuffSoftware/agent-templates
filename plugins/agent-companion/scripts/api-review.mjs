#!/usr/bin/env node
// api-review.mjs — run a code review through the Messages API on the Console API key, so it
// is billed to the plan's API credits instead of the subscription. (Claude Code is not covered
// by the credits, so this never runs `claude -p`; see scripts/lib/api-run.mjs.)
//
//   node api-review.mjs run --brief-file <f> --diff-ref <base>..<head> --model <alias>
//                           [--effort <e>] --cwd <worktree> [--writer <model/effort>]
//                           [--review-file <f>] [--max-usd N] [--max-turns N] [--max-tokens N]
//
// Prints the reviewer's output (its `VERDICT:` line first) on stdout, then one path-label
// line, books the cost under `review` in the credit ledger, and exits:
//   0  ran; the output is the review, which starts with its VERDICT line (a run that ends without
//      one, or was cut off, is exit 4, not a pass)
//   2  bad usage
//   3  "API review unavailable: <reason>" (credit balance, 401/402/403, usage policy, missing
//      workspace id): the writer spawns the plan reviewer subagent at once. Two in a row make
//      `api-credits.mjs decide review` answer plan for the rest of the cycle.
//   4  "API review failed: <reason>" (anything else, including the 8-minute wall-clock deadline and
//      a brief file that holds only a path): same fallback.
// Each paid turn is booked in the ledger as it completes. Run it with a Bash timeout of 600000 ms.
// The key is read from the configured source (api_credits_key_source: env:<NAME> or
// bws:<secret-name>), reaches only the request headers and is never printed.

import { readFileSync, writeFileSync } from 'node:fs';
import { isMain } from './lib/is-main.mjs';
import { execFileSyncHidden } from './lib/proc.mjs';
import { opt } from '../hooks/lib/context.mjs';
import { runApi, REVIEW_SYSTEM, EXIT_OK, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_FAILED } from './lib/api-run.mjs';
import { runApiSdk, DEFAULT_SDK_VERSION, DEFAULT_SDK_MAX_USD } from './lib/api-sdk-run.mjs';

const INSTRUCTION = 'Try to refute this change. Run the tests. Start with a verdict line, `VERDICT: PASS` or `VERDICT: FIX`, then list each finding as blocker, should-fix or nit, with file:line and a repro.';
const DIFF_CAP = 150000;
const BRIEF_CAP = 60000;

// Two engines: 'fetch' (Messages API, read-only tools confined to the repository, cheapest) and 'sdk'
// (the Agent SDK, with Bash, so the reviewer can run the tests). DEFAULT_RUNNER is what a review uses
// when the api_review_runner option and --runner are unset; see the README for the measurement behind it.
export const DEFAULT_RUNNER = 'fetch';
const COMMANDS_RE = /\b(?:run|runs|running|execute|executing)\b[^.\n]{0,40}\b(?:tests?|test suite|suite|commands?|build|lint|linter|checks?)\b|\bnpm (?:run )?test\b|\bnode --test\b|\bpytest\b/i;
export const briefAsksForCommands = (brief) => COMMANDS_RE.test(String(brief || ''));
// An explicit choice (--runner, then the option) always wins; with none, the default engine, except
// that a default of 'fetch' still goes to 'sdk' when the brief asks for commands to be run.
export function chooseRunner({ flag = '', option = '', brief = '', fallback = DEFAULT_RUNNER } = {}) {
  for (const v of [flag, option]) { const t = String(v || '').trim().toLowerCase(); if (t === 'sdk' || t === 'fetch') return t; }
  return fallback === 'sdk' || briefAsksForCommands(brief) ? 'sdk' : 'fetch';
}

// The reviewer's tools cannot read outside the repository, so a brief file that only names a path
// (the lead's brief kept in a file elsewhere) would reach the model as a dead pointer. Detected here,
// so the writer falls back to the subagent reviewer, which can read the path.
export function briefIsOnlyAPath(brief) {
  const body = String(brief).split(/\r?\n/).filter((l) => !/^\s*(?:TYPE|WRITER|ROLE|REVIEW):/i.test(l)).join('\n').trim();
  if (!body) return true;
  return body.length < 400 && /(?:[A-Za-z]:[\/]|(?:^|[\s"'(])\/|~\/)\S+\.[A-Za-z0-9]{1,5}\b/.test(body);
}

// The reviewer has no shell, so the diff is computed here and sent in the prompt.
export function gitDiff(cwd, range) {
  const git = (args) => execFileSyncHidden('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const stat = git(['diff', '--stat', range]);
  let diff = git(['diff', range]);
  let note = '';
  if (diff.length > DIFF_CAP) { diff = diff.slice(0, DIFF_CAP); note = `\n[diff cut at ${DIFF_CAP} characters: read the remaining changed files with read_file]`; }
  return { stat, diff, note };
}

export function buildPrompt({ brief, diffRef, writer, stat = '', diff = '', note = '', shell = false }) {
  return [
    'TYPE: code-review',
    `WRITER: ${writer || 'unknown'}`,
    'ROLE: reviewer',
    '',
    (brief.length > BRIEF_CAP ? `${brief.slice(0, BRIEF_CAP)}\n[brief cut at ${BRIEF_CAP} characters]` : brief).replace(/\s+$/, ''),
    '',
    '---',
    shell
      ? `Diff range under review: ${diffRef}. Your working directory is the repository at the head of that range. Your Read, Grep, Glob and Bash tools can read it and run the tests and checks it needs; say which checks you ran and which you could not.`
      : `Diff range under review: ${diffRef}. Your read_file, grep and glob tools see the repository at the head of that range; you have no shell, so you cannot run commands or tests: say which checks you could not run.`,
    INSTRUCTION,
    'Add nothing that narrows the review.',
    '',
    'git diff --stat:',
    stat.replace(/\s+$/, ''),
    '',
    'git diff:',
    `${diff.replace(/\s+$/, '')}${note}`,
    '',
  ].join('\n');
}

function parse(argv) {
  const o = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) return { error: `unexpected argument ${a}` };
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

export async function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`), env = process.env, fetchImpl, endpoint, sleep, now, cfg, clock, sdk, loadSdk } = {}) {
  const o = parse(argv);
  const usage = 'usage: api-review.mjs run --brief-file <f> --diff-ref <base>..<head> --model <alias> [--effort <e>] --cwd <worktree> [--writer <model/effort>] [--review-file <f>] [--runner sdk|fetch] [--max-usd N] [--max-turns N] [--max-tokens N]';
  if (o.error || o.cmd !== 'run' || !o['brief-file'] || !o['diff-ref'] || !o.model || !o.cwd) { out(o.error || usage); return EXIT_USAGE; }
  // The numeric options are validated: a NaN would silently remove its own cap.
  if (o.runner !== undefined && !['sdk', 'fetch'].includes(o.runner)) { out('runner must be sdk or fetch'); return EXIT_USAGE; }
  for (const k of ['max-usd', 'max-turns', 'max-tokens']) {
    if (o[k] !== undefined && !(Number.isFinite(Number(o[k])) && Number(o[k]) > 0)) { out(`${k} must be a positive number`); return EXIT_USAGE; }
  }
  // Read once, here, and inlined: the model's tools cannot read outside the repository.
  let brief;
  try { brief = readFileSync(o['brief-file'], 'utf8'); } catch (e) { out(`API review failed: cannot read the brief file (${e.code || 'error'})`); return EXIT_FAILED; }
  if (briefIsOnlyAPath(brief)) { out('API review failed: the brief file holds a file path or no text, not the lead\'s brief itself (the reviewer cannot read outside the repository); put the brief text in the file'); return EXIT_FAILED; }
  let d;
  try { d = gitDiff(o.cwd, o['diff-ref']); } catch (e) { out(`API review failed: cannot read the diff ${o['diff-ref']} in ${o.cwd}`); return EXIT_FAILED; }
  const runner = chooseRunner({ flag: o.runner, option: opt('api_review_runner', ''), brief });
  const meta = `review ${o['diff-ref']}`.slice(0, 120);
  let r = null;
  if (runner === 'sdk') {
    r = await runApiSdk({
      prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, shell: true, ...d }),
      model: o.model, effort: o.effort || null, cwd: o.cwd, category: 'review', meta,
      maxUsd: o['max-usd'] ? Number(o['max-usd']) : Number(opt('api_sdk_review_max_usd', DEFAULT_SDK_MAX_USD)),
      ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
      sdkVersion: String(opt('api_sdk_version', DEFAULT_SDK_VERSION)),
      requireVerdict: true, env, ...(sdk ? { sdk } : {}), ...(loadSdk ? { load: loadSdk } : {}),
      ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
    });
    if (r.sdkUnavailable) { err(`${r.reason}; using the fetch engine`); r = null; }
  }
  if (!r) r = await runApi({
    prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, ...d }),
    system: REVIEW_SYSTEM,
    model: o.model, effort: o.effort || null, cwd: o.cwd, category: 'review', meta,
    ...(o['max-usd'] ? { maxUsd: Number(o['max-usd']) } : {}),
    ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
    ...(o['max-tokens'] ? { maxTokens: Number(o['max-tokens']) } : {}),
    requireVerdict: true, ...(clock ? { clock } : {}),
    env, ...(fetchImpl ? { fetchImpl } : {}), ...(endpoint ? { endpoint } : {}), ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
  });
  if (r.ledgerError) err(r.ledgerError); // the spend is not in the ledger: say so
  if (!r.ok) {
    out(r.unavailable ? `API review unavailable: ${r.reason}` : `API review failed: ${r.reason}`);
    return r.unavailable ? EXIT_UNAVAILABLE : EXIT_FAILED;
  }
  const text = `${r.text}\n\n(review path: API credits, ${r.path || runner}, ${r.model}, ${r.turns} turn${r.turns === 1 ? '' : 's'}, $${r.usd.toFixed(2)}${r.ledgerError ? `; ${r.ledgerError}` : ''})`;
  if (o['review-file']) {
    try { writeFileSync(o['review-file'], `${text}\n`); } catch (e) { out(`API review failed: cannot write the review file (${e.code || 'error'})`); return EXIT_FAILED; }
  }
  out(text);
  return EXIT_OK;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
