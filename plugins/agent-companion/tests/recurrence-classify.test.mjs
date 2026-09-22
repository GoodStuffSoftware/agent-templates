// Tests for scripts/lib/recurrence-classify.mjs — the guard/harness/
// environment/unknown classifier and its guard-marker harvester.
//
// Deliberately isolated from recurrence.test.mjs: these tests exercise the
// classifier's exported functions directly against SYNTHETIC fixture hook
// files, never the plugin's own real hook wording — coupling a test to the
// exact current text of a real deny() message would make it brittle to a
// wording change that is not itself a regression (see
// recurrence-classify.mjs's own module banner on why guard markers are
// harvested rather than hardcoded).
//
// No test touches the real ~/.claude.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  harvestGuardMarkers, classifyText, classifyRows, sortForDisplay,
} from '../scripts/lib/recurrence-classify.mjs';

function row(sig, sample, sessions = 3) {
  return {
    sig, sample, sessions, projects: 1, hits: sessions, first: '2026-09-01', last: '2026-09-02',
  };
}

// --- harvestGuardMarkers ----------------------------------------------------

test('harvestGuardMarkers: extracts deny() literal text, splits template interpolation, drops short segments', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const hooksDir = join(dir, 'fixture-hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'sample-guard.mjs'), [
      "const deny = (reason) => process.stdout.write(reason);",
      "function run(streak) {",
      "  deny(",
      "    `Fixture guard: that is ${streak} calls in a row on the MAIN thread. ` +",
      "    'Spawn a subagent instead.'",
      "  );",
      "  deny('ok');", // too short — must be dropped
      "}",
    ].join('\n'));

    const { markers, filesScanned, callsFound } = harvestGuardMarkers([hooksDir]);
    assert.equal(filesScanned, 1);
    assert.equal(callsFound, 2);
    assert.ok(markers.some((m) => m.includes('fixture guard: that is')), JSON.stringify(markers));
    assert.ok(markers.some((m) => m.includes('spawn a subagent instead')), JSON.stringify(markers));
    assert.ok(!markers.includes('ok'), `short literal must be dropped: ${JSON.stringify(markers)}`);
    // The template's ${streak} placeholder itself must never become part of
    // a marker — it can never match a real number in real transcript text.
    assert.ok(!markers.some((m) => m.includes('${streak}')), JSON.stringify(markers));
  } finally {
    cleanup();
  }
});

test('harvestGuardMarkers: a marker longer than recurrence.mjs\'s 130-char sample truncation is capped, not dropped or left unmatchable', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const hooksDir = join(dir, 'fixture-hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Reproduces a real bug found running --init against a real corpus: a
    // ~185-char guard message (command-guard.mjs's --no-verify denial) was
    // present verbatim in a recurring row's transcript text, but recurrence.
    // mjs's own `sample` field is `m[0]...slice(0, 130)` — the marker's tail
    // never survives truncation, so an unbounded marker can never be found
    // as a substring of the row it genuinely came from.
    const longMessage = "'This fixture message is deliberately long: it repeats itself so that it comfortably exceeds one hundred characters of literal text, well past the truncation point.'";
    assert.ok(longMessage.length - 2 > 130, 'fixture message must actually exceed the 130-char sample width to test anything');
    writeFileSync(join(hooksDir, 'long-guard.mjs'), [
      'function run() {',
      `  deny(${longMessage});`,
      '}',
    ].join('\n'));

    const { markers } = harvestGuardMarkers([hooksDir]);
    const marker = markers.find((m) => m.startsWith('this fixture message is deliberately long'));
    assert.ok(marker, `expected a marker starting with the fixture text: ${JSON.stringify(markers)}`);
    assert.ok(marker.length <= 100, `marker must be capped well under the 130-char sample width, got ${marker.length}: ${JSON.stringify(marker)}`);

    // Simulate recurrence.mjs's own sample truncation: "Error: " (7 chars)
    // + up to 130 total. A row genuinely containing this message must still
    // classify as guard once truncated the same way real rows are.
    const simulatedSample = `Error: ${longMessage.slice(1, -1)}`.slice(0, 130);
    assert.equal(classifyText(simulatedSample, markers), 'guard', `truncated sample must still match: ${JSON.stringify(simulatedSample)}`);
  } finally {
    cleanup();
  }
});

