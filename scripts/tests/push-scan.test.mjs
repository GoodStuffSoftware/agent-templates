// Tests for scripts/push-scan.mjs (the pushed-commit leak scan) and its wiring
// into the pre-push gate (ci-local.mjs prePushGate).
//
// Every "private name" here is SYNTHETIC — generated at run time, or a
// made-up word (zorblax, ann) — never read from the real denylist file. The
// denylist the scan sees is a throwaway one under a temp
// AGENT_COMPANION_STATE_DIR. Assertions that text is ABSENT from output carry
// their own message, so a failure never echoes the output it inspected.
//
// Every non-ASCII test input is written as a \u escape (the only literal
// non-ASCII characters are the em dashes of the output being matched).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  compileDenyEntry, parseDenylist, matchDenylist, denylistPath, denylistDisplayPath,
  loadDenylist, decodeDenylist, isNameBoundary, parseRawDiffZ, newLines, makeRedactor,
  escapeControls, scrubHome, formatHits, resolveMaxFileBytes, runPushScan, listPushedCommits,
  resolvePublicTips, decodeEscapes, compressedKind, utf16leOf, scanGitEnv,
  REDACTED, REDACTED_PATH, REDACTED_REF,
} from '../push-scan.mjs';
import { buildScanContext } from '../leak-check.mjs';
import { prePushGate, scrubHomeDir, parsePrePushStdin } from '../ci-local.mjs';
import { cleanGitEnv } from '../../plugins/agent-companion/scripts/lib/git-env.mjs';

const temps = [];
test.after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

// A fresh, letters-only synthetic name (no digits: never SHA-like).
function synth(prefix = 'q') {
  return prefix + Array.from(randomBytes(10), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26]).join('');
}

// `s` (lowercase ASCII letters) in fullwidth form (U+FF41..U+FF5A).
const fullwidth = (s) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) - 0x61 + 0xff41)).join('');

const ZERO = '0'.repeat(40);

// Asserts none of `names` appears in `out` in any case, nor in fullwidth
// form. The message never includes `out`.
function assertNoName(out, names, what = 'output') {
  const lower = String(out).toLowerCase();
  for (const n of names) {
    assert.ok(!lower.includes(n.toLowerCase()), `a synthetic name was printed in the ${what}`);
    assert.ok(!String(out).includes(fullwidth(n.toLowerCase())), `a synthetic name (fullwidth) was printed in the ${what}`);
  }
}

// Asserts `out` carries no raw control character other than the newlines
// between lines (a TAB, ESC, CR or NUL in a printed path must be escaped).
function assertNoControls(out) {
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e]/.test(String(out)), 'a raw control character was printed');
}

// A throwaway repo with a bare "origin" remote (a second bare repo, "priv",
// is added on demand). publish(sha, name) puts `sha` on origin as
// refs/heads/<name> AND sets refs/remotes/origin/<name>, as a push plus a
// fetch would: the commit is then public on the destination the scan checks.
function makeRepo(identity = {}) {
  const repo = tmp('push-scan-repo-');
  const origin = tmp('push-scan-origin-');
  const env = cleanGitEnv(process.env, {
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...identity,
  });
  const runIn = (cwd, args, input) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], {
      cwd, env, input, windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr)}`);
    return r.stdout.toString('utf8').trim();
  };
  const run = (args, input) => runIn(repo, args, input);
  const git = (...args) => run(args);
  git('init', '-q', '-b', 'main');
  runIn(origin, ['init', '-q', '--bare']);
  git('remote', 'add', 'origin', origin);
  const commit = (files, message = 'change') => {
    for (const [name, body] of Object.entries(files)) {
      const p = join(repo, name);
      if (body === null) unlinkSync(p);
      else {
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, body);
      }
    }
    git('add', '-A');
    const msgFile = join(tmp('push-scan-msg-'), 'msg.txt');
    writeFileSync(msgFile, message);
    git('commit', '-q', '-F', msgFile);
    return git('rev-parse', 'HEAD');
  };
  // A tree from [[name, value], ...]: `name` a string or Buffer (any bytes but
  // NUL and "/"), `value` file content (string/Buffer), a nested entry list
  // (a subdirectory) or { gitlink: sha }. Built with hash-object/mktree, so
  // no path ever touches the filesystem (NTFS refuses TAB, \x01, ...).
  const tree = (entries) => {
    const parts = [];
    for (const [name, value] of entries) {
      let line;
      if (Array.isArray(value)) line = `040000 tree ${tree(value)}\t`;
      else if (value && value.gitlink) line = `160000 commit ${value.gitlink}\t`;
      else line = `100644 blob ${run(['hash-object', '-w', '--stdin'], Buffer.from(value))}\t`;
      parts.push(Buffer.from(line, 'latin1'), Buffer.from(name), Buffer.from([0]));
    }
    return run(['mktree', '-z'], Buffer.concat(parts));
  };
  // A commit of `entries` on top of `parents`, with a raw-bytes message.
  const rawCommit = (entries, { parents = [], message = 'change\n' } = {}) => {
    const msgFile = join(tmp('push-scan-msg-'), 'msg.txt');
    writeFileSync(msgFile, message);
    return run(['commit-tree', tree(entries), ...parents.flatMap((p) => ['-p', p]), '-F', msgFile]);
  };
  // Put `sha` on the bare repo `remoteDir` as refs/heads/<name>, with no hook
  // involved (the bare repo fetches it).
  const putOn = (remoteDir, sha, name) => runIn(remoteDir, ['fetch', '-q', repo, `+${sha}:refs/heads/${name}`]);
  // Mark `sha` as already public: on origin, and on its remote-tracking ref.
  const publish = (sha, name = 'main') => {
    putOn(origin, sha, name);
    git('update-ref', `refs/remotes/origin/${name}`, sha);
  };
  return { repo, origin, git, runIn, putOn, commit, rawCommit, publish, env };
}

// A state dir whose denylist is `content`: an array of lines, a Buffer (raw
// bytes), 'dir' (a directory in its place) or null (missing).
function stateDirWith(content) {
  const dir = tmp('push-scan-state-');
  if (content === null) return dir;
  mkdirSync(join(dir, 'config'), { recursive: true });
  const p = join(dir, 'config', 'private-names.txt');
  if (content === 'dir') mkdirSync(p);
  else writeFileSync(p, Buffer.isBuffer(content) ? content : `${content.join('\n')}\n`);
  return dir;
}

// Scan with a captured console, the throwaway denylist, and leak-check's
// static + path classes (derived names off: a fixture must not depend on
// this machine's project directories). A push goes to "origin" (the repo's
// bare remote, found through git ls-remote) unless `remote` says otherwise.
function scan(repo, { stateDir, pushes, commits, env: extraEnv = {}, ...rest }) {
  const out = [];
  const env = { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir, ...extraEnv };
  const leakCtx = buildScanContext({ root: repo, noDerived: true, quiet: true, user: 'fixtureuser' }, {});
  const res = runPushScan({
    repo, pushes, commits, env, leakCtx, remote: 'origin', log: (m) => out.push(m), err: (m) => out.push(m), ...rest,
  });
  return { ...res, output: out.join('\n') };
}

// A pre-push stdin line object, as ci-local's parser gives it.
const pushOf = (localSha, remoteRef, remoteSha = ZERO, localRef = remoteRef) => ({ localRef, localSha, remoteRef, remoteSha });

// Hit lines only ("  <sha12>  <where>  [<check>: <label>]"), trimmed.
const hitLines = (output) => output.split('\n').filter((l) => /^ {2}[0-9a-f]{12} {2}/.test(l)).map((l) => l.trim());

// ---------------------------------------------------------------------------
// F8: match semantics (a table)
// ---------------------------------------------------------------------------

const hits = (entry, text) => matchDenylist(text, parseDenylist(entry).entries).length > 0;

test('denylist literal: word boundaries include lower->Upper, acronym ends and letter<->digit; "ann" never hits "annotation"', () => {
  const table = [
    // entry "ann"
    ['ann', 'ann', true],
    ['ann', 'Ann', true],
    ['ann', 'ANN', true],
    ['ann', "Ann's notes", true],
    ['ann', 'ann-notes', true],
    ['ann', 'ann_x', true],
    ['ann', '(ann)', true],
    ['ann', 'path/ann/x', true],
    ['ann', 'x.ann', true],
    ['ann', 'getAnnName', true],      // lower->Upper on both sides
    ['ann', 'annFoo', true],          // lower->Upper after
    ['ann', 'fooAnn', true],          // lower->Upper before
    ['ann', 'ANNFoo', true],          // an acronym that ends before "Foo"
    ['ann', 'XMLAnn', true],          // an acronym that ends before "Ann"
    ['ann', 'ann2', true],            // letter->digit
    ['ann', '2ann', true],            // digit->letter
    ['ann', '1ann1', true],
    ['ann', 'annotation', false],
    ['ann', 'Annotation', false],
    ['ann', 'ANNOTATION', false],
    ['ann', 'ANNotation', false],     // Upper->lower is not a boundary
    ['ann', 'getAnnotation', false],
    ['ann', 'joann', false],
    ['ann', 'JOANN', false],
    ['ann', 'banner', false],
    ['ann', 'plann', false],
    ['ann', 'nann', false],
    ['ann', 'annotate2', false],
    // a made-up project name
    ['zorblax', 'fooZorblaxBar', true],
    ['zorblax', 'getZorblax', true],
    ['zorblax', 'zorblax2', true],
    ['zorblax', 'zorblaxV2', true],
    ['zorblax', 'ZorblaxService', true],
    ['zorblax', 'XMLZorblax', true],
    ['zorblax', 'zorblax_id', true],
    ['zorblax', 'x-zorblax-y', true],
    ['zorblax', 'ZORBLAX', true],
    ['zorblax', 'https://example.com/zorblax/page', true],
    ['zorblax', 'zorblaxing', false],
    ['zorblax', 'unzorblax', false],
    ['zorblax', 'Zorblaxes', false],
    ['zorblax', 'ZORBLAXES', false],
    // an entry that is itself camelCase
    ['fooBar', 'fooBar', true],
    ['fooBar', 'myFooBar', true],
    ['fooBar', 'fooBarBaz', true],
    ['fooBar', 'foobarbaz', false],
    // other forms of the text (NFKC, invisible characters)
    ['zorblax', `x ${fullwidth('zorblax')} y`, true],
    ['zorblax', 'x zorb\u200blax y', true],
    ['ren\u00e9e', 'x Rene\u0301e y', true], // decomposed (NFD) text, composed entry
    ['ren\u00e9e', 'x renee y', false],
  ];
  const wrong = table.filter(([entry, text, want]) => hits(entry, text) !== want)
    .map(([entry, text, want]) => `${JSON.stringify(entry)} vs ${JSON.stringify(text)}: expected ${want ? 'HIT' : 'no hit'}`);
  assert.deepEqual(wrong, []);
});

test('isNameBoundary: the gap rules, one by one', () => {
  const at = (s, i) => isNameBoundary(s, i);
  assert.equal(at('ab', 0), true, 'start of text');
  assert.equal(at('ab', 2), true, 'end of text');
  assert.equal(at('a-b', 1), true, 'a non-word neighbour');
  assert.equal(at('ab', 1), false, 'lower->lower');
  assert.equal(at('aB', 1), true, 'lower->Upper');
  assert.equal(at('Ab', 1), false, 'Upper->lower');
  assert.equal(at('ABc', 1), true, 'Upper->Upper then lower: an acronym ends');
  assert.equal(at('ABC', 1), false, 'Upper->Upper->Upper');
  assert.equal(at('a2', 1), true, 'letter->digit');
  assert.equal(at('2a', 1), true, 'digit->letter');
  assert.equal(at('12', 1), false, 'digit->digit');
});

test('denylist: a synthetic multi-part name matches as a literal, not a regex', () => {
  const name = `${synth()}.${synth()}`;
  const m = compileDenyEntry(name);
  assert.ok(m.test(`see ${name.toUpperCase()} here`));
  assert.ok(!m.test(name.replace('.', 'x')), 'the dot is literal');
});

test('denylist: "re:" entries are case-insensitive regexes; comments and blanks are ignored; a bad or empty-matching regex is reported by line only', () => {
  const a = synth();
  const parsed = parseDenylist(['# comment', '', `re:${a}-[a-z]`, 're:(unclosed', `  ${synth()}  `, 're:x*'].join('\n'));
  assert.deepEqual(parsed.invalid, [4, 6]);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((e) => e.lineNo), [3, 5]);
  assert.deepEqual(matchDenylist(`x\n${a.toUpperCase()}-q`, parsed.entries), [{ entryLine: 3, line: 2 }]);
});

test('denylistPath: <stateRoot>/config/private-names.txt, honouring AGENT_COMPANION_STATE_DIR and CLAUDE_CONFIG_DIR', () => {
  assert.equal(denylistPath({ AGENT_COMPANION_STATE_DIR: join('S', 'root') }), join('S', 'root', 'config', 'private-names.txt'));
  assert.equal(denylistPath({ CLAUDE_CONFIG_DIR: join('C', 'cfg') }), join('C', 'cfg', 'agent-companion', 'config', 'private-names.txt'));
});

// ---------------------------------------------------------------------------
// F6: a denylist that exists but cannot be read or decoded BLOCKS
// ---------------------------------------------------------------------------

test('decodeDenylist: UTF-8 (with or without a BOM) decodes; UTF-16 (either BOM, or none) and invalid UTF-8 are errors', () => {
  const name = synth();
  assert.equal(decodeDenylist(Buffer.from(`${name}\n`)).text, `${name}\n`);
  assert.equal(decodeDenylist(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${name}\n`)])).text, `${name}\n`);
  const utf16le = Buffer.from(`${name}\r\n`, 'utf16le');
  const utf16be = Buffer.from(utf16le).swap16();
  for (const [what, buf, why] of [
    ['UTF-16LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]), /is UTF-16 encoded/],
    ['UTF-16BE with a BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]), /is UTF-16 encoded/],
    ['UTF-16LE without a BOM', utf16le, /contains NUL bytes/],
    ['invalid UTF-8', Buffer.concat([Buffer.from(`${name}\n`), Buffer.from([0xc3, 0x28, 0x0a])]), /is not valid UTF-8/],
  ]) {
    const d = decodeDenylist(buf);
    assert.ok(d.error, `${what} must be an error`);
    assert.match(d.error, why, what);
    assertNoName(d.error, [name], `${what} error`);
  }
});

