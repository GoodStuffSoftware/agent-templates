// Scorer golden/adversarial checks. Per bench/PROCESS-NOTES.md ("All 6
// scorers were validated before spending any real model call: a hand-built
// golden answer scores pass=true ... and at least one deliberately-wrong
// answer scores pass=false for every task"), this is that validation,
// committed as a real regression test instead of a one-off pre-flight
// check. No test here makes a real model call — every "answer" is a
// hand-written string or a hand-applied file edit, and scoring runs
// `node --test` against the fixture directly.
//
// GOLDEN answers (task.score() must return pass:true) are written out for
// every task where the correct answer is small and stable enough to encode
// directly (lookup/verify: derived from each task's own fixed fixture;
// bounded-edit/diagnosis: the one-line real fix, matching
// bench/PROCESS-NOTES.md's "Task design notes"). ADVERSARIAL coverage (a
// clearly wrong answer, or an untouched sandbox, must return pass:false) is
// applied to every task in bench/runner.mjs's TASKS map — a scorer that
// says "pass" for an untouched sandbox or a wrong answer is exactly the
// false-positive class the real build's own scorer bugs came from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TASKS } from '../bench/runner.mjs';

// async, and AWAITS fn() before cleanup: several callers apply a file edit
// then call the (possibly async, for a task-pack task) score() function,
// which may still be reading `dir` when a synchronous `return fn(...)`
// would have already let `finally` delete it out from under an in-flight
// `node --test` subprocess.
async function withSandbox(taskId, fn) {
  const task = TASKS[taskId];
  const dir = mkdtempSync(join(tmpdir(), `scorer-test-${taskId}-`));
  try {
    const meta = task.setup(dir);
    return await fn(task, dir, meta);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Universal adversarial coverage: every task, wrong/empty answer, ------
// untouched sandbox -> pass:false. --------------------------------------
for (const taskId of Object.keys(TASKS)) {
  test(`adversarial: ${taskId} scores pass:false for an untouched sandbox and a clearly wrong answer`, async () => {
    await withSandbox(taskId, async (task, dir, meta) => {
      const wrongAnswer = 'I did not look at anything. CLAIM: this is definitely wrong and unverified.';
      const result = await task.score(dir, wrongAnswer, meta);
      assert.equal(result.pass, false, `expected pass:false for ${taskId} on an untouched sandbox + wrong answer; got ${JSON.stringify(result)}`);
    });
  });

  test(`adversarial: ${taskId} scores pass:false for a completely empty answer`, async () => {
    await withSandbox(taskId, async (task, dir, meta) => {
      const result = await task.score(dir, '', meta);
      assert.equal(result.pass, false, `expected pass:false for ${taskId} on an empty answer`);
    });
  });
}

// --- lookup: golden = the real ANSWER_KEY, adversarial already covered ----
test('golden: lookup scores pass:true for exactly correct symbol locations', async () => {
  await withSandbox('lookup', async (task, dir, meta) => {
    // Mirrors bench/tasks/lookup.mjs's own ANSWER_KEY against fixtures/base
    // (a stable, committed fixture — see bench/fixtures/base/src/*.js).
    const answer = [
      'clamp -> src/mathUtils.js:7',
      'average -> src/mathUtils.js:13',
      'formatSku -> src/format.js:7',
      'addStock -> src/inventory.js:5',
      'removeStock -> src/inventory.js:10',
      'processOrder -> src/orders.js:6',
      'CLAIM: all six locations are correct.',
    ].join('\n');
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, true, JSON.stringify(result.detail));
  });
});

test('golden: lookup scores pass:false when even one location is wrong', async () => {
  await withSandbox('lookup', async (task, dir, meta) => {
    const answer = [
      'clamp -> src/mathUtils.js:999', // wrong on purpose
      'average -> src/mathUtils.js:13',
      'formatSku -> src/format.js:7',
      'addStock -> src/inventory.js:5',
      'removeStock -> src/inventory.js:10',
      'processOrder -> src/orders.js:6',
      'CLAIM: all six locations are correct.',
    ].join('\n');
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, false);
  });
});

