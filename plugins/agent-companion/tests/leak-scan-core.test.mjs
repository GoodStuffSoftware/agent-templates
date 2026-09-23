// Regression tests for the adversarial-review findings against
// leak-scan-core.mjs's detection classes. Each test reproduces the
// reviewer's failing input directly (pure functions — no git/clone needed).
//
// SELF-SCAN RULE (same as scripts/tests/leak-check.test.mjs): this file is
// itself scanned by the whole-repo leak-check, so every fixture string
// SHAPED like a leak is assembled from pieces at run time — never written
// as a contiguous literal that could itself look like a real leak.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveTokens, compileDerived, scanText, isPlaceholderSegment, PLACEHOLDER_USERS, exactNameKey,
  isUnsafeDevRoot, maskPlaceholders, scanRepo,
} from '../scripts/lib/leak-scan-core.mjs';

const FAKE_USER = ['zzz', 'realuser'].join('');
const BS = '\\';

function hitLabels(text, tokens, opts = {}) {
  const derived = compileDerived(tokens);
  return scanText(text, { rel: 'x.md', derived, ...opts }).hits;
}

// --- item 1: public-name subtraction must be EXACT, never by segment -------

test('item 1: publicNames subtracts an EXACT name match only, never a shared segment', () => {
  // "acme" (a segment) must NOT match "acme-web" (the whole public name) —
  // only the identical string does, and separators/case are normalized.
  assert.notEqual(exactNameKey('acme'), exactNameKey('acme-web'));
  assert.equal(exactNameKey('acme-web'), exactNameKey('acme_web'));
  assert.equal(exactNameKey('acme-web'), exactNameKey('Acme Web'));
});

test('item 1: a name IN publicNames (exact) is removed; a segment-only match survives', () => {
  const before = ['acme-web', 'acme', 'acme-secret-internal'];
  const exact = new Set(['acme-web', 'operator/acme-api'].map(exactNameKey));
  const after = before.filter((n) => !exact.has(exactNameKey(n)));
  assert.deepEqual(after, ['acme', 'acme-secret-internal'], 'only the EXACT public name is removed');
});

test('item 1: prefixes are NEVER filtered by publicNames, even when a public name shares the segment', () => {
  // Reproduces the reviewer's real finding: a real 3-letter private agent
  // prefix ("zb") must survive even though a public repo "zb-tools" exists
  // and shares the segment "zb".
  const tokens = { names: [], prefixes: ['zb'], users: [] };
  const hits = hitLabels('the `zb-builder` agent and files named `zb-*.md`', tokens, { strict: true });
  assert.ok(hits.some((h) => h.label === 'derived-prefix'), 'the private prefix must still fire regardless of any public name sharing "zb"');
});

// --- item 3: backslash must not be treated as a word character -------------

test('item 3: a derived name immediately after a single backslash still matches', () => {
  const tokens = { names: ['myproject'], prefixes: [], users: [] };
  const cases = [
    ['D:', BS, 'dev', BS, 'myproject', BS, 'x'].join(''),
    `"D:${BS}${BS}dev${BS}${BS}myproject"`, // "D:\\dev\\myproject" as it would appear in a JSON string
    ['C:', BS, 'src', BS, 'myproject'].join(''),
  ];
  for (const line of cases) {
    const hits = hitLabels(line, tokens);
    assert.ok(hits.some((h) => h.label === 'derived-project-name'), `expected a hit in: ${line}`);
  }
});

test('item 3: CORP\\<handle> (domain-qualified account) is caught by the path class', () => {
  const line = ['login as CORP', BS, FAKE_USER, ' please'].join('');
  const hits = scanText(line, {}).hits;
  assert.ok(hits.some((h) => h.label === 'private-path:domain-user'));
});

// --- item 5: prefix match catches bare/quoted/end forms + underscore/caps --

test('item 5: prefix matches standalone/quoted/backtick/end-of-line and ZB_ (underscore, uppercase)', () => {
  const tokens = { names: [], prefixes: ['zb'], users: [] };
  const cases = [
    'the agent prefix is `zb-`',
    'quoted: "zb-"',
    'trailing zb- ',
    'environment var ZB_TOKEN=1',
    'ZB_',
  ];
  for (const line of cases) {
    const hits = hitLabels(line, tokens);
    assert.ok(hits.some((h) => h.label === 'derived-prefix'), `expected derived-prefix in: ${JSON.stringify(line)}`);
  }
});

// --- item 10: universal path-class gaps -------------------------------------