test('loadDenylist: ENOENT is "missing"; a directory, a permission error or any other read error is an error, never "missing"', () => {
  const missing = loadDenylist(join(tmp('push-scan-none-'), 'config', 'private-names.txt'));
  assert.equal(missing.missing, true);
  assert.equal(missing.error, null);
  const dir = stateDirWith('dir');
  const isDir = loadDenylist(join(dir, 'config', 'private-names.txt'));
  assert.equal(isDir.missing, false);
  assert.match(isDir.error, /directory/);
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO']) {
    const r = loadDenylist('x', { readFile: () => { throw Object.assign(new Error(`${code}: ${homedir()}`), { code }); } });
    assert.equal(r.missing, false, code);
    assert.equal(r.error, `could not be read (${code})`);
  }
  const odd = loadDenylist('x', { readFile: () => { throw new Error('no code'); } });
  assert.equal(odd.missing, false);
  assert.equal(odd.error, 'could not be read (unknown error)');
});

test('an unreadable or undecodable denylist BLOCKS the push, and its contents are never printed', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const cases = [
    ['a directory', stateDirWith('dir'), /exists but is a directory/],
    ['UTF-16LE with a BOM', stateDirWith(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${name}\r\n`, 'utf16le')])), /UTF-16/],
    ['UTF-16LE without a BOM', stateDirWith(Buffer.from(`${name}\r\n`, 'utf16le')), /NUL bytes/],
    ['invalid UTF-8', stateDirWith(Buffer.concat([Buffer.from(`${name}\n`), Buffer.from([0xff, 0x0a])])), /not valid UTF-8/],
  ];
  for (const [what, stateDir, why] of cases) {
    const r = scan(repo, { stateDir, commits: [sha] });
    assert.equal(r.status, 1, `${what} must block`);
    assert.match(r.output, /push-scan: BLOCKED — the private-names denylist \(\$AGENT_COMPANION_STATE_DIR\/config\/private-names\.txt\) exists but/);
    assert.match(r.output, why);
    assert.match(r.output, /Its contents are not shown/);
    assertNoName(r.output, [name], `${what} output`);
    assert.ok(!r.output.includes(stateDir), `${what}: the state dir was printed`);
  }
  // A permission error, injected (chmod cannot make a file unreadable on Windows).
  const denied = scan(repo, {
    stateDir: stateDirWith([name]), commits: [sha],
    readDenylistFile: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
  });
  assert.equal(denied.status, 1);
  assert.match(denied.output, /exists but could not be read \(EACCES\)/);
  // It blocks even when there is nothing to scan.
  assert.equal(scan(repo, { stateDir: stateDirWith('dir'), commits: [] }).status, 1);
});

test('a UTF-8 BOM denylist works; a missing one warns ONCE and the scan continues; an empty one warns', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const bad = commit({ 'a.txt': `${name}\n` });
  const bom = scan(repo, { stateDir: stateDirWith(Buffer.from(`\ufeff${name}\n`)), commits: [bad] });
  assert.equal(bom.status, 1, 'the first entry after a BOM still matches');

  const clean = commit({ 'a.txt': 'clean\n' });
  const missing = scan(repo, { stateDir: stateDirWith(null), commits: [clean] });
  assert.equal(missing.status, 0);
  assert.equal(missing.warnings.length, 1);
  assert.doesNotMatch(missing.warnings[0], /\n/);
  assert.match(missing.warnings[0], /no private-names denylist at \$AGENT_COMPANION_STATE_DIR\/config\/private-names\.txt/);
  assert.match(missing.output, /1 commit\(s\) scanned/);

  for (const lines of [[], ['# only a comment']]) {
    const empty = scan(repo, { stateDir: stateDirWith(lines), commits: [clean] });
    assert.equal(empty.status, 0);
    assert.equal(empty.warnings.length, 1);
    assert.match(empty.warnings[0], /has no entries/);
  }
});

test('an invalid re: entry blocks and names the denylist line, not its text', () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const bad = `re:(${synth()}`;
  const r = scan(repo, { stateDir: stateDirWith(['# header', bad]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /denylist line\(s\) 2 are not valid regexes/);
  assert.ok(!r.output.includes(bad.slice(4)), 'the entry text was printed');
});

// ---------------------------------------------------------------------------
// F7: no home path in any warning
// ---------------------------------------------------------------------------

test('denylistDisplayPath: through the variable that set it, else ~-relative — never an expanded path', () => {
  assert.equal(denylistDisplayPath({ AGENT_COMPANION_STATE_DIR: 'X' }), '$AGENT_COMPANION_STATE_DIR/config/private-names.txt');
  assert.equal(denylistDisplayPath({ CLAUDE_CONFIG_DIR: 'X' }), '$CLAUDE_CONFIG_DIR/agent-companion/config/private-names.txt');
  assert.equal(denylistDisplayPath({}), '~/.claude/agent-companion/config/private-names.txt');
});

test('the missing-denylist warning with no overrides prints the ~ path, not the home directory', () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const env = { ...process.env };
  delete env.AGENT_COMPANION_STATE_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.AGENT_COMPANION_HOME_OVERRIDE;
  const out = [];
  const leakCtx = buildScanContext({ root: repo, noDerived: true, quiet: true, user: 'fixtureuser' }, {});
  const r = runPushScan({
    repo, commits: [sha], env, leakCtx, log: (m) => out.push(m), err: (m) => out.push(m),
    readDenylistFile: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.equal(r.status, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /no private-names denylist at ~\/\.claude\/agent-companion\/config\/private-names\.txt;/);
  const text = out.join('\n');
  for (const v of [homedir(), homedir().replace(/\\/g, '/')]) {
    assert.ok(!text.toLowerCase().includes(v.toLowerCase()), 'the home directory was printed');
  }
});

test('scrubHome / scrubHomeDir: native, forward-slash, MSYS and any-case spellings of the home dir become ~', () => {
  const user = synth('u');
  const home = `C:\\Users\\${user}`;
  const s = `a C:\\Users\\${user}\\x b C:/Users/${user}/y c /c/Users/${user}/z d c:\\users\\${user.toUpperCase()}\\w`;
  for (const f of [scrubHome, scrubHomeDir]) {
    const out = f(s, home);
    assert.equal(out, 'a ~\\x b ~/y c ~/z d ~\\w');
  }
  assert.equal(scrubHome(`/home/${user}/p`, `/home/${user}`), '~/p');
});

test('a leak-check derivation error naming the home directory is printed with ~', () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const out = [];
  const r = runPushScan({
    repo, commits: [sha], env: { ...process.env, AGENT_COMPANION_STATE_DIR: stateDirWith([synth()]) },
    leakCtx: { error: `cannot read token file ${join(homedir(), 'tokens.txt')}` },
    log: (m) => out.push(m), err: (m) => out.push(m),
  });
  assert.equal(r.status, 1);
  const text = out.join('\n');
  assert.match(text, /leak-check could not derive its names: cannot read token file ~/);
  assert.ok(!text.toLowerCase().includes(homedir().toLowerCase()), 'the home directory was printed');
});

// ---------------------------------------------------------------------------
// F1: a printed path never carries a matched name
// ---------------------------------------------------------------------------

test('parseRawDiffZ: NUL-separated, byte-exact paths — spaces, TABs, newlines and quotes are never unquoted or trimmed', () => {
  const oid = 'a'.repeat(40);
  const z = ZERO;
  const buf = Buffer.concat([
    Buffer.from(`:000000 100644 ${z} ${oid} A\0`), Buffer.from('docs/my notes.md\0'),
    Buffer.from(`:100644 100644 ${oid} ${oid} R087\0`), Buffer.from('old\tname\0'), Buffer.from('new "x"\nname\0'),
    Buffer.from(`:100644 000000 ${oid} ${z} D\0`), Buffer.from([0x63, 0xe9, 0x2e, 0x74, 0]),
  ]);
  const e = parseRawDiffZ(buf);
  assert.deepEqual(e.map((x) => [x.status, x.src && x.src.text, x.dst.text]), [
    ['A', null, 'docs/my notes.md'],
    ['R', 'old\tname', 'new "x"\nname'],
    ['D', null, e[2].dst.text],
  ]);
  assert.equal(e[2].dst.key, 'c\u00e9.t', 'a non-UTF-8 path keeps its bytes in the latin1 key');
  assert.equal(e[2].dst.latin1, 'c\u00e9.t');
  assert.equal(e[0].dst.latin1, null, 'plain ASCII has no separate latin1 reading');
});

test('displayPath: each match becomes [redacted]; controls are escaped; a path that still matches in any form is withheld', () => {
  const name = 'zorblax';
  const other = synth();
  const r = makeRedactor({ entries: parseDenylist([name, other].join('\n')).entries });
  const p = (text, latin1 = null) => ({ text, latin1 });
  assert.equal(r.displayPath(p(`docs/${name} notes.md`)), `docs/${REDACTED} notes.md`);
  assert.equal(r.displayPath(p(`my docs/${name}.md`)), `my docs/${REDACTED}.md`);
  assert.equal(r.displayPath(p(`q\x01${name}.txt`)), `q\\x01${REDACTED}.txt`);
  assert.equal(r.displayPath(p(`q\t${name}.txt`)), `q\\x09${REDACTED}.txt`);
  assert.equal(r.displayPath(p(`a\nb/${name}\x1b[2J.txt`)), `a\\x0ab/${REDACTED}\\x1b[2J.txt`);
  assert.equal(r.displayPath(p(`docs/caf\u00e9-${name}.md`)), `docs/caf\u00e9-${REDACTED}.md`);
  assert.equal(r.displayPath(p(`docs/\u202e${name}.md`)), `docs/\\u202e${REDACTED}.md`);
  assert.equal(r.displayPath(p(`docs/my notes.md`)), 'docs/my notes.md', 'a clean path is printed as is');
  assert.equal(r.displayPath(p('docs/annotation.md')), 'docs/annotation.md');
  // Forms that cannot be cut out cleanly: withhold the whole path.
  assert.equal(r.displayPath(p(`docs/${fullwidth(name)}.md`)), REDACTED_PATH, 'fullwidth');
  assert.equal(r.displayPath(p(`docs/zorb\u200blax.md`)), REDACTED_PATH, 'zero-width split');
  assert.equal(r.displayPath(p(`docs/zorb\x01lax.md`)), REDACTED_PATH, 'split by a control character');
  assert.equal(r.displayPath(p('x\ufffd-.md', `x\u00e9-${name}.md`)), REDACTED_PATH, 'a hit only in the latin1 reading');
  for (const s of [`docs/${name} notes.md`, `q\t${name}`, `docs/${fullwidth(name)}.md`]) {
    assertNoName(r.displayPath(p(s)), [name]);
    assertNoControls(r.displayPath(p(s)));
  }
});

test('formatHits: prints only the SHA, the place and the check; the default withholds every path', () => {
  const sha = 'b'.repeat(40);
  const file = { text: 'docs/secret.md', latin1: null };
  const lines = formatHits([
    { sha, where: 'diff', file, line: 3, binary: true, check: 'private-names', label: 'denylist line 2' },
    { sha, where: 'message', line: 1, check: 'leak-check', label: 'git-sha-like' },
    { sha, where: 'path', file, check: 'private-names', label: 'denylist line 2' },
  ]);
  assert.deepEqual(lines, [
    `  ${'b'.repeat(12)}  ${REDACTED_PATH}:3 (binary)  [private-names: denylist line 2]`,
    `  ${'b'.repeat(12)}  commit message:1  [leak-check: git-sha-like]`,
    `  ${'b'.repeat(12)}  path ${REDACTED_PATH}  [private-names: denylist line 2]`,
  ]);
});

test('paths with spaces, TABs, control characters and unicode: a content hit prints the path with every name cut out, and no raw control character', () => {
  const name = synth();
  const other = synth();
  const { repo, rawCommit } = makeRepo();
  const cases = [
    // [what, tree entries, expected where (null: only check absence)]
    ['space in a named file', [['docs', [[`${name} notes.md`, `${other}\n`]]]], `docs/${REDACTED} notes.md:1`],
    ['space, leak-check content', [['docs', [[`${name} notes2.md`, `see ${randomBytes(20).toString('hex')}\n`]]]], `docs/${REDACTED} notes2.md:1`],
    ['space in a directory', [['my docs', [[`${name}.md`, `${other}\n`]]]], `my docs/${REDACTED}.md:1`],
    ['clean path with a space', [['docs', [['my notes.md', `${other}\n`]]]], 'docs/my notes.md:1'],
    ['clean path with a TAB', [['docs', [['a\tb.md', `${other}\n`]]]], 'docs/a\\x09b.md:1'],
    ['TAB and a name', [[`q\t${name}.txt`, `${other}\n`]], `q\\x09${REDACTED}.txt:1`],
    ['\\x01 and a name', [[`q\x01${name}.txt`, `${other}\n`]], `q\\x01${REDACTED}.txt:1`],
    ['newline, quote and backslash', [[`n\n"${name}"\\.txt`, `${other}\n`]], `n\\x0a"${REDACTED}"\\.txt:1`],
    ['ESC sequence', [[`e\x1b[31m-${name}.txt`, `${other}\n`]], `e\\x1b[31m-${REDACTED}.txt:1`],
    ['unicode', [['docs', [[`caf\u00e9 ${name} \u6587.md`, `${other}\n`]]]], `docs/caf\u00e9 ${REDACTED} \u6587.md:1`],
    ['bidi override', [[`\u202e${name}.txt`, `${other}\n`]], `\\u202e${REDACTED}.txt:1`],
    ['fullwidth name', [[`${fullwidth(name)}.txt`, `${other}\n`]], `${REDACTED_PATH}:1`],
    ['zero-width split name', [[`${name.slice(0, 4)}\u200b${name.slice(4)}.txt`, `${other}\n`]], `${REDACTED_PATH}:1`],
    ['not valid UTF-8', [[Buffer.concat([Buffer.from([0x78, 0xe9, 0x2d]), Buffer.from(`${name}.txt`)]), `${other}\n`]], `${REDACTED_PATH}:1`],
  ];
  const stateDir = stateDirWith([name, other]);
  for (const [what, entries, where] of cases) {
    const sha = rawCommit(entries);
    const r = scan(repo, { stateDir, commits: [sha] });
    assert.equal(r.status, 1, `${what}: must block`);
    assertNoName(r.output, [name, other], `${what} output`);
    assertNoControls(r.output);
    const lines = hitLines(r.output);
    const diffLine = lines.find((l) => !l.includes(' path ') && !l.includes('commit message'));
    assert.ok(diffLine, `${what}: a content hit line`);
    assert.equal(diffLine.slice(14, 14 + where.length), where, `${what}: printed place`);
  }
});

// ---------------------------------------------------------------------------
// F2: binary content is scanned as bytes
// ---------------------------------------------------------------------------

test('binary content: a NUL-byte file, a PNG text chunk, UTF-16 files and a latin1 file are all scanned', () => {
  const name = synth();
  const accented = `${synth()}\u00e9`; // an entry with a non-ASCII letter
  const { repo, commit } = makeRepo();
  const stateDir = stateDirWith([name, accented]);
  const cases = [
    ['NUL byte', { 'b.dat': Buffer.concat([Buffer.from('head\0'), Buffer.from(` ${name} tail\n`)]) }],
    ['PNG tEXt chunk', { 'img.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]), Buffer.from(`tEXtAuthor\0${name}\0`)]) }],
    ['UTF-16LE with a BOM', { 'u16le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`hello\r\nby ${name}\r\n`, 'utf16le')]) }],
    ['UTF-16BE with a BOM', { 'u16be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`hello\r\nby ${name}\r\n`, 'utf16le').swap16()]) }],
    ['latin1 (not valid UTF-8)', { 'l1.txt': Buffer.from(`by ${accented}\n`, 'latin1') }],
  ];
  for (const [what, files] of cases) {
    const sha = commit(files);
    const r = scan(repo, { stateDir, commits: [sha] });
    assert.equal(r.status, 1, `${what}: must block`);
    assert.ok(r.hits.some((h) => h.where === 'diff' && h.check === 'private-names'), `${what}: a content hit`);
    assertNoName(r.output, [name, accented], `${what} output`);
  }
});

test('.gitattributes cannot hide content: "binary" in the same commit, and "-diff" from an already-public commit', () => {
  const name = synth();
  const { repo, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  const same = commit({ '.gitattributes': '*.notes binary\n', 'x.notes': `${name}\n` });
  assert.equal(scan(repo, { stateDir, commits: [same] }).status, 1, 'binary attribute in the same commit');

  const attrs = commit({ '.gitattributes': '*.notes -diff\n' });
  publish(attrs);
  const later = commit({ 'y.notes': `${name}\n` });
  const r = scan(repo, { stateDir, pushes: [{ localSha: later, remoteSha: ZERO, remoteRef: 'refs/heads/wip/x' }] });
  assert.equal(r.status, 1, '-diff from a published .gitattributes');
  assert.deepEqual(r.commits, [later]);
});

test('a latin1-encoded commit message is matched in its latin1 reading', () => {
  const accented = `${synth()}\u00e9`;
  const { repo, rawCommit } = makeRepo();
  const sha = rawCommit([['a.txt', 'clean\n']], { message: Buffer.from(`thanks ${accented}\n`, 'latin1') });
  const r = scan(repo, { stateDir: stateDirWith([accented]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.hits.map((h) => [h.where, h.line]), [['message', 1]]);
});

test('a file over the size cap is not scanned: it WARNS "not scanned (size)", does not block, and its path is still checked', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const stateDir = stateDirWith([name]);
  const big = commit({ 'big.txt': `${'x'.repeat(200)}\n${name}\n` });
  const r = scan(repo, { stateDir, commits: [big], maxFileBytes: 100 });
  assert.equal(r.status, 0, 'over the cap: a warning, not a block');
  assert.equal(r.unscanned.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /big\.txt {2}not scanned \(size\): 2\d\d bytes, over the 100-byte cap/);
  assert.match(r.output, /1 file\(s\) not scanned \(size\)/);
  assertNoName(r.output, [name]);

  const named = commit({ [`${name}.bin`]: `${'y'.repeat(200)}\n` });
  const p = scan(repo, { stateDir, commits: [named], maxFileBytes: 100 });
  assert.equal(p.status, 1, 'the path of an unscanned file is still checked');
  assert.ok(p.hits.some((h) => h.where === 'path'));
  assertNoName(p.output, [name]);

  // Under the cap (the env override): scanned, and it blocks.
  const env = scan(repo, { stateDir, commits: [big], env: { PUSH_SCAN_MAX_FILE_BYTES: '4096' } });
  assert.equal(env.status, 1);
});

test('resolveMaxFileBytes: option, then PUSH_SCAN_MAX_FILE_BYTES, then 16 MiB; a bad value warns', () => {
  assert.deepEqual(resolveMaxFileBytes(10, {}), { value: 10, warning: null });
  assert.deepEqual(resolveMaxFileBytes(undefined, { PUSH_SCAN_MAX_FILE_BYTES: '2048' }), { value: 2048, warning: null });
  assert.equal(resolveMaxFileBytes(undefined, {}).value, 16 * 1024 * 1024);
  for (const bad of ['abc', '0', '-5', '2.5']) {
    const r = resolveMaxFileBytes(undefined, { PUSH_SCAN_MAX_FILE_BYTES: bad });
    assert.equal(r.value, 16 * 1024 * 1024);
    assert.match(r.warning, /ignoring PUSH_SCAN_MAX_FILE_BYTES/);
  }
});

test('a submodule pointer (gitlink) is skipped without error', () => {
  const { repo, rawCommit } = makeRepo();
  const sha = rawCommit([['sub', { gitlink: randomBytes(20).toString('hex') }], ['a.txt', 'clean\n']]);
  const r = scan(repo, { stateDir: stateDirWith([synth()]), commits: [sha] });
  assert.equal(r.status, 0, r.status === 0 ? '' : 'a gitlink broke the scan');
});

// ---------------------------------------------------------------------------
// F5: content that is already public is not re-scanned
// ---------------------------------------------------------------------------

test('newLines: only lines that appear in no old version count; empty lines are dropped', () => {
  const got = newLines(Buffer.from('a\nb\n\nc\r\nd\n'), [Buffer.from('a\nc\n'), Buffer.from('d\n')]);
  assert.deepEqual(got.map((l) => [l.line, l.key]), [[2, 'b']]);
});

test('merging already-public history (e.g. main) does not block: its commits are skipped and the merge adds nothing new', () => {
  const name = synth();
  const { repo, git, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  const base = commit({ 'shared.txt': 'a\nb\nc\n' });
  // "main" moves on with a name in it, and is public.
  const pub = commit({ 'pn.txt': `${name}\n`, 'shared.txt': `a\n${name}\nb\nc\n` }, 'public');
  publish(pub);
  // A branch forked before that, with its own change to the same file.
  git('checkout', '-q', '-b', 'feat', base);
  const feat = commit({ 'f.txt': 'f\n', 'shared.txt': 'a\nb\nc\nd\n' }, 'feat');
  git('merge', '-q', '--no-ff', '-m', 'merge main', pub);
  const merge = git('rev-parse', 'HEAD');
  const r = scan(repo, { stateDir, pushes: [{ localSha: merge, remoteSha: ZERO, remoteRef: 'refs/heads/wip/feat' }] });
  assert.equal(r.status, 0, 'a merge of public history must not block');
  assert.deepEqual(r.commits, [feat, merge], 'the public commit itself is not in the scan');
  const g = (a, input) => spawnSync('git', a, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true, input });
  assert.deepEqual(listPushedCommits(g, { localSha: merge, remoteSha: ZERO }, [pub]), [feat, merge]);
});

test('an evil merge (a name only in the merge commit\'s resolution) is still caught', () => {
  const name = synth();
  const { repo, git, commit, publish } = makeRepo();
  const base = commit({ 'shared.txt': 'a\nb\nc\n' });
  const pub = commit({ 'shared.txt': 'a\nX\nb\nc\n' }, 'public');
  publish(pub);
  git('checkout', '-q', '-b', 'feat', base);
  commit({ 'shared.txt': 'a\nb\nc\nd\n' }, 'feat');
  git('merge', '-q', '--no-ff', '--no-commit', pub);
  writeFileSync(join(repo, 'shared.txt'), `a\nX\nb\nc\nd\n${name}\n`);
  writeFileSync(join(repo, 'evil.txt'), `${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'merge main');
  const merge = git('rev-parse', 'HEAD');
  const r = scan(repo, { stateDir: stateDirWith([name]), pushes: [{ localSha: merge, remoteSha: ZERO, remoteRef: 'refs/heads/wip/feat' }] });
  assert.equal(r.status, 1);
  assert.deepEqual([...new Set(r.hits.map((h) => h.sha))], [merge]);
  assert.deepEqual(r.hits.map((h) => [h.where, h.line]).sort(), [['diff', 1], ['diff', 6]]);
  assertNoName(r.output, [name]);
});

test('renaming a file whose content is already public does not block; renaming to a named path does', () => {
  const name = synth();
  const { repo, git, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  commit({ 'r1.txt': `${name}\nline two\nline three\n` }, 'public');
  publish(git('rev-parse', 'HEAD'));
  git('mv', 'r1.txt', 'r2.txt');
  git('commit', '-q', '-m', 'rename');
  const ren = git('rev-parse', 'HEAD');
  const r = scan(repo, { stateDir, pushes: [{ localSha: ren, remoteSha: ZERO, remoteRef: 'refs/heads/wip/r' }] });
  assert.equal(r.status, 0, 'a rename re-adds nothing new');

  const plain = commit({ 'plain.txt': 'plain\n' });
  publish(plain);
  git('mv', 'plain.txt', `${name}.txt`);
  git('commit', '-q', '-m', 'rename to a name');
  const named = git('rev-parse', 'HEAD');
  const p = scan(repo, { stateDir, pushes: [{ localSha: named, remoteSha: ZERO, remoteRef: 'refs/heads/wip/r' }] });
  assert.equal(p.status, 1);
  assert.deepEqual(p.hits.map((h) => h.where), ['path']);
  assertNoName(p.output, [name]);
});

test('a pushed commit already reachable from a remote-tracking ref is skipped ("no new commits")', () => {
  const name = synth();
  const { repo, commit, publish } = makeRepo();
  const sha = commit({ 'o.txt': `${name}\n` });
  publish(sha, 'wip/o1');
  const r = scan(repo, { stateDir: stateDirWith([name]), pushes: [{ localSha: sha, remoteSha: ZERO, remoteRef: 'refs/heads/wip/o2' }] });
  assert.equal(r.status, 0);
  assert.match(r.output, /no new commits to scan/);
});

// ---------------------------------------------------------------------------
// Real commits: the core contract
// ---------------------------------------------------------------------------

test('a denylisted name in new content is reported by SHA and file:line, and the name is never printed', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'docs/notes.md': `line one\nwritten by ${name} today\n` });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.equal(r.hits.length, 1);
  assert.deepEqual(hitLines(r.output), [`${sha.slice(0, 12)}  docs/notes.md:2  [private-names: denylist line 1]`]);
  assertNoName(r.output, [name]);
});

test('a name in the commit message and in a touched path hits; the name is cut out of the printed path', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ [`fixtures/${name}.json`]: '{"a": 1}\n' }, `add the ${name} fixture\n\nmore text\n`);
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.deepEqual(hitLines(r.output), [
    `${sha.slice(0, 12)}  commit message:1  [private-names: denylist line 1]`,
    `${sha.slice(0, 12)}  path fixtures/${REDACTED}.json  [private-names: denylist line 1]`,
  ]);
  assertNoName(r.output, [name]);
});

test('a content hit inside a named directory prints the path with the name cut out', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ [`${name}/readme.txt`]: `about ${name}\n` });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.ok(hitLines(r.output).includes(`${sha.slice(0, 12)}  ${REDACTED}/readme.txt:1  [private-names: denylist line 1]`));
  assertNoName(r.output, [name]);
});

