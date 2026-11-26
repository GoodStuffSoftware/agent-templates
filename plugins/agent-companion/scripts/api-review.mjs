#!/usr/bin/env node
// api-review.mjs — run a code review through the Messages API on the Console API key, so it
// is billed to the plan's API credits instead of the subscription. (Claude Code is not covered
// by the credits, so this never runs `claude -p`; see scripts/lib/api-run.mjs.)
//
//   node api-review.mjs run --brief-file <f> --diff-ref <base>..<head> --model <alias>
//                           [--effort <e>] --cwd <worktree> [--writer <model/effort>] [--risk low|mid|high]
//                           [--review-file <f>] [--session-id <id> --tool-use-id <id> [--branch <b>]: the spawn guard passes these so the verdict row joins the reviewer-quality readers] [--max-usd N] [--max-turns N] [--max-tokens N]
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

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isMain } from './lib/is-main.mjs';
import { execFileSyncHidden } from './lib/proc.mjs';
import { opt, appendLog } from '../hooks/lib/context.mjs';
import { REVIEW_INSTRUCTION as INSTRUCTION } from '../hooks/lib/self-review.mjs';
import { tierFor } from '../hooks/lib/project-tier.mjs';
import { briefHash } from '../hooks/lib/sg-review-route.mjs';
import { apiVerdictFields, recordPostPassDefect } from '../hooks/lib/review-verdict.mjs';
import { runApi, REVIEW_SYSTEM, reviewLimits, EXIT_OK, EXIT_USAGE, EXIT_UNAVAILABLE, EXIT_FAILED } from './lib/api-run.mjs';
import { runApiSdk, DEFAULT_SDK_VERSION } from './lib/api-sdk-run.mjs';
import { loadConfig, resolveTargets, decide, TargetError, PRIMARY } from './lib/api-credits.mjs';

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

// The reviewer reads the files in --cwd, but the diff is of the range: a working tree that is not at the range head would show it
// other file versions than the diff describes (0.31.63). Returns null when they match, else the reason to refuse.
export function headMismatch(cwd, range) {
  const git = (args) => execFileSyncHidden('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const head = String(range).split(/\.{2,3}/).pop() || 'HEAD';
    const want = git(['rev-parse', '--verify', `${head}^{commit}`]);
    const have = git(['rev-parse', 'HEAD']);
    return want === have ? null : `the working directory is at ${have.slice(0, 9)}, not the range head ${want.slice(0, 9)} (its Read, Grep and Glob would show other file versions than the diff)`;
  } catch { return 'cannot resolve the range head in the working directory'; }
}

