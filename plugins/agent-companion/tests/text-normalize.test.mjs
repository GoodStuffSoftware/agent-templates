// Tests for hooks/lib/text-normalize.mjs — the one shared failure-text
// normalizer used by both scripts/recurrence.mjs (signature()) and
// hooks/gotcha-retrieval.mjs (normalizeErrorText()). See
// docs/adr/0002-stack-scoped-gotcha-retrieval.md, Decision part 3.
//
// No filesystem, no ~/.claude — pure functions only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripNoisePrefixes, repairMojibake, normalizeErrorText,
} from '../hooks/lib/text-normalize.mjs';

// --- stripNoisePrefixes ----------------------------------------------------

test('stripNoisePrefixes: strips Error:/ENOENT:/fatal: style prefixes, including stacked ones', () => {
  assert.equal(stripNoisePrefixes('Error: ENOENT: no such file'), 'no such file');
  assert.equal(stripNoisePrefixes('ENOENT: no such file'), 'no such file');
  assert.equal(stripNoisePrefixes('fatal: not a valid object name'), 'not a valid object name');
  assert.equal(stripNoisePrefixes('no such file'), 'no such file');
});

test('stripNoisePrefixes: never eats a real error CLASS off a message', () => {
  const te = stripNoisePrefixes('TypeError: Cannot read properties of undefined');
  const se = stripNoisePrefixes('SyntaxError: Cannot read properties of undefined');
  assert.notEqual(te, se);
  assert.ok(te.startsWith('TypeError'));
});

// --- repairMojibake ----------------------------------------------------

// Real-world mojibake generator: encode as UTF-8, then decode those bytes
// as windows-1252 — the actual mechanism the ADR names (a UTF-8 byte
// sequence mis-decoded through a single-byte codepage).
const CP1252_C1 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
function asCp1252Mojibake(str) {
  const bytes = Buffer.from(str, 'utf8');
  let out = '';
  for (const b of bytes) out += String.fromCodePoint(CP1252_C1[b] ?? b);
  return out;
}

test('repairMojibake: recovers the ADR\'s own named example — an em dash mangled through a single-byte codepage', () => {
  const clean = 'a note — like this';
  const mojibake = asCp1252Mojibake(clean);
  assert.notEqual(mojibake, clean, 'fixture must actually be damaged, or this proves nothing');
  assert.equal(repairMojibake(mojibake), clean);
});

test('repairMojibake: plain ASCII is returned unchanged (the common case for tool_error text)', () => {
  const ascii = 'command failed with exit code 1, see stderr above for details';
  assert.equal(repairMojibake(ascii), ascii);
});

test('repairMojibake: a single legitimate accented character is left alone, not "repaired" into something else', () => {
  const name = 'café';
  assert.equal(repairMojibake(name), name);
});

test('repairMojibake: never throws and never introduces a replacement character on arbitrary input', () => {
  for (const input of ['', null, undefined, 'â€', '� already broken', 'â']) {
    const out = repairMojibake(input);
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes('�') || String(input).includes('�'), `must not manufacture a replacement char from: ${JSON.stringify(input)}`);
  }
});

// --- normalizeErrorText: the one normalizer, end to end --------------------

test('normalizeErrorText: collapses whitespace, strips a noise prefix, and repairs mojibake together', () => {
  const mojibakeDash = asCp1252Mojibake('a note — like this');
  const out = normalizeErrorText(`Error:   ENOENT:  \n  ${mojibakeDash}   trailing`);
  assert.equal(out, 'a note — like this   trailing'.replace(/\s+/g, ' ').trim());
});

test('normalizeErrorText: is idempotent — normalizing an already-normalized string changes nothing', () => {
  const once = normalizeErrorText('Error: ENOENT:   no such file or directory');
  const twice = normalizeErrorText(once);
  assert.equal(once, twice);
});