test('a name added in one commit and deleted in the next is still caught (history, not the tree)', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const base = commit({ 'a.txt': 'clean\n' });
  const bad = commit({ 'a.txt': `clean\n${name}\n` });
  const fix = commit({ 'a.txt': 'clean\n' });
  const r = scan(repo, { stateDir: stateDirWith([name]), pushes: [{ localSha: fix, remoteSha: base, remoteRef: 'refs/heads/feature' }] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.commits, [bad, fix]);
  assert.deepEqual([...new Set(r.hits.map((h) => h.sha))], [bad]);
});

test('placeholder home paths and the docs\' example paths do not hit', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({
    'docs/paths.md': [
      'C:\\Users\\{{USER}}\\.claude\\agent-companion',
      '{{HOME}}/.claude/agent-companion/config/private-names.txt',
      '~/.claude/agent-companion/config/private-names.txt',
      '/home/you/dev/project',
      '/Users/<you>/Library',
      'C:\\Users\\you\\dev\\my-project',
      '%USERPROFILE%\\dev\\my-project',
      '~/dev/acme-app',
      '',
    ].join('\n'),
  }, 'docs: example paths\n');
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 0, 'a placeholder path hit');
  assert.deepEqual(r.hits, []);
});

test('a real-looking home path (synthetic user) is a leak-check hit, printed without the path', () => {
  const user = synth('u');
  const { repo, commit } = makeRepo();
  const sha = commit({ 'x.md': `see /home/${user}/stuff\n` });
  const r = scan(repo, { stateDir: stateDirWith([synth()]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /x\.md:1 {2}\[leak-check: private-path:posix-home\]/);
  assert.ok(!r.output.includes(user), 'the user was printed');
});

test('author and committer identity are exempt: a denylisted author name alone is not a hit', () => {
  const name = synth();
  const { repo, commit } = makeRepo({
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@example.invalid`,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@example.invalid`,
  });
  const sha = commit({ 'a.txt': 'clean\n' }, 'clean message\n');
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 0, 'identity was scanned');
});

test('a SHA naming a commit in this repo is fine in a message (git revert); an unknown SHA-like run is a hit', () => {
  const { repo, commit } = makeRepo();
  const first = commit({ 'a.txt': 'one\n' });
  const revert = commit({ 'a.txt': 'two\n' }, `Revert "one"\n\nThis reverts commit ${first}.\n`);
  const foreign = randomBytes(20).toString('hex');
  const other = commit({ 'a.txt': 'three\n' }, `port of ${foreign}\n`);
  const r = scan(repo, { stateDir: stateDirWith([synth()]), commits: [revert, other] });
  assert.equal(r.status, 1);
  assert.deepEqual(r.hits.map((h) => [h.sha, h.where, h.label]), [[other, 'message', 'git-sha-like']]);
  assert.ok(!r.output.includes(foreign), 'the SHA-like run was printed');
});

test('listPushedCommits: a known remote sha, and the public tips, limit the range to the new commits', () => {
  const { repo, commit } = makeRepo();
  const a = commit({ 'a.txt': '1\n' });
  const b = commit({ 'a.txt': '2\n' });
  const c = commit({ 'a.txt': '3\n' });
  const git = (args, input) => spawnSync('git', args, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true, input });
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: a }), [b, c]);
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: ZERO }), [a, b, c], 'a new ref with no public tips: everything');
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: ZERO }, [b]), [c], 'a public tip');
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: 'f'.repeat(40) }), [a, b, c], 'a remote sha this clone lacks excludes nothing');
  assert.deepEqual(listPushedCommits(git, { localSha: ZERO, remoteSha: a }), [], 'a delete publishes nothing');
});

