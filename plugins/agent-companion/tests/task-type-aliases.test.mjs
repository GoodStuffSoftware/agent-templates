// Task type aliases (config taskTypeAliases): another spelling of a type, with
// that type's own route. recommend.mjs --type and the spawn guard's TYPE: line
// resolve through the same function (hooks/lib/context.mjs canonicalTaskType).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { makeFixture, runHook, runScript, readJsonl } from './helpers.mjs';
import { modelTiers, canonicalTaskType, unknownTypeHint, taskTypeNames, resolveRoute } from '../hooks/lib/context.mjs';
import { rulesPath } from '../hooks/lib/rules.mjs';

const aliases = () => modelTiers().taskTypeAliases || {};
const rec = (...args) => runScript('scripts/recommend.mjs', args);

test('data: every alias target is a shipped type and no alias shadows a type', () => {
  const cfg = modelTiers();
  const names = Object.keys(cfg.taskTypes);
  assert.equal(names.length, 13);
  assert.ok(Object.keys(aliases()).length >= 10);
  for (const [a, target] of Object.entries(aliases())) {
    assert.ok(names.includes(target), `${a} -> ${target} must be a shipped type`);
    assert.ok(!names.includes(a), `${a} must not shadow a shipped type`);
    assert.deepEqual(canonicalTaskType(a), { name: target, via: 'alias' });
  }
  assert.equal(aliases().docs, 'mechanical-edit');
  assert.deepEqual(canonicalTaskType('explore'), { name: 'explore', via: 'shipped' });
  assert.equal(canonicalTaskType('frobnicate'), null);
  assert.equal(canonicalTaskType('investigate'), null);
});

test('unknownTypeHint names every type and the aliases', () => {
  const h = unknownTypeHint('frobnicate');
  for (const n of taskTypeNames()) assert.ok(h.includes(n), n);
  assert.match(h, /^"frobnicate" is not a task type\. Valid types:/);
  assert.match(h, /Aliases: .*docs -> mechanical-edit/);
  assert.match(h, /TYPE is the task kind, ROLE is the deliverable/);
});

test('recommend --type <alias> answers with the target\'s route and says so', () => {
  const plain = rec('--type', 'mechanical-edit', '--json');
  const al = rec('--type', 'docs', '--json');
  assert.equal(al.status, 0, al.stderr);
  assert.equal(al.json.aliasOf, 'docs');
  assert.equal(al.json.taskType, 'mechanical-edit');
  assert.equal(al.json.model, plain.json.model);
  assert.equal(al.json.effort, plain.json.effort);
  assert.equal(plain.json.aliasOf, undefined);
  const text = rec('--type', 'docs');
  assert.equal(text.status, 0);
  assert.match(text.stdout, /type docs is an alias of mechanical-edit/);
});

test('recommend answers every alias except review (which needs a writer)', () => {
  for (const [a, target] of Object.entries(aliases())) {
    if (target === 'code-review') continue;
    const r = rec('--type', a, '--json');
    assert.equal(r.status, 0, `${a}: ${r.stderr}`);
    assert.equal(r.json.taskType, target);
    assert.equal(r.json.aliasOf, a);
    assert.ok(r.json.model, a);
  }
});

test('recommend --type frobnicate exits 2 and names all 13 types and the aliases', () => {
  const r = rec('--type', 'frobnicate');
  assert.equal(r.status, 2);
  for (const n of Object.keys(modelTiers().taskTypes)) assert.ok(r.stderr.includes(n), n);
  assert.match(r.stderr, /Aliases: .*bugfix -> debug-root-cause/);
  assert.doesNotMatch(r.stderr, /see --list$/m);
});

test('recommend --type review without --writer gives the parity message', () => {
  const r = rec('--type', 'review');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sized by parity/);
  const ok = rec('--type', 'review', '--writer', 'opus/high', '--json');
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.aliasOf, 'review');
  assert.equal(ok.json.taskType, 'code-review');
});

test('recommend --list shows the aliases', () => {
  const r = rec('--list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Aliases: .*docs -> mechanical-edit/m);
});

function spawn(prompt, sid, { env = {}, subagent = 'general-purpose', model = 'sonnet', rules = null, extra = {} } = {}) {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    if (rules) writeFileSync(rulesPath(), JSON.stringify(rules));
    const res = runHook('hooks/spawn-guard.mjs', {
      session_id: sid, agent_type: 'main', cwd: dir,
      tool_input: { subagent_type: subagent, model, prompt, run_in_background: true, name: 'w', ...extra },
    }, { env });
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(join(stateDir, 'telemetry', 'spawns.jsonl'));
    const hso = res.json?.hookSpecificOutput || {};
    return { res, row: rows[rows.length - 1], ctx: hso.additionalContext || '', prompt: hso.updatedInput?.prompt || '' };
  } finally {
    cleanup();
  }
}

