// Does the harness itself run the main conversation's subagents in the background?
//
// Claude Code 2.1.302 changed the desktop app and VS Code to always run the main
// conversation's subagents in the background, as the terminal does, rather than
// let Claude choose. On those entrypoints at that version or later the spawn
// guard's foreground fix (run_in_background: true through updatedInput) changes
// nothing, so it is skipped there.
//
// Both facts come from the hook process's environment: CLAUDE_CODE_ENTRYPOINT
// (claude-desktop, claude-desktop-3p, claude-vscode) and the version in the path
// of the running CLI (CLAUDE_CODE_EXECPATH, ".../claude-code/2.1.309/<hash>/claude.exe").
// VS Code only counts when its binary path carries an exact x.y.z folder name like the desktop layout.
// When either is missing or unreadable the answer is false: the fix stays on,
// which is harmless where the harness already backgrounds the spawn.

export const HARNESS_BG_SINCE = [2, 1, 302];
const ENTRYPOINTS = new Set(['claude-desktop', 'claude-desktop-3p', 'claude-vscode']);

export function cliVersionFromPath(execPath) {
  const parts = String(execPath || '').split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(parts[i]);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

export function versionAtLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

// The harness backgrounds these spawns through its fork-subagent gate; CLAUDE_CODE_FORK_SUBAGENT=0 (or false)
// turns the gate off, and then a foreground spawn stays foreground, so the fix must stay on.
const FORK_OFF = new Set(['0', 'false', 'off', 'no']);

export function harnessBackgroundsMain(env = process.env) {
  if (FORK_OFF.has(String(env.CLAUDE_CODE_FORK_SUBAGENT || '').trim().toLowerCase())) return false;
  if (!ENTRYPOINTS.has(String(env.CLAUDE_CODE_ENTRYPOINT || '').trim())) return false;
  return versionAtLeast(cliVersionFromPath(env.CLAUDE_CODE_EXECPATH), HARNESS_BG_SINCE);
}
