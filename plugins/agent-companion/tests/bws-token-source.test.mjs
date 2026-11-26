// api_bws_token_source (0.31.73): the Bitwarden access token from env:NAME or file:<path>; a named target whose key cannot be
// resolved is skipped to the next target. Fake values only. Nothing here touches the network or a real bws.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { makeFixture } from './helpers.mjs';
import { loadConfig, bwsToken, keyConfigured, resolveKey, decide } from '../scripts/lib/api-credits.mjs';
import { main as reviewMain } from '../scripts/api-review.mjs';
import { spawnSyncHidden } from '../scripts/lib/proc.mjs';

const FAKE = 'fake-token-value-for-tests-0001';
const FAKE_ENV = 'fake-env-token-for-tests-0002';
const KB = 'sk-ant-api03-TARGETB-testkeytestkey';

function tokenFile(content, name = 'tok.txt') {
  const fx = makeFixture();
  const p = join(fx.dir, name);
  writeFileSync(p, content);
  return { fx, p };
}

test('default source: env:BWS_ACCESS_TOKEN as in 0.31.72, and the same error text when unset', () => {
  assert.equal(loadConfig((k, d) => d).bwsTokenSource, 'env:BWS_ACCESS_TOKEN');
  assert.equal(bwsToken({ BWS_ACCESS_TOKEN: FAKE }, 'env:BWS_ACCESS_TOKEN'), FAKE);
  assert.throws(() => bwsToken({}, 'env:BWS_ACCESS_TOKEN'), /^Error: BWS_ACCESS_TOKEN is not set$/);
  assert.equal(keyConfigured('bws:x', {}, 'env:BWS_ACCESS_TOKEN'), false);
  assert.equal(keyConfigured('bws:x', { BWS_ACCESS_TOKEN: FAKE }, 'env:BWS_ACCESS_TOKEN'), true);
  // An env:OTHER source reads that variable.
  assert.equal(bwsToken({ MY_TOK: FAKE }, 'env:MY_TOK'), FAKE);
});

test('file source: the file is read and trimmed', () => {
  const t = tokenFile(`  ${FAKE}\r\n`);
  try {
    assert.equal(bwsToken({}, `file:${t.p}`), FAKE);
    assert.equal(keyConfigured('bws:x', {}, `file:${t.p}`), true);
    assert.equal(loadConfig((k, d) => (k === 'api_bws_token_source' ? `file:${t.p}` : d)).bwsTokenSource, `file:${t.p}`);
  } finally { t.fx.cleanup(); }
});

test('file source: BWS_ACCESS_TOKEN, when set, wins over the file', () => {
  const t = tokenFile(FAKE);
  try { assert.equal(bwsToken({ BWS_ACCESS_TOKEN: FAKE_ENV }, `file:${t.p}`), FAKE_ENV); } finally { t.fx.cleanup(); }
});

