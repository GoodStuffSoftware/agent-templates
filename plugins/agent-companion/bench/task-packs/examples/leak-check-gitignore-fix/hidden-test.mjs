// Hidden test for the leak-check-gitignore-fix example task pack. See
// bench/task-packs/FORMAT.md for the contract: a default-exported
// check(sandboxDir) -> { pass, detail }.
//
// Builds a SEPARATE throwaway git repo (never sandboxDir itself -- the
// benchmark's own saved answer tree must never get polluted with .git/**
// noise), copies the model's (possibly fixed) scripts/leak-check.mjs into
// it, creates a .gitignore'd fixture file containing a sha-like token, and
// runs leak-check.mjs from that repo's root.
//
// PASS = leak-check reports OK (exit 0) despite the gitignored file's
// content -- i.e. it correctly scanned only the git-committable set, not
// the raw working tree.
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A task pack is self-contained (FORMAT.md), so this does not import the
// plugin's scripts/lib/git-env.mjs. Same rule, simpler form: no inherited
// GIT_* variable reaches these git calls. An inherited GIT_DIR (this check
// run under a git hook) would otherwise send git init / git config /
// git commit into the caller's repository instead of repoDir.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

export default async function check(sandboxDir) {
  const target = join(sandboxDir, 'scripts', 'leak-check.mjs');
  if (!existsSync(target)) {
    return { pass: false, detail: 'scripts/leak-check.mjs is missing from the sandbox' };
  }

  const repoDir = mkdtempSync(join(tmpdir(), 'leak-check-pack-verify-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env: GIT_ENV, windowsHide: true });
    execFileSync('git', ['config', 'user.email', 'bench@example.invalid'], { cwd: repoDir, env: GIT_ENV, windowsHide: true });
    execFileSync('git', ['config', 'user.name', 'bench'], { cwd: repoDir, env: GIT_ENV, windowsHide: true });

    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    copyFileSync(target, join(repoDir, 'scripts', 'leak-check.mjs'));

    // A sha-like token (contains digits, length >= 12) that leak-check's own
    // SHA_RE class would flag if -- and only if -- it ever scanned this
    // file. Built at RUNTIME from a lookup string with a break character
    // (see below) so this SOURCE FILE never itself contains a matching
    // contiguous hex run -- this repo's own leak-check would otherwise flag
    // this exact line, the same reason lib.mjs base64-encodes pack refs.
    const HEX_DIGITS = '0123456789_abcdef'.replace('_', '');
    const shaLikeToken = Array.from({ length: 24 }, (_, i) => HEX_DIGITS[(i * 7 + 3) % 16]).join('');
    writeFileSync(join(repoDir, '.gitignore'), 'LOCAL_SCRATCH.md\n');
    writeFileSync(join(repoDir, 'LOCAL_SCRATCH.md'), `local notes, token ${shaLikeToken} appears here by accident\n`);

    // Commit everything EXCEPT the gitignored file, so "the committable
    // set" (git ls-files --cached --others --exclude-standard) genuinely
    // differs from "the raw working tree" -- the exact distinction the fix
    // is about. A commit is not strictly required for `--others
    // --exclude-standard` to work, but it matches the real repo's shape (a
    // tracked script) rather than leaving everything untracked.
    execFileSync('git', ['add', 'scripts/leak-check.mjs'], { cwd: repoDir, env: GIT_ENV, windowsHide: true });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir, env: GIT_ENV, windowsHide: true });

    let output = '';
    let status = 0;
    try {
      output = execFileSync(process.execPath, ['scripts/leak-check.mjs'], { cwd: repoDir, env: GIT_ENV, encoding: 'utf8', windowsHide: true });
    } catch (e) {
      status = typeof e.status === 'number' ? e.status : 1;
      output = (e.stdout || '') + (e.stderr || '');
    }

    const pass = status === 0 && /leak-check: OK/.test(output);
    return {
      pass,
      detail: pass
        ? 'leak-check exited 0 and reported OK despite the gitignored fixture file -- committable-set scanning confirmed'
        : `leak-check exited ${status}; output: ${output.slice(0, 400)}`,
    };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}