test('escapeControls: C0, DEL, C1, zero-width and bidi characters become visible escapes', () => {
  assert.equal(escapeControls('a\tb\nc\x1b\x7f\x85\u200b\u202e\ufeffd'), 'a\\x09b\\x0ac\\x1b\\x7f\\x85\\u200b\\u202e\\ufeffd');
  assert.equal(escapeControls('plain caf\u00e9'), 'plain caf\u00e9');
});

// ---------------------------------------------------------------------------
// The pre-push gate: wip/** and backup/** are scanned too
// ---------------------------------------------------------------------------

function gateWith(repo, stateDir) {
  const suiteCalls = [];
  const scanned = [];
  const out = [];
  const opts = {
    scan: (refs) => {
      scanned.push(...refs.map((r) => r.remoteRef));
      return scan(repo, { stateDir, pushes: refs });
    },
    runSuites: (cls, sha) => { suiteCalls.push([cls, sha]); return [{ name: 's', status: 0, outcome: 'pass' }]; },
    log: (m) => out.push(m),
    err: (m) => out.push(m),
  };
  return { opts, suiteCalls, scanned, out };
}

test('pre-push gate: a hit on a wip/** ref blocks the push, and no suite runs', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': `${name}\n` });
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/wip/x', localSha: sha, remoteRef: 'refs/heads/wip/x', remoteSha: ZERO },
  ], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.scanned, ['refs/heads/wip/x']);
  assert.deepEqual(g.suiteCalls, []);
  assertNoName(g.out.join('\n'), [name]);
});

