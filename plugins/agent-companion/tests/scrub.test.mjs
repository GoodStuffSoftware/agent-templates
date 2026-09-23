// scrub.mjs — signal-text scrubbing (second adversarial review, L2).
// Every input below is one the reviewer showed getting through the old
// scrubText(). All names are synthetic; leak-shaped strings are assembled at
// run time (this file is itself leak-checked).

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScrubber } from '../scripts/lib/scrub.mjs';

const BS = '\\';
const U = ['Us', 'ers'].join('');
const USER = 'qzhandle';
const PRIV = 'zorblsecret';

const scrub = makeScrubber({ users: [USER], names: [PRIV], publicUrls: ['zbowner/zbpublic'] });

test('L2: doubled-backslash profile path (JSON-escaped) is scrubbed', () => {
  const s = scrub(`clone failed: ${['C:', U, USER, 'dev', 'x'].join(BS + BS)} missing`);
  assert.doesNotMatch(s, new RegExp(USER));
  assert.match(s, /<path>/);
});

test('L2: a non-profile drive path naming a private project is scrubbed', () => {
  const s = scrub(`cannot read ${['D:', 'dev', PRIV, 'x.txt'].join(BS)}`);
  assert.doesNotMatch(s, new RegExp(PRIV));
});

test('L2: a path-encoded ~/.claude/projects dir is scrubbed', () => {
  const s = scrub(`dir ${['C-', U, USER, 'dev', PRIV].join('-')} gone`);
  assert.doesNotMatch(s, new RegExp(USER));
  assert.doesNotMatch(s, new RegExp(PRIV));
});

test('L2: the OS handle glued to _ - . is scrubbed; a longer word containing it is not', () => {
  const s = scrub(`host ${USER}_dev and ${USER}-laptop and ${USER}.local`);
  assert.doesNotMatch(s, new RegExp(USER));
  assert.equal(scrub(`${USER}xyz`), `${USER}xyz`);
});

test('L2: a private repo URL is scrubbed; a known-public one is kept', () => {
  const s = scrub('clone failed: https://github.com/zbowner/zbhidden.git and git@github.com:zbowner/zbhidden2.git');
  assert.doesNotMatch(s, /zbhidden/);
  assert.equal((s.match(/<repo-url>/g) || []).length, 2);
  const pub = scrub('swept https://github.com/zbowner/zbpublic.git fine');
  assert.match(pub, /zbowner\/zbpublic/);
});

test('L2: private derived names are scrubbed, including camelCase', () => {
  const s = scrub(`hit in ${PRIV} and ZorblSecretApi`);
  assert.doesNotMatch(s, /zorblsecret/i);
});

test('L2: POSIX, url-encoded and ~/dev paths are scrubbed', () => {
  for (const t of [
    `/ho${'me'}/${USER}/src/x`,
    `%2F${'home'}%2F${USER}%2Fdev`,
    `C%3A%5C${U}%5C${USER}`,
    `~/dev/${PRIV}`,
  ]) {
    const s = scrub(`at ${t} now`);
    assert.doesNotMatch(s, new RegExp(`${USER}|${PRIV}`), `${t} -> ${s}`);
  }
});

test('L2: ordinary signal text passes through unchanged', () => {
  const t = '3 spawns/24h; 1 premium; 0 with no explicit model';
  assert.equal(scrub(t), t);
});
