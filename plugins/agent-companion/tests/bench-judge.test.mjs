// The optional rubric judge (bench/judge.mjs) and its wiring into
// bench/runner.mjs / scripts/benchmark.mjs. EVERY judge here is a stub:
// no model is called anywhere in this file. Where a code path could spawn
// claude, CLAUDE_BIN points at a path that does not exist, so a regression
// fails loudly instead of spending money.
//
// Covers: config caps (effort, budget, temperature), the different-and-at-
// least-as-strong rule, blindness, reason-before-verdict parsing, 2-of-3
// voting, the calibration gate against the example pack's real fix commit
// (known-good must PASS, parent + planted variants must FAIL), the runner's
// refusal to use an uncalibrated judge, and the judge score staying a
// SEPARATE column that never touches pass/fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, cpSync, existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PLUGIN_ROOT, runScript } from './helpers.mjs';
import {
  validateJudgeConfig, checkJudgeEligibility, scrubIdentity, buildJudgePrompt, parseVerdict, runJudge,
  treeDiff, calibrateJudge, assertJudgeCalibrated, loadCalibrationStore, taskJudgeKey,
  makeCliJudgeCaller, JUDGE_MAX_BUDGET_USD, JUDGE_DEFAULT_EFFORT, JUDGE_MAX_DIFF_CHARS,
} from '../bench/judge.mjs';
import { runOne, rebuildSummary, CELLS } from '../bench/runner.mjs';
import { judgePreflight, buildJudgeVotePlan } from '../scripts/benchmark.mjs';
import { cleanGitEnv } from '../scripts/lib/git-env.mjs';
import { loadPack, buildTaskFromPack, applyPlantedBad } from '../bench/task-packs/lib.mjs';

const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const EXAMPLE_PACK_DIR = join(PLUGIN_ROOT, 'bench', 'task-packs', 'examples', 'leak-check-gitignore-fix');
const NO_CLAUDE = { CLAUDE_BIN: join(tmpdir(), 'definitely-not-a-claude-binary.exe') };

// A deterministic "judge" that actually reads the diff it is shown: PASS
// only for a change that uses git's full committable set. This is what makes
// the calibration test meaningful -- it separates the real fix from the
// unchanged parent and from both planted variants.
function readingJudge() {
  const prompts = [];
  const fn = async ({ user, model, effort, maxBudgetUsd }) => {
    prompts.push({ user, model, effort, maxBudgetUsd });
    const change = user.split('<candidate_change')[1].split('</candidate_change>')[0];
    // Reads the CODE, not the comments: planted variant 1 keeps the fix's
    // comment (which still mentions --others) but drops it from the args.
    const good = /\+.*\["ls-files", "--cached", "--others", "--exclude-standard"\]/.test(change) && !/endsWith\(/.test(change);
    return { text: `REASONING: looked at the diff.\nVERDICT: ${good ? 'PASS' : 'FAIL'}`, cost_usd: 0.001, is_error: false };
  };
  return { fn, prompts };
}
const constantJudge = (verdict) => async () => ({ text: `REASONING: x\nVERDICT: ${verdict}`, cost_usd: 0, is_error: false });
function sequenceJudge(verdicts) {
  let i = 0;
  return async () => {
    const v = verdicts[i++];
    return v === null ? { text: 'no verdict line at all', cost_usd: 0, is_error: false } : { text: `REASONING: r\nVERDICT: ${v}`, cost_usd: 0.01, is_error: false };
  };
}

const JUDGE = () => validateJudgeConfig({ model: 'claude-fable-5-1', effort: 'low' });

// ------------------------------------------------------------- config ----

test('validateJudgeConfig: defaults, and caps on effort, budget and temperature', () => {
  const c = validateJudgeConfig({ model: 'claude-opus-5-5' });
  assert.equal(c.effort, JUDGE_DEFAULT_EFFORT);
  assert.equal(c.temperature, null);
  assert.ok(c.maxBudgetUsd > 0 && c.maxBudgetUsd <= JUDGE_MAX_BUDGET_USD);
  assert.throws(() => validateJudgeConfig({ model: 'opus' }), /full model id/);
  // xhigh is allowed (fixed 2026-09: a fable/xhigh or opus/xhigh author could
  // never get a judge whose effort was at least its own while the cap
  // stopped at 'high') -- 'max' stays out of reach, that cap is intentional.
  assert.equal(validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'xhigh' }).effort, 'xhigh');
  assert.throws(() => validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'max' }), /not allowed/);
  assert.throws(() => validateJudgeConfig({ model: 'claude-opus-5-5', maxBudgetUsd: 5 }), /exceeds the cap/);
  assert.throws(() => validateJudgeConfig({ model: 'claude-opus-5-5', temperature: 0.2 }), /temperature must be left unset/);
  assert.throws(() => validateJudgeConfig({}), /judge model is required/);
});