test('pre-push gate: wip/** and backup/** refs are scanned (suites still skipped); an ordinary branch gets both', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/wip/x', localSha: sha, remoteRef: 'refs/heads/wip/x', remoteSha: ZERO },
    { localRef: 'refs/heads/backup/y', localSha: sha, remoteRef: 'refs/heads/backup/y', remoteSha: ZERO },
    { localRef: 'refs/heads/feature', localSha: sha, remoteRef: 'refs/heads/feature', remoteSha: ZERO },
    { localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/old', remoteSha: sha },
  ], g.opts);
  assert.equal(status, 0);
  assert.deepEqual(g.scanned, ['refs/heads/wip/x', 'refs/heads/backup/y', 'refs/heads/feature']);
  assert.deepEqual(g.suiteCalls, [['normal', sha]]);
});

test('pre-push gate: a backup/** ref carrying a hit blocks too', async () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' }, `note about ${name}\n`);
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([
    { localRef: 'refs/heads/backup/y', localSha: sha, remoteRef: 'refs/heads/backup/y', remoteSha: ZERO },
  ], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.suiteCalls, []);
});

test('pre-push gate: a broken denylist blocks before any suite runs', async () => {
  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const g = gateWith(repo, stateDirWith('dir'));
  const status = await prePushGate([
    { localRef: 'refs/heads/feature', localSha: sha, remoteRef: 'refs/heads/feature', remoteSha: ZERO },
  ], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.suiteCalls, []);
});

