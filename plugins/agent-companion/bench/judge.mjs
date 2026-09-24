// Optional rubric grader ("LLM judge") for the model x effort benchmark.
//
// WHAT IT IS FOR: a task's hidden test answers "does it work". It cannot
// answer "is this a sound design" -- whether the change fixed the real cause
// or special-cased the test, stayed in scope, avoided needless complexity.
// On tasks where every cell passes the hidden test (the documented default
// outcome, see docs/BENCHMARK.md "Ceiling effects"), that is the only quality
// signal left. This module grades a run's CHANGE against a rubric that lives
// in the task definition (a task pack's rubric.md, or a built-in task's
// `rubric` string).
//
// WHAT IT IS NOT: a replacement for, or an input to, pass/fail. The judge's
// verdict is logged as its own columns (judge_pass, judge_votes, ...) and
// summarised in its own table. Nothing here ever reads or writes row.pass.
//
// THE RULES, each enforced in code below and covered by
// tests/bench-judge.test.mjs (every test stubs the judge -- no model call):
//
//   1. DIFFERENT AND AT LEAST AS STRONG. The judge model must not be the
//      model under test (a model marking its own homework is the failure
//      Anthropic's develop-tests guidance warns about), and must be at least
//      as strong: tier rank >= the tested model's, and a superseded dated id
//      (config referenceModels) never judges the current model of its own
//      tier. An unknown or unavailable model can prove neither, so it is
//      refused. See checkJudgeEligibility().
//   2. THREE INDEPENDENT CALLS, PASS ON 2 OF 3. Each vote is a fresh process
//      with no shared session (--no-session-persistence), mirroring
//      `claude plugin eval`'s llm grader. See runJudge().
//   3. REASON BEFORE THE VERDICT. The prompt asks for REASONING: first and
//      a single VERDICT: line last; only the last VERDICT line counts. An
//      unparseable vote is recorded as null, never guessed.
//   4. BLIND. buildJudgePrompt() takes no model, cell, effort, or run id --
//      there is no parameter through which the producer could leak -- and
//      scrubIdentity() strips self-identification ("as Claude Opus ...",
//      Co-Authored-By lines) from the candidate's own text.
//   5. CAPPED. Per-call --max-budget-usd (default and ceiling below, in
//      Sonnet dollars, scaled by the judge model's price exactly like task
//      budgets), effort limited to low/medium/high, no tools at all.
//      Temperature: current judge-eligible models (Sonnet 5, Opus 5/5.5,
//      Fable 5/5.1) reject sampling parameters with a 400, and `claude -p`
//      exposes none, so the only accepted value is null (not sent). Variance
//      is controlled by fixed effort plus the 3-vote majority instead.
//   6. CALIBRATED BEFORE TRUSTED. A judge is only used on a task after it
//      has scored that task's known-good change as PASS and every known-bad
//      variant as FAIL, for this exact (task content, rubric, judge model,
//      judge effort, prompt template) combination. The runner refuses to use
//      a judge without a matching trusted record. See calibrateJudge() and
//      assertJudgeCalibrated().

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { classifyModel, classifyReferenceModel, isModelAvailable, effortSupported } from '../hooks/lib/context.mjs';
import { rmrf } from './tasks/common.mjs';

// Bump whenever buildJudgePrompt()'s wording changes: every calibration
// record is keyed on it, so a prompt change forces re-calibration rather than
// silently reusing a trust decision made against different wording.
export const JUDGE_TEMPLATE_VERSION = 1;
export const JUDGE_VOTES = 3;
export const JUDGE_PASS_VOTES = 2;
export const JUDGE_EFFORTS = ['low', 'medium', 'high'];
export const JUDGE_DEFAULT_EFFORT = 'medium';
// Per-call budget, in SONNET dollars (scaled by the judge's price before use,
// same as every task budget -- see bench/runner.mjs scaledMaxBudgetUsd()).
export const JUDGE_DEFAULT_BUDGET_USD = 0.3;
export const JUDGE_MAX_BUDGET_USD = 1.0;
// Candidate diff larger than this is truncated WITH an explicit marker in the
// prompt (and judge_input_truncated on the row) -- never silently.
export const JUDGE_MAX_DIFF_CHARS = 60000;
export const JUDGE_MAX_MESSAGE_CHARS = 8000;

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------------------------------------------------------------- config --