// The commit the range ends at, resolved in cwd; null when it cannot be resolved at all.
export function rangeHead(cwd, range) {
  try {
    const head = String(range).split(/\.{2,3}/).pop() || 'HEAD';
    return execFileSyncHidden('git', ['rev-parse', '--verify', `${head}^{commit}`], { cwd, encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// The range with both ends resolved to commits in cwd: a relative ref (HEAD~1, a branch) names another commit in a worktree at the range head.
export function resolveRange(cwd, range) {
  const m = /^(.*?)(\.{2,3})(.*)$/.exec(String(range));
  const one = (r) => execFileSyncHidden('git', ['rev-parse', '--verify', `${r || 'HEAD'}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  try { return m ? `${one(m[1])}${m[2]}${one(m[3])}` : one(range); } catch { return null; }
}

// A lead in its own worktree reviews a branch it has not checked out: the review runs from a temporary detached worktree at the
// range head (0.31.67). Returns { dir, remove } or throws when git cannot make it.
// The first line of git's error text for a refusal reason: credentials in URLs removed, control characters dropped, 160 characters at most.
export function gitErrorLine(e) {
  const raw = String((e && (e.stderr || e.message)) || '').split(/\r?\n/).find((l) => l.trim()) || '';
  return raw.replace(/(:\/\/)[^\s/@]+@/g, '$1[redacted]@').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160);
}

export function tempWorktreeAt(cwd, sha) {
  const parent = mkdtempSync(join(tmpdir(), 'ac-review-'));
  const dir = join(parent, 'wt');
  // `worktree remove --force` on a tree this code created itself; rmSync retries (on Windows a shell child may still hold the cwd); prune last.
  const remove = () => {
    try { execFileSyncHidden('git', ['worktree', 'remove', '--force', dir], { cwd, encoding: 'utf8', stdio: 'pipe' }); } catch { /* fall through to the file removal */ }
    try { rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
    try { execFileSyncHidden('git', ['worktree', 'prune'], { cwd, encoding: 'utf8', stdio: 'pipe' }); } catch { /* best effort */ }
  };
  try {
    execFileSyncHidden('git', ['worktree', 'add', '--detach', dir, sha], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    remove(); // a half-registered worktree and the mkdtemp parent
    throw new Error(gitErrorLine(e) || 'git worktree add failed');
  }
  return { dir, remove };
}

// The change risk the writer states (the table of project tiers): low, mid or high.
export const RISKS = ['low', 'mid', 'high'];
// Said once, after the instruction, which lets a reviewer start the project's own run command: this reviewer cannot.
// A temporary checkout has no node_modules and no untracked or ignored files, and linking the original's node_modules in would let a
// reviewer's command run code from outside the range and make cleanup follow a link: so the check that needs them is skipped, and said so.
export const TEMP_TREE_REASON = 'temporary checkout at the range head: no node_modules or ignored files, so a check that needs installed dependencies or the project\'s own run command was skipped';
const TEMP_TREE_NOTE = `This is a temporary checkout of the range head (${TEMP_TREE_REASON.replace(/^temporary checkout at the range head: /, '')}). List such a check under the checks you would have run; do not report its failing here as a finding.`;
const NO_SHELL ='You have no shell, so you cannot start the app or any command, whatever the instruction above allows: if the change needs a check in the running app, list the checks you would have run.';

export function buildPrompt({ brief, diffRef, writer, risk = '', stat = '', diff = '', note = '', shell = false, tempTree = false }) {
  return [
    'TYPE: code-review',
    `WRITER: ${writer || 'unknown'}`,
    'ROLE: reviewer',
    ...(risk ? [`RISK: ${risk}`] : []),
    '',
    (brief.length > BRIEF_CAP ? `${brief.slice(0, BRIEF_CAP)}\n[brief cut at ${BRIEF_CAP} characters]` : brief).replace(/\s+$/, ''),
    '',
    '---',
    shell
      ? `Diff range under review: ${diffRef}. Your working directory is the repository at the head of that range. Your Read, Grep and Glob tools (and WebSearch and WebFetch) read it; you have no shell and run nothing, not even targeted tests (name the ones you would have run): a review is a read of the code.`
      : `Diff range under review: ${diffRef}. Your read_file, grep and glob tools see the repository at the head of that range; you have no shell and run nothing, not even targeted tests (name the ones you would have run): a review is a read of the code.`,
    INSTRUCTION,
    NO_SHELL,
    ...(tempTree ? [TEMP_TREE_NOTE] : []),
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
  const usage = 'usage: api-review.mjs run --brief-file <f> --diff-ref <base>..<head> --model <alias> [--effort <e>] --cwd <worktree> [--writer <model/effort>] [--risk low|mid|high] [--review-file <f>] [--session-id <id>] [--tool-use-id <id>] [--branch <b>] [--runner sdk|fetch] [--target <name>] [--max-usd N] [--max-turns N] [--max-tokens N]';
  if (o.error || o.cmd !== 'run' || !o['brief-file'] || !o['diff-ref'] || !o.model || !o.cwd) { out(o.error || usage); return EXIT_USAGE; }
  if (o.risk !== undefined && !RISKS.includes(o.risk)) { out('risk must be low, mid or high'); return EXIT_USAGE; }
  // The numeric options are validated: a NaN would silently remove its own cap.
  if (o.runner !== undefined && !['sdk', 'fetch'].includes(o.runner)) { out('runner must be sdk or fetch'); return EXIT_USAGE; }
  for (const k of ['max-turns', 'max-tokens']) {
    if (o[k] !== undefined && !(Number.isFinite(Number(o[k])) && Number(o[k]) > 0)) { out(`${k} must be a positive number`); return EXIT_USAGE; }
  }
  // --max-usd: 0 turns the hard stop off (as the option does); anything else that is not a number >= 0 is a usage error.
  if (o['max-usd'] !== undefined && !(o['max-usd'] !== '' && Number.isFinite(Number(o['max-usd'])) && Number(o['max-usd']) >= 0)) { out('max-usd must be a number, 0 or more (0 turns the hard stop off)'); return EXIT_USAGE; }
  // 0.31.72: --target names an API target (api_targets); the review fails over only to the targets after it in the review list. An unknown name is a usage error.
  const cfgEff = cfg || loadConfig();
  let chain;
  try { chain = resolveTargets('review', cfgEff, o.target === undefined ? null : o.target); } catch (e) { if (e instanceof TargetError) { out(e.message); return EXIT_USAGE; } throw e; }
  if (o.target !== undefined && !String(o.target).trim()) { out('--target needs a target name'); return EXIT_USAGE; }
  const reviewId = `rv-${randomUUID().slice(0, 8)}`; // the ledger entry's id, for api-credits.mjs record-fallback
  // 0.31.63: one telemetry row per API review (route 'api'), the count behind the share `api-credits.mjs status` prints; the guard's route and the manual path both end here.
  // A failed run is written with ok:false and the share leaves it out (the subagent retry counts as the review that happened). A run
  // that ends with a verdict carries the verdict fields (review_of_tool_use_id, review_verdict, branch, writer) the reviewer-quality
  // readers fold on, from --session-id / --tool-use-id (the guard passes them); this row is the verdict row of a routed review.
  let briefText = '';
  let projectTier = '';
  const routeRow = (ok, exit, text = null, reason = null) => {
    try {
      const row = { at: new Date().toISOString(), source: 'api-review', route: 'api', route_reason: 'api', review_id: reviewId, diff_ref: String(o['diff-ref']).slice(0, 120), model: o.model, ok, exit, ...(reason ? { reason: String(reason).slice(0, 300) } : {}), ...(briefText ? { brief_hash: briefHash(briefText) } : {}) }; // brief_hash: the guard's repeat check
      const v = ok && text ? apiVerdictFields({ text, brief: briefText, sid: o['session-id'], tu: o['tool-use-id'], writer: o.writer, model: o.model, effort: o.effort, risk: o.risk, projectTier, branch: o.branch }) : null;
      if (v) Object.assign(row, v);
      appendLog('review-verdicts.jsonl', row);
      if (v) recordPostPassDefect(row);
    } catch { /* telemetry never fails a review */ }
  };
  // Read once, here, and inlined: the model's tools cannot read outside the repository.
  let brief;
  try { brief = readFileSync(o['brief-file'], 'utf8'); } catch (e) { const why = `cannot read the brief file (${e.code || 'error'})`; out(`API review failed: ${why}`); routeRow(false, EXIT_FAILED, null, why); return EXIT_FAILED; }
  briefText = brief;
  if (briefIsOnlyAPath(brief)) { out('API review failed: the brief file holds a file path or no text, not the lead\'s brief itself (the reviewer cannot read outside the repository); put the brief text in the file'); routeRow(false, EXIT_FAILED, null, 'the brief file holds a file path or no text, not the brief itself'); return EXIT_FAILED; }
  // The reviewer reads the files in its cwd, so a cwd that is not at the range head gets a temporary detached worktree at the head.
  let cwd = o.cwd;
  let temp = null;
  let diffRange = o['diff-ref'];
  if (headMismatch(o.cwd, o['diff-ref'])) {
    const sha = rangeHead(o.cwd, o['diff-ref']);
    // A single ref is not a range (its temporary tree would show an empty diff): refused, as it was before the temporary worktree.
    const why = !sha ? 'cannot resolve the range head in the working directory' : (/\.{2,3}/.test(String(o['diff-ref'])) ? null : `the diff ref ${String(o['diff-ref']).slice(0, 60)} is one ref, not a range: give <base>..<head>`);
    let gitWhy = '';
    if (!why) { try { diffRange = resolveRange(o.cwd, o['diff-ref']) || diffRange; temp = tempWorktreeAt(o.cwd, sha); cwd = temp.dir; } catch (e) { temp = null; gitWhy = String((e && e.message) || ''); } }
    const fail = why || (temp ? null : `cannot create a temporary worktree at the range head ${sha.slice(0, 9)}${gitWhy ? ` (${gitWhy})` : ''}`);
    if (fail) { out(`API review failed: ${fail}; use the subagent reviewer`); routeRow(false, EXIT_FAILED, null, fail); return EXIT_FAILED; }
  }
  try {
    return await reviewIn(cwd);
  } finally { if (temp) temp.remove(); }

  async function reviewIn(cwd) {
  let d;
  try { d = gitDiff(cwd, diffRange); } catch (e) { const why = `cannot read the diff ${o['diff-ref']} in ${cwd}`; out(`API review failed: ${why}`); routeRow(false, EXIT_FAILED, null, why); return EXIT_FAILED; }
  const runner = chooseRunner({ flag: o.runner, option: opt('api_review_runner', '') });
  // The ledger meta carries the stated risk and the project's tier, so the weekly report can split API reviews like the others (this path bypasses the spawn guard).
  try { projectTier = tierFor(o.cwd).tier || ''; } catch { projectTier = ''; }
  const metaTail = `${o.risk ? ` risk=${o.risk}` : ''}${projectTier ? ` project_tier=${projectTier}` : ''}`;
  const meta = `review ${String(o['diff-ref']).slice(0, Math.max(0, 120 - 7 - metaTail.length))}${metaTail}`;
  // The soft note and the one hard spend backstop (0 = none); --max-usd takes precedence over the hard option for this review.
  // A soft note that is not below an active backstop is clamped, and said so once.
  let limits;
  try { limits = reviewLimits({ softRaw: opt('api_review_soft_usd', ''), hardRaw: opt('api_review_hard_usd', ''), maxUsdFlag: o['max-usd'] }); } catch (e) { out(e.message); return EXIT_USAGE; }
  const { softUsd, maxUsd, clamped } = limits;
  if (clamped) err(`API review note: ${clamped}`);
  const runOnce = async (tgt) => {
  let r = null;
  if (runner === 'sdk') {
    r = await runApiSdk({
      prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, risk: o.risk, shell: true, tempTree: !!temp, ...d }),
      model: o.model, effort: o.effort || null, cwd, category: 'review', meta,
      maxUsd, softUsd, reviewId, ...(tgt ? { target: tgt } : {}),
      ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
      sdkVersion: String(opt('api_sdk_version', DEFAULT_SDK_VERSION)),
      userGuards: opt('api_review_user_guards', true),
      requireVerdict: true, env, ...(sdk ? { sdk } : {}), ...(loadSdk ? { load: loadSdk } : {}),
      ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
    });
    if (r.sdkUnavailable) { err(`${r.reason}; using the fetch engine`); r = null; }
  }
  if (!r) r = await runApi({
    prompt: buildPrompt({ brief, diffRef: o['diff-ref'], writer: o.writer, risk: o.risk, tempTree: !!temp, ...d }),
    system: fetchSystem(REVIEW_SYSTEM, readProjectRules(cwd)),
    model: o.model, effort: o.effort || null, cwd, category: 'review', meta,
    maxUsd, softUsd, reviewId, ...(tgt ? { target: tgt } : {}),
    ...(o['max-turns'] ? { maxTurns: Number(o['max-turns']) } : {}),
    ...(o['max-tokens'] ? { maxTokens: Number(o['max-tokens']) } : {}),
    requireVerdict: true, ...(clock ? { clock } : {}),
    env, ...(fetchImpl ? { fetchImpl } : {}), ...(endpoint ? { endpoint } : {}), ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}), ...(cfg ? { cfg } : {}),
  });
  return r;
  };
  // The first target of the list (primary only, with the options unset); a run that ends capped (spend-limit 400, the enforced 429, credit
  // exhausted) goes to the next target the governor still answers api for. Past the last, it is the unavailable result below: the plan, as today.
  let tgt = chain[0].name === PRIMARY ? null : chain[0].name;
  let r = await runOnce(tgt);
  while (!r.ok && r.capped) {
    const at = chain.findIndex((t) => t.name === (tgt || PRIMARY));
    const next = chain[at + 1];
    if (!next) break;
    let nd;
    try { nd = decide('review', { cfg: cfgEff, env, target: next.name, ...(now ? { now } : {}) }); } catch { break; }
    if (nd.decision !== 'api') break;
    err(`API review note: target ${tgt || PRIMARY} is capped (${String(r.reason).slice(0, 80)}); failing over to ${nd.target || PRIMARY}`);
    tgt = nd.target || null;
    r = await runOnce(tgt);
  }
  if (r.ledgerError) err(r.ledgerError); // the spend is not in the ledger: say so
  for (const n of r.notes || []) err(`API review note: ${n}`);
  if (!r.ok) {
    const idNote = r.ledgerError ? '' : ` (review id: ${reviewId})`; // no ledger entry, no id to record a fallback against
    out(r.unavailable ? `API review unavailable: ${r.reason}${idNote}` : `API review failed: ${r.reason}${idNote}`);
    routeRow(false, r.unavailable ? EXIT_UNAVAILABLE : EXIT_FAILED, null, r.reason);
    return r.unavailable ? EXIT_UNAVAILABLE : EXIT_FAILED;
  }
  const text = `${r.text}\n\n(review path: API credits, ${r.path || runner}, ${r.model}, ${r.turns} turn${r.turns === 1 ? '' : 's'}, $${r.usd.toFixed(2)}${(r.notes || []).length ? `; ${r.notes.join('; ')}` : ''}${r.ledgerError ? `; ${r.ledgerError}` : ''})`;
  if (o['review-file']) {
    try { writeFileSync(o['review-file'], `${text}\n`); } catch (e) { out(`API review failed: cannot write the review file (${e.code || 'error'})`); return EXIT_FAILED; }
  }
  out(text);
  routeRow(true, EXIT_OK, r.text, temp ? TEMP_TREE_REASON : null);
  return EXIT_OK;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
