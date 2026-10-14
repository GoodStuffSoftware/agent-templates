import { PLUGIN_ROOT } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const read = (...p) => readFileSync(join(PLUGIN_ROOT, ...p), 'utf8');
const SKILL = read('skills', 'usage-analysis', 'SKILL.md');

test('usage-analysis skill: frontmatter, short listing description with its triggers, short body', () => {
  const m = SKILL.match(/^---\nname: usage-analysis\ndescription: (.+)\n---\n/);
  assert.ok(m, 'frontmatter with name and a one-line description');
  assert.ok(m[1].length <= 160 && m[1].length >= 80, `description is ${m[1].length} chars`);
  for (const t of ['analyze yesterday', 'compare today with', 'add a scenario', 'explain this result']) assert.ok(m[1].includes(t), t);
  assert.match(m[1], /\bUse\b/);
  assert.ok(SKILL.length < 6000, `skill body is ${SKILL.length} chars`);
});

test('usage-analysis skill: names the three layers, the project namespace, zero cost and the rater release', () => {
  for (const s of ['Shipped', 'User', 'Project', 'project:<label>/', 'u.<name>', 'zero model calls', '0.31.19']) assert.ok(SKILL.includes(s), s);
});

test('usage-analysis skill: only drives commands the CLI has', () => {
  const cli = readFileSync(join(PLUGIN_ROOT, 'scripts', 'usage-analysis.mjs'), 'utf8');
  const cfgCli = readFileSync(join(PLUGIN_ROOT, 'scripts', 'usage-config.mjs'), 'utf8');
  for (const m of SKILL.matchAll(/usage-analysis\.mjs" (\w+)/g)) assert.ok(['run', 'status', 'report', 'init'].includes(m[1]), m[1]);
  for (const m of SKILL.matchAll(/usage-config\.mjs" (\w+)/g)) assert.ok(['check', 'explain', 'list'].includes(m[1]), m[1]);
  assert.ok(cli.includes("'init'") && cfgCli.includes("'explain'"));
});

test('the docs page exists, is linked from the README and the skill, and its relative links resolve', () => {
  const page = join(PLUGIN_ROOT, 'docs', 'USAGE-ANALYSIS.md');
  assert.ok(existsSync(page));
  const readme = read('README.md');
  assert.match(readme, /\| `usage-analysis` \| `\/ac usage` \|/, 'README skills table row');
  assert.ok(readme.includes('docs/USAGE-ANALYSIS.md'));
  assert.ok(SKILL.includes('docs/USAGE-ANALYSIS.md'));
  const text = readFileSync(page, 'utf8');
  for (const m of text.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)) assert.ok(existsSync(resolve(dirname(page), m[1])), `broken link ${m[1]}`);
  for (const k of ['04:10', 'zero-token', 'usage-analysis.json', 'init --from-register']) assert.ok(text.includes(k), k);
});

test('README: the analysis needs no pin of its own (it runs inside the scout)', () => {
  const readme = read('README.md');
  const at = readme.indexOf('### Routine pin rule');
  const para = readme.slice(at).split('\n\n').find((p) => p.includes('USAGE-ANALYSIS.md'));
  assert.ok(para && /04:10/.test(para) && /no pin or scheduled task of its own/.test(para), 'routine-pins paragraph');
});

test('routines: every routines/*.md carries a frontmatter model: line (known gaps listed, and must shrink)', () => {
  // Calibration-scout-daily.md has no model: line today. The scheduler definition carries the pin (see
  // the Routine pin rule), and batch 7 edits this routine; delete the entry here when the line lands.
  const KNOWN_UNPINNED = [];
  const dir = join(PLUGIN_ROOT, 'routines');
  const missing = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const fm = readFileSync(join(dir, f), 'utf8').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fm, `${f}: no frontmatter`);
    if (!/^model:\s*\S+/m.test(fm[1])) missing.push(f);
  }
  assert.deepEqual(missing.filter((f) => !KNOWN_UNPINNED.includes(f)), [], 'routine without a model: line');
  const fixed = KNOWN_UNPINNED.filter((f) => !missing.includes(f));
  assert.deepEqual(fixed, [], `now pinned, remove from KNOWN_UNPINNED: ${fixed.join(', ')}`);
});

test('the /ac forwarder routes `usage` to the usage-analysis skill, with the CLI as fallback', () => {
  const shim = readFileSync(join(PLUGIN_ROOT, 'shims', 'ac', 'SKILL.md'), 'utf8');
  assert.match(shim, /\| `usage <args>` \| `agent-companion:usage-analysis` \| `node "\$AC\/scripts\/usage-analysis\.mjs" <args>` \|/);
  assert.ok(existsSync(join(PLUGIN_ROOT, 'skills', 'usage-analysis', 'SKILL.md')));
});