test('item 10: WSL, UNC, URL-encoded, and lowercase-encoded path shapes are all caught', () => {
  const cases = [
    [['/mnt/c/Users/', FAKE_USER, '/dev/thing'].join(''), 'private-path:wsl-home'],
    [[BS, BS, 'corpshare', BS, 'c$', BS, 'Users', BS, FAKE_USER].join(''), 'private-path:unc'],
    [['C%3A%5CUsers%5C', FAKE_USER, '%5Cdev'].join(''), 'private-path:url-encoded'],
    [['path is %2FUsers%2F', FAKE_USER, '%2Fdev'].join(''), 'private-path:url-encoded'],
    [['~/.claude/projects/c--users-', FAKE_USER, '-dev-thing/memory'].join(''), 'private-path:encoded-claude-project'],
  ];
  for (const [line, label] of cases) {
    const hits = scanText(line, {}).hits;
    assert.ok(hits.some((h) => h.label === label), `expected ${label} in: ${line} — got ${JSON.stringify(hits)}`);
  }
});

test('item 10: a quadruple-escaped backslash Windows profile path still matches', () => {
  const b4 = BS + BS + BS + BS;
  const line = ['C:', b4, 'Users', b4, FAKE_USER, b4, 'dev'].join('');
  const hits = scanText(line, {}).hits;
  assert.ok(hits.some((h) => h.label === 'private-path:windows-profile'));
});

// --- item 11: placeholder exemption is identifier-shaped only --------------

test('item 11: {{UPPER_SNAKE}} is exempt, but a braced real path/derived-name is still scanned', () => {
  const tokens = { names: ['myproject'], prefixes: [], users: [] };
  const clean = hitLabels('the project is {{PROJECT_NAME}} and its dir is {{my-app}}', tokens);
  assert.deepEqual(clean, []);

  const bracedPath = ['the path is {{C:', BS, 'Users', BS, FAKE_USER, BS, 'dev}}'].join('');
  const stillFlagged1 = scanText(bracedPath, {}).hits;
  assert.ok(stillFlagged1.some((h) => h.label === 'private-path:windows-profile'), 'a braced real path must still be scanned');

  const stillFlagged2 = hitLabels('this is {{myproject}} the real name', tokens);
  assert.ok(stillFlagged2.some((h) => h.label === 'derived-project-name'), 'a braced derived name must still be scanned');
});

// --- item 12: cluster/joined/camelCase name forms ---------------------------

test('item 12: a multi-segment derived name matches its joined and camelCase forms', () => {
  const tokens = { names: ['zorbl-api'], prefixes: [], users: [] };
  for (const line of ['see zorblapi docs', 'the ZorblApi client', 'Zorbl-Api works too']) {
    const hits = hitLabels(line, tokens);
    assert.ok(hits.some((h) => h.label === 'derived-project-name'), `expected a hit in: ${line}`);
  }
});

// --- item 17: a real OS handle that looks generic is still caught in paths -

test('item 17: a real handle in the placeholder-user list is still caught in a Users path, but not as a bare word', () => {
  const realUsers = new Set(['admin']); // a real OS username that happens to be a generic word
  assert.equal(isPlaceholderSegment('admin', PLACEHOLDER_USERS), true, 'without realUsers, "admin" is a placeholder as before');
  assert.equal(isPlaceholderSegment('admin', PLACEHOLDER_USERS, realUsers), false, 'with realUsers, the REAL handle is never a placeholder');

  const line = ['C:', BS, 'Users', BS, 'admin', BS, 'dev', BS, 'thing'].join('');
  const hits = scanText(line, { realUsers }).hits;
  assert.ok(hits.some((h) => h.label === 'private-path:windows-profile'), 'the real handle must be caught in a private path');
});

// ===========================================================================
// Second adversarial review (H1-H4, M1, L3). Each test carries the
// reviewer's failing input. scripts/tests/leak-check-parity.test.mjs feeds
// the same inputs to BOTH copies (this module and scripts/leak-check.mjs).
// ===========================================================================

function devRootWith(dirs) {
  const d = mkdtempSync(join(tmpdir(), 'lsc-h-'));
  for (const n of dirs) mkdirSync(join(d, n), { recursive: true });
  return d;
}
const derivedHits = (text, tokens) => scanText(text, { rel: 'x.md', derived: compileDerived(tokens) }).hits
  .filter((h) => h.label.startsWith('derived-'));

