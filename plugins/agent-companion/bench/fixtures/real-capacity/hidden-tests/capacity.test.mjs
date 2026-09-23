// Hidden scoring test for the real-capacity task. Not visible to the model
// during the run -- copied into test/capacity.test.mjs at scoring time only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHeadroomGB,
  computeConcurrencyBudget,
  computePolicy,
  computeBudget,
  isClaudeCodeSessionProcess,
  isElectronDesktopProcess,
} from '../src/capacity.mjs';

// --- pre-existing suite: unrelated pure math, must still pass -------------

test('computeHeadroomGB: 25% of total when that exceeds the 4GB floor', () => {
  assert.equal(computeHeadroomGB(64), 16);
  assert.equal(computeHeadroomGB(32), 8);
});

test('computeHeadroomGB: floors at 4GB on small machines', () => {
  assert.equal(computeHeadroomGB(8), 4);
  assert.equal(computeHeadroomGB(4), 4);
  assert.equal(computeHeadroomGB(0), 4);
});

test('computeConcurrencyBudget: straightforward division, floored', () => {
  assert.equal(computeConcurrencyBudget(20, 4, 2), 8);
});

test('computeConcurrencyBudget: clamps to >= 1 when usable memory is negative or tiny', () => {
  assert.equal(computeConcurrencyBudget(2, 4, 2), 1);
});

test('computePolicy: idle-teammates-ok at and above threshold', () => {
  assert.equal(computePolicy(12, 12).policy, 'idle-teammates-ok');
  assert.equal(computePolicy(20, 12).policy, 'idle-teammates-ok');
});

test('computePolicy: stop-between-rounds below threshold', () => {
  assert.equal(computePolicy(5, 12).policy, 'stop-between-rounds');
});

test('computeBudget: end-to-end on a generous machine', () => {
  const r = computeBudget({ totalGB: 64, freeGB: 41 });
  assert.equal(r.policy, 'idle-teammates-ok');
});

// --- new tests from the fix commit: the process matcher --------------------
// Synthetic executablePath/commandLine strings only -- no real process table
// read here. Shapes: a Windows claude-code session vs. the Windows Store
// desktop (Electron) app main + helper process (share the same "claude.exe"
// Name, only ExecutablePath/CommandLine tell them apart), and the POSIX /
// macOS equivalents.

const WIN_SESSION = {
  executablePath: String.raw`C:\Users\you\AppData\Roaming\Claude\claude-code\2.1.280\claude.exe`,
  commandLine: String.raw`"C:\Users\you\AppData\Roaming\Claude\claude-code\2.1.280\claude.exe" --output-format stream-json`,
};

const WIN_DESKTOP_MAIN = {
  executablePath: String.raw`C:\Program Files\WindowsApps\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe`,
  commandLine: String.raw`"C:\Program Files\WindowsApps\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe" `,
};

const WIN_DESKTOP_HELPER = {
  executablePath: String.raw`C:\Program Files\WindowsApps\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe`,
  commandLine: String.raw`"C:\Program Files\WindowsApps\Claude_2.7032.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe" --type=renderer --user-data-dir="C:\Users\you\AppData\Roaming\Claude"`,
};

const POSIX_SESSION_BINARY = {
  commandLine: '/usr/local/bin/claude --output-format stream-json --print',
};

const POSIX_SESSION_NPM_PKG = {
  commandLine: 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --output-format stream-json',
};

const POSIX_ELECTRON_MAC = {
  commandLine: '/Applications/Claude.app/Contents/MacOS/Claude',
};

const POSIX_ELECTRON_MAC_HELPER = {
  commandLine: '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer',
};

const POSIX_UNRELATED = {
  commandLine: '/usr/bin/node /opt/some-other-app/server.js --port 3000',
};

test('isClaudeCodeSessionProcess: matches a Windows claude-code session by ExecutablePath', () => {
  assert.equal(isClaudeCodeSessionProcess(WIN_SESSION), true);
});

test('isClaudeCodeSessionProcess: excludes the Windows desktop Electron main process', () => {
  assert.equal(isClaudeCodeSessionProcess(WIN_DESKTOP_MAIN), false);
});

test('isClaudeCodeSessionProcess: excludes a Windows desktop Electron helper (--type=renderer etc.)', () => {
  assert.equal(isClaudeCodeSessionProcess(WIN_DESKTOP_HELPER), false);
});

test('isClaudeCodeSessionProcess: matches the POSIX claude CLI binary', () => {
  assert.equal(isClaudeCodeSessionProcess(POSIX_SESSION_BINARY), true);
});

test('isClaudeCodeSessionProcess: matches a POSIX @anthropic-ai/claude-code npm invocation', () => {
  assert.equal(isClaudeCodeSessionProcess(POSIX_SESSION_NPM_PKG), true);
});

test('isClaudeCodeSessionProcess: excludes the macOS desktop Electron app bundle', () => {
  assert.equal(isClaudeCodeSessionProcess(POSIX_ELECTRON_MAC), false);
});

test('isClaudeCodeSessionProcess: excludes a macOS desktop Electron helper', () => {
  assert.equal(isClaudeCodeSessionProcess(POSIX_ELECTRON_MAC_HELPER), false);
});

test('isClaudeCodeSessionProcess: an unrelated node process matches neither shape', () => {
  assert.equal(isClaudeCodeSessionProcess(POSIX_UNRELATED), false);
});

test('isElectronDesktopProcess: true for Windows desktop main + helper, false for a session', () => {
  assert.equal(isElectronDesktopProcess(WIN_DESKTOP_MAIN), true);
  assert.equal(isElectronDesktopProcess(WIN_DESKTOP_HELPER), true);
  assert.equal(isElectronDesktopProcess(WIN_SESSION), false);
});

test('isElectronDesktopProcess: true for macOS desktop bundle + helper, false for a session', () => {
  assert.equal(isElectronDesktopProcess(POSIX_ELECTRON_MAC), true);
  assert.equal(isElectronDesktopProcess(POSIX_ELECTRON_MAC_HELPER), true);
  assert.equal(isElectronDesktopProcess(POSIX_SESSION_BINARY), false);
});
