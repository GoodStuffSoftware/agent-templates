// Decision register, wired in (spec 5.2 groups 8 and 12): the SessionStart hook process
// (piece 5 of hooks/scout-surface.mjs), the daily checkup script calling runRegister, and
// runReleaseWatch's `onParsed`. Fixtures are synthetic; nothing reads the real register, the
// real transcripts or the network.
import './isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeFixture, runHook, runScript, PLUGIN_ROOT } from './helpers.mjs';
import {
  registerPath, statePath, detailPath, readState, scanChangelog, scanChangelogToState, emptyState, writeState,
  clauseAround, compilePattern, LINE_MAX,
} from '../scripts/lib/decision-register.mjs';
import { runReleaseWatch, parseChangelog } from '../scripts/lib/release-watch.mjs';
import { checkupPaths } from '../scripts/lib/daily-checkup.mjs';

const T = (s) => Date.parse(s);
const HOUR = 3600000;
const FLAG_AT = T('2026-10-12T10:00:00Z');

const ITEM = 'Updated the cost figures to price cache reads at $0.50 per million tokens (was $1.00)';
const RELEASES = [{ version: '2.1.300', items: ['Fixed a typo in the help text', ITEM] }, { version: '2.1.299', items: ['Nothing relevant'] }];

function register(over = {}) {
  return {
    schema: 'agent-companion/decision-register',
    version: 1,
    decisions: [{
      id: 'cache-price', title: 'Cost model v1', status: 'active', decided: '2026-10-01',
      decision: 'Priced tokens carry a cost multiplier.', reverse: 'Remove the multiplier.',
      premises: [{ id: 'p1', text: 'Cache reads cost $1.00 per million.', label: 'M' }],
      triggers: [{ id: 'price-change', premise: 'p1', kind: 'changelog', sinceVersion: '2.1.295', flags: 'i', pattern: 'cache reads? at \\$[0-9.]+' }],
      ...over,
    }],
  };
}

function putRegister(reg) {
  mkdirSync(dirname(registerPath()), { recursive: true });
  writeFileSync(registerPath(), typeof reg === 'string' ? reg : JSON.stringify(reg));
}

// Register on disk plus one changelog flag recorded at `nowT`.
function flagged(nowT = FLAG_AT) {
  const reg = register();
  putRegister(reg);
  const state = emptyState();
  const fresh = scanChangelog(RELEASES, reg, state, { nowT });
  writeState(state);
  return fresh;
}

const go = (fx, payload, env = {}) => runHook('hooks/scout-surface.mjs', { session_id: 's-main', cwd: fx.dir, ...payload }, {
  cwd: fx.dir, env: { AGENT_COMPANION_FAKE_NOW: '2026-10-12T12:00:00Z', ...env },
});

// ---------------------------------------------------------------------------------------
// 8. The hook process
// ---------------------------------------------------------------------------------------

test('8. the hook prints one line with the title, premise and details path; the second start prints nothing', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(flagged(), ['cache-price/price-change@2.1.300']);
    const first = go(fx, {});
    assert.equal(first.status, 0);
    const ctx = first.json.hookSpecificOutput.additionalContext;
    assert.equal(ctx.split('\n').length, 1, 'one line');
    assert.match(ctx, /Decision review due: Cost model v1 \(cache-price\), premise p1 hit: /);
    assert.ok(ctx.includes(detailPath()), 'names the details path');
    assert.ok(ctx.length <= LINE_MAX, `line is ${ctx.length} chars`);
    assert.deepEqual(readState().surfaced, ['cache-price/price-change@2.1.300'], 'marked as shown');
    const second = go(fx, { session_id: 's2' });
    assert.equal(second.stdout.trim(), '', 'already shown');
  } finally { fx.cleanup(); }
});

