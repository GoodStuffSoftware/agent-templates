// Settings journal (hooks/settings-journal.mjs). Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, runHook } from './helpers.mjs';
import { nextRow, settingEvents, settingInstant } from '../hooks/lib/settings-journal.mjs';

const HOOK = 'hooks/settings-journal.mjs';
const rows = (fx) => {
  const f = join(fx.stateDir, 'telemetry', 'settings-changes.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const start = (sid, extra = {}) => ({ session_id: sid, cwd: '/work/alpha', source: 'startup', model: 'claude-opus-5-5', ...extra });

test('first session writes a baseline row; an unchanged one writes nothing', () => {
  const fx = makeFixture();
  try {
    const r1 = runHook(HOOK, start('s1', { effort: { level: 'high' } }));
    assert.equal(r1.status, 0);
    assert.equal(r1.stdout.trim(), '');
    let got = rows(fx);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].changed, ['baseline']);
    assert.equal(got[0].model, 'claude-opus-5-5');
    assert.equal(got[0].effort, 'high');
    assert.equal(got[0].cwd, '/work/alpha');
    runHook(HOOK, start('s2', { effort: { level: 'high' } }));
    runHook(HOOK, start('s3', { effort: { level: 'high' }, source: 'resume' }));
    got = rows(fx);
    assert.equal(got.length, 1, 'no row when nothing changed');
  } finally { fx.cleanup(); }
});

test('a change of model or effort writes one row naming what changed', () => {
  const fx = makeFixture();
  try {
    runHook(HOOK, start('s1', { effort: { level: 'high' } }));
    runHook(HOOK, start('s2', { effort: { level: 'xhigh' } }));
    runHook(HOOK, start('s3', { effort: { level: 'xhigh' }, model: 'claude-sonnet-5-5' }));
    const got = rows(fx);
    assert.equal(got.length, 3);
    assert.deepEqual(got[1].changed, ['effort']);
    assert.deepEqual(got[2].changed, ['model']);
    assert.equal(got[2].effort, 'xhigh');
  } finally { fx.cleanup(); }
});

test('a changed option digest is a change; the option value never lands in the row', () => {
  const fx = makeFixture();
  try {
    const cfg = (v) => writeFileSync(join(fx.dir, '.claude', 'settings.json'),
      JSON.stringify({ pluginConfigs: { 'agent-companion@x': { options: { catchup_note: v, secret_thing: 'hunter2-value' } } } }));
    mkdirSync(join(fx.dir, '.claude'), { recursive: true });
    cfg(true);
    runHook(HOOK, start('s1'));
    cfg(false);
    runHook(HOOK, start('s2'));
    runHook(HOOK, start('s3'));
    const got = rows(fx);
    assert.equal(got.length, 2);
    assert.deepEqual(got[1].changed, ['options']);
    assert.notEqual(got[0].options, got[1].options);
    assert.ok(!JSON.stringify(got).includes('hunter2'));
  } finally { fx.cleanup(); }
});

test('subagent, fixture and malformed starts write nothing and never throw', () => {
  const fx = makeFixture();
  try {
    assert.equal(runHook(HOOK, start('s1', { agent_id: 'a1' })).status, 0);
    assert.equal(runHook(HOOK, start('test-1')).status, 0);
    assert.equal(runHook(HOOK, undefined).status, 0);
    assert.equal(runHook(HOOK, { session_id: 7 }).status, 0);
    assert.deepEqual(rows(fx), []);
  } finally { fx.cleanup(); }
});

test('row carries no prompt or transcript path', () => {
  const fx = makeFixture();
  try {
    runHook(HOOK, start('s1', { prompt: 'secret prompt text', transcript_path: 'proj-x/s1.jsonl' }));
    const text = JSON.stringify(rows(fx));
    assert.ok(!text.includes('secret prompt'));
    assert.ok(!text.includes('transcript'));
    assert.deepEqual(Object.keys(rows(fx)[0]).sort(),
      ['at', 'changed', 'cwd', 'effort', 'model', 'options', 'plugin_version', 'session_id', 'v']);
  } finally { fx.cleanup(); }
});

test('nextRow: null observations are not changes and carry the prior value', () => {
  const prior = { model: 'm1', effort: 'high', plugin_version: '1', options: 'none' };
  const ctx = { at: 't', session_id: 's', cwd: null };
  assert.equal(nextRow(prior, { model: null, effort: null, plugin_version: '1', options: 'none' }, ctx), null);
  const r = nextRow(prior, { model: 'm2', effort: null, plugin_version: '1', options: 'none' }, ctx);
  assert.equal(r.effort, 'high');
  assert.deepEqual(r.changed, ['model']);
});

test('resolver: the first instant of a value; a revert is a new event', () => {
  const j = [
    { at: '2026-10-10T20:03:00Z', model: 'm', effort: 'xhigh', plugin_version: '1', options: 'a' },
    { at: '2026-10-11T08:00:00Z', model: 'm', effort: 'high', plugin_version: '1', options: 'a' },
    { at: '2026-10-11T09:00:00Z', model: 'm', effort: 'high', plugin_version: '2', options: 'a' },
    { at: '2026-10-12T09:00:00Z', model: 'm', effort: 'xhigh', plugin_version: '2', options: 'a' },
    { at: '2026-10-13T09:00:00Z', model: 'm', effort: 'high', plugin_version: '2', options: 'a' },
  ];
  assert.equal(settingInstant(j, 'setting:effort=high'), Date.parse('2026-10-11T08:00:00Z'));
  assert.equal(settingInstant(j, 'effort=high', { after: Date.parse('2026-10-12T00:00:00Z') }), Date.parse('2026-10-13T09:00:00Z'));
  assert.equal(settingInstant(j, 'setting:plugin_version=2'), Date.parse('2026-10-11T09:00:00Z'));
  assert.equal(settingInstant(j, 'setting:effort=low'), null);
  assert.equal(settingInstant(j, 'garbage'), null);
  assert.equal(settingEvents(j).filter((e) => e.key === 'model').length, 1);
});
