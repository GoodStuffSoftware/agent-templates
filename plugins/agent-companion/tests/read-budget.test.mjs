// Shell reads, the per-file read budget and the outline (0.31.65): the parser and rules (unit), then the hooks run as the harness
// runs them. Rules and reasoning: hooks/lib/read-shell.mjs, hooks/lib/read-dedupe.mjs (decide, decideShell), hooks/bash-read.mjs.
// Names in fixtures are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { makeFixture, runHook, decisionOf } from './helpers.mjs';
import { parseShellRead, resolveRange, isOutputFile, outlineOf, outlineKind, countLinesIn, mayBeShellRead, inBudgetScope } from '../hooks/lib/read-shell.mjs';
import { decide, decideShell, budgetOf, budgetExempt, invalidate, record } from '../hooks/lib/read-dedupe.mjs';

// --- unit: parseShellRead -----------------------------------------------------

const P = (c) => parseShellRead(c);

test('parse: the plain read forms', () => {
  assert.equal(P("sed -n '10,40p' src/widget.mjs").file, 'src/widget.mjs');
  assert.equal(P("sed -n '10,40p' src/widget.mjs").a, 10);
  assert.equal(P("sed -n '10,40p' src/widget.mjs").b, 40);
  assert.equal(P('cat src/widget.mjs').file, 'src/widget.mjs');
  assert.equal(P('head -n 50 src/widget.mjs').file, 'src/widget.mjs');
  assert.equal(P('head -50 src/widget.mjs').file, 'src/widget.mjs');
  assert.equal(P('tail -n 30 src/widget.mjs').file, 'src/widget.mjs');
  assert.equal(P('Get-Content src/widget.mjs').file, 'src/widget.mjs');
  assert.equal(P('Get-Content src/widget.mjs -TotalCount 20').file, 'src/widget.mjs');
  assert.equal(P("awk 'NR>=5&&NR<=9' src/widget.mjs").file, 'src/widget.mjs');
  assert.equal(P('cat "src/with space.mjs"').file, 'src/with space.mjs');
});

test('parse: piped into head/tail/Select-Object/grep -n "" is still one read', () => {
  assert.equal(P("sed -n '1,200p' f.mjs | head -50").file, 'f.mjs');
  assert.equal(P('cat f.mjs | tail -n 20').file, 'f.mjs');
  assert.equal(P('Get-Content f.mjs | Select-Object -First 30').file, 'f.mjs');
  assert.equal(P("cat f.mjs | grep -n ''").file, 'f.mjs');
});

test('parse: not a plain read -> null (search, redirect, several files, follow, glob, chains)', () => {
  for (const c of [
    'cat f.mjs | grep foo',
    "sed -n '1,9p' f.mjs | grep -n widget",
    'grep -n foo f.mjs',
    'rg foo f.mjs',
    'cat f.mjs > out.txt',
    'cat f.mjs >> out.txt',
    'cat a.mjs b.mjs',
    'tail -f f.mjs',
    'cat src/*.mjs',
    'cat f.mjs && echo done',
    'cat f.mjs; ls',
    'cat $(echo f.mjs)',
    'cat <<EOF\nhi\nEOF',
    'echo hello',
    'ls -la',
    '',
  ]) assert.equal(P(c), null, c);
  assert.equal(mayBeShellRead('echo hello'), false);
  assert.equal(mayBeShellRead(undefined), false);
});

test('resolveRange: forms and clamping', () => {
  assert.deepEqual(resolveRange(P("sed -n '10,40p' f"), 100), [10, 40]);
  assert.deepEqual(resolveRange(P("sed -n '10,400p' f"), 100), [10, 100]);
  assert.deepEqual(resolveRange(P('cat f'), 80), [1, 80]);
  assert.deepEqual(resolveRange(P('head -n 20 f'), 80), [1, 20]);
  assert.deepEqual(resolveRange(P('tail -n 20 f'), 80), [61, 80]);
  assert.deepEqual(resolveRange(P("sed -n '10,60p' f | head -5"), 100), [10, 14]);
  assert.deepEqual(resolveRange(P("sed -n '10,60p' f | tail -5"), 100), [56, 60]);
  assert.equal(resolveRange(P("sed -n '200,300p' f"), 100), null);
  assert.equal(resolveRange(null, 100), null);
});