test('guard: TYPE: bugfix routes as debug-root-cause, keeps the raw value, gets the type\'s rules text', () => {
  const rules = [{ id: 'dbg-clause', scope: 'spawn', when: 'TYPE:\\s*debug-root-cause', then: 'DEBUG CLAUSE INJECTED' }];
  const { row, prompt } = spawn('TYPE: bugfix\nfix the thing', 'sess-alias-bugfix', { rules });
  assert.equal(row.declared_type, 'bugfix');
  assert.equal(row.declared_type_resolved, 'debug-root-cause');
  const want = resolveRoute({ type: 'debug-root-cause' });
  assert.equal(row.fit_expected, `${want.model}${want.effort ? '/' + want.effort : ''}`);
  assert.match(prompt, /DEBUG CLAUSE INJECTED/);
  assert.match(prompt, /^TYPE: bugfix/m, 'the brief text itself is untouched');
});

test('guard: a writer alias on a ladder rung gets the self-review block, like its target', () => {
  const a = spawn('TYPE: bugfix\nfix the thing', 'sess-alias-sr-a', { subagent: 'agent-companion:ac-sonnet-high', model: undefined });
  const b = spawn('TYPE: debug-root-cause\nfix the thing', 'sess-alias-sr-b', { subagent: 'agent-companion:ac-sonnet-high', model: undefined });
  assert.ok(b.prompt.length > 'TYPE: debug-root-cause\nfix the thing'.length, 'the target is a self-reviewing type, so a block is appended');
  assert.equal(a.row.self_review_injected, b.row.self_review_injected);
  assert.equal(a.row.self_review_expected, b.row.self_review_expected);
  assert.equal(a.prompt.length - 'TYPE: bugfix\nfix the thing'.length, b.prompt.length - 'TYPE: debug-root-cause\nfix the thing'.length);
});

test('guard: TYPE: review + WRITER is sized by parity like code-review', () => {
  const a = spawn('TYPE: review\nWRITER: opus/high\ncheck it', 'sess-alias-rev-a', { model: 'opus' });
  const b = spawn('TYPE: code-review\nWRITER: opus/high\ncheck it', 'sess-alias-rev-b', { model: 'opus' });
  assert.equal(a.row.declared_type, 'review');
  assert.equal(a.row.declared_type_resolved, 'code-review');
  assert.ok(a.row.fit_expected, 'parity route resolved');
  assert.equal(a.row.fit_expected, b.row.fit_expected);
});

test('guard: TYPE: user (prose) gets the nudge with the type list and routes nothing', () => {
  const { row, ctx } = spawn('TYPE: user story\ndo it', 'sess-alias-user');
  assert.equal(row.declared_type, 'user');
  assert.equal(row.declared_type_resolved, null);
  assert.equal(row.fit_expected, null);
  assert.match(ctx, /TYPE: user is not a task type, so it routes and measures nothing/);
  for (const n of Object.keys(modelTiers().taskTypes)) assert.ok(ctx.includes(n), n);
  assert.match(ctx, /Not blocking/);
});

test('guard: a known type and an alias get no type nudge; type_line_nudge false silences it', () => {
  assert.doesNotMatch(spawn('TYPE: docs\ndo it', 'sess-alias-quiet-a').ctx, /not a task type/);
  assert.doesNotMatch(spawn('TYPE: explore\ndo it', 'sess-alias-quiet-b').ctx, /not a task type/);
  const off = spawn('TYPE: user\ndo it', 'sess-alias-off', { env: { CLAUDE_PLUGIN_OPTION_TYPE_LINE_NUDGE: '0' } });
  assert.doesNotMatch(off.ctx, /not a task type/);
  assert.equal(off.row.declared_type, 'user');
});

test('parity: for every alias the guard\'s route equals recommend.mjs --type <alias>', () => {
  for (const [a, target] of Object.entries(aliases())) {
    if (target === 'code-review') continue;
    const r = rec('--type', a, '--json');
    const route = resolveRoute({ type: canonicalTaskType(a).name });
    assert.equal(r.json.model, route.model, a);
    assert.equal(r.json.effort, route.effort, a);
    const { row } = spawn(`TYPE: ${a}\ndo it`, `sess-alias-par-${a}`);
    assert.equal(row.declared_type, a);
    assert.equal(row.declared_type_resolved, target);
    assert.equal(row.fit_expected, `${route.model}${route.effort ? '/' + route.effort : ''}`, a);
  }
});
