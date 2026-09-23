// Extracted from a larger shared-helpers module. Standalone here: only the
// pieces opt() actually needs.
import { join } from 'node:path';
import { homedir } from 'node:os';

export function homeRoot() {
  return process.env.AGENT_COMPANION_HOME_OVERRIDE || homedir();
}
export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homeRoot(), '.claude');
}

// userConfig keys surface as CLAUDE_PLUGIN_OPTION_<KEY> env vars, and Claude
// Code uppercases <KEY> (e.g. `webhook_url` -> CLAUDE_PLUGIN_OPTION_WEBHOOK_URL).
// process.env property lookup is case-insensitive on Windows but
// case-sensitive on Linux/macOS, so a lowercase-only lookup here would work on
// Windows and silently fall back to the default everywhere else. Try the
// uppercased name first, then the verbatim key, so this is correct regardless
// of which case the harness actually used.
export function opt(key, fallback) {
  const raw = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`]
    ?? process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  if (raw === undefined || raw === '') return fallback;
  if (typeof fallback === 'boolean') return !/^(false|0|no|off)$/i.test(raw);
  if (typeof fallback === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  return raw;
}