test('isOutputFile: logs, tool output and tmp directories; not source', () => {
  for (const f of ['run.log', 'logs/a.LOG', 'out/test.out', 'tmp/x.txt', 'a/temp/b.mjs', 'job-stdout.txt', 'test-output.json', 'img.png', 'x.lock']) assert.equal(isOutputFile(f), true, f);
  for (const f of ['src/widget.mjs', 'README.md', 'hooks/lib/read-shell.mjs', 'docs/output-format.md']) assert.equal(isOutputFile(f), false, f);
});

// --- unit: outline ------------------------------------------------------------

test('outline: one case per kind, with line numbers', () => {
  const js = 'import x from "y";\nexport function alpha() {}\nexport async function beta() {}\nclass Gizmo {}\nexport const gamma = (a) => a;\nexport const LIMIT = 5;\nconst inner = 3;\n';
  const o = outlineOf(js, 'a.mjs');
  assert.match(o, /alpha\(\):2/);
  assert.match(o, /beta\(\):3/);
  assert.match(o, /class Gizmo:4/);
  assert.match(o, /gamma\(\):5/);
  assert.match(o, /export LIMIT:6/);
  assert.doesNotMatch(o, /inner/);
  assert.match(outlineOf('def foo():\n  pass\nclass Bar:\n  def m(self): pass\n', 'a.py'), /foo\(\):1, class Bar:3/);
  assert.match(outlineOf('# Title\ntext\n```\n# not heading\n```\n## Part\n', 'a.md'), /# Title:1, ## Part:6/);
  assert.doesNotMatch(outlineOf('# Title\n```\n# not heading\n```\n', 'a.md'), /not heading/);
  assert.match(outlineOf('setup() {\n  :\n}\nfunction other {\n}\n', 'a.sh'), /setup\(\):1, other\(\):4/);
  assert.match(outlineOf('function Do-Thing {\n}\nfunction Other {\n}\n', 'a.ps1'), /Do-Thing\(\):1, Other\(\):3/);
});

test('outline: at most 1500 chars and says how many more; empty when nothing found or kind unknown', () => {
  const text = Array.from({ length: 400 }, (_, i) => `export function fn${String(i).padStart(4, '0')}Handler() {}`).join('\n');
  const o = outlineOf(text, 'big.mjs');
  assert.ok(o.length <= 1500, `len ${o.length}`);
  assert.match(o, /\+\d+ more$/);
  assert.equal(outlineOf('nothing here\n', 'a.mjs'), '');
  assert.equal(outlineOf('function a() {}\n', 'a.txt'), '');
  assert.equal(outlineKind('a.json'), '');
  assert.equal(outlineKind('A.TS'), 'js');
  assert.equal(countLinesIn('a\nb\nc'), 3);
  assert.equal(countLinesIn('a\nb\n'), 2);
});

// --- unit: decide / decideShell budget ------------------------------------------

const STAT = { mtimeMs: 1000, size: 60000 };
const BUD = budgetOf(400);
const blank = () => ({ v: 1, agents: {}, pending: {} });
function shell(state, a, b, extra = {}) {
  return decideShell(state, { agent: 'w', pk: 'k', a, b, total: 1000, stat: STAT, budget: BUD, now: 5000, ...extra }).value;
}

test('budgetOf: nudge at 75 percent, bad values fall back to 400', () => {
  assert.deepEqual(budgetOf(400), { max: 400, nudge: 300 });
  assert.deepEqual(budgetOf(200), { max: 200, nudge: 150 });
  assert.equal(budgetOf('x').max, 400);
  assert.equal(budgetOf(1).max, 400);
});

test('decideShell: nudge at 300 distinct lines once, deny new lines at 400, repeat runs', () => {
  const s = blank();
  assert.equal(shell(s, 1, 100).action, 'allow');
  assert.equal(shell(s, 101, 200).nudge, undefined);
  const n = shell(s, 201, 300);
  assert.equal(n.nudge, true);
  assert.equal(n.have, 200);
  assert.equal(shell(s, 301, 350).nudge, undefined, 'nudged once');
  assert.equal(shell(s, 351, 400).action, 'allow');
  const d = shell(s, 401, 450);
  assert.equal(d.action, 'deny');
  assert.equal(d.reason, 'budget');
  assert.equal(shell(s, 401, 450).action, 'retry', 'identical repeat runs');
  assert.equal(shell(s, 401, 450).action, 'deny', 'override used up');
});

test('decideShell: covered big repeat denied, small one allowed; a changed file forgets', () => {
  const s = blank();
  assert.equal(shell(s, 1, 100).action, 'allow');
  assert.equal(shell(s, 1, 100).reason, 'covered');
  assert.equal(shell(s, 1, 100).action, 'retry');
  assert.equal(shell(s, 5, 6).action, 'allow', 'est under 2000 chars');
  const s2 = blank();
  shell(s2, 1, 100);
  assert.equal(shell(s2, 1, 100, { stat: { ...STAT, mtimeMs: 2000 } }).action, 'allow', 'changed on disk');
});

test('decideShell: cap denies a long span; budget off lets everything through; handoff files are exempt', () => {
  const c = shell(blank(), 1, 500, { cap: 300 });
  assert.equal(c.action, 'deny');
  assert.equal(c.reason, 'cap');
  const off = blank();
  assert.equal(shell(off, 1, 390, { budget: null }).action, 'allow');
  assert.equal(shell(off, 391, 800, { budget: null }).action, 'allow');
  assert.equal(budgetExempt('x/task-handoff.md'), true);
  assert.equal(budgetExempt('x/brief.md'), true);
  assert.equal(budgetExempt('x/widget.mjs'), false);
  const ex = blank();
  const h = (a, b) => decideShell(ex, { agent: 'w', pk: 'x/task-handoff.md', a, b, total: 1000, stat: STAT, budget: BUD }).value.action;
  assert.equal(h(1, 450), 'allow');
  assert.equal(h(451, 900), 'allow');
});

test('decideShell: a shell read and a Read share one ledger', () => {
  const s = blank();
  const input = { file_path: 'x', offset: 1, limit: 350 };
  assert.equal(decide(s, { agent: 'w', pk: 'k', input, stat: STAT, now: 5000, budget: BUD }).value.action, 'allow');
  const resp = { type: 'text', file: { filePath: 'x', content: Array.from({ length: 350 }, () => 'a'.repeat(60)).join('\n'), numLines: 350, startLine: 1, totalLines: 1000 } };
  record(s, { agent: 'w', pk: 'k', input, response: resp, stat: STAT, now: 5000 });
  assert.equal(shell(s, 351, 400).action, 'allow');
  assert.equal(shell(s, 401, 450).reason, 'budget'); // 400 lines read by Read and shell together
  const r = decide(s, { agent: 'w', pk: 'k', input: { file_path: 'x', offset: 500, limit: 20 }, stat: STAT, now: 5001, budget: BUD }).value;
  assert.equal(r.action, 'deny');
  assert.equal(r.budget, true);
  invalidate(s, { agent: 'w', pk: 'k' });
  assert.equal(shell(s, 401, 450).action, 'allow', 'after an edit the ledger is cleared');
});

// --- hooks as the harness runs them --------------------------------------------

function withFx(fn) {
  const fx = makeFixture();
  try { return fn(fx); } finally { fx.cleanup(); }
}
function makeFile(fx, name, lines, cpl = 60, fn) {
  const f = join(fx.dir, name);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, Array.from({ length: lines }, (_, i) => (fn ? fn(i) : String(i + 1).padStart(4, '0')).padEnd(cpl, 'x')).join('\n') + '\n');
  return f;
}
const sh = (fx, command, { agent = 'agent-1', env = {}, tool = 'Bash', sid = 's1' } = {}) => runHook('hooks/bash-read.mjs', {
  session_id: sid, cwd: fx.dir, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command },
  ...(agent ? { agent_id: agent, agent_type: 'x' } : {}),
}, { env });
const rd = (fx, file, offset, limit, { agent = 'agent-1', env = {}, sid = 's1' } = {}) => runHook('hooks/read-dedupe.mjs', {
  session_id: sid, cwd: fx.dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file, offset, limit },
  ...(agent ? { agent_id: agent, agent_type: 'x' } : {}),
}, { args: ['--event', 'pre'], env });
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';
const context = (r) => r.json?.hookSpecificOutput?.additionalContext || '';

