// Optional "Compact instructions" CLAUDE.md block and its opt-in installer
// (scripts/install-compact-instructions.mjs). Temp dirs only; every run
// passes --target AND a temp HOME/USERPROFILE/CLAUDE_CONFIG_DIR, so the real
// ~/.claude/CLAUDE.md is never read or written. Only the pure lib is
// imported; the installer runs as a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScript } from './helpers.mjs';
import { BEGIN, END, BODY, BLOCK_LINES, inspect, withBlock, withoutBlock } from '../scripts/lib/compact-instructions.mjs';

const SCRIPT = 'scripts/install-compact-instructions.mjs';

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'ac-compact-'));
  const target = join(home, 'CLAUDE.md');
  const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const run = (...a) => runScript(SCRIPT, ['--target', target, ...a], { env });
  return { home, target, run, done: () => rmSync(home, { recursive: true, force: true }) };
}

test('the block is short (paid every session start): <= 8 lines, < 500 chars', () => {
  assert.ok(BLOCK_LINES.length <= 8, `${BLOCK_LINES.length} lines`);
  assert.ok(BLOCK_LINES.join('\n').length < 500, `${BLOCK_LINES.join('\n').length} chars`);
  assert.equal(BODY[0], '# Compact instructions');
});

test('pure edits: append, idempotent refresh, remove restores the original', () => {
  const orig = '# Mine\n\nrule\n';
  const once = withBlock(orig);
  assert.equal(inspect(once).state, 'ours');
  assert.equal(withBlock(once), once);
  assert.equal(withoutBlock(once), orig);
  const crlf = 'a\r\nb\r\n';
  const c = withBlock(crlf);
  assert.doesNotMatch(c.replace(/\r\n/g, ''), /\n/);
  assert.equal(withoutBlock(c), crlf);
  assert.equal(withoutBlock(withBlock('')), '');
});

test('inspect: foreign heading, stale body, unbalanced markers', () => {
  assert.equal(inspect('## Compact Instructions\nx\n').foreign, true);
  assert.equal(inspect(`${BEGIN}\nold\n${END}\n`).state, 'ours-stale');
  assert.match(inspect(`${BEGIN}\nx\n`).problem, /unbalanced/);
  assert.match(inspect(`${END}\n${BEGIN}\n`).problem, /unbalanced/);
});

test('install into a missing file, then status, idempotent re-run, uninstall', () => {
  const s = sandbox();
  try {
    let r = s.run('--dry-run');
    assert.equal(r.status, 0, r.stderr); assert.equal(existsSync(s.target), false);
    r = s.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(inspect(readFileSync(s.target, 'utf8')).state, 'ours');
    assert.match(s.run('--status').stdout, /: installed in/);
    const before = readFileSync(s.target, 'utf8');
    assert.match(s.run().stdout, /already installed/);
    assert.equal(readFileSync(s.target, 'utf8'), before);
    r = s.run('--uninstall');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(s.target, 'utf8'), '');
    assert.match(s.run('--uninstall').stdout, /nothing to uninstall/);
  } finally { s.done(); }
});

test('existing content is kept and backed up before a write', () => {
  const s = sandbox();
  try {
    writeFileSync(s.target, '# Mine\nkeep me\n');
    assert.equal(s.run().status, 0);
    const text = readFileSync(s.target, 'utf8');
    assert.match(text, /^# Mine\nkeep me\n\n<!-- agent-companion/);
    assert.ok(readdirSync(s.home).some((f) => f.startsWith('CLAUDE.md.bak-')));
    s.run('--uninstall');
    assert.equal(readFileSync(s.target, 'utf8'), '# Mine\nkeep me\n');
  } finally { s.done(); }
});

test('an existing Compact instructions section blocks install unless --force', () => {
  const s = sandbox();
  try {
    writeFileSync(s.target, '# Compact instructions\nmine\n');
    const r = s.run();
    assert.equal(r.status, 0); assert.match(r.stdout, /already has/);
    assert.equal(readFileSync(s.target, 'utf8'), '# Compact instructions\nmine\n');
    assert.match(s.run('--status').stdout, /not installed.*another/);
    assert.equal(s.run('--force').status, 0);
    assert.equal(inspect(readFileSync(s.target, 'utf8')).state, 'ours');
  } finally { s.done(); }
});

test('unbalanced markers: refuses with exit 1 and writes nothing', () => {
  const s = sandbox();
  try {
    writeFileSync(s.target, `${BEGIN}\nhalf\n`);
    const r = s.run();
    assert.equal(r.status, 1); assert.match(r.stderr, /refusing/);
    assert.equal(readFileSync(s.target, 'utf8'), `${BEGIN}\nhalf\n`);
  } finally { s.done(); }
});

test('--print shows the exact block and writes nothing', () => {
  const s = sandbox();
  try {
    const r = s.run('--print');
    assert.equal(r.stdout.trim(), BLOCK_LINES.join('\n'));
    assert.equal(existsSync(s.target), false);
  } finally { s.done(); }
});
