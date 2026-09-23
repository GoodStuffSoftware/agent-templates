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

// --- third adversarial review: N1 (repo:file:line eaten), N2 (userinfo, scheme-less, bare pairs) ---

const scrubMy = makeScrubber({ users: [USER], names: [PRIV], publicUrls: ['https://github.com/myorg/zbpublic', 'myorg/zbpublic'] });

test('N1: a public repo URL glued to :file:line keeps repo, file and line (the URL stops at ":")', () => {
  assert.equal(scrubMy('https://github.com/myorg/zbpublic:README.md:3 [x]'), 'https://github.com/myorg/zbpublic:README.md:3 [x]');
  assert.equal(scrubMy('https://github.com/myorg/zbhidden:README.md:3 [x]'), '<repo-url>:README.md:3 [x]');
});

test('N1: the detect.mjs sample shape "<repo> — <rel>:<line> [label]" survives scrubbing for a public repo', () => {
  const t = 'https://github.com/myorg/zbpublic — README.md:3 [private-path:windows-profile]; https://github.com/myorg/zbpublic — docs/guide.md:12 [y]';
  assert.equal(scrubMy(t), t);
});

test('N2: userinfo is always stripped — token@ on a known-public https URL', () => {
  const s = scrubMy('clone https://ghp_zbfaketoken@github.com/myorg/zbpublic.git');
  assert.doesNotMatch(s, /ghp_zbfaketoken/);
  assert.equal(s, 'clone https://github.com/myorg/zbpublic.git');
});

test('N2: userinfo is always stripped — user:token@ on a known-public https URL', () => {
  const s = scrubMy('https://x-oauth-basic:ghp_zbfaketoken@github.com/myorg/zbpublic');
  assert.equal(s, 'https://github.com/myorg/zbpublic');
});

test('N2: userinfo is always stripped — scheme-less user:token@github.com/o/r (public kept, private scrubbed)', () => {
  assert.equal(scrubMy('x-oauth-basic:ghp_zbfaketoken@github.com/myorg/zbpublic'), 'github.com/myorg/zbpublic');
  assert.equal(scrubMy('x-oauth-basic:ghp_zbfaketoken@github.com/myorg/privrepo'), '<repo-url>');
});

test('N2: userinfo is always stripped — scp form with a token user, and a private https URL with a token', () => {
  assert.equal(scrubMy('ghp_zbfaketoken@github.com:myorg/zbpublic.git'), 'git@github.com:myorg/zbpublic.git');
  const s = scrubMy("fatal: repository 'https://ghp_zbfaketoken@github.com/myorg/privrepo/' not found");
  assert.equal(s, "fatal: repository '<repo-url>' not found");
});

test('N2: userinfo is stripped on a non-git host too', () => {
  const s = scrubMy('ghp_zbfaketoken@gitea.example.org/myorg/privrepo');
  assert.doesNotMatch(s, /ghp_zbfaketoken|privrepo/);
});

test('N2: a bare owner/repo pair is scrubbed unless known public', () => {
  assert.equal(scrubMy('repository myorg/privrepo not found'), 'repository <repo> not found');
  assert.equal(scrubMy('repository myorg/zbpublic not found'), 'repository myorg/zbpublic not found');
});

test('N2: a scheme-less github.com/o/r is scrubbed unless known public', () => {
  assert.equal(scrubMy('remote github.com/myorg/privrepo'), 'remote <repo-url>');
  assert.equal(scrubMy('remote github.com:myorg/privrepo'), 'remote <repo-url>');
  assert.equal(scrubMy('remote github.com/myorg/zbpublic fine'), 'remote github.com/myorg/zbpublic fine');
});

test('N2: rates and file:line references are not mistaken for owner/repo pairs', () => {
  assert.equal(scrubMy('12 runs/7d; see docs/guide.md:4'), '12 runs/7d; see docs/guide.md:4');
});

// --- final review F2: bare GitHub tokens are redacted anywhere --------------

const FAKE20 = 'zbFAKE0123456789abcdefXY';
const GHP = ['gh', 'p_'].join('') + FAKE20;
const GHS = ['gh', 's_'].join('') + FAKE20;
const PAT = ['github', '_pat_'].join('') + `11${FAKE20}_zb${FAKE20}`;

test('F2: a bare classic GitHub token (ghp_/ghs_…) anywhere in text becomes <token>', () => {
  assert.equal(scrubMy(`GH_TOKEN=${GHP} failed`), 'GH_TOKEN=<token> failed');
  assert.equal(scrubMy(`auth: ${GHS}`), 'auth: <token>');
});

test('F2: a bare fine-grained github_pat_ token becomes <token>', () => {
  assert.equal(scrubMy(`token ${PAT} rejected`), 'token <token> rejected');
});

test('F2: a token used as URL userinfo is still dropped with the URL handling intact', () => {
  assert.equal(scrubMy(`https://${GHP}@github.com/myorg/privrepo`), '<repo-url>');
  assert.equal(scrubMy(`https://${GHP}@github.com/myorg/zbpublic`), 'https://github.com/myorg/zbpublic');
  assert.equal(scrubMy(`x-access-token:${PAT}@github.com/myorg/privrepo`), '<repo-url>');
});

test('F2: short gh_-looking words are not tokens', () => {
  assert.equal(scrubMy('ghp_short and gho_ and github_pat_x'), 'ghp_short and gho_ and github_pat_x');
});