test('8. the changelog line quotes the clause around the match, not the first 60 characters of the item', () => {
  const fx = makeFixture();
  try {
    // The whole line is capped at 300 characters (LINE_MAX) with the details path last, so a long
    // temp-directory path would squeeze the clause out: use a short state dir and title.
    process.env.AGENT_COMPANION_STATE_DIR = join(fx.dir, 's');
    const reg = register({ title: 'Cache price', id: 'cp' });
    putRegister(reg);
    const st = emptyState();
    scanChangelog(RELEASES, reg, st, { nowT: FLAG_AT });
    writeState(st);
    const ctx = go(fx, {}).json.hookSpecificOutput.additionalContext;
    // The line is cut from the right when the path is long, so the version may not fit.
    const quoted = ctx.match(/hit: "(.*?)(?:" in 2\.1\.300|\.\.\.\. Details:)/);
    assert.ok(quoted, ctx);
    assert.match(quoted[1], /cache reads at \$0\.50/, 'the matched text is in the line');
    assert.ok(!quoted[1].startsWith('Updated `/cost`, the status line'), 'not the item head');
  } finally { fx.cleanup(); }
});

test('8. clauseAround: short items whole, long items cut at word boundaries around the match', () => {
  const re = compilePattern('cache reads? at \\$[0-9.]+', 'i');
  assert.equal(clauseAround('Short item about cache reads at $0.50 only', re), 'Short item about cache reads at $0.50 only');
  const long = `${'word '.repeat(40)}cache reads at $0.50 per million${' tail'.repeat(40)}`;
  const c = clauseAround(long, re);
  assert.ok(c.length <= 78, `${c.length}`);
  assert.match(c, /^\.\.\./);
  assert.match(c, /\.\.\.$/);
  assert.match(c, /cache reads at \$0\.50/);
  assert.ok(!/\bwor\b|\bta\b/.test(c), 'no word is cut in half');
  assert.equal(clauseAround('no match here at all', re), 'no match here at all');
});

test('8. the checkup line still prints alongside the register line', () => {
  const fx = makeFixture();
  try {
    flagged();
    mkdirSync(dirname(checkupPaths().history), { recursive: true });
    const start = T('2026-10-11T08:00:00Z');
    writeFileSync(checkupPaths().history, `${JSON.stringify({
      v: 1, day: '2026-10-11', from: new Date(start).toISOString(), to: new Date(start + 86400000).toISOString(),
      pct: { main: 1, subagent: 9, total: 10 }, targetPct: 14, vsTargetPct: -4,
      week: { pctSoFar: 30, paceAtResetPct: 90 }, changes: { active: [], switchedOn: [] },
    })}\n`);
    const ctx = go(fx, {}).json.hookSpecificOutput.additionalContext.split('\n');
    assert.equal(ctx.length, 2);
    assert.match(ctx[0], /Daily checkup 2026-10-11/);
    assert.match(ctx[1], /Decision review due/);
  } finally { fx.cleanup(); }
});

test('8. silent with the decision_register option off, with scout_suppress, for a subagent, and for a flag older than 72 h', () => {
  const fx = makeFixture();
  try {
    flagged();
    assert.equal(go(fx, {}, { CLAUDE_PLUGIN_OPTION_DECISION_REGISTER: 'false' }).stdout.trim(), '', 'option off');
    assert.equal(go(fx, {}, { CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'decision_review_due' }).stdout.trim(), '', 'scout_suppress');
    assert.equal(go(fx, { agent_id: 'agent-abc' }).stdout.trim(), '', 'subagent');
    assert.equal(go(fx, { transcript_path: join(fx.dir, 'p', 's', 'subagents', 'agent-q.jsonl') }).stdout.trim(), '', 'subagent by transcript path');
    assert.deepEqual(readState().surfaced, [], 'none of those used up the flag');
    const stale = go(fx, {}, { AGENT_COMPANION_FAKE_NOW: new Date(FLAG_AT + 73 * HOUR).toISOString() });
    assert.equal(stale.stdout.trim(), '', 'older than 72 hours');
    assert.deepEqual(readState().surfaced, [], 'a stale flag is not marked');
    assert.match(go(fx, {}).json.hookSpecificOutput.additionalContext, /Decision review due/, 'and it was still there to show');
  } finally { fx.cleanup(); }
});

