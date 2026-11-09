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
//   4  "API review failed: <reason>" (anything else, including a hung run (no message or tool result for 10 minutes), the
//      spend backstop (api_review_hard_usd, $2.00; 0 = none) and a brief file that holds only a path): same fallback. The message
//      ends with `(review id: rv-...)` when the run was booked: after a fallback to the plan reviewer, the writer runs
//      `api-credits.mjs record-fallback <review id> --reason <r>` so the weekly report can count the double-spent review.
// Limits are soft: a review that runs past 8 minutes is logged to long-runs.jsonl and continues; one that passes api_review_soft_usd ($1.00) gets a
// note (stderr, the review-path label and the ledger entry) and continues. Each paid turn is booked in the ledger as it
// completes. Run it in the background (run_in_background) and wait for its notification: a foreground Bash call is cut at
// 10 minutes and a review can outlast that.
// The key is read from the configured source (api_credits_key_source: env:<NAME> or
// bws:<secret-name>), reaches only the request headers and is never printed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMain } from './lib/is-main.mjs';
import { execFileSyncHidden } from './lib/proc.mjs';
import { opt } from '../hooks/lib/context.mjs';
import { REVIEW_INSTRUCTION as INSTRUCTION } from '../hooks/lib/self-review.mjs';
import { runApi, REVIEW_SYSTEM, reviewLimits, EXIT_OK, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_FAILED } from './lib/api-run.mjs';
import { runApiSdk, DEFAULT_SDK_VERSION } from './lib/api-sdk-run.mjs';

