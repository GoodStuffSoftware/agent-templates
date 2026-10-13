// Review of 0.31.17, part 2 of 2 (everything except hooks/): tests that FAIL on the review baseline
// and pass once the defect named in each title is fixed. Not part of the release;
// the reviewer left it uncommitted. Findings: the 0.31.17 rest review (kept outside the repo)
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const readPlugin = (rel) => readFileSync(join(PLUGIN_ROOT, rel), 'utf8');

// ---------------------------------------------------------------------------
// F1  README "Task type aliases" still lists `research` as an alias of explore and says "ten".
test('F1: the README alias paragraph lists exactly the taskTypeAliases in config/model-tiers.json', () => {
  const cfg = JSON.parse(readPlugin('config/model-tiers.json'));
  const para = /### Task type aliases\r?\n([\s\S]*?)\r?\n## /.exec(readPlugin('README.md'));
  assert.ok(para, 'README has a "Task type aliases" section');
  const list = /defaults:\s*(.*?)\.\s+They live under/s.exec(para[1]);
  assert.ok(list, 'the paragraph lists the defaults');
  const documented = {};
  for (const seg of list[1].split(';')) {
    const [lhs, rhs] = seg.split('->');
    const target = /`([^`]+)`/.exec(rhs)[1];
    for (const m of lhs.matchAll(/`([^`]+)`/g)) documented[m[1]] = target;
  }
  assert.deepEqual(documented, cfg.taskTypeAliases);
});

test('F1b: the README alias paragraph states the real number of default aliases', () => {
  const cfg = JSON.parse(readPlugin('config/model-tiers.json'));
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const m = /The (\w+) defaults:/.exec(readPlugin('README.md'));
  assert.ok(m, 'README states "The <n> defaults"');
  assert.equal(words[m[1].toLowerCase()], Object.keys(cfg.taskTypeAliases).length);
});

// ---------------------------------------------------------------------------
// F2  docs/TELEMETRY.md: the two rows added in 0.31.17 have an unescaped "|" in "string | null",
//     so each has 4 cells under a 3-column header and the description cell is dropped when rendered.
const unescapedCells = (line) => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  let n = 1;
  for (let i = 0; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '|') n++; }
  return n;
};
test('F2: the new review-verdict rows in docs/TELEMETRY.md have as many cells as their table header', () => {
  const lines = readPlugin('docs/TELEMETRY.md').split(/\r?\n/);
  const rows = lines.map((l, i) => [l, i]).filter(([l]) => /^\| `review(ed|er)_model`/.test(l));
  assert.equal(rows.length, 2, 'the reviewed_model and reviewer_model rows exist');
  for (const [row, i] of rows) {
    let j = i;
    while (j > 0 && !/^\|[\s:|-]+\|\s*$/.test(lines[j])) j--; // the separator row above
    const header = lines[j - 1];
    assert.equal(unescapedCells(row), unescapedCells(header), `line ${i + 1}: ${row.slice(0, 60)}`);
  }
});

// ---------------------------------------------------------------------------
// F3  The new reviewer tier-minEffort floor (hooks/lib/context.mjs parityFloors) keys on the tier ALIAS,
//     so a legacy `claude-haiku-4-5` writer (a reference model that takes no effort parameter, and whose
//     "set effort" note 0.31.17 itself removed) gets a reviewer on `claude-haiku-4-5` with effort `medium`.
//     On origin/main the same call returns no effort.
test('F3: a legacy claude-haiku-4-5 writer gets a reviewer with no effort (the model takes none)', async () => {
  const ctx = await import('../hooks/lib/context.mjs');
  assert.deepEqual(ctx.classifyReferenceModel('claude-haiku-4-5').efforts, [], 'premise: the reference table says it takes no effort');
  for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
    const r = ctx.resolveRoute({ type: 'code-review', writer: { model, effort: '' }, profile: false, now: new Date('2026-10-13T12:00:00Z') });
    assert.equal(r.model, model);
    assert.equal(r.effort || '', '', `${model} reviewer must not be given an effort it does not take`);
  }
});