test('validateJudgeConfig: judge effort is bumped to at least the author\'s effort, never lowered, capped at xhigh', () => {
  assert.equal(validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'low', authorEffort: 'xhigh' }).effort, 'xhigh');
  assert.equal(validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'high', authorEffort: 'low' }).effort, 'high', 'never lowered below its own configured effort');
  assert.equal(validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'medium', authorEffort: 'medium' }).effort, 'medium');
  // An author run at 'max' (not a judge-eligible effort) still gets the
  // strongest judge effort actually available, rather than being refused.
  assert.equal(validateJudgeConfig({ model: 'claude-opus-5-5', effort: 'high', authorEffort: 'max' }).effort, 'xhigh');
});

test('checkJudgeEligibility: different from, and at least as strong as, the model under test', () => {
  assert.equal(checkJudgeEligibility('claude-opus-5-5', 'claude-opus-5-5').ok, false, 'never its own homework');
  assert.equal(checkJudgeEligibility('claude-sonnet-5', 'claude-opus-5-5').ok, false, 'weaker tier');
  assert.equal(checkJudgeEligibility('claude-opus-5-5', 'claude-sonnet-5').ok, true);
  assert.equal(checkJudgeEligibility('claude-fable-5-1', 'claude-opus-5-5').ok, true);
  assert.equal(checkJudgeEligibility('claude-opus-5-5', 'claude-opus-5').ok, true, 'current id may judge the superseded one');
  assert.equal(checkJudgeEligibility('claude-opus-5', 'claude-opus-5-5').ok, false, 'superseded id may not judge the current one');
  assert.equal(checkJudgeEligibility('claude-mythos-5-1', 'claude-opus-5-5').ok, false, 'unavailable on this account');
  assert.equal(checkJudgeEligibility('claude-unknown-9', 'claude-sonnet-5').ok, false, 'unknown strength');
});

// ------------------------------------------------------------ blindness --

test('scrubIdentity removes self-identification from the candidate text', () => {
  const s = scrubIdentity('As Claude Opus 5.5 I fixed it (claude-opus-5-5, sonnet was slower).\nCo-Authored-By: Claude Opus 5.5 <x@y>');
  assert.doesNotMatch(s, /opus|sonnet|claude/i);
  assert.match(scrubIdentity('+ const tier = "opus";\n+Co-Authored-By: Claude', { codeSafe: true }), /tier = "opus"/, 'code keeps model names');
  assert.doesNotMatch(scrubIdentity('+Co-Authored-By: Claude Fable 5.1', { codeSafe: true }), /Fable/);
});

test('buildJudgePrompt is blind: no model/cell parameter, identity scrubbed, deterministic', () => {
  const args = {
    taskPrompt: 'Fix the bug.', rubric: 'PASS if good.',
    diff: '--- a/x\n+++ b/x\n@@\n+fixed\n+// Co-Authored-By: Claude Opus 5.5',
    finalMessage: 'I am Claude, running as claude-opus-5-5 at xhigh.\nCLAIM: fixed',
  };
  const p1 = buildJudgePrompt(args);
  const p2 = buildJudgePrompt({ ...args, model: 'claude-sonnet-5', cell: 'sonnet-high' });
  assert.equal(p1.user, p2.user, 'extra identity arguments are ignored -- there is no channel for them');
  assert.doesNotMatch(p1.user, /claude-opus|Opus 5\.5|Co-Authored-By/i);
  assert.match(p1.user, /not told who or what produced it/);
  // Reason before verdict: the REASONING instruction precedes the VERDICT one.
  assert.ok(p1.user.indexOf('"REASONING:"') < p1.user.indexOf('"VERDICT: PASS"'));
});

