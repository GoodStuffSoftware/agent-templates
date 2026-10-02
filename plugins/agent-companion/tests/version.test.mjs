// scripts/version.mjs: which copies of the plugin exist, what version each is
// at, and whether any is behind. Every test builds its copies in a fixture home
// (the CLI cache + installed_plugins.json, a marketplace clone, a desktop-app
// rpm folder) with deliberately mismatched versions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { makeFixture, runScript, PLUGIN_ROOT } from './helpers.mjs';
import { HOUR, FIXTURE_SHA, writeManifest, machine as buildMachine } from './version-fixture.mjs';
import {
  collect, classifyPath, thisCopy, cliCopies, desktopCopies, desktopSessionRoots, marketplaceInfo,
  remoteInfo, lagStartMs, staleBeyondGrace, renderText, parseArgs, redact, STALE_GRACE_MS,
} from '../scripts/version.mjs';

const NOW = Date.parse('2026-10-02T20:00:00.000Z');
const machine = (dir, opts) => buildMachine(dir, NOW, opts);

const run = (fx, extra = []) => {
  const res = runScript('scripts/version.mjs', extra, { cwd: fx.dir, timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  return res;
};

test('all copies at the marketplace version: "all copies current"', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir);
    const res = run(fx, ['--json']);
    assert.equal(res.json.verdict.ok, true);
    assert.equal(res.json.verdict.line, 'all copies current');
    assert.equal(res.json.latest.version, '0.29.24');
    assert.equal(res.json.cli[0].version, '0.29.24');
    assert.equal(res.json.cli[0].gitCommitSha, FIXTURE_SHA);
    assert.equal(res.json.desktop[0].version, '0.29.24');
  } finally { fx.cleanup(); }
});

test('a desktop copy behind the CLI copy: STALE, names the desktop sessions and the fix', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { desktop: '0.29.22' });
    const res = run(fx, ['--json']);
    const v = res.json.verdict;
    assert.equal(v.ok, false);
    assert.match(v.line, /^STALE: desktop copy \(plugin_FIX0\) is 0\.29\.22, latest is 0\.29\.24/);
    assert.match(v.line, /Desktop Code-tab sessions/);
    assert.match(v.line, /restart the desktop app/);
    assert.doesNotMatch(v.line, /CLI cache copy/, 'the CLI copy is current and must not be named');
    const text = run(fx).stdout;
    assert.match(text, /Verdict:\s+STALE: desktop copy/);
    assert.match(text, /Fix \(desktop\):.*claude\.ai.*not fully verified/);
    assert.match(text, /<- STALE/);
  } finally { fx.cleanup(); }
});

test('a CLI copy behind the marketplace: STALE, CLI sessions, claude plugin update', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { cli: '0.29.23', desktop: '0.29.24', marketplace: '0.29.24' });
    const v = run(fx, ['--json']).json.verdict;
    assert.equal(v.ok, false);
    assert.match(v.line, /^STALE: CLI cache copy \(user scope\) is 0\.29\.23, latest is 0\.29\.24 \(CLI sessions run the older plugin\) - fix: run claude plugin update/);
    assert.doesNotMatch(v.line, /desktop copy/);
  } finally { fx.cleanup(); }
});

test('both kinds stale: both are named, in one line', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { cli: '0.29.23', desktop: ['0.29.22', '0.29.24'] });
    const v = run(fx, ['--json']).json.verdict;
    assert.equal(v.stale.length, 2);
    assert.ok(!v.line.includes('\n'));
    assert.match(v.line, /CLI cache copy.*0\.29\.23/);
    assert.match(v.line, /desktop copy \(plugin_FIX0\) is 0\.29\.22/);
    assert.doesNotMatch(v.line, /plugin_FIX1/, 'the current desktop copy is not named');
  } finally { fx.cleanup(); }
});

test('a desktop rpm folder for another plugin, or no manifest, is ignored', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { desktop: '0.29.24' });
    writeManifest(join(fx.dir, 'desktop', 'acct-1', 'org-1', 'rpm', 'plugin_OTHER'), '9.9.9', 'some-other-plugin');
    mkdirSync(join(fx.dir, 'desktop', 'acct-1', 'org-1', 'rpm', 'plugin_EMPTY'), { recursive: true });
    mkdirSync(join(fx.dir, 'desktop', 'acct-1', 'org-1', 'rpm', 'not-a-plugin-dir'), { recursive: true });
    const found = desktopCopies([join(fx.dir, 'desktop')]);
    assert.deepEqual(found.map((c) => c.id), ['plugin_FIX0']);
    assert.equal(found[0].version, '0.29.24');
    assert.ok(found[0].mtime, 'mtime recorded');
  } finally { fx.cleanup(); }
});