test('file source: a missing file and an empty file fail by naming the source, never a value', () => {
  const t = tokenFile('  \n');
  try {
    assert.throws(() => bwsToken({}, `file:${t.p}`), (e) => /Bitwarden token file is empty \(file:/.test(e.message) && e.message.includes(t.p));
    const none = join(t.fx.dir, 'absent.txt');
    assert.throws(() => bwsToken({}, `file:${none}`), (e) => /missing or unreadable \(file:/.test(e.message) && e.message.includes(none));
    assert.equal(keyConfigured('bws:x', {}, `file:${none}`), false);
    assert.equal(keyConfigured('bws:x', {}, `file:${t.p}`), false);
    assert.throws(() => bwsToken({}, 'nonsense'), /must be env:<NAME> or file:<path>/);
  } finally { t.fx.cleanup(); }
});

test('file source: a leading ~ is the home directory', () => {
  const t = tokenFile(FAKE, 'home-tok.txt');
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = t.fx.dir; process.env.USERPROFILE = t.fx.dir;
  try {
    assert.equal(homedir(), t.fx.dir);
    assert.equal(bwsToken({}, 'file:~/home-tok.txt'), FAKE);
    assert.equal(bwsToken({}, 'file:~\\home-tok.txt'), FAKE);
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    t.fx.cleanup();
  }
});

test('no leak: the token is in no error message and no governor reason', () => {
  const t = tokenFile(FAKE);
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  process.env.AGENT_COMPANION_BWS_BIN = join(t.fx.dir, 'no-such-bws-binary');
  try {
    const seen = [];
    try { resolveKey('bws:some-secret', {}, `file:${t.p}`); } catch (e) { seen.push(e.message); }
    try { resolveKey('bws:some-secret', { BWS_ACCESS_TOKEN: FAKE_ENV }, 'env:BWS_ACCESS_TOKEN'); } catch (e) { seen.push(e.message); }
    try { bwsToken({}, `file:${join(t.fx.dir, 'absent.txt')}`); } catch (e) { seen.push(e.message); }
    const cfg = loadConfig((k, d) => (k === 'api_targets' ? JSON.stringify({ a: { key: 'bws:x' } }) : k === 'api_category_targets' ? 'review=a' : k === 'api_bws_token_source' ? `file:${t.p}` : d));
    const d = decide('review', { cfg, env: {}, path: join(t.fx.dir, 'ledger.json') });
    seen.push(JSON.stringify(d));
    assert.equal(seen.length, 4);
    for (const s of seen) { assert.ok(!s.includes(FAKE) && !s.includes(FAKE_ENV), `leaked in: ${s}`); }
    assert.match(seen[0], /bws failed to return the secret/);
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    t.fx.cleanup();
  }
});

// --- an unresolvable named key does not block the job -----------------------------------------------------------------

const mk = (opts = {}) => loadConfig((k, d) => (k in opts ? opts[k] : d));

test('decide: a target whose bws token is missing is skipped to the next target, then to the plan, with a reason', () => {
  const t = tokenFile('');
  try {
    const targets = JSON.stringify({ a: { key: 'bws:x' }, b: { key: 'env:AC_KEY_B' } });
    const path = join(t.fx.dir, 'ledger.json');
    const cfg = mk({ api_targets: targets, api_category_targets: 'workers=a,b', api_bws_token_source: `file:${t.p}` });
    const d = decide('workers', { cfg, env: { AC_KEY_B: KB }, path, now: Date.parse('2026-11-20T00:00:00Z') });
    assert.equal(d.decision, 'api');
    assert.equal(d.target, 'b');
    const only = mk({ api_targets: targets, api_category_targets: 'workers=a', api_bws_token_source: `file:${t.p}` });
    const p = decide('workers', { cfg: only, env: {}, path });
    assert.equal(p.decision, 'plan');
    assert.match(p.reason, /target a: no API key available/);
  } finally { t.fx.cleanup(); }
});

function rig() {
  const fx = makeFixture();
  const repo = join(fx.dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...a) => { const r = spawnSyncHidden('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'first');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'second');
  const brief = join(fx.dir, 'brief.txt');
  writeFileSync(brief, 'TYPE: bounded-feature\nthe lead brief, verbatim\n');
  const run = async (cfg, env, fetchImpl) => {
    const lines = []; const errs = [];
    const code = await reviewMain(['run', '--brief-file', brief, '--diff-ref', 'HEAD~1..HEAD', '--model', 'sonnet', '--cwd', repo, '--runner', 'fetch'],
      { out: (s) => lines.push(s), err: (s) => errs.push(s), env, fetchImpl, sleep: async () => {}, cfg });
    return { code, out: lines.join('\n'), err: errs.join('\n') };
  };
  return { fx, run };
}

const okFetch = () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(init.headers['x-api-key']);
    return { status: 200, text: async () => JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'VERDICT: PASS' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 } }) };
  };
  f.calls = calls;
  return f;
};