test('8. an absent or invalid register prints no line', () => {
  const fx = makeFixture();
  try {
    assert.equal(go(fx, {}).stdout.trim(), '', 'absent');
    flagged();
    putRegister('{ not json');
    assert.equal(go(fx, {}).stdout.trim(), '', 'invalid');
    putRegister({ ...register(), version: 99 });
    assert.equal(go(fx, {}).stdout.trim(), '', 'unknown version');
  } finally { fx.cleanup(); }
});

test('8. decision_review_due stays out of the generic scout line', () => {
  const fx = makeFixture();
  try {
    flagged();
    const dir = join(fx.stateDir, 'state');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scout-latest.json'), JSON.stringify({
      checkedAt: '2026-10-12T09:00:00Z',
      signals: [{ kind: 'decision_review_due', detail: 'decision review due: cache-price', dispatch: 'none' }],
    }));
    const ctx = go(fx, {}).json.hookSpecificOutput.additionalContext;
    assert.doesNotMatch(ctx, /Scout 2026/, 'no scout block for that kind alone');
    assert.match(ctx, /Decision review due: Cost model v1/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------------------
// 12. Integration
// ---------------------------------------------------------------------------------------

function transcriptRoot(fx) {
  const root = join(fx.dir, 'transcripts');
  const f = join(root, 'projA', 's1.jsonl');
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `${JSON.stringify({
    type: 'assistant', timestamp: '2026-10-09T12:00:00Z', requestId: 'r1', uuid: 'u1',
    message: {
      id: 'm1', model: 'claude-sonnet-5-5',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000_000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
    },
  })}\n`);
  return root;
}

const checkup = (fx, root, env = {}) => runScript('scripts/daily-checkup.mjs', ['--root', root, '--now', '2026-10-10T09:00:00Z', '--hold-ms', '0', '--quiet'], { env });

test('12. daily-checkup.mjs calls runRegister after runCheckup: the state file appears', () => {
  const fx = makeFixture();
  try {
    putRegister(register());
    const root = transcriptRoot(fx);
    assert.ok(!existsSync(statePath()));
    const res = checkup(fx, root);
    assert.equal(res.status, 0);
    assert.ok(existsSync(checkupPaths().history), 'the checkup wrote its history');
    assert.ok(existsSync(statePath()), 'the register state file appeared');
    const state = readState();
    assert.equal(state.v, 1);
    assert.ok(state.lastEvalDay, 'it evaluated the latest history day');
    assert.ok(existsSync(detailPath()) === false, 'no open flag, so no details file');
    assert.ok(!existsSync(checkupPaths().lock), 'the lock is released');
  } finally { fx.cleanup(); }
});

test('12. no register, or the option off: the checkup writes no register state', () => {
  const fx = makeFixture();
  try {
    const root = transcriptRoot(fx);
    assert.equal(checkup(fx, root).status, 0);
    assert.ok(existsSync(checkupPaths().history));
    assert.ok(!existsSync(statePath()), 'no register, no state');
  } finally { fx.cleanup(); }
  const fx2 = makeFixture();
  try {
    putRegister(register());
    const root = transcriptRoot(fx2);
    assert.equal(checkup(fx2, root, { CLAUDE_PLUGIN_OPTION_DECISION_REGISTER: 'false' }).status, 0);
    assert.ok(!existsSync(statePath()), 'option off, no state');
  } finally { fx2.cleanup(); }
});

test('12. a broken register never fails the checkup', () => {
  const fx = makeFixture();
  try {
    putRegister('{ broken');
    const root = transcriptRoot(fx);
    const res = checkup(fx, root);
    assert.equal(res.status, 0);
    assert.ok(existsSync(checkupPaths().history));
  } finally { fx.cleanup(); }
});

const CHANGELOG_TEXT = [
  '# Changelog', '', '## 9.0.3', '', '- Fixed a terminal glitch', `- ${ITEM}`, '', '## 9.0.2', '', '- Fixed a typo', '',
].join('\n');
const stubFetch = (body) => async () => ({ ok: true, status: 200, text: async () => body, headers: new Map(), body: null });

