// Shared env for every test that runs scripts/detect.mjs.
//
// detect.mjs section 1 runs `claude --version` (20 s inner timeout) and
// section 9 asks `gh` for CI status. A test that lets those reach the real CLI
// does two things wrong: every full `node --test` run spawns the real claude
// (forbidden on this machine), and under load the child can outlive the test's
// spawn budget, so the test sees status null and flakes.
//
// detectEnv() returns env overrides that make both calls offline and instant:
//   - a `claude` stub dir FIRST on PATH, in one of two modes:
//       missing (default)  exits 127, like a CI runner with no CLI installed;
//                          detect.mjs takes its harness_version_unreadable path.
//       { version }        prints `<version> (Claude Code)` and exits 0, for
//                          tests whose assertions depend on what
//                          `claude --version` reports.
//   - AGENT_COMPANION_CI_STATUS_NO_GH=1, detect.mjs's own offline switch for
//     section 9.
//
// The stub is a shell script (sh on Linux/macOS, .cmd and .bat on Windows) and
// never node, so it reads and writes nothing under the real home. Each mode's
// stub dir is created once per process under the OS temp dir and removed when
// the process exits.
//
// PATH spelling: Windows env names are case-insensitive but a spread object is
// not, and callers merge the result OVER process.env. So PATH is written under
// the exact spelling process.env uses (Path or PATH), never as a second key
// beside it.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';

// What the stub reports when a test asks for a version but not a particular one.
export const DEFAULT_STUB_VERSION = '2.1.300';
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

const stubDirs = new Map(); // mode key -> dir
let cleanupArmed = false;

function armCleanup() {
  if (cleanupArmed) return;
  cleanupArmed = true;
  process.once('exit', () => {
    for (const dir of stubDirs.values()) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
    }
  });
}

function stubDir(version) {
  const key = version ?? '';
  const known = stubDirs.get(key);
  if (known) return known;
  if (version !== undefined && !VERSION_SHAPE.test(version)) {
    throw new Error(`detectEnv: version must look like 1.2.3, got ${JSON.stringify(version)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), version === undefined ? 'ac-noclaude-' : 'ac-fakeclaude-'));
  if (process.platform === 'win32') {
    // cmd.exe tries every PATHEXT extension in THIS directory before moving to
    // the next one, so a .cmd/.bat here shadows a real claude.exe later in PATH.
    const body = version === undefined
      ? '@echo off\r\nexit /b 127\r\n'
      : `@echo off\r\necho ${version} (Claude Code)\r\nexit /b 0\r\n`;
    writeFileSync(join(dir, 'claude.cmd'), body);
    writeFileSync(join(dir, 'claude.bat'), body);
  } else {
    const body = version === undefined
      ? '#!/bin/sh\nexit 127\n'
      : `#!/bin/sh\necho '${version} (Claude Code)'\nexit 0\n`;
    writeFileSync(join(dir, 'claude'), body, { mode: 0o755 });
  }
  stubDirs.set(key, dir);
  armCleanup();
  return dir;
}

// opts.env      base env to take PATH from and carry through (default: none, so
//               PATH comes from process.env). Any PATH spelling is accepted.
// opts.version  "1.2.3": the stub prints `1.2.3 (Claude Code)` and exits 0.
//               Omitted: the stub exits 127 (claude missing).
// Returns an env object to pass as a runScript()/spawn `env`.
export function detectEnv({ env = {}, version } = {}) {
  const out = {};
  let path = '';
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === 'path') { path = path || v; continue; }
    out[k] = v;
  }
  if (!path) path = process.env[PATH_KEY] || '';
  out[PATH_KEY] = [stubDir(version), path].filter(Boolean).join(delimiter);
  out.AGENT_COMPANION_CI_STATUS_NO_GH = '1';
  return out;
}