test('harvestGuardMarkers: a deny() call with inline backtick code does not close early on its internal parens', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const hooksDir = join(dir, 'fixture-hooks');
    mkdirSync(hooksDir, { recursive: true });
    // Mirrors the real command-guard.mjs shape: a single-quoted string whose
    // TEXT contains backtick-quoted inline code with its own parens —
    // `git push origin <ref>`), which a naive "find the next )" scan would
    // treat as the call's closing paren.
    writeFileSync(join(hooksDir, 'sample-guard2.mjs'), [
      "function run() {",
      "  deny(",
      "    'DESTRUCTIVE FIXTURE (backup rule): run ' +",
      "    '(`git branch backup-ref` + `git push origin <ref>`), then retry.'",
      "  );",
      "}",
    ].join('\n'));

    const { markers } = harvestGuardMarkers([hooksDir]);
    assert.ok(markers.some((m) => m.includes('destructive fixture (backup rule): run')), JSON.stringify(markers));
    assert.ok(markers.some((m) => m.includes('git push origin <ref>')), JSON.stringify(markers));
  } finally {
    cleanup();
  }
});

test('harvestGuardMarkers: fails open on a missing directory and ignores non-.mjs files', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const result = harvestGuardMarkers([join(dir, 'does-not-exist')]);
    assert.deepEqual(result.markers, []);
    assert.equal(result.filesScanned, 0);
  } finally {
    cleanup();
  }
});

// --- classifyText / classifyRows -------------------------------------------

test('classifyText: a guard marker match wins over everything else', () => {
  const markers = ['fixture guard: that is'];
  // Also errno-shaped, which alone would be `environment` — guard wins.
  const text = 'Fixture guard: that is 4 calls in a row (ENOENT along the way)';
  assert.equal(classifyText(text, markers), 'guard');
});

test('classifyText: harness tool-layer errors classify as harness, not environment', () => {
  assert.equal(classifyText('File has not been read yet. Read it first.', []), 'harness');
  assert.equal(classifyText('String to replace not found in file.', []), 'harness');
  assert.equal(classifyText('File content (30000 tokens) exceeds maximum allowed tokens (25000).', []), 'harness');
  assert.equal(classifyText('ripgrep search timed out after 10000ms', []), 'harness');
});

test('classifyText: real external failures classify as environment', () => {
  assert.equal(classifyText("Error: ENOENT: no such file or directory, open '/a/b'", []), 'environment');
  assert.equal(classifyText('fatal: not a valid object name: main', []), 'environment');
  assert.equal(classifyText("'foo' is not recognized as an internal or external command", []), 'environment');
  assert.equal(classifyText('bash: foo: command not found', []), 'environment');
  assert.equal(classifyText('EACCES: permission denied, open \'/etc/shadow\'', []), 'environment');
  assert.equal(classifyText('Error: Cannot find module \'left-pad\'', []), 'environment');
});

test('classifyText: a generic wrapper with no specific shape stays unknown, not environment', () => {
  // Deliberately generic — no errno, no shell wording, no git fatal: — this
  // is exactly the case recurrence-classify.mjs's module banner says must
  // fail toward `unknown`, not get guessed into `environment`.
  assert.equal(classifyText('Error: something went wrong', []), 'unknown');
  assert.equal(classifyText('exit code 1', []), 'unknown');
});

test('classifyRows: counts every class and attaches .class per row', () => {
  const rows = [
    row('s1', 'fatal: not a valid object name: main'),
    row('s2', 'File has not been read yet.'),
    row('s3', 'Fixture guard: denied this call'),
    row('s4', 'Error: something went wrong'),
  ];
  const { rows: out, counts } = classifyRows(rows, ['fixture guard: denied']);
  assert.deepEqual(out.map((r) => r.class), ['environment', 'harness', 'guard', 'unknown']);
  assert.deepEqual(counts, {
    guard: 1, harness: 1, environment: 1, unknown: 1,
  });
});

test('sortForDisplay: environment first, then unknown, then harness, then guard — sessions desc within a class', () => {
  const rows = [
    { ...row('g', 'x', 5), class: 'guard' },
    { ...row('e-low', 'x', 3), class: 'environment' },
    { ...row('h', 'x', 9), class: 'harness' },
    { ...row('e-high', 'x', 8), class: 'environment' },
    { ...row('u', 'x', 4), class: 'unknown' },
  ];
  const sorted = sortForDisplay(rows).map((r) => r.sig);
  assert.deepEqual(sorted, ['e-high', 'e-low', 'u', 'h', 'g']);
});