test('hook: a repeated covered shell read is denied naming Read(file_path, offset, limit); repeating it runs', () => withFx((fx) => {
  makeFile(fx, 'src/widget.mjs', 300);
  assert.equal(sh(fx, "sed -n '1,100p' src/widget.mjs").stdout.trim(), '');
  const d = sh(fx, "sed -n '10,90p' src/widget.mjs");
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(reason(d), /Read\(file_path="src\/widget\.mjs", offset=10, limit=81\)/);
  assert.notEqual(decisionOf(sh(fx, "sed -n '10,90p' src/widget.mjs").json), 'deny', 'identical repeat runs');
}));

test('hook: cap deny names the Read call; cat of a long file is over the cap', () => withFx((fx) => {
  makeFile(fx, 'src/long.mjs', 350);
  const d = sh(fx, 'cat src/long.mjs');
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(reason(d), /Read\(file_path="src\/long\.mjs", offset=1, limit=300\)/);
}));

test('hook: shell reads and Reads count against one budget; the nudge comes first', () => withFx((fx) => {
  const f = makeFile(fx, 'src/big.mjs', 900);
  const w = (a, b) => sh(fx, `sed -n '${a},${b}p' src/big.mjs`);
  assert.notEqual(decisionOf(w(1, 100).json), 'deny');
  assert.notEqual(decisionOf(w(101, 200).json), 'deny');
  assert.match(context(w(201, 310)), /read budget/);
  assert.notEqual(decisionOf(w(311, 400).json), 'deny');
  const d = w(401, 450);
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(reason(d), /Read budget/);
  assert.match(reason(d), /Read\(file_path="src\/big\.mjs", offset=401, limit=50\)/);
  // The Read tool sees the same ledger.
  const r = rd(fx, f, 500, 20);
  assert.equal(decisionOf(r.json), 'deny');
  assert.match(reason(r), /Read budget/);
  // The identical shell call, repeated, runs.
  assert.notEqual(decisionOf(w(401, 450).json), 'deny');
}));