// Validates and normalises a judge config. Throws with every problem listed
// rather than the first, so one run of --dry-run shows the whole story.
export function validateJudgeConfig(cfg = {}) {
  const problems = [];
  const model = cfg.model ? String(cfg.model) : '';
  if (!model) problems.push('judge model is required (--judge-model <full model id>)');
  if (model && !/^claude-/.test(model)) problems.push(`judge model "${model}" must be a full model id (claude-...), not an alias -- aliases float across versions`);
  let effort = cfg.effort == null ? JUDGE_DEFAULT_EFFORT : String(cfg.effort).toLowerCase();
  if (!JUDGE_EFFORTS.includes(effort)) problems.push(`judge effort "${effort}" is not allowed (allowed: ${JUDGE_EFFORTS.join(', ')}) -- capped so a judge cannot cost more than the run it grades`);
  // A tier that takes no effort parameter at all (haiku) gets none sent.
  if (model) {
    const sup = effortSupported(model, effort);
    if (sup && Array.isArray(sup.supported) && sup.supported.length === 0 && /takes no effort/i.test(sup.reason || '')) effort = null;
  }
  const maxBudgetUsd = cfg.maxBudgetUsd == null ? JUDGE_DEFAULT_BUDGET_USD : Number(cfg.maxBudgetUsd);
  if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) problems.push(`judge budget must be a positive number, got ${cfg.maxBudgetUsd}`);
  else if (maxBudgetUsd > JUDGE_MAX_BUDGET_USD) problems.push(`judge budget $${maxBudgetUsd} per call exceeds the cap of $${JUDGE_MAX_BUDGET_USD} (Sonnet dollars)`);
  if (cfg.temperature != null) {
    problems.push('judge temperature must be left unset: current judge-eligible models reject sampling parameters (HTTP 400) and `claude -p` exposes none -- variance is controlled by fixed effort and the 3-vote majority');
  }
  if (problems.length) throw new Error('invalid judge config:\n  - ' + problems.join('\n  - '));
  return { model, effort, maxBudgetUsd, temperature: null };
}

// Strength of a model for the "at least as strong" rule: tier rank first,
// then current (1) over superseded dated id (0) within the same tier.
export function modelStrength(model) {
  const c = classifyModel(model);
  const ref = classifyReferenceModel(model);
  return { known: !!c.known, rank: c.rank || 0, current: ref ? 0 : 1, alias: c.alias, available: isModelAvailable(model) };
}

export function checkJudgeEligibility(judgeModel, testedModel) {
  const j = String(judgeModel || '');
  const t = String(testedModel || '');
  if (!j) return { ok: false, reason: 'no judge model' };
  if (j.toLowerCase() === t.toLowerCase()) return { ok: false, reason: `judge ${j} is the model under test -- a model may not grade its own work` };
  const js = modelStrength(j);
  const ts = modelStrength(t);
  if (!js.known) return { ok: false, reason: `judge ${j} is not in the tier table -- its strength cannot be established` };
  if (!js.available) return { ok: false, reason: `judge ${j} is marked unavailable on this account` };
  if (!ts.known) return { ok: false, reason: `model under test ${t} is not in the tier table -- cannot prove the judge is at least as strong` };
  if (js.rank < ts.rank) return { ok: false, reason: `judge ${j} (rank ${js.rank}) is weaker than the model under test ${t} (rank ${ts.rank})` };
  if (js.rank === ts.rank && js.current < ts.current) return { ok: false, reason: `judge ${j} is a superseded id of the same tier as ${t} -- not at least as strong` };
  return { ok: true, reason: '' };
}

// ------------------------------------------------------------- blindness --