function rwArgs(dir, extra = {}) {
  return {
    installed: '9.0.0',
    stateFilePath: join(dir, 'state', 'release-watch.json'),
    detailsFilePath: join(dir, 'state', 'cli-release-details.md'),
    claudeDirPath: join(dir, '.claude'),
    ...extra,
  };
}

test('12. runReleaseWatch calls onParsed once with the full item list on a parsed fetch', async () => {
  const fx = makeFixture();
  try {
    const calls = [];
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: T('2026-10-12T10:00:00Z'), fetchImpl: stubFetch(CHANGELOG_TEXT), onParsed: (p) => calls.push(p) }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((r) => r.version), ['9.0.3', '9.0.2']);
    assert.ok(calls[0][0].items.includes('Fixed a terminal glitch'), 'items the topic filter drops are present');
  } finally { fx.cleanup(); }
});

test('12. onParsed is not called on a network failure, a non-changelog 200, or when the check is not due', async () => {
  const fx = makeFixture();
  try {
    let n = 0;
    const onParsed = () => { n += 1; };
    const t0 = T('2026-10-12T10:00:00Z');
    const failing = async () => { throw new Error('offline'); };
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t0, fetchImpl: failing, onParsed }));
    assert.equal(n, 0, 'network failure, no local cache');
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t0 + 25 * HOUR, fetchImpl: stubFetch('<html>please sign in</html>'), onParsed }));
    assert.equal(n, 0, 'a 200 that is not a changelog');
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t0 + 50 * HOUR, fetchImpl: stubFetch(CHANGELOG_TEXT), onParsed }));
    assert.equal(n, 1);
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t0 + 51 * HOUR, fetchImpl: stubFetch(CHANGELOG_TEXT), onParsed }));
    assert.equal(n, 1, 'inside the 24 h throttle');
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t0 + 80 * HOUR, noNet: true, onParsed }));
    assert.equal(n, 1, 'network disabled and no local cache');
  } finally { fx.cleanup(); }
});

test('12. onParsed is called on the local-cache fallback, and a throwing onParsed changes nothing', async () => {
  const fx = makeFixture();
  try {
    mkdirSync(join(fx.dir, '.claude', 'cache'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'cache', 'changelog.md'), CHANGELOG_TEXT);
    const calls = [];
    const failing = async () => { throw new Error('offline'); };
    const r = await runReleaseWatch(rwArgs(fx.dir, { nowMs: T('2026-10-12T10:00:00Z'), fetchImpl: failing, onParsed: (p) => calls.push(p) }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].version, '9.0.3');
    assert.ok(r, 'still returns');
    const fx2 = r;
    assert.ok(fx2.checked);
    const ok = await runReleaseWatch(rwArgs(fx.dir, {
      stateFilePath: join(fx.dir, 'state', 'second.json'), nowMs: T('2026-10-12T10:00:00Z'), fetchImpl: stubFetch(CHANGELOG_TEXT),
      onParsed: () => { throw new Error('boom'); },
    }));
    assert.ok(ok.signal, 'the release signal is unaffected by a throwing onParsed');
  } finally { fx.cleanup(); }
});

test('12. onParsed feeding the register stores the changelog hit and the details file', async () => {
  const fx = makeFixture();
  try {
    putRegister(register({ triggers: [{ id: 'price-change', premise: 'p1', kind: 'changelog', sinceVersion: '9.0.0', flags: 'i', pattern: 'cache reads? at \\$[0-9.]+' }] }));
    const t = T('2026-10-12T10:00:00Z');
    await runReleaseWatch(rwArgs(fx.dir, { nowMs: t, fetchImpl: stubFetch(CHANGELOG_TEXT), onParsed: (p) => scanChangelogToState(p, { nowT: t }) }));
    const state = readState();
    const hit = state.changelogHits['cache-price/price-change@9.0.3'];
    assert.ok(hit, JSON.stringify(Object.keys(state.changelogHits)));
    assert.equal(hit.count, 1);
    assert.ok(existsSync(detailPath()));
    assert.match(readFileSync(detailPath(), 'utf8'), /cache reads at \$0\.50/);
    // The same fetch again adds nothing.
    assert.deepEqual(scanChangelogToState(parseChangelog(CHANGELOG_TEXT), { nowT: t }).newFlags, []);
    // No register: a quiet no-op.
    putRegister('{ bad');
    assert.deepEqual(scanChangelogToState(parseChangelog(CHANGELOG_TEXT), { nowT: t }), { ok: false });
  } finally { fx.cleanup(); }
});