test('parseVerdict: only the last VERDICT line counts; none -> null', () => {
  assert.equal(parseVerdict(['REASONING: the format is', 'VERDICT: PASS', 'or its opposite.', 'VERDICT: FAIL'].join('\n')), 'FAIL');
  assert.equal(parseVerdict(['REASONING: ok', '**VERDICT: PASS**'].join('\n')), 'PASS');
  assert.equal(parseVerdict('I think it passes.'), null);
});

// --------------------------------------------------------------- voting --

test('runJudge: three independent calls, pass on 2 of 3, unparseable votes never guessed', async () => {
  const config = JUDGE();
  const base = { config, taskPrompt: 't', rubric: 'r', diff: '', finalMessage: '' };
  let calls = 0;
  const counting = async () => { calls += 1; return { text: 'VERDICT: PASS', cost_usd: 0.01, is_error: false }; };
  const all = await runJudge({ ...base, callJudge: counting });
  assert.equal(calls, 3, 'always three votes');
  assert.equal(all.pass, true);
  assert.equal((await runJudge({ ...base, callJudge: sequenceJudge(['PASS', 'FAIL', 'PASS']) })).pass, true);
  assert.equal((await runJudge({ ...base, callJudge: sequenceJudge(['FAIL', 'FAIL', 'PASS']) })).pass, false);
  const one = await runJudge({ ...base, callJudge: sequenceJudge(['PASS', null, null]) });
  assert.equal(one.pass, null, 'fewer than two readable votes: no verdict');
  assert.equal(one.invalid, 2);
  const err = await runJudge({ ...base, callJudge: async () => ({ text: 'VERDICT: PASS', is_error: true, cost_usd: null }) });
  assert.equal(err.pass, null, 'an errored call is not a vote');
  assert.equal(err.cost_usd, null, 'unknown cost stays null');
});

test('treeDiff: real unified diff (git diff --no-index), guard file excluded, no-change -> empty', () => {
  const d = treeDiff({ 'a.js': 'x\ny\nz\n', 'DO_NOT_TOUCH.txt': 'g' }, { 'a.js': 'x\nY\nz\n', 'b.js': 'new\n', 'DO_NOT_TOUCH.txt': 'changed' }, { exclude: ['DO_NOT_TOUCH.txt'] });
  assert.match(d, /--- a\/a\.js\n\+\+\+ b\/a\.js\n@@[^\n]*@@[^\n]*\n x\n-y\n\+Y\n z/);
  assert.match(d, /--- \/dev\/null\n\+\+\+ b\/b\.js/, 'a new file diffs against /dev/null');
  assert.doesNotMatch(d, /DO_NOT_TOUCH/, 'excluded path never appears');
  assert.equal(treeDiff({ a: '1' }, { a: '1' }), '', 'identical trees -> empty diff');
});

test('treeDiff: a file over 3000 lines with a small change gives a SMALL diff (fails on the old LCS-fallback code, which replaced the whole file)', () => {
  const lines = [];
  for (let i = 0; i < 3500; i += 1) lines.push(`line${i}`);
  const oldContent = `${lines.join('\n')}\n`;
  const changed = lines.slice();
  changed[1000] = 'CHANGED';
  const newContent = `${changed.join('\n')}\n`;
  const d = treeDiff({ 'src/big.js': oldContent }, { 'src/big.js': newContent });
  assert.ok(d.length < 1000, `expected a small hunk-only diff, got ${d.length} chars (old code produced 440-780K on real files this shape)`);
  assert.match(d, /-line1000/);
  assert.match(d, /\+CHANGED/);
  assert.doesNotMatch(d, /line0\b/, 'unrelated lines 3000+ apart are not dumped as whole-file replacement');
});