test('review: a named target whose key cannot be read (bws fails) is skipped to the next target; exhausted, it is the plan result, no throw', async () => {
  const t = rig();
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  process.env.AGENT_COMPANION_BWS_BIN = join(t.fx.dir, 'no-such-bws-binary');
  try {
    const targets = JSON.stringify({ a: { key: 'bws:x' }, b: { key: 'env:AC_KEY_B' } });
    const env = { BWS_ACCESS_TOKEN: FAKE, AC_KEY_B: KB };
    const cfg = mk({ api_targets: targets, api_category_targets: 'review=a,b', api_credits_review_ratio: 1 });
    const f = okFetch();
    const r = await t.run(cfg, env, f);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(f.calls, [KB]);
    assert.match(r.err, /target a has no usable key/);
    assert.ok(!r.out.includes(FAKE) && !r.err.includes(FAKE));
    const only = mk({ api_targets: targets, api_category_targets: 'review=a', api_credits_review_ratio: 1 });
    const f2 = okFetch();
    const r2 = await t.run(only, env, f2);
    assert.equal(r2.code, 3, r2.out + r2.err);
    assert.match(r2.out, /API review unavailable/);
    assert.equal(f2.calls.length, 0);
    assert.ok(!r2.out.includes(FAKE) && !r2.err.includes(FAKE));
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    t.fx.cleanup();
  }
});

test('worker: a first target whose key cannot be read is skipped to the next; exhausted, it is refused_key, and no field leaks', async () => {
  const { runWorker } = await import('../scripts/api-worker.mjs');
  const w = makeFixture();
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  process.env.AGENT_COMPANION_BWS_BIN = join(w.dir, 'no-such-bws-binary');
  try {
    const keysSeen = [];
    const sdk = { query: ({ options }) => { keysSeen.push(options.env.ANTHROPIC_API_KEY); return (async function* () {
      yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' };
      yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 100 } } };
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 100 } };
    })(); } };
    const credits = { decide: (c, t) => ({ decision: 'api', reason: 'ok', ...(t && t !== 'primary' ? { target: t } : {}) }), record: () => {} };
    const targets = JSON.stringify({ a: { key: 'bws:x' }, b: { key: 'env:AC_KEY_B' } });
    const env = { BWS_ACCESS_TOKEN: FAKE, AC_KEY_B: KB };
    const r = await runWorker({ prompt: 'x', cwd: w.dir, env, cfg: mk({ api_targets: targets, api_category_targets: 'workers=a,b' }), credits, sdk, configDir: '' });
    assert.equal(r.status, 'done', r.reason);
    assert.deepEqual(keysSeen, [KB]);
    assert.equal(r.target, 'b');
    const r2 = await runWorker({ prompt: 'x', cwd: w.dir, env, cfg: mk({ api_targets: targets, api_category_targets: 'workers=a' }), credits, sdk, configDir: '' });
    assert.equal(r2.status, 'refused_key');
    assert.ok(!('keyFailed' in r2));
    assert.ok(!JSON.stringify(r2).includes(FAKE));
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    w.cleanup();
  }
});

// --- 0.31.74: hardening ---------------------------------------------------------------------------------------------

const utf16le = (s, bom) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);

test('file source: a UTF-16LE file (PowerShell 5.1 `>`), with and without BOM, decodes to the token', () => {
  const a = tokenFile(utf16le(`${FAKE}\r\n`, true), 'bom.txt');
  const b = tokenFile(utf16le(FAKE, false), 'nobom.txt');
  const c = tokenFile(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(FAKE, 'utf16le').swap16()]), 'be.txt');
  try {
    assert.equal(bwsToken({}, `file:${a.p}`), FAKE);
    assert.equal(bwsToken({}, `file:${b.p}`), FAKE);
    assert.equal(bwsToken({}, `file:${c.p}`), FAKE);
  } finally { a.fx.cleanup(); b.fx.cleanup(); c.fx.cleanup(); }
});