// ---------------------------------------------------------------------------
// F4  routineModelDrift compares every run in the last 48 h with the CURRENT SKILL.md `model:` line.
//     Fix the pin and the runs that predate the fix are still reported (severity high) until they age out.
//     Seen live on 2026-10-13: both scout SKILL.md files were set to `model: sonnet` at 15:43 -0400 and
//     the next scout run reported four "drift" rows, all from runs before 15:43.
test('F4: a run that predates the task\'s current model: line is not drift; one after it still is', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { routineModelDrift } = await import('../scripts/lib/routine-model-drift.mjs');
    const sessions = join(dir, 'sessions');
    const claudeDir = join(dir, '.claude');
    const skill = join(claudeDir, 'scheduled-tasks', 'scout', 'SKILL.md');
    write(skill, '---\nname: scout\ndescription: d\nmodel: opus\n---\nBody\n');
    const now = Date.now();
    const pinnedAt = new Date(now - 3600 * 1000);
    utimesSync(skill, pinnedAt, pinnedAt); // the pin was added one hour ago
    const rec = (id, ageMs) => write(join(sessions, 'acct', 'org', `local_${id}-0000.json`), JSON.stringify({
      sessionId: `local_${id}-0000`, scheduledTaskId: 'scout', cwd: dir, model: 'claude-fable-5-1', effort: 'high', createdAt: now - ageMs,
    }));
    rec('aaaaaaaa', 3 * 3600 * 1000); // before the pin was added: judged against a line that did not exist yet
    rec('bbbbbbbb', 10 * 60 * 1000); // after the pin was added: a real miss
    const res = routineModelDrift({ sessionsRoot: sessions, claudeDirPath: claudeDir, nowMs: now });
    assert.equal(res.drift.length, 1, res.drift.join('\n'));
    assert.match(res.drift[0], /bbbbbbbb/);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// F5  A `model:` value the plugin's own pinned-model.mjs accepts as an alias (best, opusplan) is never
//     matched, so such a task is reported as high-severity drift on every run; and an inline YAML comment
//     is kept as part of the value.
test('F5b: a trailing YAML comment is not part of the model: value', async () => {
  const { frontmatterModel } = await import('../scripts/lib/routine-model-drift.mjs');
  assert.equal(frontmatterModel('---\nname: x\nmodel: opus # pinned for the scout\n---\nb'), 'opus');
});

test('F5: a task pinned `best` or `opusplan` is not reported as drift on an opus run', async () => {
  const { dir, cleanup } = makeFixture();
  try {
    const { routineModelDrift } = await import('../scripts/lib/routine-model-drift.mjs');
    const sessions = join(dir, 'sessions');
    const claudeDir = join(dir, '.claude');
    const now = Date.now();
    for (const [name, line] of [['t-best', 'best'], ['t-opusplan', 'opusplan']]) {
      write(join(claudeDir, 'scheduled-tasks', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\nmodel: ${line}\n---\nBody\n`);
      const old = new Date(now - 24 * 3600 * 1000);
      utimesSync(join(claudeDir, 'scheduled-tasks', name, 'SKILL.md'), old, old);
      write(join(sessions, 'acct', 'org', `local_${name}-0000.json`), JSON.stringify({
        sessionId: `local_${name}-0000`, scheduledTaskId: name, cwd: dir, model: 'claude-opus-5-5', effort: 'low', createdAt: now - 3600 * 1000,
      }));
    }
    const res = routineModelDrift({ sessionsRoot: sessions, claudeDirPath: claudeDir, nowMs: now });
    assert.deepEqual(res.drift, []);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// F7  routing-table.mjs prints the "haiku/low writer gets a haiku/medium reviewer" example inside the
//     per-tier loop, so a second tier with a minEffort (a per-user override) gets the haiku example.
test('F7: each tier-effort-floor sentence in the generated routing doc gives that tier\'s own reviewer example', () => {
  const { dir, stateDir, cleanup } = makeFixture();
  try {
    write(join(stateDir, 'model-tiers.json'), JSON.stringify({ tiers: { sonnet: { minEffort: 'medium' } } }));
    const res = runScript('scripts/routing-table.mjs', [], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const sentences = res.stdout.split('\n').filter((l) => l.startsWith('A tier effort floor applies'));
    assert.equal(sentences.length, 2, 'haiku (shipped) and sonnet (override)');
    const sonnet = sentences.find((l) => l.includes('`sonnet` never resolves below'));
    assert.ok(sonnet, 'a sentence for sonnet');
    assert.doesNotMatch(sonnet, /haiku\/low/);
  } finally { cleanup(); }
});
