---
name: version
description: Say which agent-companion version is running and whether every installed copy (CLI cache, desktop app copy, marketplace clone) is current. Use for "what version", "which agent-companion version", "is the plugin up to date", "is the desktop app on the new version", "why is the old routing still in effect", or "/ac version".
---

# version — which copy is running, and are they all current

Claude Code keeps more than one copy of this plugin:

- **CLI cache** (`~/.claude/plugins/cache/<marketplace>/agent-companion/<ver>/`),
  the copy `installed_plugins.json` records. CLI sessions run it.
- **Desktop copy** (`%APPDATA%\Claude\local-agent-mode-sessions\<acct>\<org>\rpm\plugin_<id>\`,
  the equivalent folder on macOS and Linux). The desktop app may keep its own
  copy, synced from claude.ai, not from the CLI cache; Desktop Code-tab sessions
  run their hooks and skills from it. When the app has none, desktop sessions
  use the CLI cache copy, and the script says so.
- **Marketplace clone** (`~/.claude/plugins/marketplaces/<marketplace>/`), what
  `claude plugin update` installs from.

Only the **user-scope** record in `installed_plugins.json` is a valid install: the
plugin runs from ONE install per machine. Any project- or local-scope record is
not judged for staleness; the script reports it as "should not exist (user scope
only)".

They update separately. On 2026-10-02 the desktop copy was 0.29.22 while the CLI
copy was 0.29.24, so desktop sessions kept the old routing and nothing said so.

## Run it

Run the script from this skill's own plugin copy (the base directory shown when
the skill loaded is `<plugin>/skills/version`, so the script is two levels up):

```bash
node "<base directory>/../../scripts/version.mjs"
```

`--remote` also reads origin/main's version (via `gh api`, else `git ls-remote`;
optional, time-boxed, a failure only adds a note). `--json` prints the same data
as JSON. If the base directory is not known, resolve the plugin like the other
skills do:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
node "$AC/scripts/version.mjs"
```

The first form reports on the copy the session is actually using; the second
runs the marketplace clone's script, which finds the same installs.

## Report it in 3 to 5 plain lines

1. **This copy:** the version, and which kind of copy it is (CLI cache, desktop
   copy, or a source checkout). That is the copy the current session runs.
2. **The other copies:** each one's version (CLI cache, each desktop copy).
3. **Latest:** the marketplace version (and origin/main, if `--remote` was used).
4. **The verdict line** from the script, as it is: `all copies current`, or
   `STALE: <copy> is <ver>, latest is <ver>`, either followed by `N project- or
   local-scope records should not exist (user scope only)` when stray records
   exist (with no user-scope install it opens `no user-scope install;`: install
   at user scope first).
5. **The fix**, only when something is stale or a project/local record exists, naming which sessions are affected:
   - **CLI cache stale** (CLI sessions): `claude plugin marketplace update
     agent-templates`, then `claude plugin update agent-companion@agent-templates
     --scope user`, then restart the session or `/reload-plugins`.
   - **Project or local record** ("should not exist (user scope only)"): never
     update it. Per record, the script gives the project path, the settings file
     that recreates it (`enabledPlugins` in `.claude/settings.json` or
     `settings.local.json`), and the fix: remove that line (the user settings
     already enable the plugin), then remove the record from
     `installed_plugins.json` (edit the file; not `claude plugin uninstall`,
     which wipes the plugin options).
   - **Desktop copy stale** (Desktop Code-tab sessions): `claude plugin update`
     does not touch it. Verified 2026-10-02: disable, then re-enable,
     agent-companion in the desktop app's plugin manager (not `claude plugin
     uninstall`, which wipes the plugin options). That removes the desktop copy.
     After that, idle desktop sessions pick up the current copy on their next turn; a
     session that is mid-turn picks it up after that turn. Confirm with
     `/ac version`. Afterwards the desktop session runs the CLI cache copy,
     so a later `claude plugin update` covers it.
   - **No separate desktop copy**: not a fault. The script prints that desktop
     sessions load the CLI cache copy; report that line as it is.
   - **This session's copy is an older cache folder** than the installed one: the
     session predates an update. Restart the session (or `/reload-plugins`).

If a hook or guard message names an rpm path that version.mjs does not list, check
whether that directory still exists. If it is gone, the message predates the
copy's removal; that session runs the current copy from its next turn.

A copy younger than about 6 hours behind is normal after a release; say so rather
than raising an alarm. Never print tokens or credentials; the script prints none.