test('no desktop app data: reported as none, the verdict is still given', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { desktop: null });
    const res = run(fx);
    assert.match(res.stdout, /Desktop copy:\s+none found/);
    assert.match(res.stdout, /Verdict:\s+all copies current/);
  } finally { fx.cleanup(); }
});

test('nothing installed at all: CANNOT JUDGE rather than "current"', () => {
  const fx = makeFixture();
  try {
    const v = run(fx, ['--json']).json.verdict;
    assert.equal(v.ok, null);
    assert.match(v.line, /^CANNOT JUDGE/);
  } finally { fx.cleanup(); }
});

test('THIS copy is the directory the script runs from, resolved from its own location', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir);
    const j = run(fx, ['--json']).json;
    assert.equal(j.this.path, PLUGIN_ROOT);
    assert.equal(j.this.kind, 'checkout', 'the repo checkout is a git work tree');
    assert.match(j.this.version, /^\d+\.\d+\.\d+$/);
    assert.equal(j.copies.filter((c) => c.isThis).length, 1);
  } finally { fx.cleanup(); }
});

test('classifyPath tells a CLI cache copy, a desktop rpm copy and a marketplace clone apart', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir);
    const claude = m.claude;
    assert.equal(classifyPath(m.cliPath, claude), 'cli-cache');
    assert.equal(classifyPath(m.desktopPaths[0], claude), 'desktop-rpm');
    assert.equal(classifyPath(join(m.marketplacePath, 'plugins', 'agent-companion'), claude), 'marketplace-clone');
    assert.equal(classifyPath(join(fx.dir, 'somewhere-else'), claude), 'unknown');
    assert.equal(classifyPath(PLUGIN_ROOT, claude), 'checkout');
  } finally { fx.cleanup(); }
});

test('when THIS copy is the desktop copy, it is flagged there and judged once', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { desktop: '0.29.22' });
    const r = collect({ root: m.desktopPaths[0], claudeDirPath: m.claude, desktopRoots: [join(fx.dir, 'desktop')], now: NOW });
    assert.equal(r.this.kind, 'desktop-rpm');
    const mine = r.copies.filter((c) => c.isThis);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].kind, 'desktop-rpm');
    assert.equal(mine[0].stale, true);
    assert.equal(r.copies.length, 2, 'CLI + desktop, THIS not listed twice');
    assert.equal(r.verdict.stale.length, 1);
  } finally { fx.cleanup(); }
});

test('a source checkout that is behind or ahead is shown but never judged stale', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { cli: '0.29.24', desktop: null });
    const checkout = join(fx.dir, 'checkout', 'plugins', 'agent-companion');
    writeManifest(checkout, '0.1.0');
    mkdirSync(join(fx.dir, 'checkout', '.git'), { recursive: true });
    const r = collect({ root: checkout, claudeDirPath: m.claude, desktopRoots: [], now: NOW });
    assert.equal(r.this.kind, 'checkout');
    assert.equal(r.this.version, '0.1.0');
    assert.equal(r.verdict.ok, true);
  } finally { fx.cleanup(); }
});

test('lag is counted from when the marketplace published, and only past the 6 hour grace', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { desktop: '0.29.22', publishedMsAgo: 7 * HOUR });
    const old = collect({ root: PLUGIN_ROOT, claudeDirPath: m.claude, desktopRoots: [join(fx.dir, 'desktop')], now: NOW });
    const beyond = staleBeyondGrace(old);
    assert.equal(beyond.length, 1);
    assert.equal(Math.round(beyond[0].behindMs / HOUR), 7);

    const m2 = machine(fx.dir, { desktop: '0.29.22', publishedMsAgo: 5 * HOUR });
    const fresh = collect({ root: PLUGIN_ROOT, claudeDirPath: m2.claude, desktopRoots: [join(fx.dir, 'desktop')], now: NOW });
    assert.equal(fresh.verdict.ok, false, 'stale is still reported by the verdict');
    assert.deepEqual(staleBeyondGrace(fresh), [], '...but the scout waits out the grace');
    assert.equal(STALE_GRACE_MS, 6 * HOUR);
  } finally { fx.cleanup(); }
});

