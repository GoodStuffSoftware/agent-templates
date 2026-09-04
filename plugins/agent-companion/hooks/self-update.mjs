// SessionStart — keep the installed plugin current.
//
// Claude Code has its own plugin autoupdater. It runs at startup and is gated
// on the same switch as the CLI's self-update (DISABLE_AUTOUPDATER=1, or
// `autoUpdates: false` in settings). Turning that off is common and
// deliberate — a pinned CLI on a machine where updates broke something — and
// it has a silent side effect: the plugins stop updating too. A month-old copy
// keeps running, guards and all, looking exactly like the current one.
//
// This hook covers that case: when the native autoupdater is off, it runs
// `marketplace update` + `plugin update` in a detached background process at
// most once a day. Either way it does the one thing a background process
// cannot — tells the session when a newer version is installed but not yet
// loaded. Zero tokens on a quiet day. Never runs in a cloud sandbox (fresh
// each run) or for an inline/dev load (not ours to update).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readStdin, opt, dataDir, passthrough } from './lib/context.mjs';

const THROTTLE_MS = 24 * 60 * 60 * 1000;
const CLAUDE_HOME = join(homedir(), '.claude');

function installedVersion(plugin, marketplace) {
  try {
    const j = JSON.parse(readFileSync(join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'), 'utf8'));
    const entries = (j.plugins || j)[`${plugin}@${marketplace}`];
    const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
    const user = list.find((e) => e.scope === 'user') || list[0];
    return user?.version || null;
  } catch {
    return null;
  }
}

function nativeAutoupdateOff() {
  if (/^(1|true|yes)$/i.test(String(process.env.DISABLE_AUTOUPDATER || ''))) return true;
  try {
    const s = JSON.parse(readFileSync(join(CLAUDE_HOME, 'settings.json'), 'utf8'));
    if (s.autoUpdates === false) return true;
    if (/^(1|true|yes)$/i.test(String(s.env?.DISABLE_AUTOUPDATER || ''))) return true;
  } catch { /* no settings: native default is on */ }
  return false;
}

function finish(messages) {
  if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: `agent-companion: ${messages.join(' ')}` }));
  }
  process.exit(0);
}

try {
  readStdin();
  if (!opt('auto_update', true)) passthrough();
  if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) passthrough();

  // Only a marketplace-cache load is ours to update: .../plugins/cache/<marketplace>/<plugin>/<version>
  const root = String(process.env.CLAUDE_PLUGIN_ROOT || '').replace(/\\/g, '/');
  const m = root.match(/\/plugins\/cache\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!m) passthrough();
  const [, marketplace, plugin, running] = m;

  const messages = [];

  // 1. A newer version already installed but not loaded: say so. This is the
  //    part that needs a live session, and the part people miss.
  const installed = installedVersion(plugin, marketplace);
  if (installed && installed !== running) {
    messages.push(`${plugin} ${installed} is installed but this session is running ${running} — restart to apply it.`);
  }

  // 2. Defer to the native autoupdater when it is on.
  if (!nativeAutoupdateOff()) finish(messages);

  // 3. Native is off: throttled background refresh of the clone and the install.
  const stampFile = join(dataDir(), 'self-update.json');
  let stamp = {};
  try { stamp = JSON.parse(readFileSync(stampFile, 'utf8')); } catch { /* first run */ }
  if (Date.now() - (stamp.lastRun || 0) >= THROTTLE_MS) {
    try { writeFileSync(stampFile, JSON.stringify({ lastRun: Date.now(), running, installed, reason: 'native autoupdater off' })); } catch { /* fail open */ }
    const cmd = `claude plugin marketplace update ${marketplace} && claude plugin update ${plugin}@${marketplace}`;
    let log;
    try { log = openSync(join(dataDir(), 'self-update.log'), 'a'); } catch { log = 'ignore'; }
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', cmd], { detached: true, stdio: ['ignore', log, log], windowsHide: true })
      : spawn('sh', ['-c', cmd], { detached: true, stdio: ['ignore', log, log] });
    child.on('error', () => { /* claude not on PATH here: nothing to do */ });
    child.unref();
  }

  finish(messages);
} catch {
  passthrough(); // never break a session
}
