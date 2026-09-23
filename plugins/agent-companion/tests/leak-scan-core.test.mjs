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
import {
  deriveTokens, compileDerived, scanText, isPlaceholderSegment, PLACEHOLDER_USERS, exactNameKey,
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
