// The pinned-model-id check (scripts/lib/pinned-model.mjs): which values count as a pin,
// how a pin is classified against the tier data, and each surface it scans (tier data,
// scheduled tasks, settings, agent definitions). Synthetic fixtures only; nothing reads
// the operator's ~/.claude.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import {
  pinnedIdIn, classifyPinned, scanTierData, scanScheduledTasks, scanSettings, scanAgentDir, scanPinnedModels, findingKey,
} from '../scripts/lib/pinned-model.mjs';

const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };

test('an alias, an empty value or inherit is not a pin', () => {
  for (const v of ['sonnet', 'opus', 'haiku', 'opus[1m]', 'sonnet[1m]', 'inherit', 'default', 'best', 'opusplan', '', '  ', undefined, null]) {
    assert.equal(pinnedIdIn(v), null, String(v));
  }
});

test('a full id is a pin: quoted, dated or in a cloud-provider form', () => {
  assert.equal(pinnedIdIn('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(pinnedIdIn('"claude-sonnet-5"'), 'claude-sonnet-5');
  assert.equal(pinnedIdIn('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
  assert.equal(pinnedIdIn('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet-20241022');
  assert.equal(pinnedIdIn('anthropic.claude-sonnet-5-5-v1:0'), 'claude-sonnet-5-5-v1:0');
});

test('classifyPinned: superseded, current and unlisted ids', () => {
  assert.equal(classifyPinned('claude-sonnet-5').status, 'superseded');
  assert.equal(classifyPinned('claude-haiku-4-5').status, 'superseded');
  assert.equal(classifyPinned('claude-haiku-4-5-20251001').status, 'superseded');
  assert.equal(classifyPinned('claude-sonnet-5-5').status, 'current');
  assert.equal(classifyPinned('claude-haiku-5-5').status, 'current');
  assert.equal(classifyPinned('claude-opus-9-9').status, 'unlisted');
  assert.equal(classifyPinned('claude-sonnet-5-5').alias, 'sonnet');
});

test('classifyPinned follows the tier data it is given, not a fixed list', () => {
  const cfg = { tiers: { sonnet: { resolvesTo: { modelId: 'claude-sonnet-6' } } } };
  assert.equal(classifyPinned('claude-sonnet-6', cfg).status, 'current');
});

test('the shipped tier data names no superseded model', () => {
  assert.deepEqual(scanTierData(), []);
});

test('a tier whose resolvesTo names a superseded id is a finding with the alias to use', () => {
  const cfg = { tiers: { haiku: { resolvesTo: { modelId: 'claude-haiku-4-5' } }, sonnet: { resolvesTo: { modelId: 'claude-sonnet-5-5' } } } };
  const found = scanTierData(cfg);
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'claude-haiku-4-5');
  assert.match(found[0].text, /tier data haiku pins claude-haiku-4-5: superseded/);
  assert.match(found[0].text, /use "haiku"/);
});

test('scheduled tasks: a model line with a full id is a finding; prose and aliases are not', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const c = join(dir, 'claude');
    write(join(c, 'scheduled-tasks', 'pinned', 'SKILL.md'), '---\nname: pinned\n---\nRun the report.\nmodel: claude-sonnet-5\n');
    write(join(c, 'scheduled-tasks', 'inline', 'SKILL.md'), 'Create it with "model": "claude-haiku-4-5" and cron 0 7 * * *.\n');
    write(join(c, 'scheduled-tasks', 'alias', 'SKILL.md'), 'model: sonnet\nUse the sonnet alias.\n');
    write(join(c, 'scheduled-tasks', 'prose', 'SKILL.md'), 'Sonnet 5 shipped; claude-sonnet-5 was the id back then.\n');
    const found = scanScheduledTasks(c);
    assert.deepEqual(found.map((f) => f.where).sort(), ['scheduled task inline', 'scheduled task pinned']);
    assert.match(found.find((f) => f.where.endsWith('pinned')).text, /claude-sonnet-5: superseded \(Sonnet 5\); use "sonnet"/);
  } finally { cleanup(); }
});

test('settings: model and the two env model fields; modelSettings keys and ANTHROPIC_DEFAULT_*_MODEL are left alone', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const f = join(dir, 'settings.json');
    write(f, JSON.stringify({
      model: 'claude-opus-5',
      env: { ANTHROPIC_MODEL: 'claude-sonnet-5', CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5' },
      modelSettings: { 'claude-sonnet-5': { fastMode: true } },
    }));
    const found = scanSettings([{ label: 'user settings', path: f }]);
    assert.deepEqual(found.map((x) => x.where).sort(), ['user settings env ANTHROPIC_MODEL', 'user settings model']);
    const ok = join(dir, 'ok.json');
    write(ok, JSON.stringify({ model: 'opus[1m]', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }));
    assert.deepEqual(scanSettings([{ label: 'x', path: ok }]), []);
    const bad = join(dir, 'bad.json');
    write(bad, '{ not json');
    assert.deepEqual(scanSettings([{ label: 'x', path: bad }, { label: 'y', path: join(dir, 'missing.json') }]), []);
  } finally { cleanup(); }
});

test('agent definitions: only the frontmatter model line counts', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const d = join(dir, 'agents');
    write(join(d, 'a.md'), '---\nname: a\nmodel: claude-haiku-4-5\n---\nBody mentions model: claude-sonnet-5 in text.\n');
    write(join(d, 'b.md'), '---\nname: b\nmodel: sonnet\n---\nBody.\n');
    write(join(d, 'c.md'), '---\nname: c\n---\nNo model line.\n');
    write(join(d, 'd.md'), 'No frontmatter. model: claude-opus-5\n');
    const found = scanAgentDir(d, 'user');
    assert.equal(found.length, 1);
    assert.equal(found[0].where, 'user agent a.md');
    assert.equal(found[0].id, 'claude-haiku-4-5');
  } finally { cleanup(); }
});

test('scanPinnedModels: user dir and a project, one finding per place and id, nothing for a clean setup', () => {
  const { dir, cleanup } = makeFixture();
  try {
    const c = join(dir, 'claude');
    const proj = join(dir, 'proj');
    write(join(c, 'settings.json'), JSON.stringify({ model: 'claude-sonnet-5' }));
    write(join(c, 'agents', 'x.md'), '---\nname: x\nmodel: claude-opus-5\n---\n');
    write(join(proj, '.claude', 'settings.local.json'), JSON.stringify({ model: 'claude-haiku-4-5' }));
    write(join(proj, '.claude', 'agents', 'y.md'), '---\nname: y\nmodel: claude-sonnet-5\n---\n');
    const found = scanPinnedModels({ claudeDirPath: c, projects: [proj, proj] });
    assert.equal(found.length, 4);
    assert.equal(new Set(found.map(findingKey)).size, 4);
    assert.ok(found.some((f) => f.where === 'project proj local settings model'));

    const clean = join(dir, 'clean');
    write(join(clean, 'settings.json'), JSON.stringify({ model: 'opus' }));
    assert.deepEqual(scanPinnedModels({ claudeDirPath: clean, projects: [] }), []);
    assert.deepEqual(scanPinnedModels({ claudeDirPath: join(dir, 'nowhere'), projects: [join(dir, 'nowhere2')] }), []);
  } finally { cleanup(); }
});