test('H1: public `zorbl` + private `zorbl-internal` — the private name survives public subtraction', () => {
  const dev = devRootWith(['zorbl', 'zorbl-internal']);
  try {
    const t = deriveTokens({ devRoots: [dev], publicNames: ['zorbl'] });
    const names = t.names.map((n) => n.toLowerCase());
    assert.ok(!names.includes('zorbl'), 'the public name itself is subtracted');
    assert.ok(names.includes('zorbl-internal'), 'the private extension is NOT dropped with it');
    const hits = derivedHits('ported from zorbl-internal yesterday; zorbl is public', t);
    assert.deepEqual(hits.map((h) => h.token.toLowerCase()), ['zorbl-internal']);
  } finally { rmSync(dev, { recursive: true, force: true }); }
});

test('H1: a cluster root that is exactly public is not a token, but its private children still are', () => {
  const dev = devRootWith(['zorbl-api', 'zorbl-web']);
  try {
    const t = deriveTokens({ devRoots: [dev], publicNames: ['zorbl'] });
    assert.deepEqual(t.names.map((n) => n.toLowerCase()).sort(), ['zorbl-api', 'zorbl-web']);
  } finally { rmSync(dev, { recursive: true, force: true }); }
});

test('H2: camelCase continuations match (ZorblApi, FrobnicatorService); a lowercase suffix does not (Zorbls)', () => {
  const tokens = { names: ['zorbl', 'frobnicator'], prefixes: [], users: [] };
  for (const line of ['the ZorblApi client', 'class FrobnicatorService {}', 'ZORBL_API', 'zorbl.web']) {
    assert.ok(derivedHits(line, tokens).length > 0, `expected a hit in: ${line}`);
  }
  for (const line of ['three Zorbls walked in', 'zorblxyz', 'frobnicators']) {
    assert.deepEqual(derivedHits(line, tokens), [], `expected no hit in: ${line}`);
  }
});

test('H2: a joined lowercase compound matches only when it is a derived multi-segment name joined', () => {
  // zorbl-api + zorbl-web cluster into "zorbl"; both are collapsed under it,
  // so each joined form ("zorblapi") needs its own matcher.
  const dev = devRootWith(['zorbl-api', 'zorbl-web']);
  try {
    const t = deriveTokens({ devRoots: [dev] });
    assert.deepEqual(t.names.map((n) => n.toLowerCase()), ['zorbl']);
    assert.equal(t.joined.length, 2);
    assert.equal(derivedHits('see zorblapi docs', t).length, 1, 'joined derived name matches');
    assert.equal(derivedHits('see zorblweb docs', t).length, 1, 'joined derived name matches');
    assert.equal(derivedHits('the ZorblApi client', t).length, 1, 'camelCase: exactly one hit (the cluster root), no duplicate');
    assert.deepEqual(derivedHits('see zorblxyz and Zorbls', t), [], 'an arbitrary suffix is not a derived name');
  } finally { rmSync(dev, { recursive: true, force: true }); }
});

test('H3: a TitleCase or UPPER placeholder whose text IS a derived token is not masked', () => {
  const tokens = { names: ['frobnicator', 'zorbl'], prefixes: ['zb'], users: ['qzhandle'] };
  for (const [line, want] of [
    ['see {{Frobnicator}} here', 'derived-project-name'],
    ['see {{ZORBL}} here', 'derived-project-name'],
    ['see {{ZORBL_API}} here', 'derived-project-name'],
    ['see {{ZB_TOKEN}} here', 'derived-prefix'],
    ['see {{QZHANDLE}} here', 'derived-user-handle'],
  ]) {
    const hits = derivedHits(line, tokens);
    assert.ok(hits.some((h) => h.label === want), `expected ${want} in: ${line} — got ${JSON.stringify(hits)}`);
  }
  // A genuine placeholder is still exempt, and masking is column-stable.
  assert.deepEqual(derivedHits('the project is {{PROJECT_NAME}} by {{OwnerName}}', tokens), []);
  const derived = compileDerived(tokens);
  assert.equal(maskPlaceholders('a {{PROJECT_NAME}} b', derived), `a ${' '.repeat(16)} b`);
  assert.equal(maskPlaceholders('a {{Frobnicator}} b', derived), 'a {{Frobnicator}} b');
});

test('H4: realUsers comes from the RAW handle — a generic-looking handle (Admin) fires in paths, never as a bare word', () => {
  const t = deriveTokens({ users: ['Admin'] });
  assert.deepEqual(t.users, [], 'no bare-word token for a placeholder-looking handle');
  assert.deepEqual(t.realUsers, ['admin'], 'but it IS a real handle for the path classes');
  const pathLine = ['C:', 'Users', 'Admin', 'x'].join(BS);
  const r = scanText(`open ${pathLine} and ask the admin`, { derived: compileDerived(t), realUsers: new Set(t.realUsers) });
  assert.ok(r.hits.some((h) => h.label === 'private-path:windows-profile'), JSON.stringify(r.hits));
  assert.ok(!r.hits.some((h) => h.label === 'derived-user-handle'));
});