test('treeDiff: ordered source files first, then tests, then docs', () => {
  const oldTree = { 'docs/guide.md': 'old doc', 'src/index.js': 'old src', 'tests/index.test.js': 'old test' };
  const newTree = { 'docs/guide.md': 'new doc', 'src/index.js': 'new src', 'tests/index.test.js': 'new test' };
  const d = treeDiff(oldTree, newTree);
  const iSrc = d.indexOf('src/index.js');
  const iTest = d.indexOf('tests/index.test.js');
  const iDoc = d.indexOf('docs/guide.md');
  assert.ok(iSrc >= 0 && iTest >= 0 && iDoc >= 0, 'all three files are present in the diff');
  assert.ok(iSrc < iTest, 'source comes before tests');
  assert.ok(iTest < iDoc, 'tests come before docs');
});

test('treeDiff: caps total size at JUDGE_MAX_DIFF_CHARS with an explicit truncation marker', () => {
  const big = 'x\n'.repeat(JUDGE_MAX_DIFF_CHARS);
  const d = treeDiff({ 'f.txt': '' }, { 'f.txt': big });
  assert.ok(d.length <= JUDGE_MAX_DIFF_CHARS + 200, 'capped near the limit, not left to grow unbounded');
  assert.match(d, /truncated/, 'a clear truncation marker, not a silent cut');
});

