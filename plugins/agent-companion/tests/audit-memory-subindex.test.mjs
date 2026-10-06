// The audit's memory-index check follows links one level into linked .md
// index files inside the memory dir, so a memory linked only from a topic
// sub-index is reachable. Fixture memory dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import './isolate.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS } from '../scripts/checks.mjs';

const check = CHECKS.find((c) => c.id === 'memory-index');

function memDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-memidx-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test('direct links in MEMORY.md work as before: linked is reachable, unlinked is an orphan', () => {
  const dir = memDir({
    'MEMORY.md': '- [a](a.md) - note\n',
    'a.md': 'a\n',
    'b.md': 'b\n',
  });
  try {
    const r = check.run({ memoryDir: dir });
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.data.ruleOrphans, ['b.md']);
    assert.deepEqual(r.data.broken, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a memory linked only from a sub-index linked in MEMORY.md is reachable', () => {
  const dir = memDir({
    'MEMORY.md': '- [long tail](index_topics.md) - older entries\n- [a](a.md)\n',
    'index_topics.md': '- [deep](deep.md) - one\n- [deeper](deeper.md) - two\n',
    'a.md': 'a\n',
    'deep.md': 'deep\n',
    'deeper.md': 'deeper\n',
  });
  try {
    const r = check.run({ memoryDir: dir });
    assert.equal(r.status, 'ok', JSON.stringify(r.findings));
    assert.deepEqual(r.data.ruleOrphans, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sub-index links are followed one level only; a file no index reaches is still an orphan', () => {
  const dir = memDir({
    'MEMORY.md': '- [t](index_topics.md)\n',
    'index_topics.md': '- [t2](index_more.md)\n- [x](x.md)\n',
    'index_more.md': '- [y](y.md)\n',
    'x.md': 'x\n',
    'y.md': 'y\n',
    'z.md': 'z\n',
  });
  try {
    const r = check.run({ memoryDir: dir });
    assert.equal(r.status, 'fail');
    assert.deepEqual([...r.data.ruleOrphans].sort(), ['y.md', 'z.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only MEMORY.md-linked files named index_*.md are followed; any other linked memory is not an index', () => {
  const dir = memDir({
    'MEMORY.md': '- [m](note.md)\n',
    'note.md': 'see [other](other.md)\n',
    'other.md': 'o\n',
  });
  try {
    const r = check.run({ memoryDir: dir });
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.data.ruleOrphans, ['other.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--fix does not append sub-indexed files back into MEMORY.md, and still re-links a true orphan', () => {
  const dir = memDir({
    'MEMORY.md': '- [t](index_topics.md)\n',
    'index_topics.md': '- [x](x.md)\n',
    'x.md': '---\nname: x\ndescription: sub-indexed\n---\nx\n',
    'lost.md': '---\nname: lost\ndescription: nobody links this\n---\nl\n',
  });
  try {
    const before = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    const prev = check.run({ memoryDir: dir });
    assert.deepEqual(prev.data.ruleOrphans, ['lost.md']);
    const done = check.fix({ memoryDir: dir }, prev);
    assert.deepEqual(done, ['re-linked lost.md']);
    const after = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(after.startsWith(before.trimEnd()));
    assert.match(after, /\(lost\.md\)/);
    assert.doesNotMatch(after, /\(x\.md\)/);
    assert.equal(check.run({ memoryDir: dir }).status, 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a broken link inside a sub-index is reported', () => {
  const dir = memDir({
    'MEMORY.md': '- [t](index_topics.md)\n',
    'index_topics.md': '- [gone](gone.md)\n',
  });
  try {
    const r = check.run({ memoryDir: dir });
    assert.equal(r.status, 'fail');
    assert.deepEqual(r.data.broken, ['gone.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