test('pre-push gate: a scan that throws blocks (fails closed), with the home directory shown as ~', async () => {
  const out = [];
  const status = await prePushGate([
    { localRef: 'refs/heads/feature', localSha: 'a'.repeat(40), remoteRef: 'refs/heads/feature', remoteSha: ZERO },
  ], {
    scan: () => { throw new Error(`boom in ${join(homedir(), 'x.mjs')}`); },
    runSuites: () => { throw new Error('must not run'); },
    log: (m) => out.push(m), err: (m) => out.push(m),
  });
  assert.equal(status, 1);
  const text = out.join('\n');
  assert.match(text, /BLOCKED — the pushed-commit scan could not run: boom in ~/);
  assert.ok(!text.toLowerCase().includes(homedir().toLowerCase()), 'the home directory was printed');
});

// ---------------------------------------------------------------------------
// Round 3. Special characters are built from code points (cp) and a
// backslash constant (BS), so this source stays plain ASCII.
// ---------------------------------------------------------------------------

const cp = (...n) => String.fromCharCode(...n);
const BS = '\\';

// R1: pushed ref names are scanned, and printed only redacted.

test('R1: a denylisted name in a pushed ref name (branch, tag, or the local ref) blocks; the name is printed as [redacted]', () => {
  const name = synth();
  const { repo, commit, publish } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  publish(sha); // the commit itself is public: only the ref name is new
  const stateDir = stateDirWith([name]);
  for (const [what, push, where] of [
    ['a branch', pushOf(sha, `refs/heads/wip/${name}-notes`), `remote ref refs/heads/wip/${REDACTED}-notes`],
    ['a tag', pushOf(sha, `refs/tags/v1-${name}`), `remote ref refs/tags/v1-${REDACTED}`],
    ['the local ref only', pushOf(sha, 'refs/heads/wip/clean', ZERO, `refs/heads/${name}`), `local ref refs/heads/${REDACTED}`],
  ]) {
    const r = scan(repo, { stateDir, pushes: [push] });
    assert.equal(r.status, 1, `${what}: must block`);
    assert.deepEqual(hitLines(r.output), [`${sha.slice(0, 12)}  ${where}  [private-names: denylist line 1]`], `${what}: the hit line`);
    assert.match(r.output, /hit\(s\) in the pushed ref name\(s\)/);
    assert.match(r.output, /push under another name/);
    assertNoName(r.output, [name], `${what} output`);
  }
  const ok = scan(repo, { stateDir, pushes: [pushOf(sha, 'refs/heads/wip/clean')] });
  assert.equal(ok.status, 0, 'a clean ref name passes');
  assert.match(ok.output, /no new commits to scan/);
});

test('R1: a ref name is checked with leak-check too, and a name only its latin1 reading shows is withheld whole', () => {
  const user = synth('u');
  const accented = `${synth()}${cp(0xe9)}`;
  const { repo, commit, publish } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  publish(sha);
  const leak = scan(repo, { stateDir: stateDirWith([synth()]), pushes: [pushOf(sha, `refs/heads/wip/C--Users-${user}-notes`)] });
  assert.equal(leak.status, 1);
  assert.ok(leak.hits.some((h) => h.where === 'ref' && h.check === 'leak-check'), 'a leak-check hit in the ref name');
  assert.ok(!leak.output.includes(user), 'the user was printed');
  // Not valid UTF-8: the ref name's bytes as git sent them.
  const bytes = Buffer.from(`refs/heads/wip/${accented}`, 'latin1');
  const l1 = scan(repo, { stateDir: stateDirWith([accented]), pushes: [{ ...pushOf(sha, bytes.toString('utf8')), remoteRefBytes: bytes, localRefBytes: bytes }] });
  assert.equal(l1.status, 1);
  assert.deepEqual(hitLines(l1.output), [`${sha.slice(0, 12)}  remote ref ${REDACTED_REF}  [private-names: denylist line 1]`]);
  assertNoName(l1.output, [accented]);
});

test('R1: parsePrePushStdin keeps each ref name as the exact bytes git sent', () => {
  const raw = Buffer.concat([Buffer.from('refs/heads/wip/x'), Buffer.from([0xe9]), Buffer.from('y')]);
  const line = Buffer.concat([raw, Buffer.from(` ${'a'.repeat(40)} `), raw, Buffer.from(` ${ZERO}\r\n\n`)]);
  const refs = parsePrePushStdin(line);
  assert.equal(refs.length, 1);
  assert.ok(refs[0].localRefBytes.equals(raw) && refs[0].remoteRefBytes.equals(raw), 'byte-exact ref names');
  assert.equal(refs[0].localSha, 'a'.repeat(40));
  assert.equal(refs[0].remoteSha, ZERO);
  assert.equal(refs[0].remoteRef, raw.toString('utf8'));
  assert.deepEqual(parsePrePushStdin(Buffer.from('\n \n')), []);
});

test('R1: ci-local prints a ref name only through the scan\'s redactor, and withholds it when the scan gives none', async () => {
  const name = synth();
  const refs = [pushOf('a'.repeat(40), `refs/heads/wip/${name}`), pushOf('b'.repeat(40), `refs/heads/feat-${name}`)];
  const out = [];
  const opts = { runSuites: () => [{ name: 's', status: 0, outcome: 'pass' }], log: (m) => out.push(m), err: (m) => out.push(m) };
  assert.equal(await prePushGate(refs, { ...opts, scan: () => ({ status: 0 }) }), 0);
  let text = out.join('\n');
  assertNoName(text, [name], 'gate output without a redactor');
  assert.match(text, /suites skipped for \[ref name withheld\]/);
  assert.match(text, /\[ref name withheld\] -> full suite/);
  out.length = 0;
  assert.equal(await prePushGate(refs, { ...opts, scan: () => ({ status: 0, showRef: (r) => `<${String(r).length}>` }) }), 0);
  text = out.join('\n');
  assertNoName(text, [name], 'gate output with a redactor');
  assert.match(text, /suites skipped for <\d+>/);
});

test('R1: the real gate blocks a named ref with clean content, and prints no name', async () => {
  const name = synth();
  const { repo, commit, publish } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  publish(sha);
  const g = gateWith(repo, stateDirWith([name]));
  const status = await prePushGate([pushOf(sha, `refs/heads/wip/${name}-notes`)], g.opts);
  assert.equal(status, 1);
  assert.deepEqual(g.suiteCalls, []);
  assertNoName(g.out.join('\n'), [name]);
});