test('12. the scout records decision_register_invalid and decision_review_due, and honours the option', () => {
  const fx = makeFixture();
  try {
    const env = { AGENT_COMPANION_RELEASE_WATCH_NO_NET: '1', AGENT_COMPANION_FAKE_NOW: '2026-10-12T12:00:00Z' };
    const kinds = (res) => (res.json?.signals || []).map((s) => s.kind);
    putRegister('{ bad');
    const invalid = runScript('scripts/detect.mjs', [], { env, cwd: fx.dir, timeout: 60000 });
    assert.ok(kinds(invalid).includes('decision_register_invalid'), JSON.stringify(kinds(invalid)));
    const off = runScript('scripts/detect.mjs', [], { env: { ...env, CLAUDE_PLUGIN_OPTION_DECISION_REGISTER: 'false' }, cwd: fx.dir, timeout: 60000 });
    assert.ok(!kinds(off).includes('decision_register_invalid'), 'option off');
    flagged();
    const due = runScript('scripts/detect.mjs', [], { env, cwd: fx.dir, timeout: 60000 });
    const sig = (due.json?.signals || []).find((s) => s.kind === 'decision_review_due');
    assert.ok(sig, JSON.stringify(kinds(due)));
    assert.match(sig.detail, /cache-price/);
    assert.ok(!kinds(due).includes('decision_register_invalid'));
    const sup = runScript('scripts/detect.mjs', [], { env: { ...env, CLAUDE_PLUGIN_OPTION_SCOUT_SUPPRESS: 'decision_review_due' }, cwd: fx.dir, timeout: 60000 });
    assert.ok(!kinds(sup).includes('decision_review_due'), 'scout_suppress');
  } finally { fx.cleanup(); }
});

test('12. the CLI --changelog <file> scans that file and flags a hit; --check is unchanged', () => {
  const fx = makeFixture();
  try {
    putRegister(register({ triggers: [{ id: 'price-change', premise: 'p1', kind: 'changelog', sinceVersion: '9.0.0', flags: 'i', pattern: 'cache reads? at \\$[0-9.]+' }] }));
    const file = join(fx.dir, 'CHANGELOG.md');
    writeFileSync(file, CHANGELOG_TEXT);
    const res = runScript('scripts/decision-register.mjs', ['--changelog', file, '--now', '2026-10-12T10:00:00Z']);
    assert.equal(res.status, 0);
    assert.deepEqual(res.json.newFlags, ['cache-price/price-change@9.0.3']);
    assert.equal(res.json.open, 1);
    assert.deepEqual(Object.keys(readState().flags), ['cache-price/price-change@9.0.3']);
    const again = runScript('scripts/decision-register.mjs', ['--evaluate', '--changelog', file, '--now', '2026-10-12T11:00:00Z']);
    assert.deepEqual(again.json.newFlags, [], 'a rescan adds nothing');
    const missing = runScript('scripts/decision-register.mjs', ['--changelog', join(fx.dir, 'nope.md')]);
    assert.equal(missing.status, 0, 'a missing file is a message, not a failure');
    assert.match(missing.stdout, /error/);
    assert.match(runScript('scripts/decision-register.mjs', ['--check']).stdout, /^OK: /);
  } finally { fx.cleanup(); }
});

test('12. the plugin option and the version are declared', () => {
  const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.userConfig.decision_register.type, 'boolean');
  assert.equal(plugin.userConfig.decision_register.default, true);
  const market = JSON.parse(readFileSync(join(PLUGIN_ROOT, '..', '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
  const entry = market.plugins.find((p) => p.name === 'agent-companion');
  assert.equal(plugin.version, '0.31.13');
  assert.equal(entry.version, plugin.version);
});
