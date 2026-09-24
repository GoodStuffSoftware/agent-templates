// ADR 0003 §2: "Nothing else reads taskTypes.*.override ... and a test greps
// for any other reader." resolveRoute() in hooks/lib/context.mjs is the one
// place a shipped trial is read, so it is floored and explained the same way
// everywhere. This greps the plugin's own source (everything but tests/) for
// property reads of `override` and fails on any outside resolveRoute().
//
// A config-validation TEST reading the raw data is not routing and is out of
// scope. Prose in comments is ignored; code that merely mentions the word
// (e.g. "no override: expected" in a catch comment) does not match, because
// the detector looks for a property READ, not the word.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';

const SKIP_DIRS = new Set(['tests', 'node_modules', '.git']);
const CODE = /\.(mjs|cjs|js)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, out); } else if (CODE.test(name)) out.push(p);
  }
  return out;
}

// Code with comments removed: full-line // and * comment lines, block
// comments, and trailing `  // ...` (a `//` preceded by whitespace, so a URL
// inside a string is kept).
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(\/\/|\*)/.test(l) ? '' : l.replace(/\s\/\/.*$/, '')));
}

// A property read of `override`: t.override, t?.override, t['override'],
// or destructuring `{ override }` / `{ ..., override: x }`.
const READER = /(\?\.|\.)\s*override\b|\[\s*['"`]override['"`]\s*\]|\{[^}]*\boverride\b[^}]*\}\s*=/;

export function overrideReaders(text) {
  const hits = [];
  codeOnly(text).forEach((l, i) => { if (READER.test(l)) hits.push({ line: i + 1, text: l.trim() }); });
  return hits;
}

test('the detector itself catches every read shape and ignores prose', () => {
  for (const s of ['const ov = t.override;', 'x = t?.override', "y = t['override']", 'const { override } = t;', 'const { weight, override: ov } = t;']) {
    assert.equal(overrideReaders(s).length, 1, s);
  }
  for (const s of ['// reads taskTypes.*.override', ' * t.override in a doc comment', "try {} catch { /* no override: expected */ }", 'const s = "an override applies";', 'x = 1; // t.override']) {
    assert.equal(overrideReaders(s).length, 0, s);
  }
});

test('nothing but resolveRoute() reads taskTypes.*.override', () => {
  const offenders = [];
  for (const file of walk(PLUGIN_ROOT)) {
    const rel = relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    let hits = overrideReaders(text);
    if (rel === 'hooks/lib/context.mjs') {
      // Allowed only inside resolveRoute()'s own body.
      const start = text.indexOf('export function resolveRoute(');
      assert.ok(start >= 0, 'resolveRoute() not found in context.mjs');
      const end = text.indexOf('\n}\n', start);
      const [a, b] = [text.slice(0, start).split('\n').length, text.slice(0, end).split('\n').length];
      assert.ok(hits.some((h) => h.line >= a && h.line <= b), 'resolveRoute() should itself be the reader');
      hits = hits.filter((h) => h.line < a || h.line > b);
    }
    for (const h of hits) offenders.push(`${rel}:${h.line}: ${h.text}`);
  }
  assert.deepEqual(offenders, [], 'read the trial through resolveRoute() (its stack carries the trial entry and metadata)');
});
