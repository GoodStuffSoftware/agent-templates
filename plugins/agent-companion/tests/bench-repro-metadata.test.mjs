// Reproducibility metadata on every results.jsonl row (bench/runner.mjs's
// reproMetadata()/harnessErrorRow()): claude CLI version, requested vs
// resolved model id, requested effort, and content hashes of the task prompt,
// the starting fixture tree, and (for a task pack) the pack's brief, held-out
// test and rubric. runOne() is driven through its runClaudeImpl test seam --
// a stub that returns a canned `claude -p --output-format json` result -- so
// no model is ever called and no claude binary is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, cpSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PLUGIN_ROOT } from './helpers.mjs';
import {
  runOne, CELLS, TASKS, reproMetadata, harnessErrorRow, treeSha256,
} from '../bench/runner.mjs';
import { loadPack, buildTaskFromPack, packContentSha256 } from '../bench/task-packs/lib.mjs';

const REPO_ROOT = resolve(PLUGIN_ROOT, '..', '..');
const EXAMPLE_PACK_DIR = join(PLUGIN_ROOT, 'bench', 'task-packs', 'examples', 'leak-check-gitignore-fix');
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function stubClaude(resolvedModel = 'claude-sonnet-5') {
  const calls = [];
  const impl = async (opts) => {
    calls.push(opts);
    return {
      json: {
        result: 'Done.\nCLAIM: nothing verified', is_error: false, total_cost_usd: 0.01, num_turns: 1,
        session_id: 'stub', usage: {}, modelUsage: { [resolvedModel]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 } },
      },
      stdout: '{}', stderr: '', err: null, wallMs: 1,
    };
  };
  return { impl, calls };
}

function tmpOut() {
  const outDir = mkdtempSync(join(tmpdir(), 'ac-bench-repro-'));
  const answersDir = join(outDir, 'answers');
  mkdirSync(answersDir);
  return { outDir, answersDir };
}

test('every runOne row carries CLI version, requested/resolved model, effort and content hashes', async () => {
  const { outDir, answersDir } = tmpOut();
  try {
    const { impl, calls } = stubClaude('claude-sonnet-5');
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELLS['sonnet-medium'], taskId: 'lookup', task: TASKS.lookup, rep: 1,
      outDir, answersDir, runClaudeImpl: impl, cliVersion: '9.9.9 (Claude Code)',
    });
    assert.equal(calls.length, 1);
    assert.equal(row.claude_cli_version, '9.9.9 (Claude Code)');
    assert.equal(row.requested_model, 'claude-sonnet-5');
    assert.equal(row.resolved_model, 'claude-sonnet-5');
    assert.equal(row.requested_effort, 'medium');
    assert.equal(row.task_family, 'easy');
    assert.equal(row.task_prompt_sha256, sha(calls[0].prompt), 'prompt hash is over the exact prompt the model received');
    assert.match(row.task_fixture_sha256, HEX64);
    assert.match(row.task_content_sha256, HEX64);
    assert.equal(row.task_pack_sha256, null, 'a built-in task has no pack');
    assert.ok(!('judge_pass' in row), 'no judge configured -> no judge columns');

    // Same task, second run: identical content hashes (stable fixture walk).
    const row2 = await runOne({
      cellId: 'opus55-low', cell: CELLS['opus55-low'], taskId: 'lookup', task: TASKS.lookup, rep: 1,
      outDir, answersDir, runClaudeImpl: stubClaude('claude-opus-5-5').impl, cliVersion: '9.9.9 (Claude Code)',
    });
    assert.equal(row2.task_fixture_sha256, row.task_fixture_sha256);
    assert.equal(row2.task_content_sha256, row.task_content_sha256);
    assert.equal(row2.requested_effort, 'low');

    const persisted = readFileSync(join(outDir, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    for (const r of persisted) {
      for (const k of ['claude_cli_version', 'requested_model', 'resolved_model', 'requested_effort', 'task_prompt_sha256', 'task_fixture_sha256', 'task_content_sha256']) {
        assert.ok(k in r, `results.jsonl row missing ${k}`);
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a task-pack row carries task_pack_sha256, and editing the pack changes it', async () => {
  const { outDir, answersDir } = tmpOut();
  const packCopy = mkdtempSync(join(tmpdir(), 'ac-pack-copy-'));
  try {
    const pack = loadPack(EXAMPLE_PACK_DIR);
    const task = buildTaskFromPack(pack, { repoPath: REPO_ROOT });
    const row = await runOne({
      cellId: 'sonnet-medium', cell: CELLS['sonnet-medium'], taskId: pack.id, task, rep: 1,
      outDir, answersDir, runClaudeImpl: stubClaude().impl, cliVersion: 'x',
    });
    assert.equal(row.task_pack_sha256, packContentSha256(pack));
    assert.equal(row.task_family, 'pack');
    assert.match(row.task_rubric_sha256, HEX64, 'the example pack ships a rubric');

    cpSync(EXAMPLE_PACK_DIR, packCopy, { recursive: true });
    writeFileSync(join(packCopy, 'hidden-test.mjs'), readFileSync(join(packCopy, 'hidden-test.mjs'), 'utf8') + '\n// edited\n');
    assert.notEqual(packContentSha256(loadPack(packCopy)), row.task_pack_sha256, 'a held-out test edit must change the pack hash');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(packCopy, { recursive: true, force: true });
  }
});

test('reproMetadata and treeSha256 are pure and order-independent', () => {
  assert.equal(treeSha256({ a: '1', b: '2' }), treeSha256({ b: '2', a: '1' }));
  assert.notEqual(treeSha256({ a: '1' }), treeSha256({ a: '2' }));
  const m = reproMetadata({ promptText: 'p', initialTree: { a: '1' }, task: {}, cliVersion: null });
  assert.equal(m.claude_cli_version, null, 'unknown version is null, never guessed');
  assert.equal(m.task_prompt_sha256, sha('p'));
});

test('harnessErrorRow (runOne threw) still names harness, model and effort', () => {
  const r = harnessErrorRow({
    cellId: 'opus55-low', cell: CELLS['opus55-low'], taskId: 'lookup', task: TASKS.lookup, rep: 2, error: new Error('boom'), cliVersion: '1.2.3',
  });
  assert.equal(r.claude_cli_version, '1.2.3');
  assert.equal(r.requested_model, 'claude-opus-5-5');
  assert.equal(r.requested_effort, 'low');
  assert.equal(r.task_family, 'easy');
  assert.equal(r.pass, false);
  assert.equal(r.exec_err, 'boom');
});