test('hook: untouched cases - main thread, grep pipelines, logs, outside the repo, non-reads, binaries', () => withFx((fx) => {
  makeFile(fx, 'src/widget.mjs', 300);
  makeFile(fx, 'logs/run.log', 300);
  makeFile(fx, 'tmp/scratch.txt', 300);
  writeFileSync(join(fx.dir, 'blob.dat'), Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.alloc(20000, 65)]));
  for (let i = 0; i < 3; i += 1) {
    assert.equal(sh(fx, "sed -n '1,100p' src/widget.mjs", { agent: '' }).stdout.trim(), '', 'main thread');
    assert.equal(sh(fx, 'cat src/widget.mjs | grep -n foo').stdout.trim(), '', 'grep pipeline');
    assert.equal(sh(fx, 'grep -n foo src/widget.mjs').stdout.trim(), '', 'grep search');
    assert.equal(sh(fx, "sed -n '1,100p' logs/run.log").stdout.trim(), '', 'log');
    assert.equal(sh(fx, "sed -n '1,100p' tmp/scratch.txt").stdout.trim(), '', 'tmp dir');
    assert.equal(sh(fx, "sed -n '1,100p' blob.dat").stdout.trim(), '', 'binary');
    assert.equal(sh(fx, "sed -n '1,100p' ../../outside-the-repo.mjs").stdout.trim(), '', 'outside');
    assert.equal(sh(fx, 'echo hello').stdout.trim(), '', 'not a read');
  }
}));