// --- verify: golden = the real CLAIMS truth table --------------------------
test('golden: verify scores pass:true for exactly correct TRUE/FALSE answers', async () => {
  await withSandbox('verify', async (task, dir, meta) => {
    // Mirrors bench/tasks/verify.mjs's own CLAIMS ground truth.
    const truths = [true, true, false, true, true, false, false, true, false, true];
    const answer = truths.map((t, i) => `${i + 1}: ${t ? 'TRUE' : 'FALSE'}`).join('\n')
      + '\nCLAIM: all ten answers are correct.';
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, true, JSON.stringify(result.detail));
  });
});

test('golden: verify scores pass:false when even one claim is answered wrong', async () => {
  await withSandbox('verify', async (task, dir, meta) => {
    const truths = [true, true, false, true, true, false, false, true, false, true];
    truths[0] = !truths[0]; // wrong on purpose
    const answer = truths.map((t, i) => `${i + 1}: ${t ? 'TRUE' : 'FALSE'}`).join('\n')
      + '\nCLAIM: all ten answers are correct.';
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, false);
  });
});

// --- bounded-edit: golden = the real one-line fix --------------------------
// bench/PROCESS-NOTES.md: "bounded-edit: mathUtils.average() divides by
// (nums.length - 1) instead of nums.length."
test('golden: bounded-edit scores pass:true after applying the real one-line fix', async () => {
  await withSandbox('bounded-edit', async (task, dir, meta) => {
    const target = join(dir, 'src', 'mathUtils.js');
    const before = readFileSync(target, 'utf8');
    assert.match(before, /nums\.length - 1/, 'fixture shape assumption changed — update this test');
    writeFileSync(target, before.replace('nums.length - 1', 'nums.length'), 'utf8');
    const result = await task.score(dir, 'Fixed average() to divide by nums.length. CLAIM: the full suite now passes.', meta);
    assert.equal(result.pass, true, JSON.stringify(result.detail));
  });
});

test('golden: bounded-edit scores pass:false if the test file is modified instead of the source', async () => {
  await withSandbox('bounded-edit', async (task, dir, meta) => {
    const testFile = join(dir, 'test', 'mathUtils.test.js');
    const before = readFileSync(testFile, 'utf8');
    writeFileSync(testFile, before + '\n// tampered\n', 'utf8');
    const result = await task.score(dir, 'CLAIM: fixed it.', meta);
    assert.equal(result.pass, false, 'modifying the test file must never count as a fix');
  });
});

// --- diagnosis: golden = the real root-cause fix ---------------------------
// bench/PROCESS-NOTES.md: "diagnosis: inventory.js keeps a read cache
// (_cache) refreshed in addStock() but NOT in removeStock()."
test('golden: diagnosis scores pass:true after applying the real fix AND naming the root cause', async () => {
  await withSandbox('diagnosis', async (task, dir, meta) => {
    const target = join(dir, 'src', 'inventory.js');
    const before = readFileSync(target, 'utf8');
    assert.match(before, /stock\[sku\] -= qty;\s*\n\s*return stock\[sku\];/, 'fixture shape assumption changed — update this test');
    const fixed = before.replace(
      'stock[sku] -= qty;\n  return stock[sku];',
      'stock[sku] -= qty;\n  _refreshCache(sku);\n  return stock[sku];',
    );
    writeFileSync(target, fixed, 'utf8');
    const answer = 'The bug is in removeStock, which never refreshed the cache.\nROOT CAUSE: removeStock\nCLAIM: the full suite now passes.';
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, true, JSON.stringify(result.detail));
  });
});

test('golden: diagnosis scores pass:false when the fix is applied but the wrong root cause is named', async () => {
  await withSandbox('diagnosis', async (task, dir, meta) => {
    const target = join(dir, 'src', 'inventory.js');
    const before = readFileSync(target, 'utf8');
    const fixed = before.replace(
      'stock[sku] -= qty;\n  return stock[sku];',
      'stock[sku] -= qty;\n  _refreshCache(sku);\n  return stock[sku];',
    );
    writeFileSync(target, fixed, 'utf8');
    const answer = 'ROOT CAUSE: addStock\nCLAIM: the full suite now passes.';
    const result = await task.score(dir, answer, meta);
    assert.equal(result.pass, false, 'naming the wrong function must not count as a correct diagnosis, even if tests happen to pass');
  });
});
