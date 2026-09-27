// Namegate names must match the Agent tool's `name` schema pattern, or the
// autofilled spawn fails validation (a dotted description like "release
// 0.29.19" used to leak a '.' into the name).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENT_COMPANION_STATE_DIR = mkdtempSync(join(tmpdir(), 'ac-namegate-re-'));
const { buildCandidateName, makeUnique, reserveUniqueName, AGENT_NAME_RE } =
  await import('../hooks/lib/namegate.mjs');
const RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

test.after(() => rmSync(process.env.AGENT_COMPANION_STATE_DIR, { recursive: true, force: true }));

test('exported pattern is exactly the Agent tool pattern', () => {
  assert.equal(AGENT_NAME_RE.source, RE.source);
});

test('dotted description yields a valid name (the 0.29.19 repro)', () => {
  const n = buildCandidateName({ cwd: '/w/strange-ardinghelli-70ccdc', declaredType: 'operate', description: 'Cut and land release 0.29.19' });
  assert.match(n, RE);
  assert.ok(!n.includes('.'));
});

test('leading underscore / dot project dir yields a valid name', () => {
  for (const cwd of ['/w/_private', '/w/.hidden', '/w/__._x']) {
    const n = buildCandidateName({ cwd, subagentType: 'x:_y', description: '.dots.everywhere.' });
    assert.match(n, RE, `${cwd} -> ${n}`);
  }
});

test('64+ char inputs and uniqueness suffixes stay within the pattern', () => {
  const long = 'a'.repeat(80);
  const n = buildCandidateName({ cwd: `/w/${long}`, declaredType: long, description: long });
  assert.match(n, RE);
  const taken = [n];
  for (let i = 2; i <= 60; i += 1) taken.push(`${n.slice(0, 57)}-${i}`);
  assert.match(makeUnique(n, taken), RE);
  assert.match(makeUnique('_bad.name', []), RE);
  assert.match(makeUnique('x'.repeat(70), []), RE);
  const sid = 'namegate-re-test-session';
  assert.match(reserveUniqueName(sid, n, []), RE);
  assert.match(reserveUniqueName(sid, n, []), RE); // collides -> suffixed
  assert.match(reserveUniqueName(sid, '.dotted.bad', []), RE);
});
