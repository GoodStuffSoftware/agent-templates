// Optional "Compact instructions" CLAUDE.md block and its opt-in installer
// (scripts/install-compact-instructions.mjs). Temp dirs only; every run
// passes --target AND a temp HOME/USERPROFILE/CLAUDE_CONFIG_DIR, so the real
// ~/.claude/CLAUDE.md is never read or written. Only the pure lib is
// imported; the installer runs as a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pruneBackups } from '../scripts/lib/backup-file.mjs';
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
    assert.equal(existsSync(s.target), false, 'install created it, so uninstall removes it');
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
    assert.ok(r.stdout.startsWith(`${BLOCK_LINES.join('\n')}\n`), r.stdout);
    assert.equal(existsSync(s.target), false);
  } finally { s.done(); }
});

const SHAPES = ['', 'abc', 'abc\n', 'abc\n\n', 'abc\n\n\n', '\n', '\n\n', 'a\r\nb', 'a\r\nb\r\n', 'a\r\nb\r\n\r\n', '﻿# x\n', '﻿'];

test('F3 pure round trip is byte-identical for every trailing-newline shape', () => {
  for (const t of SHAPES) {
    const w = withBlock(t);
    assert.equal(inspect(w).state, 'ours', JSON.stringify(t));
    assert.equal(withBlock(w), w, `idempotent ${JSON.stringify(t)}`);
    assert.equal(withoutBlock(w), t, `round trip ${JSON.stringify(t)}`);
  }
});

test('F3 installer round trip is byte-identical on disk for every shape', () => {
  for (const t of SHAPES) {
    const s = sandbox();
    try {
      writeFileSync(s.target, t);
      assert.equal(s.run().status, 0);
      assert.equal(s.run('--uninstall').status, 0);
      assert.equal(existsSync(s.target), true, `existing file kept: ${JSON.stringify(t)}`);
      assert.equal(readFileSync(s.target, 'utf8'), t, JSON.stringify(t));
    } finally { s.done(); }
  }
});

test('F4 uninstall removes a file install created, keeps a pre-existing empty one', () => {
  const s = sandbox();
  try {
    assert.equal(s.run().status, 0);
    assert.equal(s.run('--uninstall').status, 0);
    assert.equal(existsSync(s.target), false);
    writeFileSync(s.target, '');
    s.run(); s.run('--uninstall');
    assert.equal(existsSync(s.target), true);
    assert.equal(readFileSync(s.target, 'utf8'), '');
    // Created, then the operator added text: the file stays with their text.
    rmSync(s.target); s.run();
    writeFileSync(s.target, `${readFileSync(s.target, 'utf8')}mine\n`);
    s.run('--uninstall');
    assert.equal(readFileSync(s.target, 'utf8'), 'mine\n');
  } finally { s.done(); }
});

test('F2 the block names no operator-specific files and stays <= ~400 chars', () => {
  const text = BLOCK_LINES.join('\n');
  assert.doesNotMatch(text, /SESSION-STATE|HANDOFF[.]md/);
  assert.ok(text.length <= 420, `${text.length} chars`);
});

test('F1 --print and --status on the default target state the documented path', () => {
  const s = sandbox();
  try {
    const env = { HOME: s.home, USERPROFILE: s.home, CLAUDE_CONFIG_DIR: join(s.home, '.claude') };
    assert.match(runScript(SCRIPT, ['--print'], { env }).stdout, /project-root CLAUDE[.]md.*--target <repo>\/CLAUDE[.]md/s);
    assert.match(runScript(SCRIPT, ['--status'], { env }).stdout, /not documented to steer it/);
    assert.equal(existsSync(join(s.home, '.claude', 'CLAUDE.md')), false);
  } finally { s.done(); }
});

test('F5 backups: newest 3 per target are kept, older ones pruned', () => {
  const s = sandbox();
  try {
    writeFileSync(s.target, 'x\n');
    for (let i = 0; i < 4; i += 1) { s.run(); s.run('--uninstall'); }
    const baks = readdirSync(s.home).filter((f) => f.startsWith('CLAUDE.md.bak-agent-companion-'));
    assert.equal(baks.length, 3, baks.join(','));
    // Look-alikes that are not exactly ours (no valid timestamp) survive.
    for (const n of ['agent-companion-x', 'agent-companion-2026-01-01', '2026-01-01T00-00-00-000Z']) writeFileSync(join(s.home, `CLAUDE.md.bak-${n}`), 'k');
    pruneBackups(s.target, 0);
    assert.deepEqual(readdirSync(s.home).filter((f) => f.includes('.bak-')).sort(),
      ['CLAUDE.md.bak-2026-01-01T00-00-00-000Z', 'CLAUDE.md.bak-agent-companion-2026-01-01', 'CLAUDE.md.bak-agent-companion-x']);
  } finally { s.done(); }
});

test('F5 operator backups survive 5 install/uninstall cycles of both installers', () => {
  const home = mkdtempSync(join(tmpdir(), 'ac-baks-'));
  try {
    const cfg = join(home, '.claude'); mkdirSync(cfg);
    const env = { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg };
    const md = join(cfg, 'CLAUDE.md'); const settings = join(cfg, 'settings.json');
    writeFileSync(md, '# mine\n'); writeFileSync(settings, '{}\n');
    const keep = { 'CLAUDE.md.bak-2026-07-07': 'hand', 'settings.json.bak-foo': 'hand', 'settings.json.bak-2026-09-24-compact': 'hand' };
    for (const [f, c] of Object.entries(keep)) writeFileSync(join(cfg, f), c);
    const rh = ['--settings', settings, '--hooks-dir', join(cfg, 'hooks')];
    for (let i = 0; i < 5; i += 1) {
      for (const a of [[], ['--uninstall']]) {
        assert.equal(runScript(SCRIPT, ['--target', md, ...a], { env }).status, 0);
        assert.equal(runScript('scripts/install-reinject-hook.mjs', [...rh, ...a], { env }).status, 0);
      }
    }
    for (const [f, c] of Object.entries(keep)) assert.equal(readFileSync(join(cfg, f), 'utf8'), c, f);
    const files = readdirSync(cfg);
    assert.equal(files.filter((f) => f.startsWith('CLAUDE.md.bak-agent-companion-')).length, 3);
    assert.equal(files.filter((f) => f.startsWith('settings.json.bak-agent-companion-')).length, 3);
    assert.equal(readFileSync(md, 'utf8'), '# mine\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('F6 a read-only target: exit 1, file untouched, no backup written', () => {
  const s = sandbox();
  try {
    writeFileSync(s.target, 'ro\n');
    chmodSync(s.target, 0o444);
    const r = s.run();
    assert.equal(r.status, 1, r.stdout);
    assert.equal(readFileSync(s.target, 'utf8'), 'ro\n');
    assert.equal(readdirSync(s.home).filter((f) => f.includes('.bak-')).length, 0);
  } finally { chmodSync(s.target, 0o666); s.done(); }
});

test('F7 importing either installer runs nothing and writes nothing', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const f of ['scripts/install-compact-instructions.mjs', 'scripts/install-reinject-hook.mjs']) {
    const home = mkdtempSync(join(tmpdir(), 'ac-import-'));
    try {
      const url = pathToFileURL(join(root, f)).href;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('IMPORTED');`], {
        cwd: home, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'IMPORTED', f);
      assert.deepEqual(readdirSync(home), [], f);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});