const DIFF_CAP = 150000;
const BRIEF_CAP = 60000;
// The fetch engine inlines the project's rules into the system prompt (the sdk engine loads them itself, through the
// SDK's project settings). Cap: 20,000 characters in all, about 8K tokens (prose runs about 2.4 characters per token). A
// CLAUDE.md is meant to stay under about 200 lines, roughly 8-10K characters, so a normal one fits whole; the cap bounds what
// one review pays for them: about two cents on Sonnet on a cold cache (first turn), a fraction of a cent per later turn, against a
// $1.00 soft limit. A file that does not fit is cut, with a note saying how much was left out. The fetch engine runs no hooks: its
// guard coverage is the tool allow-list in lib/api-tools.mjs (read_file, grep, glob, confined to the repository) and nothing else.
export const RULES_CAP = 20000;
const norm = (p) => p.split('\\').join('/').toLowerCase();
export function readProjectRules(cwd, cap = RULES_CAP) {
  const roots = [cwd];
  try {
    const top = execFileSyncHidden('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    if (top && norm(top) !== norm(cwd)) roots.push(top);
  } catch { /* not a git checkout: cwd only */ }
  const seen = new Set();
  const parts = [];
  let left = cap;
  for (const root of roots) {
    for (const rel of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
      const p = join(root, rel);
      if (seen.has(norm(p)) || !existsSync(p)) continue;
      seen.add(norm(p));
      let t;
      try { t = readFileSync(p, 'utf8').trim(); } catch { continue; }
      if (!t) continue;
      const name = norm(rel);
      if (left <= 0) { parts.push(`[${name} left out: the ${cap}-character cap on project rules was reached]`); continue; }
      const cut = t.length > left;
      const note = cut ? `[cut: ${t.length - left} more characters not shown, the ${cap}-character cap on project rules]\n` : '';
      parts.push(`<project-rules file="${name}">\n${cut ? t.slice(0, left) : t}\n${note}</project-rules>`);
      left -= Math.min(left, t.length);
    }
  }
  return parts.join('\n');
}
export function fetchSystem(base, rules) {
  if (!rules) return base;
  return `${base}\n\nThe repository's own rules follow (its CLAUDE.md files). Follow its conventions and prohibitions. Rules that address a lead or a writer (delegate, spawn agents, load skills, run a knowledge check, ask the user) do not apply to you: you are the reviewer and do no knowledge check.\n\n${rules}`;
}

// Two engines: 'fetch' (Messages API, read-only tools confined to the repository, cheapest) and 'sdk'
// (the Agent SDK: loads the project's rules and hooks; Read, Grep, Glob and web lookups, no shell: a review is a read). DEFAULT_RUNNER is what a review uses
// when the api_review_runner option and --runner are unset; see the README for the measurement behind it.
export const DEFAULT_RUNNER = 'sdk';
// An explicit choice (--runner, then the option) always wins; with none, the default engine. The brief
// plays no part: both engines are read-only, so a brief that mentions running tests (the protocol's own
// review instruction does) is no reason to prefer one engine over the other.
export function chooseRunner({ flag = '', option = '', fallback = DEFAULT_RUNNER } = {}) {
  for (const v of [flag, option]) { const t = String(v || '').trim().toLowerCase(); if (t === 'sdk' || t === 'fetch') return t; }
  return fallback === 'fetch' ? 'fetch' : 'sdk';
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
      ? `Diff range under review: ${diffRef}. Your working directory is the repository at the head of that range. Your Read, Grep and Glob tools (and WebSearch and WebFetch) read it; you have no shell and run nothing, not even targeted tests (name the ones you would have run): a review is a read of the code.`
      : `Diff range under review: ${diffRef}. Your read_file, grep and glob tools see the repository at the head of that range; you have no shell and run nothing, not even targeted tests (name the ones you would have run): a review is a read of the code.`,
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
  for (const k of ['max-turns', 'max-tokens']) {
    if (o[k] !== undefined && !(Number.isFinite(Number(o[k])) && Number(o[k]) > 0)) { out(`${k} must be a positive number`); return EXIT_USAGE; }
  }
  // --max-usd: 0 turns the hard stop off (as the option does); anything else that is not a number >= 0 is a usage error.
  if (o['max-usd'] !== undefined && !(o['max-usd'] !== '' && Number.isFinite(Number(o['max-usd'])) && Number(o['max-usd']) >= 0)) { out('max-usd must be a number, 0 or more (0 turns the hard stop off)'); return EXIT_USAGE; }
  // Read once, here, and inlined: the model's tools cannot read outside the repository.
  let brief;
  try { brief = readFileSync(o['brief-file'], 'utf8'); } catch (e) { out(`API review failed: cannot read the brief file (${e.code || 'error'})`); return EXIT_FAILED; }
  if (briefIsOnlyAPath(brief)) { out('API review failed: the brief file holds a file path or no text, not the lead\'s brief itself (the reviewer cannot read outside the repository); put the brief text in the file'); return EXIT_FAILED; }
  let d;
  try { d = gitDiff(o.cwd, o['diff-ref']); } catch (e) { out(`API review failed: cannot read the diff ${o['diff-ref']} in ${o.cwd}`); return EXIT_FAILED; }
  const runner = chooseRunner({ flag: o.runner, option: opt('api_review_runner', '') });
  const meta = `review ${o['diff-ref']}`.slice(0, 120);
  // The soft note and the one hard spend backstop (0 = none); --max-usd takes precedence over the hard option for this review.
  // A soft note that is not below an active backstop is clamped, and said so once.
  let limits;
  try { limits = reviewLimits({ softRaw: opt('api_review_soft_usd', ''), hardRaw: opt('api_review_hard_usd', ''), maxUsdFlag: o['max-usd'] }); } catch (e) { out(e.message); return EXIT_USAGE; }
  const { softUsd, maxUsd, clamped } = limits;
  if (clamped) err(`API review note: ${clamped}`);
  const reviewId = `rv-${randomUUID().slice(0, 8)}`; // the ledger entry's id, for api-credits.mjs record-fallback
  let r = null;
  if (runner === 'sdk') {
    r = await runApiSdk({
      prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, shell: true, ...d }),
      model: o.model, effort: o.effort || null, cwd: o.cwd, category: 'review', meta,
      maxUsd, softUsd, reviewId,
      ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
      sdkVersion: String(opt('api_sdk_version', DEFAULT_SDK_VERSION)),
      userGuards: opt('api_review_user_guards', true),
      requireVerdict: true, env, ...(sdk ? { sdk } : {}), ...(loadSdk ? { load: loadSdk } : {}),
      ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
    });
    if (r.sdkUnavailable) { err(`${r.reason}; using the fetch engine`); r = null; }
  }
  if (!r) r = await runApi({
    prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, ...d }),
    system: fetchSystem(REVIEW_SYSTEM, readProjectRules(o.cwd)),
    model: o.model, effort: o.effort || null, cwd: o.cwd, category: 'review', meta,
    maxUsd, softUsd, reviewId,
    ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
    ...(o['max-tokens'] ? { maxTokens: Number(o['max-tokens']) } : {}),
    requireVerdict: true, ...(clock ? { clock } : {}),
    env, ...(fetchImpl ? { fetchImpl } : {}), ...(endpoint ? { endpoint } : {}), ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
  });
  if (r.ledgerError) err(r.ledgerError); // the spend is not in the ledger: say so
  for (const n of r.notes || []) err(`API review note: ${n}`);
  if (!r.ok) {
    const idNote = r.ledgerError ? '' : ` (review id: ${reviewId})`; // no ledger entry, no id to record a fallback against
    out(r.unavailable ? `API review unavailable: ${r.reason}${idNote}` : `API review failed: ${r.reason}${idNote}`);
    return r.unavailable ? EXIT_UNAVAILABLE : EXIT_FAILED;
  }
  const text = `${r.text}\n\n(review path: API credits, ${r.path || runner}, ${r.model}, ${r.turns} turn${r.turns === 1 ? '' : 's'}, $${r.usd.toFixed(2)}${(r.notes || []).length ? `; ${r.notes.join('; ')}` : ''}${r.ledgerError ? `; ${r.ledgerError}` : ''})`;
  if (o['review-file']) {
    try { writeFileSync(o['review-file'], `${text}\n`); } catch (e) { out(`API review failed: cannot write the review file (${e.code || 'error'})`); return EXIT_FAILED; }
  }
  out(text);
  return EXIT_OK;
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
