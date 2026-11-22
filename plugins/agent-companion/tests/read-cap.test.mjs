// Read cap for subagents (hooks/read-cap.mjs): a subagent's Read with no limit on a long text file is capped and the agent is told how
// to read the rest, in the same reply (PreToolUse updatedInput + additionalContext, no permissionDecision).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook, PLUGIN_ROOT } from './helpers.mjs';

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function read(fx, input, { agent = true, env = {}, extra = {} } = {}) {
  return runHook('hooks/read-cap.mjs', {
    session_id: 'sess-cap', cwd: fx.dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: input,
    ...(agent ? { agent_id: 'agent-cap-1', agent_type: 'general-purpose' } : {}), ...extra,
  }, { env });
}

test('a subagent Read of a 1000-line file with no limit is capped to 300 and told the line count and how to read on', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dir, 'big.txt'), lines(1000));
    const r = read(fx, { file_path: 'big.txt' });
    const o = r.json.hookSpecificOutput;
    assert.equal(o.hookEventName, 'PreToolUse');
    assert.deepEqual(o.updatedInput, { file_path: 'big.txt', limit: 300 });
    assert.equal(o.permissionDecision, undefined, 'no decision: a permission prompt is never skipped');
    assert.match(o.additionalContext, /big\.txt has 1000 lines/);
    assert.match(o.additionalContext, /lines 1-300 \(limit 300\)/);
    assert.match(o.additionalContext, /offset=301/);
    assert.match(o.additionalContext, /grep -n/);
  } finally { fx.cleanup(); }
});

test('an offset is kept; the cap applies only while more than the cap remains; other input fields are carried over', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dir, 'big.txt'), lines(1000));
    const a = read(fx, { file_path: 'big.txt', offset: 500 }).json.hookSpecificOutput;
    assert.deepEqual(a.updatedInput, { file_path: 'big.txt', offset: 500, limit: 300 });
    assert.match(a.additionalContext, /lines 500-799/);
    assert.match(a.additionalContext, /offset=800/);
    const b = read(fx, { file_path: 'big.txt', offset: 701 });
    assert.equal(b.stdout.trim(), '', '300 lines remain: not capped');
  } finally { fx.cleanup(); }
});

test('untouched: main thread, a Read with a limit, a short file, images, PDFs, notebooks, binary, missing, garbage input', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dir, 'big.txt'), lines(1000));
    writeFileSync(join(fx.dir, 'small.txt'), lines(300));
    writeFileSync(join(fx.dir, 'nonl.txt'), lines(300).trimEnd());
    writeFileSync(join(fx.dir, 'big.png'), lines(1000));
    writeFileSync(join(fx.dir, 'big.pdf'), lines(1000));
    writeFileSync(join(fx.dir, 'big.ipynb'), lines(1000));
    writeFileSync(join(fx.dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(lines(1000))]));
    const quiet = (input, o) => assert.equal(read(fx, input, o).stdout.trim(), '', JSON.stringify(input));
    quiet({ file_path: 'big.txt' }, { agent: false });
    quiet({ file_path: 'big.txt', limit: 2000 });
    quiet({ file_path: 'big.txt', pages: '1-2' });
    quiet({ file_path: 'small.txt' });
    quiet({ file_path: 'nonl.txt' });
    quiet({ file_path: 'big.png' });
    quiet({ file_path: 'big.pdf' });
    quiet({ file_path: 'big.ipynb' });
    quiet({ file_path: 'blob.bin' });
    quiet({ file_path: 'missing.txt' });
    quiet({ file_path: 'big.txt' }, { extra: { session_id: 'served:abc' } });
    const r = runHook('hooks/read-cap.mjs', undefined);
    assert.equal(r.status, 0, 'garbage stdin fails open');
  } finally { fx.cleanup(); }
});

test('a last line without a newline counts as a line (301 lines are capped)', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dir, 'n301.txt'), lines(301).trimEnd());
    assert.match(read(fx, { file_path: 'n301.txt' }).json.hookSpecificOutput.additionalContext, /has 301 lines/);
  } finally { fx.cleanup(); }
});

test('options: read_cap=false turns it off (env), read_cap_lines changes the threshold', () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.dir, 'mid.txt'), lines(500));
    assert.equal(read(fx, { file_path: 'mid.txt' }, { env: { CLAUDE_PLUGIN_OPTION_READ_CAP: '0' } }).stdout.trim(), '');
    assert.equal(read(fx, { file_path: 'mid.txt' }, { env: { CLAUDE_PLUGIN_OPTION_READ_CAP_LINES: '600' } }).stdout.trim(), '');
    const o = read(fx, { file_path: 'mid.txt' }, { env: { CLAUDE_PLUGIN_OPTION_READ_CAP_LINES: '100' } }).json.hookSpecificOutput;
    assert.equal(o.updatedInput.limit, 100);
    assert.match(o.additionalContext, /has 500 lines/);
  } finally { fx.cleanup(); }
});

test('registered beside read-dedupe on the Read matcher, with the options declared', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const block = hooks.hooks.PreToolUse.find((b) => b.matcher === '^Read$');
  assert.ok(block.hooks.some((h) => h.args.some((a) => a.endsWith('hooks/read-cap.mjs'))));
  const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).userConfig;
  assert.equal(cfg.read_cap.default, true);
  assert.equal(cfg.read_cap_lines.default, 300);
  assert.equal(cfg.interrupted_worker_notice.default, true);
});