// 0.29.1 fix b: the judge's diff uses the shared, case-insensitive
// cleanGitEnv(). An inherited GIT_DIR pointing at a repository whose
// attributes say `* binary` turns the diff into "Binary files differ"; the
// old local helper stripped only an exact-case /^GIT_/, so on Windows a
// `Git_Dir` (the same variable to git there) slipped through.
test('treeDiff ignores an inherited GIT_DIR in any case (Git_Dir, GIT_DIR)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-judge-gitdir-'));
  const saved = Object.fromEntries(Object.keys(process.env).filter((k) => /^git_dir$/i.test(k)).map((k) => [k, process.env[k]]));
  try {
    const victim = join(root, 'victim');
    mkdirSync(victim);
    execFileSync('git', ['init', '-q', victim], { windowsHide: true, env: cleanGitEnv() });
    writeFileSync(join(victim, '.git', 'info', 'attributes'), '* binary\n');
    for (const name of ['Git_Dir', 'GIT_DIR']) {
      for (const k of Object.keys(process.env)) if (/^git_dir$/i.test(k)) delete process.env[k];
      process.env[name] = join(victim, '.git');
      const d = treeDiff({ 'src/a.js': 'x\n' }, { 'src/a.js': 'y\n' });
      assert.doesNotMatch(d, /Binary files/, `${name} leaked into the judge's git diff`);
      assert.match(d, /^-x$/m, name);
      assert.match(d, /^\+y$/m, name);
    }
  } finally {
    for (const k of Object.keys(process.env)) if (/^git_dir$/i.test(k)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test('makeCliJudgeCaller pipes the prompt through stdin, not argv (fails on the old code, which hit ENAMETOOLONG on Windows for large prompts)', async () => {
  const captured = {};
  const execFileImpl = (bin, args, options, callback) => {
    captured.bin = bin;
    captured.args = args;
    const chunks = [];
    return {
      stdin: {
        write(chunk) { chunks.push(chunk); return true; },
        end() {
          captured.stdin = chunks.join('');
          const json = JSON.stringify({ result: `REASONING: got ${captured.stdin.length} chars\nVERDICT: PASS`, total_cost_usd: 0.002, is_error: false });
          callback(null, json, '');
        },
      },
    };
  };
  const caller = makeCliJudgeCaller(() => 'fake-claude-bin', { execFileImpl });
  const bigUser = `PROMPT_START${'y'.repeat(45000)}PROMPT_END`; // over the ~32K Windows argv limit
  const result = await caller({ system: 'sys prompt', user: bigUser, model: 'claude-fable-5-1', effort: 'xhigh', maxBudgetUsd: 0.3 });
  assert.ok(!captured.args.some((a) => a.includes('PROMPT_START')), 'the prompt is never one of the spawned argv entries');
  assert.equal(captured.stdin, bigUser, 'the exact prompt text arrives intact via stdin');
  assert.match(result.text, /VERDICT: PASS/);
  assert.equal(captured.args[0], '-p', '-p is passed bare (no positional prompt argument) so the CLI reads stdin');
  assert.ok(captured.args.includes('xhigh'), 'effort still passed as a normal argument');
});

// ---------------------------------------------------------- calibration --

test('calibration on the example pack: the real fix PASSES, parent and planted variants FAIL -> trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-judge-cal-'));
  try {
    const storeFile = join(dir, 'cal.json');
    const task = buildTaskFromPack(loadPack(EXAMPLE_PACK_DIR), { repoPath: REPO_ROOT });
    assert.ok(task.rubric && /PASS if ALL/.test(task.rubric), 'the example pack ships a rubric');
    const { fn, prompts } = readingJudge();
    const rec = await calibrateJudge({ taskId: 'leak-check-gitignore-fix', task, config: JUDGE(), budgetUsd: 1.5, callJudge: fn, storeFile });
    assert.equal(rec.knownGood.pass, true);
    assert.deepEqual(rec.knownBad.map((b) => b.pass), [false, false, false], 'parent-unchanged + 2 planted variants');
    assert.equal(rec.trusted, true);
    assert.equal(prompts.length, 3 * 4, '3 votes x (1 good + 3 bad)');
    assert.ok(prompts.every((p) => p.maxBudgetUsd === 1.5 && p.model === 'claude-fable-5-1'));
    assert.equal(loadCalibrationStore(storeFile).records[rec.key].trusted, true);
    assert.doesNotThrow(() => assertJudgeCalibrated({ taskId: 'leak-check-gitignore-fix', task, config: JUDGE(), storeFile }));
    // A different judge effort is a different trust decision.
    assert.throws(() => assertJudgeCalibrated({ taskId: 'leak-check-gitignore-fix', task, config: validateJudgeConfig({ model: 'claude-fable-5-1', effort: 'high' }), storeFile }), /not calibrated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calibration: a judge that passes everything, or fails everything, is NOT trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-judge-cal-'));
  try {
    const storeFile = join(dir, 'cal.json');
    const task = buildTaskFromPack(loadPack(EXAMPLE_PACK_DIR), { repoPath: REPO_ROOT });
    const lenient = await calibrateJudge({ taskId: 'p', task, config: JUDGE(), callJudge: constantJudge('PASS'), storeFile });
    assert.equal(lenient.trusted, false, 'passing the known-bad parent means the judge cannot discriminate');
    const harsh = await calibrateJudge({ taskId: 'p', task, config: JUDGE(), callJudge: constantJudge('FAIL'), storeFile });
    assert.equal(harsh.trusted, false);
    assert.throws(() => assertJudgeCalibrated({ taskId: 'p', task, config: JUDGE(), storeFile }), /not calibrated/, 'an untrusted record is written but never honoured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calibration key: editing the rubric invalidates a prior trust decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-judge-cal-'));
  try {
    const packCopy = join(dir, 'pack');
    cpSync(EXAMPLE_PACK_DIR, packCopy, { recursive: true });
    const storeFile = join(dir, 'cal.json');
    const task = buildTaskFromPack(loadPack(packCopy), { repoPath: REPO_ROOT });
    await calibrateJudge({ taskId: 'p', task, config: JUDGE(), callJudge: readingJudge().fn, storeFile });
    writeFileSync(join(packCopy, 'rubric.md'), readFileSync(join(packCopy, 'rubric.md'), 'utf8') + '\n- one more item\n');
    const edited = buildTaskFromPack(loadPack(packCopy), { repoPath: REPO_ROOT });
    assert.notEqual(taskJudgeKey('p', edited, JUDGE()), taskJudgeKey('p', task, JUDGE()));
    assert.throws(() => assertJudgeCalibrated({ taskId: 'p', task: edited, config: JUDGE(), storeFile }), /not calibrated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calibration refuses a task with no known-good/known-bad cases', async () => {
  await assert.rejects(
    calibrateJudge({ taskId: 'x', task: { rubric: 'r' }, config: JUDGE(), callJudge: constantJudge('PASS') }),
    /no calibration cases/,
  );
});

test('applyPlantedBad refuses a variant whose find text no longer exists', () => {
  assert.throws(() => applyPlantedBad({ 'a.js': 'abc' }, { file: 'a.js', find: 'zzz', replace: '' }), /no longer matches/);
});

// --------------------------------------------------------- runner wiring --

function packTask() {
  const pack = loadPack(EXAMPLE_PACK_DIR);
  return { pack, task: buildTaskFromPack(pack, { repoPath: REPO_ROOT }) };
}

// A stub "model" that writes the REAL fix into the sandbox, so the hidden
// test genuinely passes and the judge sees the real change.
function fixingClaude(pack) {
  const fixed = execFileSync('git', ['-C', REPO_ROOT, 'show', `${pack.fixRef}:scripts/leak-check.mjs`], { encoding: 'utf8', windowsHide: true, env: cleanGitEnv() });
  const calls = [];
  const impl = async ({ cwd, model }) => {
    calls.push(model);
    writeFileSync(join(cwd, 'scripts', 'leak-check.mjs'), fixed);
    return {
      json: { result: 'As Claude Opus 5.5 I fixed it.\nCLAIM: fixed and verified', is_error: false, total_cost_usd: 0.02, num_turns: 2, modelUsage: { [model]: { inputTokens: 1, outputTokens: 1 } } },
      stdout: '{}', stderr: '', err: null, wallMs: 1,
    };
  };
  return { impl, calls };
}

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-judge-'));
  mkdirSync(join(outDir, 'answers'));
  return { outDir, answersDir: join(outDir, 'answers') };
}

test('runOne refuses an uncalibrated judge BEFORE any model call (code JUDGE_REFUSED)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { pack, task } = packTask();
    const { impl, calls } = fixingClaude(pack);
    await assert.rejects(
      runOne({
        cellId: 'sonnet-medium', cell: CELLS['sonnet-medium'], taskId: pack.id, task, rep: 1, outDir, answersDir,
        runClaudeImpl: impl, cliVersion: 'x',
        judge: { config: JUDGE(), storeFile: join(outDir, 'empty-store.json'), callJudge: constantJudge('PASS') },
      }),
      (e) => e.code === 'JUDGE_REFUSED' && /not calibrated/.test(e.message),
    );
    assert.equal(calls.length, 0, 'no model call was made');
    assert.equal(existsSync(join(outDir, 'results.jsonl')), false, 'no row written');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runOne refuses a judge that is not stronger than the cell (same model)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { pack, task } = packTask();
    const { impl, calls } = fixingClaude(pack);
    await assert.rejects(
      runOne({
        cellId: 'fable51-low', cell: CELLS['fable51-low'], taskId: pack.id, task, rep: 1, outDir, answersDir,
        runClaudeImpl: impl, cliVersion: 'x', judge: { config: JUDGE(), storeFile: join(outDir, 's.json'), callJudge: constantJudge('PASS') },
      }),
      (e) => e.code === 'JUDGE_REFUSED' && /own work/.test(e.message),
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// 0.29.1 fix a: runOne() re-validates the judge config with
// authorEffort: cell.effort, so the effort floor actually applies per cell --
// to the calibration gate, to the votes, and to the judge_effort column.
test('runOne floors the judge effort at the cell\'s author effort (calibration gate, votes and column)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { pack, task } = packTask();
    const storeFile = join(outDir, 'cal.json');
    // Calibrated at the CONFIGURED effort (low) only.
    assert.equal((await calibrateJudge({ taskId: pack.id, task, config: JUDGE(), callJudge: readingJudge().fn, storeFile })).trusted, true);
    const first = fixingClaude(pack);
    await assert.rejects(
      runOne({
        cellId: 'opus55-high', cell: CELLS['opus55-high'], taskId: pack.id, task, rep: 1, outDir, answersDir,
        runClaudeImpl: first.impl, cliVersion: 'x', judge: { config: JUDGE(), storeFile, callJudge: constantJudge('PASS') },
      }),
      (e) => e.code === 'JUDGE_REFUSED' && /claude-fable-5-1\/high is not calibrated/.test(e.message),
      'a high-effort author needs a judge calibrated at high, not the configured low',
    );
    assert.equal(first.calls.length, 0, 'refused before any model call');

    const hi = validateJudgeConfig({ model: 'claude-fable-5-1', effort: 'high' });
    assert.equal((await calibrateJudge({ taskId: pack.id, task, config: hi, callJudge: readingJudge().fn, storeFile })).trusted, true);
    const judged = readingJudge();
    const row = await runOne({
      cellId: 'opus55-high', cell: CELLS['opus55-high'], taskId: pack.id, task, rep: 1, outDir, answersDir,
      runClaudeImpl: fixingClaude(pack).impl, cliVersion: 'x',
      judge: { config: JUDGE(), storeFile, callJudge: judged.fn, scaledJudgeBudget: 0.9 },
    });
    assert.equal(row.judge_effort, 'high');
    assert.equal(judged.prompts.length, 3);
    assert.ok(judged.prompts.every((p) => p.effort === 'high'), 'every vote runs at the floored effort');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('judgePreflight and buildJudgeVotePlan apply the same per-cell effort floor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-bench-judge-pf-'));
  try {
    const { pack, task } = packTask();
    const storeFile = join(dir, 'cal.json');
    await calibrateJudge({ taskId: pack.id, task, config: JUDGE(), callJudge: readingJudge().fn, storeFile });
    const args = { judgeModel: 'claude-fable-5-1', judgeEffort: 'low', judgeCalibrations: storeFile };
    const tasksMap = { [pack.id]: task };
    const ok = judgePreflight({ args, cellIds: ['sonnet-low'], taskIds: [pack.id], tasksMap });
    assert.deepEqual(ok.problems, [], 'a low-effort cell is served by the low calibration');
    const bumped = judgePreflight({ args, cellIds: ['sonnet-low', 'sonnet-high'], taskIds: [pack.id], tasksMap });
    assert.equal(bumped.problems.length, 1, bumped.problems.join('\n'));
    assert.match(bumped.problems[0], /claude-fable-5-1\/high is not calibrated \(raised from low to match the author effort of sonnet-high; calibrate with --judge-effort high\)/);
    const plan = buildJudgeVotePlan({ judge: bumped, cellIds: ['sonnet-low', 'sonnet-high'], reps: 1 });
    assert.equal(plan.effort, 'high', 'the estimate prices the highest effective judge effort');
    assert.equal(buildJudgeVotePlan({ judge: ok, cellIds: ['sonnet-low'], reps: 1 }).effort, 'low');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calibrated judge: separate judge_* columns, blind across cells, pass/fail untouched', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { pack, task } = packTask();
    const storeFile = join(outDir, 'cal.json');
    const cal = await calibrateJudge({ taskId: pack.id, task, config: JUDGE(), callJudge: readingJudge().fn, storeFile });
    assert.equal(cal.trusted, true);
    // The sonnet-medium cell is judged at fable/MEDIUM (the judge's effort is
    // floored at the author's -- 0.29.1 fix a), so that config needs its own
    // trusted record too.
    const calMedium = await calibrateJudge({
      taskId: pack.id, task, config: validateJudgeConfig({ model: 'claude-fable-5-1', effort: 'medium' }), callJudge: readingJudge().fn, storeFile,
    });
    assert.equal(calMedium.trusted, true);

    const seen = [];
    const judgeFn = async (args) => { seen.push(args.user); return { text: 'REASONING: r\nVERDICT: FAIL', cost_usd: 0.003, is_error: false }; };
    const rows = [];
    for (const cellId of ['sonnet-medium', 'opus55-low']) {
      // eslint-disable-next-line no-await-in-loop
      rows.push(await runOne({
        cellId, cell: CELLS[cellId], taskId: pack.id, task, rep: 1, outDir, answersDir,
        runClaudeImpl: fixingClaude(pack).impl, cliVersion: 'x',
        judge: { config: JUDGE(), storeFile, callJudge: judgeFn, scaledJudgeBudget: 0.9 },
      }));
    }
    for (const r of rows) {
      assert.equal(r.pass, true, 'the hidden test verdict stands on its own');
      assert.equal(r.judge_pass, false, 'judge verdict is recorded separately (the stub failed it)');
      assert.deepEqual(r.judge_votes, ['FAIL', 'FAIL', 'FAIL']);
      assert.equal(r.judge_model, 'claude-fable-5-1');
      assert.ok(Math.abs(r.judge_cost_usd - 0.009) < 1e-9);
      assert.match(r.judge_rubric_sha256, /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(rows.map((r) => r.judge_effort), ['medium', 'low'], 'judge effort floored at each cell\'s author effort');
    assert.equal(seen.length, 6);
    assert.ok(seen.every((u) => u === seen[0]), 'identical judge input whichever cell produced the change: blind');
    assert.doesNotMatch(seen[0], /claude-opus|claude-sonnet|opus55|sonnet-medium|Opus 5\.5/i);
    assert.match(seen[0], /\+.*--exclude-standard/, 'the judge sees the actual change');

    rebuildSummary(outDir);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
    for (const s of summary) {
      assert.equal(s.pass_at_1, 1, 'pass@1 is from the hidden test only');
      assert.equal(s.judge_pass_rate, 0);
      assert.equal(s.judge_n, 1);
    }
    const md = readFileSync(join(outDir, 'summary.md'), 'utf8');
    assert.match(md, /## Rubric judge \(separate score -- never merged into pass@1\)/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a task without a rubric is simply not judged (no columns, no refusal)', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { TASKS } = await import('../bench/runner.mjs');
    let judgeCalls = 0;
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELLS['sonnet-medium'], taskId: 'lookup', task: TASKS.lookup, rep: 1, outDir, answersDir,
      runClaudeImpl: async () => ({ json: { result: 'x', is_error: false, modelUsage: {} }, stdout: '', stderr: '', err: null, wallMs: 1 }),
      cliVersion: 'x', judge: { config: JUDGE(), storeFile: join(outDir, 's.json'), callJudge: async () => { judgeCalls += 1; return {}; } },
    });
    assert.equal(judgeCalls, 0);
    assert.ok(!('judge_pass' in row));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------- CLI --

test('scripts/benchmark.mjs: --dry-run shows a judge that would be refused (weaker than a cell)', () => {
  const r = runScript('scripts/benchmark.mjs', [
    '--dry-run', '--cells', 'opus55-low', '--tasks', 'leak-check-gitignore-fix',
    '--task-pack', EXAMPLE_PACK_DIR, '--pack-repo', REPO_ROOT, '--judge-model', 'claude-sonnet-5',
    '--judge-calibrations', join(tmpdir(), 'ac-no-such-store.json'),
  ], { env: NO_CLAUDE });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /JUDGE WOULD BE REFUSED/);
  assert.match(r.stdout, /weaker than the model under test/);
  assert.match(r.stdout, /not calibrated/);
});

test('scripts/benchmark.mjs: a live run with an uncalibrated judge refuses to start (exit 2, nothing spawned)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-bench-judge-cli-'));
  try {
    const r = runScript('scripts/benchmark.mjs', [
      '--cells', 'sonnet-medium', '--tasks', 'leak-check-gitignore-fix',
      '--task-pack', EXAMPLE_PACK_DIR, '--pack-repo', REPO_ROOT, '--judge-model', 'claude-opus-5-5',
      '--judge-calibrations', join(dir, 'store.json'), '--out-dir', join(dir, 'out'),
    ], { env: NO_CLAUDE });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /Refusing to start/);
    assert.match(r.stderr, /not calibrated/);
    assert.equal(existsSync(join(dir, 'out', 'results.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/benchmark.mjs: --calibrate-judge --dry-run lists the rubric tasks it would calibrate', () => {
  const r = runScript('scripts/benchmark.mjs', [
    '--calibrate-judge', '--dry-run', '--tasks', 'leak-check-gitignore-fix',
    '--task-pack', EXAMPLE_PACK_DIR, '--pack-repo', REPO_ROOT, '--judge-model', 'claude-opus-5-5',
  ], { env: NO_CLAUDE });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would calibrate judge claude-opus-5-5\/medium on: leak-check-gitignore-fix/);
});