test('pre-push gate: the scan is told the destination (the hook\'s remote name and URL); the hook passes them on', async () => {
  const seen = [];
  await prePushGate([pushOf('a'.repeat(40), 'refs/heads/wip/x')], {
    scan: (refs, target) => { seen.push(target); return { status: 1 }; },
    runSuites: () => [], log: () => {}, err: () => {}, remote: 'origin', url: 'https://example.invalid/r.git',
  });
  assert.deepEqual(seen, [{ remote: 'origin', url: 'https://example.invalid/r.git' }]);
  const hook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.githooks', 'pre-push'), 'utf8');
  assert.match(hook, /ci-local\.mjs" --pre-push-hook "\$@"/);
});

// R2: git replace and grafts.

test('R2: git replace and a graft file cannot show the scan other objects than the ones the push sends', () => {
  const name = synth();
  const { repo, git, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  const base = commit({ 'a.txt': 'clean\n' });
  publish(base);
  const bad = commit({ 'a.txt': `clean\n${name}\n` });
  git('checkout', '-q', '-b', 'good', base);
  const good = commit({ 'a.txt': 'clean\nnothing\n' });
  git('replace', bad, good);
  const r = scan(repo, { stateDir, pushes: [pushOf(bad, 'refs/heads/wip/rep')] });
  assert.equal(r.status, 1, 'a replaced commit is scanned as itself');
  assert.deepEqual(r.commits, [bad]);
  assertNoName(r.output, [name]);
  git('replace', '-d', bad);

  // A graft that hides a commit: fix's real parent is bad; the graft says base.
  git('checkout', '-q', 'main');
  const fix = commit({ 'a.txt': 'clean\n' });
  writeFileSync(join(repo, '.git', 'info', 'grafts'), `${fix} ${base}\n`);
  const g = scan(repo, { stateDir, pushes: [pushOf(fix, 'refs/heads/wip/graft')] });
  assert.equal(g.status, 1, 'the commit a graft hides is scanned');
  assert.deepEqual(g.commits, [bad, fix]);
  const env = scanGitEnv({});
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.ok(env.GIT_GRAFT_FILE, 'the graft file is pointed away');
});

// R3: denylist line separators.

test('R3: denylist lines end at LF, CRLF, CR, U+2028 or U+2029; blank and comment lines are ignored', () => {
  const [a, b, c] = [synth(), synth(), synth()];
  const LS = cp(0x2028);
  const PS = cp(0x2029);
  for (const [what, text] of [
    ['LF', `${a}\n${b}\n${c}\n`], ['CRLF', `${a}\r\n${b}\r\n${c}\r\n`], ['CR only', `${a}\r${b}\r${c}\r`],
    ['U+2028', `${a}${LS}${b}${LS}${c}`], ['U+2029', `${a}${PS}${b}${PS}${c}`], ['mixed', `${a}\r\n${b}\r${c}${LS}`],
  ]) {
    const d = parseDenylist(text);
    assert.deepEqual(d.entries.map((e) => e.lineNo), [1, 2, 3], what);
    assert.deepEqual(d.controls, [], what);
    for (const n of [a, b, c]) assert.equal(matchDenylist(`by ${n}`, d.entries).length, 1, `${what}: each entry matches on its own`);
  }
  assert.deepEqual(parseDenylist(`# c\r\r  \r${a}${LS}# x${PS}${b}`).entries.map((e) => e.lineNo), [4, 6]);
});

test('R3: an entry holding a control character (NEL, VT, FF, a TAB) BLOCKS the push, naming its line only', () => {
  const [a, b, c] = [synth(), synth(), synth()];
  const d = parseDenylist(`${a}\n${b}${cp(0x85)}${c}\n${a}\t# note\nx${cp(0x0b)}y\nz${cp(0x0c)}w\n`);
  assert.deepEqual(d.controls, [2, 3, 4, 5]);
  assert.deepEqual(d.entries.map((e) => e.lineNo), [1]);

  const { repo, commit } = makeRepo();
  const sha = commit({ 'a.txt': 'clean\n' });
  const r = scan(repo, { stateDir: stateDirWith(Buffer.from(`${b}${cp(0x85)}${c}\n`, 'utf8')), commits: [sha] });
  assert.equal(r.status, 1);
  assert.match(r.output, /denylist line\(s\) 1 hold a control character/);
  assertNoName(r.output, [b, c]);
  // A CR-only file: its SECOND entry now matches (it used to be one entry that matched nothing).
  const hit = commit({ 'b.txt': `by ${c}\n` });
  assert.equal(scan(repo, { stateDir: stateDirWith(Buffer.from(`${a}\r${c}\r`)), commits: [hit] }).status, 1);
});

// R4: names hidden behind escapes.

test('R4: decodeEscapes undoes JSON/JS escapes and percent-encoding, one level; an escaped backslash stays a backslash', () => {
  const table = [
    [`hi${BS}nname`, 'hi\nname'],
    [`a${BS}tb${BS}rc`, 'a\tb\rc'],
    [`x${BS}u0041y`, 'xAy'],
    [`x${BS}u{41}y`, 'xAy'],
    [`x${BS}x41y`, 'xAy'],
    [`q${BS}"x${BS}/y`, 'q"x/y'],
    [`C:${BS}${BS}new`, `C:${BS}new`],
    ['%2Fname%2F', '/name/'],
    ['caf%C3%A9', `caf${cp(0xe9)}`],
    ['caf%E9', `caf${cp(0xe9)}`],
    ['100%', '100%'],
    ['%zz', '%zz'],
    ['plain', 'plain'],
  ];
  const wrong = table.filter(([s, want]) => decodeEscapes(s) !== want).map(([s]) => JSON.stringify(s));
  assert.deepEqual(wrong, []);
});

test('R4: a name right after an escape hits (JSONL \\n, a URL %2F), and the word boundaries still hold', () => {
  const table = [
    ['zorblax', `{"text":"hi${BS}nzorblax here"}`, true],
    ['zorblax', `{"text":"col${BS}tzorblax"}`, true],
    ['zorblax', `{"text":"a${BS}r${BS}nzorblax"}`, true],
    ['zorblax', 'https://example.com/?to=%2Fzorblax%2F', true],
    ['zorblax', 'redirect_uri=https%3A%2F%2Fexample.com%2Fzorblax%2F', true],
    ['zorblax', 'q=name%3Dzorblax', true],
    ['zorblax', 'mailto%3Azorblax%40example.com', true],
    ['zorblax', `zorbl${BS}u0061x`, true],
    [`ren${cp(0xe9)}e`, `"Ren${BS}u00e9e"`, true],
    ['ann', `"x${BS}nannotation"`, false],
    ['ann', '%2Fannotation', false],
    ['ann', `"${BS}njoann"`, false],
    ['zorblax', `C:${BS}${BS}nzorblax`, false],
    ['zorblax', 'x%2Fzorblaxing', false],
  ];
  const wrong = table.filter(([entry, text, want]) => hits(entry, text) !== want)
    .map(([entry, text, want]) => `${JSON.stringify(entry)} vs ${JSON.stringify(text)}: expected ${want ? 'HIT' : 'no hit'}`);
  assert.deepEqual(wrong, []);
});

test('R4: through a commit, a JSONL line and a percent-encoded URL block; an escaped name in a path withholds the path', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({
    't.jsonl': `{"role":"user","text":"hi${BS}n${name} here"}\n`,
    'u.log': `GET /cb?redirect_uri=https%3A%2F%2Fexample.com%2F${name}%2Fhome\n`,
    [`docs/a%2F${name}.md`]: 'clean\n',
  });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 1);
  assert.deepEqual(hitLines(r.output).sort(), [
    `${sha.slice(0, 12)}  path ${REDACTED_PATH}  [private-names: denylist line 1]`,
    `${sha.slice(0, 12)}  t.jsonl:1  [private-names: denylist line 1]`,
    `${sha.slice(0, 12)}  u.log:1  [private-names: denylist line 1]`,
  ].sort());
  assertNoName(r.output, [name]);
});

// R5: what counts as already public.