const MODEL_NAME_RE = /\b(?:claude[-\s]?)?(?:opus|sonnet|haiku|fable|mythos)(?:[-\s]?\d+(?:[.-]\d+)*)?\b/gi;
const MODEL_ID_RE = /\bclaude-[a-z0-9.-]+\b/gi;
const ATTRIBUTION_LINE_RE = /^.*(?:co-authored-by:|generated (?:with|by) \[?claude).*$/gim;
const SELF_ID_RE = /\b(?:as|i am|i'm) (?:an? )?(?:ai|assistant|language model|claude)\b[^.\n]*/gi;

// Removes anything in the CANDIDATE's own text that could tell the judge who
// produced it. Applied to the final message in full; applied to the diff
// only for attribution lines (a diff's code may legitimately contain model
// names -- e.g. a routing table -- and rewriting code would change what is
// being judged).
export function scrubIdentity(text, { codeSafe = false } = {}) {
  let s = String(text ?? '');
  s = s.replace(ATTRIBUTION_LINE_RE, '[attribution line removed]');
  if (codeSafe) return s;
  s = s.replace(MODEL_ID_RE, '[model]');
  s = s.replace(MODEL_NAME_RE, '[model]');
  s = s.replace(SELF_ID_RE, '[self-description removed]');
  return s;
}

// ------------------------------------------------------------------ diff --

// Line diff via LCS, rendered as unified hunks with 3 lines of context. Zero
// dependencies on purpose (the sandbox trees are small text fixtures). Files
// past MAX_LCS_LINES fall back to "whole file replaced" rather than an
// O(n*m) table that could stall a batch.
const MAX_LCS_LINES = 3000;

function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES) {
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])];
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i += 1; j += 1; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i += 1; }
    else { ops.push(['+', b[j]]); j += 1; }
  }
  while (i < n) { ops.push(['-', a[i]]); i += 1; }
  while (j < m) { ops.push(['+', b[j]]); j += 1; }
  return ops;
}

function hunks(ops, context = 3) {
  const changed = ops.map((o) => o[0] !== ' ');
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) { k += 1; continue; }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (changed[end]) { end += 1; continue; }
      let run = end;
      while (run < ops.length && !changed[run]) run += 1;
      if (run - end > context * 2 || run === ops.length) { end = Math.min(ops.length, end + context); break; }
      end = run;
    }
    out.push(ops.slice(start, end));
    k = end;
  }
  return out;
}