test('with a real marketplace history, lag starts at the OLDEST release newer than the copy', () => {
  const fx = makeFixture();
  try {
    const loc = join(fx.dir, 'mkt');
    const rel = join('plugins', 'agent-companion', '.claude-plugin', 'plugin.json');
    mkdirSync(join(loc, 'plugins', 'agent-companion', '.claude-plugin'), { recursive: true });
    const env = {
      ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x.invalid',
    };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
    const git = (args, extra = {}) => execFileSync('git', args, { cwd: loc, env: { ...env, ...extra }, stdio: 'ignore', windowsHide: true });
    git(['init', '--quiet', '-b', 'main']);
    const releases = [['0.29.22', '2026-09-29T12:00:00Z'], ['0.29.23', '2026-10-02T09:00:00Z'], ['0.29.24', '2026-10-02T18:00:00Z']];
    for (const [v, at] of releases) {
      writeFileSync(join(loc, rel), JSON.stringify({ name: 'agent-companion', version: v }));
      git(['add', '-A']);
      git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `release ${v}`], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
    }
    mkdirSync(join(fx.dir, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(fx.dir, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'agent-templates': { installLocation: loc } }));
    const market = marketplaceInfo(join(fx.dir, '.claude'), 'agent-templates');
    assert.equal(market.version, '0.29.24');
    assert.equal(market.isRepo, true);
    assert.equal(market.publishedFrom, 'release-commit');
    assert.equal(Date.parse(market.publishedAt), Date.parse('2026-10-02T18:00:00Z'));
    // A copy on 0.29.22 has lagged since 0.29.23, not since 0.29.24.
    assert.equal(lagStartMs(market, '0.29.22', 1), Date.parse('2026-10-02T09:00:00Z'));
    assert.equal(lagStartMs(market, '0.29.23', 1), Date.parse('2026-10-02T18:00:00Z'));
    assert.equal(lagStartMs(market, '0.29.24', 1), 1, 'a current copy has no newer release: the fallback');
  } finally { fx.cleanup(); }
});

test('cliCopies reads version, commit and lastUpdated from installed_plugins.json', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { cli: '0.29.23' });
    const [c] = cliCopies(m.claude);
    assert.equal(c.version, '0.29.23');
    assert.equal(c.scope, 'user');
    assert.equal(c.lastUpdated, '2026-10-02T18:46:41.054Z');
    assert.equal(c.gitCommitSha, FIXTURE_SHA);
    assert.equal(c.path, m.cliPath);
  } finally { fx.cleanup(); }
});

test('desktopSessionRoots: Windows, macOS, Linux, a redirected home, and the explicit dir', () => {
  const real = '/real/home';
  const win = desktopSessionRoots({ env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, platform: 'win32', home: real });
  assert.match(win[0].replace(/\\/g, '/'), /AppData\/Roaming\/Claude\/local-agent-mode-sessions$/);
  const mac = desktopSessionRoots({ env: {}, platform: 'darwin', home: real });
  assert.match(mac[0].replace(/\\/g, '/'), /Library\/Application Support\/Claude\/local-agent-mode-sessions$/);
  const lin = desktopSessionRoots({ env: {}, platform: 'linux', home: real });
  assert.match(lin[0].replace(/\\/g, '/'), /\.config\/Claude\/local-agent-mode-sessions$/);
  assert.deepEqual(desktopSessionRoots({ env: { AGENT_COMPANION_DESKTOP_DIR: '/elsewhere' }, platform: 'linux', home: real }), ['/elsewhere']);
  // The suite's sandbox: home is redirected, so the real APPDATA is not used.
  const sandboxed = desktopSessionRoots({ env: { APPDATA: 'C:\\REAL\\AppData' }, platform: 'win32' });
  assert.ok(!/REAL/.test(sandboxed[0]), `real APPDATA leaked into ${sandboxed[0]}`);
});

// --- origin/main (optional, time-boxed) ---------------------------------------

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
const SRC = 'https://github.com/example-owner/example-repo.git';

test('remoteInfo: gh api returns origin/main\'s version', () => {
  const calls = [];
  const r = remoteInfo({
    sourceUrl: SRC, env: {},
    run: (cmd, args) => { calls.push([cmd, ...args]); return ok(JSON.stringify({ name: 'agent-companion', version: '0.29.30' })); },
  });
  assert.deepEqual({ ok: r.ok, via: r.via, version: r.version }, { ok: true, via: 'gh api', version: '0.29.30' });
  assert.equal(calls.length, 1);
  assert.match(calls[0].join(' '), /repos\/example-owner\/example-repo\/contents\/plugins\/agent-companion\/\.claude-plugin\/plugin\.json\?ref=main/);
});

