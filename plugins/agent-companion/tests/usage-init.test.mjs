import { makeFixture } from './helpers.mjs'; // sandboxes state paths first (see isolate.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './helpers.mjs';
import { main } from '../scripts/usage-analysis.mjs';
import { buildProposal, lineDiff, runInit } from '../scripts/lib/usage/init.mjs';
import { loadConfig, userConfigPath, SHIPPED_DEFAULTS_PATH } from '../scripts/lib/usage/config.mjs';

function registerWith(dir, ids) {
  const ex = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'config', 'decision-register.example.json'), 'utf8'));
  const base = ex.decisions[0];
  ex.decisions = ids.map((id) => ({ ...base, id }));
  const file = join(dir, 'decision-register.json');
  writeFileSync(file, JSON.stringify(ex));
  return file;
}

async function cli(args) {
  const lines = [];
  const code = await main(args, { out: (s) => lines.push(s) });
  return { code, text: lines.join('\n'), lines };
}

test('init --from-register writes the user file when it is absent, and the proposal loads clean', async () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'state-root');
    const reg = registerWith(fx.dir, ['leads-effort-high', 'haiku-5-5-trial', 'unrelated']);
    const path = userConfigPath(root);
    assert.equal(existsSync(path), false);
    // The operator has both rollout rows, so the whole leads comparison is proposed.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'rollout.json'), JSON.stringify({ 'leads-xhigh': '2026-09-01T00:00:00Z' }));
    const r = await cli(['init', '--from-register', '--root', root, '--register', reg]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /^wrote /);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.schema, 'agent-companion/usage-analysis');
    assert.equal(written.windows['leads-high'].from, 'decision:leads-effort-high');
    assert.equal(written.windows['leads-high'].to, 'rollout:leads-xhigh');
    assert.equal(written.windows['haiku-trial'].from, 'decision:haiku-5-5-trial');
    assert.ok(written.exclusions['fable-tree'] && written.exclusions['stray-tests']);
    assert.deepEqual(written.scenarios.map((s) => s.id).sort(), ['u.haikuTrialSpawns', 'u.leadsXhighVsHigh']);
    const cfg = loadConfig({ root, shippedPath: SHIPPED_DEFAULTS_PATH, cwds: [], writeSignal: false });
    assert.deepEqual(cfg.problems.filter((p) => !/not implemented|metric/i.test(JSON.stringify(p))), [], JSON.stringify(cfg.problems));
  } finally { fx.cleanup(); }
});

test('init never overwrites an existing file: it prints a diff and leaves the bytes alone', async () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'state-root');
    const reg = registerWith(fx.dir, ['haiku-5-5-trial']);
    const path = userConfigPath(root);
    mkdirSync(join(root, 'config'), { recursive: true });
    const mine = '{\n  "schema": "agent-companion/usage-analysis",\n  "schemaVersion": 1,\n  "revision": 7\n}\n';
    writeFileSync(path, mine);
    const before = statSync(path).mtimeMs;
    const r = await cli(['init', '--from-register', '--root', root, '--register', reg]);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /exists and was not changed/);
    assert.ok(r.lines.some((l) => l.startsWith('- ') && l.includes('"revision": 7')), 'the existing line is marked');
    assert.ok(r.lines.some((l) => l.startsWith('+ ') && l.includes('haiku-trial')), 'the proposed line is marked');
    assert.equal(readFileSync(path, 'utf8'), mine);
    assert.equal(statSync(path).mtimeMs, before);
    // a second run on the written proposal reports it identical
    const again = runInit({ root, registerFile: reg });
    assert.equal(again.action, 'diff');
    assert.deepEqual(again.diff.filter((l) => /^[-+] /.test(l)).length > 0, true);
  } finally { fx.cleanup(); }
});

test('init on its own output reports identical; --dry-run writes nothing; a missing register is exit 1', async () => {
  const fx = makeFixture();
  try {
    const root = join(fx.dir, 'state-root');
    const reg = registerWith(fx.dir, ['haiku-5-5-trial']);
    const dry = await cli(['init', '--from-register', '--dry-run', '--root', root, '--register', reg]);
    assert.equal(dry.code, 0);
    assert.match(dry.text, /^would write /);
    assert.equal(existsSync(userConfigPath(root)), false);
    assert.equal((await cli(['init', '--from-register', '--root', root, '--register', reg])).code, 0);
    const same = await cli(['init', '--from-register', '--root', root, '--register', reg]);
    assert.match(same.text, /already matches/);
    const missing = await cli(['init', '--from-register', '--root', join(fx.dir, 'other'), '--register', join(fx.dir, 'nope.json')]);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /no decision register/);
    assert.equal(existsSync(userConfigPath(join(fx.dir, 'other'))), false);
    assert.equal((await cli(['init', '--root', root])).code, 2, 'init needs --from-register');
  } finally { fx.cleanup(); }
});

test('the proposal invents nothing machine-specific, and omits windows the register does not back', () => {
  const none = buildProposal({ decisions: [{ id: 'unrelated' }] });
  assert.deepEqual(none.windows, {});
  assert.deepEqual(none.scenarios, []);
  const { $comment, ...body } = buildProposal({ decisions: [{ id: 'leads-effort-high' }, { id: 'haiku-5-5-trial' }] });
  const text = JSON.stringify(body);
  assert.ok(!/sessionId|weeklyLimitUnits|[A-Za-z]:[\\/]|\b[0-9a-f]{7,12}\b/.test(text), text);
});

test('lineDiff marks only the differing lines', () => {
  assert.deepEqual(lineDiff('a\nb\nc\n', 'a\nx\nc\n'), ['  a', '- b', '+ x', '  c']);
  assert.deepEqual(lineDiff('a\n', 'a\n'), ['  a']);
});
