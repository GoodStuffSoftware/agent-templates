// Tests for scripts/push-scan.mjs (the pushed-commit leak scan) and its wiring
// into the pre-push gate (ci-local.mjs prePushGate).
//
// Every "private name" here is SYNTHETIC — generated at run time, or a
// made-up word (zorblax, ann) — never read from the real denylist file. The
// denylist the scan sees is a throwaway one under a temp
// AGENT_COMPANION_STATE_DIR. Assertions that text is ABSENT from output carry
// their own message, so a failure never echoes the output it inspected.
//
// This file stays plain ASCII: every non-ASCII character is a \u escape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  compileDenyEntry, parseDenylist, matchDenylist, denylistPath, denylistDisplayPath,
  loadDenylist, decodeDenylist, isNameBoundary, parseRawDiffZ, newLines, makeRedactor,
  escapeControls, scrubHome, formatHits, resolveMaxFileBytes, runPushScan, listPushedCommits,
  REDACTED, REDACTED_PATH,
} from '../push-scan.mjs';
import { buildScanContext } from '../leak-check.mjs';
import { prePushGate, scrubHomeDir } from '../ci-local.mjs';
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

function makeRepo(identity = {}) {
  const repo = tmp('push-scan-repo-');
  const env = cleanGitEnv(process.env, {
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    ...identity,
  });
  const run = (args, input) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'core.autocrlf=false', ...args], {
      cwd: repo, env, input, windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr)}`);
    return r.stdout.toString('utf8').trim();
  };
  const git = (...args) => run(args);
  git('init', '-q', '-b', 'main');
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
  // Mark `sha` as already public: reachable from a remote-tracking ref.
  const publish = (sha, name = 'main') => git('update-ref', `refs/remotes/origin/${name}`, sha);
  return { repo, git, commit, rawCommit, publish, env };
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
// this machine's project directories).
function scan(repo, { stateDir, pushes, commits, env: extraEnv = {}, ...rest }) {
  const out = [];
  const env = { ...process.env, AGENT_COMPANION_STATE_DIR: stateDir, ...extraEnv };
  const leakCtx = buildScanContext({ root: repo, noDerived: true, quiet: true, user: 'fixtureuser' }, {});
  const res = runPushScan({
    repo, pushes, commits, env, leakCtx, log: (m) => out.push(m), err: (m) => out.push(m), ...rest,
  });
  return { ...res, output: out.join('\n') };
}

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
  for (const [what, buf] of [
    ['UTF-16LE with a BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le])],
    ['UTF-16BE with a BOM', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be])],
    ['UTF-16LE without a BOM', utf16le],
    ['invalid UTF-8', Buffer.concat([Buffer.from(`${name}\n`), Buffer.from([0xc3, 0x28, 0x0a])])],
  ]) {
    const d = decodeDenylist(buf);
    assert.ok(d.error, `${what} must be an error`);
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
  assert.deepEqual(listPushedCommits((a) => spawnSync('git', a, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true }), { localSha: merge, remoteSha: ZERO }), [feat, merge]);
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

test('listPushedCommits: a known remote sha limits the range to the new commits', () => {
  const { repo, commit } = makeRepo();
  const a = commit({ 'a.txt': '1\n' });
  const b = commit({ 'a.txt': '2\n' });
  const c = commit({ 'a.txt': '3\n' });
  const git = (args) => spawnSync('git', args, { cwd: repo, env: cleanGitEnv(), encoding: 'utf8', windowsHide: true });
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: a }), [b, c]);
  assert.deepEqual(listPushedCommits(git, { localSha: c, remoteSha: ZERO }), [a, b, c], 'a new ref: everything not on a remote-tracking ref');
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