test('R5: only the destination\'s own tracking refs that it still advertises count as public — every re-review bypass now blocks', () => {
  const name = synth();
  const { repo, origin, git, runIn, putOn, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  const base = commit({ 'a.txt': 'clean\n' });
  publish(base);
  const bypass = (what, prep) => {
    git('checkout', '-q', '-B', 'work', base);
    const c = commit({ [`${synth()}.txt`]: `${name}\n` });
    prep(c);
    const r = scan(repo, { stateDir, pushes: [pushOf(c, `refs/heads/wip/${synth()}`)] });
    assert.equal(r.status, 1, `${what}: must block`);
    assert.deepEqual(r.commits, [c], `${what}: the commit is scanned`);
    assertNoName(r.output, [name], `${what} output`);
    return r;
  };
  bypass('a1: a hand-made refs/remotes/origin/*', (c) => git('update-ref', 'refs/remotes/origin/fake', c));
  bypass('a2: a git-p4 style refs/remotes/p4/master', (c) => git('update-ref', 'refs/remotes/p4/master', c));
  const priv = tmp('push-scan-priv-');
  runIn(priv, ['init', '-q', '--bare']);
  git('remote', 'add', 'priv', priv);
  bypass('b: a commit only on a second remote', (c) => { putOn(priv, c, 'x'); git('fetch', '-q', 'priv'); });
  const c1 = bypass('c1: a stale tracking ref (deleted upstream)', (c) => {
    publish(c, 'wip/gone');
    runIn(origin, ['update-ref', '-d', 'refs/heads/wip/gone']);
  });
  assert.match(c1.output, /remote-tracking ref\(s\) of origin do not match what it advertises now/);

  // c3: scrubbed upstream by a force-push from another clone; this clone
  // still holds the old tip and pushes a child of it.
  git('checkout', '-q', '-B', 'work', base);
  const bad = commit({ 'd.txt': `${name}\n` });
  publish(bad, 'wip/d');
  putOn(origin, base, 'wip/d');
  const child = commit({ 'd2.txt': 'more work\n' });
  const c3 = scan(repo, { stateDir, pushes: [pushOf(child, 'refs/heads/wip/d-child')] });
  assert.equal(c3.status, 1, 'c3: re-publishing a scrubbed commit must block');
  assert.deepEqual(c3.commits, [bad, child]);

  // Controls: a fresh tracking ref the destination advertises counts...
  git('checkout', '-q', '-B', 'work', base);
  const pub = commit({ 'p.txt': `${name}\n` });
  publish(pub, 'wip/public');
  const fresh = scan(repo, { stateDir, pushes: [pushOf(pub, 'refs/heads/wip/again')] });
  assert.equal(fresh.status, 0, 'an advertised commit is public');
  assert.match(fresh.output, /no new commits to scan/);
  // ...and so does a remote tip git passes on stdin, for every ref in the push.
  git('update-ref', '-d', 'refs/remotes/origin/wip/public');
  const next = commit({ 'q.txt': 'clean\n' });
  const viaStdin = scan(repo, { stateDir, pushes: [pushOf(next, 'refs/heads/wip/public', pub), pushOf(pub, 'refs/heads/wip/copy')] });
  assert.equal(viaStdin.status, 0, 'a remote tip on stdin is public for the whole push');
  assert.deepEqual(viaStdin.commits, [next]);
});

test('R5: resolvePublicTips reports the destination\'s tracking refs, the stale ones, and ls-remote failures; a URL push trusts no tracking ref', () => {
  const { repo, origin, git, commit, publish } = makeRepo();
  const a = commit({ 'a.txt': '1\n' });
  publish(a);
  const b = commit({ 'a.txt': '2\n' });
  git('update-ref', 'refs/remotes/origin/stale', b);
  const g = (args, input) => spawnSync('git', args, { cwd: repo, env: scanGitEnv(), encoding: 'utf8', windowsHide: true, input });
  g.lsRemote = (target) => {
    const res = spawnSync('git', ['ls-remote', '--', target], { cwd: repo, env: scanGitEnv(), encoding: 'utf8', windowsHide: true });
    return res.status === 0 ? { ok: true, shas: new Set(res.stdout.split('\n').map((l) => l.split('\t')[0]).filter(Boolean)) } : { ok: false, reason: `exit ${res.status}` };
  };
  assert.deepEqual(resolvePublicTips(g, { remote: 'origin' }), { tips: [a], tracking: 2, stale: 1, lsRemoteFailed: null });
  assert.deepEqual(resolvePublicTips(g, { remote: 'origin', remoteUrl: origin }), { tips: [a], tracking: 2, stale: 1, lsRemoteFailed: null }, 'the URL is what is listed');
  const failed = resolvePublicTips(g, { remote: 'origin', remoteUrl: join(tmp('push-scan-none-'), 'no-such-remote') });
  assert.deepEqual(failed.tips, []);
  assert.match(failed.lsRemoteFailed, /^exit /);
  assert.deepEqual(resolvePublicTips(g, { remote: origin, remoteUrl: origin }).tips, [], 'a push to a URL: no tracking ref counts');
  assert.deepEqual(resolvePublicTips(g, { remote: 'origin', pushes: [pushOf(b, 'refs/heads/x', a)] }).tips.sort(), [a], 'a stdin remote tip counts');
});

test('R5: when git ls-remote gives no answer, a warning says so, the remote tips on stdin still count, and the URL is never printed', () => {
  const name = synth();
  const { repo, commit, publish } = makeRepo();
  const stateDir = stateDirWith([name]);
  commit({ 'a.txt': 'clean\n' });
  const pub = commit({ 'p.txt': `${name}\n` });
  publish(pub);
  const next = commit({ 'c.txt': 'clean\n' });
  const url = join(tmp('push-scan-none-'), `no-such-${synth()}`);
  const r = scan(repo, { stateDir, pushes: [pushOf(next, 'refs/heads/wip/new')], remoteUrl: url });
  assert.equal(r.status, 1, 'the public commit is scanned when the destination cannot be listed');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /could not list what origin has now \(git ls-remote: exit \d+\)/);
  assert.match(r.output, /commits it may already have were scanned too/);
  assert.ok(!r.output.includes(url) && !r.output.includes(url.replace(/\\/g, '/')), 'the URL was printed');
  assertNoName(r.output, [name]);
  const ff = scan(repo, { stateDir, pushes: [pushOf(next, 'refs/heads/main', pub)], remoteUrl: url });
  assert.equal(ff.status, 0, 'a fast-forward over the stdin remote tip still passes');
  assert.deepEqual(ff.commits, [next]);
});

// The node heap-corruption guard.

test('utf16leOf: odd-offset, odd-length views are decoded from an aligned copy (node v24.21.0 heap corruption)', () => {
  let total = 0;
  for (let n = 0; n < 3000; n += 1) {
    const b = Buffer.alloc(200 + 2 * (n % 400));
    for (let k = 0; k < b.length; k += 1) b[k] = (k * 7 + n) & 0x7f;
    total += utf16leOf(b.subarray(1)).length;
  }
  assert.ok(total > 0);
  assert.equal(utf16leOf(Buffer.from([0x78, 0x41, 0x00, 0x42, 0x00]).subarray(1)), 'AB');
  assert.equal(utf16leOf(Buffer.from([0x41, 0x00, 0x42])), 'A');
});

// R6 (deferred; the warning ships now): compressed containers.

function zipOf(entries, method) {
  const locals = [];
  for (const [nm, content] of entries) {
    const data = method === 8 ? zlib.deflateRawSync(content) : content;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(method, 8);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(content.length, 22);
    h.writeUInt16LE(Buffer.byteLength(nm), 26);
    locals.push(h, Buffer.from(nm), data);
  }
  return Buffer.concat(locals);
}
function pngOf(chunks) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks.map(([t, d]) => chunk(t, d)), chunk('IEND', Buffer.alloc(0))]);
}

test('compressedKind: packed zip entries, gzip, bzip2, xz, zstd, 7z, PNG zTXt / compressed iTXt and PDF filters; not stored zips, plain PNG text or plain PDF', () => {
  const text = Buffer.from('notes by nobody\n');
  const table = [
    ['zip, deflated entry', zipOf([['docProps/core.xml', text]], 8), 'zip'],
    ['zip, stored entries only', zipOf([['a.txt', text]], 0), null],
    ['gzip', zlib.gzipSync(text), 'gzip'],
    ['bzip2', Buffer.concat([Buffer.from('BZh9'), Buffer.from([0x31, 0x41, 0x59, 0x26, 0x53, 0x59]), Buffer.alloc(8)]), 'bzip2'],
    ['text that starts BZh9', Buffer.from('BZh9 is not a bzip2 stream\n'), null],
    ['xz', Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0]), 'xz'],
    ['zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0]), 'zstd'],
    ['7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), '7z'],
    ['PNG zTXt', pngOf([['zTXt', Buffer.concat([Buffer.from('Author\0\0'), zlib.deflateSync(text)])]]), 'png'],
    ['PNG iTXt, compressed', pngOf([['iTXt', Buffer.concat([Buffer.from('Author\0'), Buffer.from([1, 0]), Buffer.from('\0\0'), zlib.deflateSync(text)])]]), 'png'],
    ['PNG iTXt, plain', pngOf([['iTXt', Buffer.concat([Buffer.from('Author\0'), Buffer.from([0, 0]), Buffer.from('\0\0'), text])]]), null],
    ['PNG tEXt', pngOf([['tEXt', Buffer.concat([Buffer.from('Author\0'), text])]]), null],
    ['PDF FlateDecode', Buffer.from('%PDF-1.5\n1 0 obj << /Filter /FlateDecode >> stream\nx\nendstream\n'), 'pdf'],
    ['PDF plain', Buffer.from('%PDF-1.4\n1 0 obj << /Author (nobody) >> endobj\n'), null],
    ['plain text', text, null],
  ];
  const wrong = table.filter(([, buf, want]) => compressedKind(buf) !== want).map(([what]) => what);
  assert.deepEqual(wrong, []);
});

test('a compressed file WARNS "compressed content not scanned" and does not block', () => {
  const name = synth();
  const { repo, commit } = makeRepo();
  const sha = commit({ 'notes.txt.gz': zlib.gzipSync(Buffer.from(`by ${name}\n`)) });
  const r = scan(repo, { stateDir: stateDirWith([name]), commits: [sha] });
  assert.equal(r.status, 0, 'compressed content warns, it does not block');
  assert.equal(r.compressed.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /notes\.txt\.gz {2}compressed content not scanned \(gzip\)/);
  assert.match(r.output, /1 file\(s\) with compressed content not scanned/);
});

// F1-a (output): a name split by a replacement character.

test('displayPath: a name split by U+FFFD, or by one invalid byte, is withheld rather than printed readable', () => {
  const r = makeRedactor({ entries: parseDenylist('zorblax').entries });
  const FFFD = cp(0xfffd);
  assert.equal(r.displayPath({ text: `docs/zor${FFFD}blax.md`, latin1: null }), REDACTED_PATH);
  assert.equal(r.displayPath({ text: `docs/zor${FFFD}blax.md`, latin1: `docs/zor${cp(0x85)}blax.md` }), REDACTED_PATH);
  assert.equal(r.displayPath({ text: `docs/a${FFFD}b.md`, latin1: `docs/a${cp(0xe9)}b.md` }), `docs/a${FFFD}b.md`, 'a clean path is still printed');
  assert.equal(r.displayPath('refs/heads/wip/zorblax', REDACTED_REF), `refs/heads/wip/${REDACTED}`);
  assert.equal(r.displayPath(`refs/heads/zor${FFFD}blax`, REDACTED_REF), REDACTED_REF);
});