function splitLines(text) {
  if (text == null) return [];
  const s = String(text).replace(/\r\n/g, '\n');
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Unified-style diff between two sandbox trees ({ relPath: content }).
// `exclude` paths (e.g. the guard sentinel file) are never shown.
export function treeDiff(oldTree = {}, newTree = {}, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const paths = [...new Set([...Object.keys(oldTree), ...Object.keys(newTree)])].filter((p) => !skip.has(p)).sort();
  const parts = [];
  for (const p of paths) {
    const a = oldTree[p];
    const b = newTree[p];
    if (a === b) continue;
    parts.push(`--- ${a == null ? '/dev/null' : 'a/' + p}`);
    parts.push(`+++ ${b == null ? '/dev/null' : 'b/' + p}`);
    for (const h of hunks(lineDiff(splitLines(a), splitLines(b)))) {
      parts.push('@@');
      for (const [op, line] of h) parts.push(op + line);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------- prompt --

const JUDGE_SYSTEM = 'You are a careful, skeptical software reviewer acting as a grader. You grade one candidate change against a rubric. You have no tools; everything you need is in the message.';

function clip(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + `\n[... truncated: ${s.length - max} more characters not shown ...]`, truncated: true };
}

// Deterministic, and BLIND by construction: its only inputs are the task
// brief, the rubric, the change, and the candidate's scrubbed final message.
// No model, cell, effort, run id, rep, cost, or timing is accepted.
export function buildJudgePrompt({ taskPrompt, rubric, diff, finalMessage }) {
  const d = clip(scrubIdentity(diff || '', { codeSafe: true }), JUDGE_MAX_DIFF_CHARS);
  const f = clip(scrubIdentity(finalMessage || ''), JUDGE_MAX_MESSAGE_CHARS);
  const user = [
    'You are grading ONE candidate solution to a software task. You are not told who or what produced it; grade only the work shown.',
    '',
    '<task_given_to_candidate>',
    String(taskPrompt || '').trim(),
    '</task_given_to_candidate>',
    '',
    '<rubric>',
    String(rubric || '').trim(),
    '</rubric>',
    '',
    '<candidate_change format="unified diff of the working tree, before -> after">',
    d.text.trim() ? d.text : '(no files changed)',
    '</candidate_change>',
    '',
    '<candidate_final_message>',
    f.text.trim() ? f.text : '(empty)',
    '</candidate_final_message>',
    '',
    'How to answer:',
    '1. Reason first. Start with a line "REASONING:" and check the change against every rubric item, citing the diff. Functional correctness is tested separately; grade what the rubric asks about. The candidate\'s own claims are not evidence -- the diff is.',
    '2. Then end with exactly one final line: "VERDICT: PASS" or "VERDICT: FAIL". PASS only if every PASS condition in the rubric holds and no FAIL condition applies.',
  ].join('\n');
  return { system: JUDGE_SYSTEM, user, truncated: d.truncated || f.truncated };
}

// Only the LAST VERDICT line counts (the reasoning may quote the format).
export function parseVerdict(text) {
  const re = /^\s*\**\s*VERDICT\s*:\s*\**\s*(PASS|FAIL)\b/gim;
  let m;
  let last = null;
  while ((m = re.exec(String(text || ''))) !== null) last = m[1].toUpperCase();
  return last;
}

// ------------------------------------------------------------ transport --

// The default judge transport: one fresh `claude -p` process per vote, no
// tools, no settings, no MCP, no session persistence, from an empty temp cwd.
// `getBin` is injected (bench/runner.mjs's lazy resolver) to avoid a circular
// import. Returns { text, cost_usd, is_error }.
export function makeCliJudgeCaller(getBin) {
  return function callJudgeViaCli({ system, user, model, effort, maxBudgetUsd }) {
    return new Promise((resolve) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-judge-'));
      const args = [
        '-p', user,
        '--model', model,
        '--output-format', 'json',
        '--system-prompt', system,
        '--tools', '',
        '--setting-sources', '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--max-budget-usd', String(maxBudgetUsd),
      ];
      if (effort) args.push('--effort', effort);
      execFile(getBin(), args, {
        cwd, env: { ...process.env }, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, timeout: 10 * 60 * 1000,
        windowsHide: true,
      }, (err, stdout) => {
        // rmrf() (bench/tasks/common.mjs) retries EPERM/EBUSY/ENOTEMPTY with
        // bounded backoff before giving up -- still best-effort here (a
        // judge vote's temp cwd leaking on a rare Windows failure is
        // harmless), so any final failure is still swallowed.
        try { rmrf(cwd); } catch { /* best effort */ }
        let json = null;
        try { json = JSON.parse(stdout); } catch { json = null; }
        resolve({
          text: json ? String(json.result ?? '') : '',
          cost_usd: json ? (json.total_cost_usd ?? null) : null,
          is_error: json ? !!json.is_error : true,
          error: err ? String(err.message || err) : null,
        });
      });
    });
  };
}

// ------------------------------------------------------------------ run --

// Three independent votes, pass on two. `callJudge` is injectable (tests pass
// a stub; production passes makeCliJudgeCaller(...)). `budgetUsd` is the
// already price-scaled per-call cap.
export async function runJudge({ config, budgetUsd, taskPrompt, rubric, diff, finalMessage, callJudge }) {
  if (typeof callJudge !== 'function') throw new Error('runJudge: callJudge is required');
  const prompt = buildJudgePrompt({ taskPrompt, rubric, diff, finalMessage });
  const votes = [];
  let cost = 0;
  let costKnown = true;
  for (let i = 0; i < JUDGE_VOTES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await callJudge({ system: prompt.system, user: prompt.user, model: config.model, effort: config.effort, maxBudgetUsd: budgetUsd ?? config.maxBudgetUsd });
    votes.push(r && !r.is_error ? parseVerdict(r.text) : null);
    if (typeof r?.cost_usd === 'number') cost += r.cost_usd; else costKnown = false;
  }
  const passes = votes.filter((v) => v === 'PASS').length;
  const valid = votes.filter((v) => v !== null).length;
  const pass = passes >= JUDGE_PASS_VOTES ? true : (valid < JUDGE_PASS_VOTES ? null : false);
  return {
    pass, votes, passes, invalid: JUDGE_VOTES - valid,
    cost_usd: costKnown ? cost : null,
    truncated: prompt.truncated,
    prompt_sha256: sha256(prompt.system + '\n' + prompt.user),
  };
}

// ---------------------------------------------------------- calibration --

// Everything a trust decision depends on. Change any of it and the old
// record no longer matches -- the judge must be re-calibrated.
export function calibrationKey({ taskId, taskIdentity, rubric, model, effort }) {
  return sha256(JSON.stringify({
    v: JUDGE_TEMPLATE_VERSION, taskId, taskIdentity: taskIdentity ?? null, rubric: sha256(rubric || ''), model, effort: effort ?? null,
  }));
}

export function taskJudgeKey(taskId, task, config) {
  const identity = typeof task.judgeIdentity === 'function' ? task.judgeIdentity() : null;
  return calibrationKey({ taskId, taskIdentity: identity, rubric: task.rubric, model: config.model, effort: config.effort });
}

export function loadCalibrationStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && s.records ? s : { records: {} };
  } catch {
    return { records: {} };
  }
}