test('file source: a NUL or control character in the token is rejected with a fixed message naming only the source', () => {
  const secretPart = 'fake-nul-part-for-tests-0003';
  for (const body of [`${secretPart}\0tail`, `${secretPart}\x07tail`, `${secretPart}\nsecond-line`]) {
    const t = tokenFile(body);
    try {
      assert.throws(() => bwsToken({}, `file:${t.p}`), (e) => e.keyFailure === true && /not plain text \(file:/.test(e.message) && !e.message.includes(secretPart));
      assert.equal(keyConfigured('bws:x', {}, `file:${t.p}`), false);
      assert.throws(() => resolveKey('bws:x', {}, `file:${t.p}`), (e) => e.keyFailure === true && !e.message.includes(secretPart));
    } finally { t.fx.cleanup(); }
  }
  assert.throws(() => bwsToken({ MY_TOK: 'a\0b' }, 'env:MY_TOK'), (e) => e.keyFailure === true && /MY_TOK is not a plain-text token/.test(e.message) && !e.message.includes('a\0b'));
});

test('file source: a relative path is rejected with a fixed message (absolute or ~ only)', () => {
  for (const rel of ['tok.txt', './tok.txt', '..\\tok.txt', '~other/tok.txt']) {
    assert.throws(() => bwsToken({}, `file:${rel}`), (e) => e.keyFailure === true && /must be absolute or start with ~ \(file:/.test(e.message), rel);
  }
  assert.equal(keyConfigured('bws:x', {}, 'file:tok.txt'), false);
});

test('a throw from the bws spawn is rethrown as a fixed text with no value, as a key failure', () => {
  // spawnSync throws a TypeError (quoting the value) on a NUL in an env value; here an unrelated variable carries it.
  assert.throws(() => resolveKey('bws:some-secret', { BWS_ACCESS_TOKEN: FAKE, OTHER_VAR: 'fake-nul\0value' }, 'env:BWS_ACCESS_TOKEN'),
    (e) => e.keyFailure === true && e.configFailure === true && e.message === 'bws could not be started' && !e.message.includes('fake-nul'));
});

// A fake bws: node itself runs a preload (NODE_OPTIONS --import) that checks the token arrived in its env and prints a fake secret.
function fakeBws(dir) {
  const stub = join(dir, 'fake-bws-stub.mjs');
  writeFileSync(stub, `const ok = process.env.BWS_ACCESS_TOKEN === ${JSON.stringify(FAKE)};
if (ok) process.stdout.write(JSON.stringify([{ key: 'some-secret', value: ${JSON.stringify(KB)} }]));
process.exit(ok ? 0 : 1);
`);
  return { AGENT_COMPANION_BWS_BIN: process.execPath, NODE_OPTIONS: `--import ${pathToFileURL(stub).href}` };
}

test('positive path: the file token reaches the bws child as BWS_ACCESS_TOKEN and the secret comes back', () => {
  const t = tokenFile(utf16le(FAKE, true));
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  const f = fakeBws(t.fx.dir);
  process.env.AGENT_COMPANION_BWS_BIN = f.AGENT_COMPANION_BWS_BIN;
  try {
    const env = { ...process.env, NODE_OPTIONS: f.NODE_OPTIONS };
    delete env.BWS_ACCESS_TOKEN;
    assert.equal(resolveKey('bws:some-secret', env, `file:${t.p}`), KB);
    // A wrong token makes the stub exit 1: a key failure with the fixed text.
    const bad = tokenFile('fake-wrong-token-0004');
    try { assert.throws(() => resolveKey('bws:some-secret', env, `file:${bad.p}`), /bws failed to return the secret/); } finally { bad.fx.cleanup(); }
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    t.fx.cleanup();
  }
});

function filesUnder(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else out.push(p);
  }
  return out;
}

test('review: a malformed token file skips to the next target and leaks into no stdout, ledger, review-verdicts or telemetry row', async () => {
  const t = rig();
  try {
    const part = 'fake-leak-part-for-tests-0005';
    const tf = join(t.fx.dir, 'bad-token.txt');
    writeFileSync(tf, `${part}\0more-bytes`);
    const targets = JSON.stringify({ a: { key: 'bws:x' }, b: { key: 'env:AC_KEY_B' } });
    const cfg = mk({ api_targets: targets, api_category_targets: 'review=a,b', api_credits_review_ratio: 1, api_bws_token_source: `file:${tf}` });
    const f = okFetch();
    const r = await t.run(cfg, { AC_KEY_B: KB }, f);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(f.calls, [KB]);
    assert.match(r.err, /target a has no usable key \(Bitwarden token file is not plain text/);
    const all = [r.out, r.err];
    for (const p of filesUnder(t.fx.dir)) { if (p === tf) continue; try { all.push(readFileSync(p, 'utf8')); } catch { /* unreadable */ } }
    for (const s of all) assert.ok(!s.includes(part) && !s.includes('more-bytes'), 'token fragment leaked');
    assert.ok(filesUnder(t.fx.dir).some((p) => /review-verdicts\.jsonl$/.test(p)), 'review-verdicts row was written');
  } finally { t.fx.cleanup(); }
});

test('worker: the skip note carries the reason and no secret', async () => {
  const { runWorker } = await import('../scripts/api-worker.mjs');
  const w = makeFixture();
  try {
    const part = 'fake-worker-part-for-tests-0006';
    const tf = join(w.dir, 'bad-token.txt');
    writeFileSync(tf, `${part}\0x`);
    const sdk = { query: () => (async function* () {
      yield { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' };
      yield { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 100 } } };
      yield { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 100 } };
    })() };
    const credits = { decide: (c, tg) => ({ decision: 'api', reason: 'ok', ...(tg && tg !== 'primary' ? { target: tg } : {}) }), record: () => {} };
    const targets = JSON.stringify({ a: { key: 'bws:x' }, b: { key: 'env:AC_KEY_B' } });
    const r = await runWorker({ prompt: 'x', cwd: w.dir, env: { AC_KEY_B: KB }, cfg: mk({ api_targets: targets, api_category_targets: 'workers=a,b', api_bws_token_source: `file:${tf}` }), credits, sdk, configDir: '' });
    assert.equal(r.status, 'done', r.reason);
    assert.equal(r.notes.length, 1);
    assert.match(r.notes[0], /^target a has no usable key \(no API key: Bitwarden token file is not plain text .*\), skipped$/);
    assert.ok(!JSON.stringify(r).includes(part));
  } finally { w.cleanup(); }
});

test('readAdminKey honours an injected cfg.bwsTokenSource', async () => {
  const { readAdminKey } = await import('../scripts/lib/api-spend.mjs');
  const t = tokenFile(FAKE);
  const was = process.env.AGENT_COMPANION_BWS_BIN;
  const f = fakeBws(t.fx.dir);
  process.env.AGENT_COMPANION_BWS_BIN = f.AGENT_COMPANION_BWS_BIN;
  try {
    const env = { ...process.env, NODE_OPTIONS: f.NODE_OPTIONS };
    delete env.BWS_ACCESS_TOKEN;
    // The stub's secret is not an admin key, so a read that got that far fails on the admin-key check, not on the token.
    assert.throws(() => readAdminKey('bws:some-secret', { env, cfg: { bwsTokenSource: `file:${t.p}` } }), /not an admin key/);
    assert.throws(() => readAdminKey('bws:some-secret', { env, cfg: { bwsTokenSource: 'file:rel.txt' } }), /must be absolute or start with ~/);
  } finally {
    if (was === undefined) delete process.env.AGENT_COMPANION_BWS_BIN; else process.env.AGENT_COMPANION_BWS_BIN = was;
    t.fx.cleanup();
  }
});