test('H4: scanRepo builds realUsers from the raw users option, even under noDerived', () => {
  const root = mkdtempSync(join(tmpdir(), 'lsc-h4-'));
  try {
    writeFileSync(join(root, 'a.md'), `${['C:', 'Users', 'Dev', 'thing'].join(BS)}\n`);
    const r = scanRepo({ root, devRoots: [], users: ['Dev'], noDerived: true });
    assert.ok(r.hits.some((h) => h.label === 'private-path:windows-profile'), JSON.stringify(r.hits));
    const other = scanRepo({ root, devRoots: [], users: ['qzhandle'], noDerived: true });
    assert.ok(!other.hits.some((h) => h.label === 'private-path:windows-profile'), 'a generic segment that is NOT the real handle stays a placeholder');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The reviewer's 13 M1 cases, with prefix "bqq".
const M1_CAUGHT = [
  ['D:', 'dev', 'bqq-tool'].join(BS),
  ['D:', 'bqq-tool'].join(BS),
  `"${['D:', 'dev', 'bqq-x'].join(BS + BS)}"`,
  ['D:', 'dev', 'bqq-x'].join(BS + BS + BS + BS),
  ['CORP', 'bqq-svc'].join(BS),
  'plain bqq-writer',
];
const M1_NOT_FIRING = [
  `/${BS}bqq-/`,
  `(?:${BS}bqq-)`,
  `"${BS}${BS}bqq-"`,
  `[${BS}bqq-]`,
  `a|${BS}bqq-`,
];
const M1_ACCEPTED_MISSES = [
  `"${BS}nbqq-"`,
  `${BS}${BS}bqq-host${BS}share`,
];

test('M1: a backslash is a boundary only after a path segment or drive letter (13 reviewer cases)', () => {
  const tokens = { names: [], prefixes: ['bqq'], users: [] };
  for (const line of M1_CAUGHT) assert.equal(derivedHits(line, tokens).length, 1, `must be caught: ${line}`);
  for (const line of M1_NOT_FIRING) assert.deepEqual(derivedHits(line, tokens), [], `regex/string escape must not fire: ${line}`);
  for (const line of M1_ACCEPTED_MISSES) assert.deepEqual(derivedHits(line, tokens), [], `documented accepted miss: ${line}`);
});

test('M1: an API-key regex literal (/\\b<prefix>-.../) no longer reads as a derived-prefix hit', () => {
  // Synthetic prefix "bqq": the shape is `\b` glued to a key literal starting "qq-".
  const tokens = { names: [], prefixes: ['bqq'], users: [] };
  assert.deepEqual(derivedHits(`  ['some-api-key', /${BS}bqq-[A-Za-z0-9]{20,}${BS}b/],`, tokens), []);
});

test('L3: %2Fhome%2F<user> is caught by the url-encoded path class', () => {
  const hits = scanText(['path=%2Fhome%2F', FAKE_USER, '%2Fdev'].join(''), {}).hits;
  assert.ok(hits.some((h) => h.label === 'private-path:url-encoded'), JSON.stringify(hits));
  assert.deepEqual(scanText(['path=%2Fhome%2F', 'user', '%2Fdev'].join(''), {}).hits, [], 'a placeholder user stays exempt');
});

test('L3: a temp/system/home/root dir is never a DEFAULT dev root', () => {
  const home = mkdtempSync(join(tmpdir(), 'lsc-home-'));
  try {
    assert.equal(isUnsafeDevRoot(tmpdir(), home), true, 'the temp dir itself');
    assert.equal(isUnsafeDevRoot(join(tmpdir(), 'anything'), home), true, 'anything inside temp');
    assert.equal(isUnsafeDevRoot(home, home), true, 'the home dir');
    assert.equal(isUnsafeDevRoot(process.platform === 'win32' ? 'C:\\' : '/', '/nonexistent-home'), true, 'a filesystem root');
  } finally { rmSync(home, { recursive: true, force: true }); }
  const outside = process.platform === 'win32' ? 'Q:\\zb-projects' : '/opt/zb-projects';
  assert.equal(isUnsafeDevRoot(outside, '/nonexistent-home'), false, 'an ordinary dir outside temp is fine');
});
