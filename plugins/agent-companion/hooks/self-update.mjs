// SessionStart — say when a newer plugin version is installed but not loaded.
//
// Keeping a plugin current is the harness's job: Claude Code's own plugin
// autoupdater runs at startup whenever its auto-updater switch is on, and the
// built-in commands (`claude plugin marketplace update`, `claude plugin
// update`) cover the case where it is off — the daily local scout runs them.
// This hook does not update anything. It does the one thing neither of those
// can: tell a live session that the copy it is running is older than the copy
// on disk, because "installed" and "loaded" differ by a restart nobody is
// reminded to do.
//
// Zero side effects, zero tokens on a quiet day. Skipped for inline/dev loads.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readStdin, opt, passthrough } from './lib/context.mjs';

function installedVersion(plugin, marketplace) {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = (j.plugins || j)[`${plugin}@${marketplace}`];
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    const user = list.find((e) => e.scope === 'user') || list[0];
    return user?.version || null;
  } catch {
    return null;
  }
}

try {
  readStdin();
  if (!opt('update_notice', true)) passthrough();

  // Only a marketplace-cache load has a version to compare:
  // .../plugins/cache/<marketplace>/<plugin>/<version>
  const root = String(process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\\/g, '/');
  const m = root.match(/\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!m) passthrough();
  const [, marketplace, plugin, running] = m;

  const installed = installedVersion(plugin, marketplace);
  if (installed && installed !== running) {
    process.stdout.write(JSON.stringify({
      systemMessage: `agent-companion: ${plugin} ${installed} is installed but this session is running ${running} — restart to apply it.`,
    }));
  }
  process.exit(0);
} catch {
  passthrough(); // never break a session
}