export function saveCalibrationRecord(file, record) {
  const store = loadCalibrationStore(file);
  store.records[record.key] = record;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  return store;
}

export function findTrustedCalibration(file, key) {
  const rec = loadCalibrationStore(file).records[key];
  return rec && rec.trusted === true ? rec : null;
}

// Runs the judge against a task's known-good change and every known-bad
// variant. Trusted only if good -> PASS and every bad -> FAIL. An
// unparseable result (pass === null) is NOT trusted either way. Writes the
// record (trusted or not) to `storeFile` so the failure is inspectable.
//
// `task.judgeCalibrationCases()` supplies the cases: for a task pack, the
// real fix commit's diff is the known-good and the unchanged parent (plus
// any planted broken variants from the manifest) are the known-bad -- see
// bench/task-packs/lib.mjs.
export async function calibrateJudge({ taskId, task, config, budgetUsd, callJudge, storeFile, now = () => new Date().toISOString() }) {
  if (!task.rubric) throw new Error(`task "${taskId}" has no rubric -- nothing to calibrate`);
  if (typeof task.judgeCalibrationCases !== 'function') {
    throw new Error(`task "${taskId}" supplies no calibration cases (known-good / known-bad) -- a judge cannot be trusted on it`);
  }
  const cases = await task.judgeCalibrationCases();
  if (!cases?.knownGood || !Array.isArray(cases.knownBad) || cases.knownBad.length === 0) {
    throw new Error(`task "${taskId}": calibration needs one known-good and at least one known-bad case`);
  }
  const grade = (c) => runJudge({
    config, budgetUsd, taskPrompt: cases.taskPrompt, rubric: task.rubric,
    diff: treeDiff(c.oldTree, c.newTree, { exclude: cases.exclude || [] }), finalMessage: c.finalMessage, callJudge,
  });
  const good = await grade(cases.knownGood);
  const bad = [];
  for (const c of cases.knownBad) {
    // eslint-disable-next-line no-await-in-loop
    const r = await grade(c);
    bad.push({ label: c.label, pass: r.pass, votes: r.votes, cost_usd: r.cost_usd });
  }
  const trusted = good.pass === true && bad.every((b) => b.pass === false);
  const key = taskJudgeKey(taskId, task, config);
  const record = {
    key, taskId, trusted, ts: now(),
    judgeModel: config.model, judgeEffort: config.effort, templateVersion: JUDGE_TEMPLATE_VERSION,
    rubricSha256: sha256(task.rubric),
    knownGood: { pass: good.pass, votes: good.votes, cost_usd: good.cost_usd },
    knownBad: bad,
  };
  if (storeFile) saveCalibrationRecord(storeFile, record);
  return record;
}

// The runner's gate: throws unless a TRUSTED calibration record exists for
// exactly this (task, rubric, judge model, judge effort, template).
export function assertJudgeCalibrated({ taskId, task, config, storeFile }) {
  const key = taskJudgeKey(taskId, task, config);
  const rec = findTrustedCalibration(storeFile, key);
  if (!rec) {
    throw new Error(
      `judge ${config.model}/${config.effort ?? 'none'} is not calibrated for task "${taskId}" (no trusted record in ${storeFile}). ` +
      'Run scripts/benchmark.mjs --calibrate-judge with the same --judge-model/--judge-effort first; the runner never uses an uncalibrated judge.',
    );
  }
  return rec;
}