test('remoteInfo: a gh timeout falls back to git ls-remote, which gives the commit only', () => {
  const sha = 'a'.repeat(40);
  const r = remoteInfo({
    sourceUrl: SRC, env: {}, marketplaceCommit: sha, timeoutMs: 50,
    run: (cmd) => (cmd === 'git'
      ? ok(`${sha}\trefs/heads/main\n`)
      : { status: null, error: Object.assign(new Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'git ls-remote');
  assert.equal(r.version, null);
  assert.equal(r.sameCommitAsMarketplace, true);
  assert.match(r.note, /gh api timed out after 50 ms/);
  assert.match(r.note, /version is not readable/);
});

test('remoteInfo: everything failing is { ok: false } with a reason, never a throw', () => {
  const r = remoteInfo({
    sourceUrl: SRC, env: {}, timeoutMs: 10,
    run: () => ({ status: null, error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /gh api timed out/);
  assert.match(r.error, /git ls-remote timed out/);
  const noUrl = remoteInfo({ sourceUrl: null, run: () => { throw new Error('must not run'); } });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /no GitHub source url/);
});

test('remoteInfo: tokens in a child process\'s error text never reach the result', () => {
  const secret = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_');
  const r = remoteInfo({
    sourceUrl: SRC, env: {},
    run: () => ({ status: 1, stdout: '', stderr: `HTTP 401: bad credentials, token ${secret}\nmore` }),
  });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(secret), r.error);
  assert.match(r.error, /redacted/);
  assert.ok(!redact(`Authorization: Bearer ${secret}`).includes(secret));
  assert.ok(!redact(`https://user:${secret}@github.com/x.git`).includes(secret));
});

test('collect with a remote newer than the marketplace: latest comes from origin/main and the marketplace is behind', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { desktop: '0.29.24' });
    // A github.com source, so the injected runner is consulted (it never reaches the network).
    writeFileSync(join(m.claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'agent-templates': { source: { source: 'git', url: SRC }, installLocation: m.marketplacePath },
    }));
    const r = collect({
      root: PLUGIN_ROOT, claudeDirPath: m.claude, desktopRoots: [join(fx.dir, 'desktop')], remote: true, now: NOW,
      run: () => ok(JSON.stringify({ version: '0.29.30' })),
    });
    assert.equal(r.latest.version, '0.29.30');
    assert.equal(r.latest.from, 'origin/main');
    assert.equal(r.marketplaceBehindRemote, true);
    assert.equal(r.verdict.ok, false);
    assert.match(r.verdict.line, /marketplace clone is 0\.29\.24, origin\/main is 0\.29\.30 - fix: run claude plugin marketplace update/);
    assert.match(r.verdict.line, /CLI cache copy.*0\.29\.24, latest is 0\.29\.30/);
    // The lag clock only runs against a marketplace release: none claimed here.
    assert.deepEqual(staleBeyondGrace(r), []);
  } finally { fx.cleanup(); }
});

test('--remote with no usable source stays graceful: exit 0, the report, an "unavailable" note', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir, { desktop: '0.29.22' });
    const res = runScript('scripts/version.mjs', ['--remote', '--json', '--timeout', '500'], {
      cwd: fx.dir,
      env: { AGENT_COMPANION_GH_BIN: join(fx.dir, 'no-such-gh') },
      timeout: 30000,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.json.remote.ok, false);
    assert.match(res.json.remote.error, /no GitHub source url/);
    assert.ok(res.json.verdict.line.startsWith('STALE: desktop copy'), res.json.verdict.line);
    const text = runScript('scripts/version.mjs', ['--remote'], { cwd: fx.dir, timeout: 30000 }).stdout;
    assert.match(text, /origin\/main:\s+unavailable - no GitHub source url/);
  } finally { fx.cleanup(); }
});

test('the report never contains a token from the environment', () => {
  const fx = makeFixture();
  try {
    machine(fx.dir);
    const secret = ['ghp', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'].join('_');
    const res = runScript('scripts/version.mjs', ['--json'], { cwd: fx.dir, env: { GH_TOKEN: secret, GITHUB_TOKEN: secret }, timeout: 30000 });
    assert.equal(res.status, 0);
    assert.ok(!res.stdout.includes(secret) && !res.stderr.includes(secret));
  } finally { fx.cleanup(); }
});

test('renderText and parseArgs', () => {
  const fx = makeFixture();
  try {
    const m = machine(fx.dir, { desktop: '0.29.22' });
    const r = collect({ root: PLUGIN_ROOT, claudeDirPath: m.claude, desktopRoots: [join(fx.dir, 'desktop')], now: NOW });
    const t = renderText(r);
    for (const label of ['THIS copy:', 'CLI cache:', 'Desktop copy:', 'Marketplace:', 'origin/main:', 'Verdict:']) assert.ok(t.includes(label), label);
    assert.match(t, /origin\/main:\s+not checked \(add --remote\)/);
    assert.deepEqual(parseArgs(['--json', '--remote', '--timeout', '2500']), { json: true, remote: true, timeoutMs: 2500, help: false });
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['--timeout', 'x']), /positive number/);
  } finally { fx.cleanup(); }
});

test('an unknown flag exits 2 with usage', () => {
  const res = runScript('scripts/version.mjs', ['--bogus']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: node version\.mjs/);
});

test('thisCopy reads a plain directory\'s manifest', () => {
  const d = mkdtempSync(join(tmpdir(), 'ac-this-'));
  try {
    writeManifest(d, '1.2.3');
    assert.equal(thisCopy(d, join(d, 'nowhere')).version, '1.2.3');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
