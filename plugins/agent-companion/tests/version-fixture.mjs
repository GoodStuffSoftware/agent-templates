// Fixture machine for the version.mjs / plugin_copy_stale tests: a CLI cache copy
// with its installed_plugins.json entry, a marketplace clone, and desktop-app rpm
// copies, each at a version the test chooses. Built inside a makeFixture() home.

import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export const HOUR = 3600 * 1000;
// A 40-hex commit id for installed_plugins.json, assembled so no contiguous hex
// run appears in this file (it is itself leak-checked).
export const FIXTURE_SHA = ['01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67', '89', 'ab', 'cd', 'ef', '01', '23', '45', '67'].join('');

export function writeManifest(dir, version, name = 'agent-companion') {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
}

// Build a fixture machine. versions: { cli, desktop (string or array of
// strings), marketplace }; a null cli means no installed_plugins.json entry.
export function machine(dir, now, { cli = '0.29.24', desktop = '0.29.24', marketplace = '0.29.24', publishedMsAgo = 10 * HOUR } = {}) {
  const claude = join(dir, '.claude');
  const out = { claude, cliPath: null, desktopPaths: [], marketplacePath: null };
  if (cli) {
    out.cliPath = join(claude, 'plugins', 'cache', 'agent-templates', 'agent-companion', cli);
    writeManifest(out.cliPath, cli);
    mkdirSync(join(claude, 'plugins'), { recursive: true });
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'agent-companion@agent-templates': [{
          scope: 'user', installPath: out.cliPath, version: cli,
          installedAt: '2026-09-18T20:28:32.855Z', lastUpdated: '2026-10-02T18:46:41.054Z',
          gitCommitSha: FIXTURE_SHA,
        }],
      },
    }));
  }
  if (marketplace) {
    const loc = join(claude, 'plugins', 'marketplaces', 'agent-templates');
    out.marketplacePath = loc;
    mkdirSync(join(loc, '.claude-plugin'), { recursive: true });
    writeFileSync(join(loc, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'agent-templates', plugins: [{ name: 'agent-companion', source: './plugins/agent-companion', version: marketplace }],
    }));
    const pdir = join(loc, 'plugins', 'agent-companion');
    writeManifest(pdir, marketplace);
    const when = new Date(now - publishedMsAgo);
    utimesSync(join(pdir, '.claude-plugin', 'plugin.json'), when, when);
    mkdirSync(join(claude, 'plugins'), { recursive: true });
    writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({
      'agent-templates': {
        source: { source: 'git', url: 'https://git.example.invalid/example-owner/example-repo.git' },
        installLocation: loc, lastUpdated: '2026-10-02T18:46:39.838Z',
      },
    }));
  }
  const dvs = desktop === null ? [] : [].concat(desktop);
  dvs.forEach((v, i) => {
    const p = join(dir, 'desktop', 'acct-1', 'org-1', 'rpm', `plugin_FIX${i}`);
    writeManifest(p, v);
    out.desktopPaths.push(p);
  });
  return out;
}