test('hook: the first read of a file over 400 lines carries an outline, once; a small file does not', () => withFx((fx) => {
  makeFile(fx, 'src/big.mjs', 500, 60, (i) => (i % 50 === 0 ? `export function task${i}() {}` : `// line ${i}`));
  makeFile(fx, 'src/small.mjs', 60, 60, (i) => `export function tiny${i}() {}`);
  const o = context(sh(fx, "sed -n '1,40p' src/big.mjs"));
  assert.match(o, /outline of src\/big\.mjs \(500 lines/);
  assert.match(o, /task0\(\):1/);
  assert.match(o, /task50\(\):51/);
  assert.ok(o.length < 1800);
  assert.equal(context(sh(fx, "sed -n '41,80p' src/big.mjs")), '', 'once');
  assert.equal(context(sh(fx, "sed -n '1,40p' src/small.mjs")), '');
}));

test('hook: the Read hook gives the outline on a first Read of a big file, subagent only', () => withFx((fx) => {
  const f = makeFile(fx, 'src/big.mjs', 500, 60, (i) => (i % 50 === 0 ? `export function task${i}() {}` : `// line ${i}`));
  assert.equal(context(rd(fx, f, 1, 40, { agent: '' })), '', 'main thread');
  assert.match(context(rd(fx, f, 1, 40)), /task0\(\):1/);
  assert.equal(context(rd(fx, f, 41, 40)), '', 'once');
}));

test('hook: read_budget off and read_budget_lines override through plugin options', () => withFx((fx) => {
  makeFile(fx, 'src/big.mjs', 900);
  const off = { CLAUDE_PLUGIN_OPTION_READ_BUDGET: '0' };
  for (const [a, b] of [[1, 250], [251, 500], [501, 750]]) {
    const r = sh(fx, `sed -n '${a},${b}p' src/big.mjs`, { env: off, sid: 'off' });
    assert.notEqual(decisionOf(r.json), 'deny', `${a}-${b}`);
    assert.doesNotMatch(context(r), /read budget/);
  }
  const small = { CLAUDE_PLUGIN_OPTION_READ_BUDGET_LINES: '100' };
  assert.notEqual(decisionOf(sh(fx, "sed -n '1,100p' src/big.mjs", { env: small, sid: 'small' }).json), 'deny');
  const d = sh(fx, "sed -n '101,150p' src/big.mjs", { env: small, sid: 'small' });
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(reason(d), /budget 100/);
}));

test('hook: PowerShell tool and Get-Content go through the same path', () => withFx((fx) => {
  makeFile(fx, 'src/widget.mjs', 200);
  assert.equal(sh(fx, 'Get-Content src/widget.mjs -TotalCount 100', { tool: 'PowerShell' }).stdout.trim(), '');
  const d = sh(fx, 'Get-Content src/widget.mjs -TotalCount 100', { tool: 'PowerShell' });
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(reason(d), /Read\(file_path="src\/widget\.mjs", offset=1, limit=100\)/);
}));

// --- review round 1 (0.31.65): outline survives a denied first read; the Read hook has the same budget scope ---

test('decideShell: a denied first read leaves the outline for the next read that runs', () => {
  const s = blank();
  const d = shell(s, 1, 500, { cap: 300, bigLines: 800 });
  assert.equal(d.action, 'deny');
  assert.equal(d.outline, undefined);
  assert.equal(shell(s, 1, 100, { bigLines: 800 }).outline, true, 'the next allowed read carries it');
  assert.equal(shell(s, 101, 150, { bigLines: 800 }).outline, undefined, 'once');
});

test('hook: a cat denied for its length does not use up the outline; the Read that follows carries it', () => withFx((fx) => {
  const f = makeFile(fx, 'src/big.mjs', 800, 60, (i) => (i % 50 === 0 ? `export function task${i}() {}` : `// line ${i}`));
  const d = sh(fx, 'cat src/big.mjs');
  assert.equal(decisionOf(d.json), 'deny');
  assert.match(context(rd(fx, f, 1, 100)), /outline of .*big\.mjs/);
}));

test('inBudgetScope: source in the repository yes; logs, test output and files outside no', () => withFx((fx) => {
  const fs = { existsSync };
  const path = { resolve, dirname, relative };
  const pu = (child, parent) => { const r = relative(parent, child); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
  assert.equal(inBudgetScope('src/big.mjs', fx.dir, pu, fs, path), true);
  assert.equal(inBudgetScope(join(fx.dir, 'src', 'big.mjs'), fx.dir, pu, fs, path), true);
  assert.equal(inBudgetScope('logs/run.log', fx.dir, pu, fs, path), false);
  assert.equal(inBudgetScope('logs/test-output.txt', fx.dir, pu, fs, path), false);
  assert.equal(inBudgetScope('tmp/scratch.mjs', fx.dir, pu, fs, path), false);
  assert.equal(inBudgetScope('../../outside-the-repo.mjs', fx.dir, pu, fs, path), false);
}));

test('hook: the Read hook still denies new lines of source past the budget (scope check did not switch it off)', () => withFx((fx) => {
  const f = makeFile(fx, 'src/big.mjs', 900);
  for (const [a, b] of [[1, 250], [251, 400]]) assert.notEqual(decisionOf(sh(fx, `sed -n '${a},${b}p' src/big.mjs`).json), 'deny');
  assert.equal(decisionOf(rd(fx, f, 401, 100).json), 'deny');
}));
