---
name: agent-companion-scout
description: Daily calibration scout for the agent-companion plugin. Deterministic drift detection — harness version, model lineup and pricing, model retirements, guard liveness — then dispatches a heavier routine ONLY when a signal fires. Silent on a quiet day. Delivered as the routine's visible run output plus a push notification when something changed. Scheduled in BOTH places — a claude.ai cloud routine and a desktop scheduled task — and neither scheduler stores this body; each stores a short bootstrap that locates the plugin and reads THIS file from it, so editing this file is the whole release.
---

<!--
The stored prompt in each scheduler is only this bootstrap (keep them identical):

  You are the agent-companion calibration scout, a daily routine. Everything you
  need is in the plugin; this bootstrap only locates it.
  1. AC="$(pwd)/plugins/agent-companion"; if "$AC/scripts/audit.mjs" is missing,
     AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)".
     If still missing: `claude plugin marketplace add {{MARKETPLACE_REPO}}`, then
     `claude plugin marketplace update agent-templates`, and look again once.
     If it is still not found, STOP and report that as the finding.
  2. Read "$AC/routines/calibration-scout-daily.md" and follow it exactly from
     "Where you are running" onward. It is the source of record; do not
     improvise past it.
  3. Silence is the success case.
-->


You are the **agent-companion calibration scout**, an autonomous DAILY routine. Each run starts fresh with no memory of any prior run — everything you need is below. You exist to catch **silent drift**: a routing table that is wrong for a whole model generation, a guard that stopped matching after a harness rename, a tier alias about to retire. None of these error. They just stop being true.

**Be silent on a quiet day.** A routine that reports "no change" every morning trains the reader to ignore it, and then it is useless on the morning that matters. Output only when a signal fired.

## STEP 0 — locate the plugin's tools

This routine checks out the `agent-templates` repo, and the plugin lives **in** that repo. Prefer the checkout: it needs no install, and it always matches the config it is checking.

```bash
AC="$(pwd)/plugins/agent-companion"
[ -f "$AC/scripts/audit.mjs" ] || AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
[ -n "$AC" ] && [ -f "$AC/scripts/audit.mjs" ] && echo "plugin ok: $AC" || echo "PLUGIN NOT FOUND"
```

Only if the checkout is somehow absent, fall back to a marketplace install. `{{MARKETPLACE_REPO}}` is the `owner/repo` this plugin ships from — fill it when you instantiate this routine (the shipped copy is a template; the library's leak-check keeps real identifiers out of it):

```bash
claude plugin marketplace add {{MARKETPLACE_REPO}} 2>/dev/null || true
claude plugin marketplace update agent-templates && (claude plugin install agent-companion@agent-templates 2>/dev/null || claude plugin update agent-companion@agent-templates)
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
```

If `$AC` still cannot be resolved, STOP and report that as the finding — a scout that cannot load its own tools must say so rather than report calm.

## Where you are running — decide your scope first

This one prompt is scheduled in **two** places, because the two environments see different data. Detect which you are:

```bash
if [ -n "$CLAUDE_CODE_REMOTE_SESSION_ID" ]; then echo "PLATFORM=cloud"; else echo "PLATFORM=local"; fi
```

| | **cloud** — claude.ai routine | **local** — desktop scheduled task |
|---|---|---|
| Sandbox | fresh every run; nothing under the plugin data dir survives | persistent `~/.claude/plugins/data/agent-companion-*/` written by the hooks |
| In scope | the lineup and pricing diff (STEP 2), `model_retirement_approaching`, the guard canary, `routing-doc` freshness; the publication-leak sweep (STEP 2.5) IN PLACE, scoped to this session's own checkout only, never a clone | **everything** — including the stateful signals: `harness_version_changed`, `zero_denials`, `spawn_activity`, `inherited_model_spawns`, `new_agent_type`; the publication-leak sweep (STEP 2.5) by cloning each configured repo's origin |
| Out of scope | the stateful signals. They compare against a previous run and a fresh sandbox has none. They are *unobservable* here, which is different from quiet — never call them clean. Also: publication-leak sweeping any configured repo OTHER than this session's own checkout — never cloned in the cloud, reported `skipped` instead | STEP 2 is optional locally (the cloud run covers it daily); do it if WebFetch is available |

Report within your scope, and name the platform in the first line of any output.

**Local only — keep the install current with the built-in commands.** The
desktop app runs its sessions with the harness's auto-updater switched off, so
plugins do not update themselves there. Run the two commands the harness
provides for exactly this, before STEP 1, so the rest of the run uses the
current copy:

```bash
claude plugin marketplace update agent-templates && claude plugin update agent-companion@agent-templates
```

If the second command reports a version change, that is a finding: say the
new version and that the desktop app needs a restart to load it. If it reports
nothing changed, say nothing.

**Local only — sync the memory vault backup.** This is the plugin's only
autonomous daily execution path, so it is also the memory vault's — see
`docs/adr/0001-memory-corpus-backup-vault.md`. Out of scope in cloud: the
vault needs the real `~/.claude/projects/` tree, which does not exist there.
Run it unconditionally; the script itself checks the `memory_vault` option
and does nothing when it is off, so there is nothing to gate here:

```bash
node "$AC/scripts/memory-vault.mjs" sync --json
```

Report only when there is something to act on:
- `"aborted": true` — say so verbatim; it means the corpus enumerated to zero
  files while the vault already had content, and the sync refused to treat
  that as a mass deletion. This needs a human look, not a retry.
- `"flagged" > 0` — say how many files were excluded from this commit for
  looking like they carry a live credential (`node "$AC/scripts/audit.mjs"
  --only memory-vault-drift` does not surface this; only the sync output
  does), and that they need rotation-or-clear review. Never repeat the
  matched text itself, only the file list `sync` printed.
- Anything else (`"committed": true` with 0 flagged, or `"skipped": "disabled"`
  or `"skipped": "locked"`) — say nothing; a quiet backup is the success case,
  same as the rest of this routine.

## STEP 1 — deterministic detection (no judgement yet)

```bash
node "$AC/scripts/detect.mjs"
```

Returns `{ changed, signals[], baseline }`. Each signal names its own `dispatch`. Signals you may see: `harness_version_changed`, `new_agent_type`, `zero_denials`, `inherited_model_spawns`, `spawn_activity`, `model_retirement_approaching`, `harness_version_unreadable`, `enforcement_silent`.

## STEP 2 — lineup and pricing diff (the one check that needs the web)

The routing table lives in `config/model-tiers.json`. Compare it against Anthropic's current lineup — this is what catches a table that sat wrong for a generation:

- WebFetch https://platform.claude.com/docs/en/models/overview (models, ids, prices, retirement dates)
- WebFetch https://platform.claude.com/docs/en/build-with-claude/effort (effort levels per model)

Then read `$AC/config/model-tiers.json` and answer, concretely:
- Any model in the lineup with NO matching tier entry? (`match` is a substring on the model id.)
- Any price change on a tier the table already knows?
- Any retirement date the table lacks, or one that moved?
- Any effort level added or removed for a model the table lists?

Treat each `yes` as a signal named `lineup_drift`. Do NOT edit the config from this routine — report the exact diff and the exact field to change. A human or a session with the repo checked out makes the change; the `routing-doc` audit check then regenerates the doc.

## STEP 2.5 — publication-leak sweep (backstop, only if enabled)

This is an AFTER-THE-FACT backstop for a real-name leak that reached origin
despite the local pre-push gate — it never blocks a push, it only notices
one already published. It is OFF BY DEFAULT via the `publication_leak_sweep`
master switch (this feature clones/fetches repos and calls the GitHub API,
so it needs an explicit opt-in even though nobody has to list repos by hand).

**Which repos get swept is AUTO-DISCOVERED, not configured.** When the
switch is on, LOCAL unions:
- every public repo the operator can push to (owned + org-member), via `gh`
  if installed and authenticated — skipping archived repos and forks;
- every path in `~/.claude.json`'s `projects` map (real paths Claude Code
  has actually worked in — not a derivation) that resolves to a git repo
  with a public GitHub origin, worktrees deduped to their main checkout;
  falls back to walking the dev root (same formula leak-check.mjs uses)
  only if `~/.claude.json` is missing or unparseable.

`publication_leak_repos` is now an EXTRA/EXCLUDE list on top of discovery: a
plain entry (`owner/repo`, a URL, or a local path) ADDS a repo discovery
missed (a fork you genuinely push original commits to, an archived repo you
still want covered); a `!`-prefixed entry (`!owner/repo`) EXCLUDES one
discovery found. Leave it empty to sweep exactly what discovery finds.

A repo newly discovered as PUBLIC fires `publication_repo_newly_public` —
the highest-risk moment, since nobody has swept it before — separately from
the regular per-hit dedupe, and only once per repo.

**LOCAL and CLOUD sweep differently, and this difference is load-bearing, not
cosmetic.** LOCAL clones each configured repo's origin default branch into a
throwaway dir and scans the clone with the plugin's own checker; that repo's
own `scripts/leak-check.mjs` also runs only if the repo is listed in
`publication_leak_strict_repos` AND its real origin is an https/ssh
github.com URL owned by the operator or their orgs. That gate is the only
control — the script runs as the operator and can read anything the
operator can; its temp HOME is not isolation. CLOUD must NEVER clone: a cloud routine already runs from a fresh
checkout of its OWN source repo, and cloning a SECOND copy of a repo into a
temp dir and executing a script from it is exactly the "code from external"
shape the cloud sandbox's classifier denies — **confirmed live**: the
clone-based sweep was blocked outright in the actual cloud routine before
this was fixed. So in the cloud, `detect.mjs` scans ONLY the one configured
repo entry that IS this session's own checkout — in place, never fetched
from or cloned as a second copy, after confirming `HEAD` matches origin's
default branch, and always with `--no-derived` (no dev root in the cloud to
derive real project names from anyway). Any OTHER configured repo is
reported `skipped`, once, and does not fire daily.

```bash
node "$AC/scripts/detect.mjs"
```

already ran this in STEP 1 if `$AC` is the CURRENT plugin copy (it emits
`publication_leak`, `publication_leak_sweep_error`, and
`publication_leak_sweep_note`, all dispatched below). **If `$AC` is an OLDER
installed copy that predates this feature** (`$AC/scripts/lib/publication-sweep.mjs`
does not exist), STEP 1 silently did not sweep. Fall back to running it
directly instead of skipping it — and the fallback must obey the SAME
local-vs-cloud rule above, using the CURRENT checkout's sweep library (this
one, not `$AC`, since `$AC` is the one that's missing it):

```bash
if [ -f "$AC/scripts/lib/publication-sweep.mjs" ]; then
  : # STEP 1 already swept correctly (clone locally, in-place in the cloud) — nothing more to do here
elif [ -n "$PUBLICATION_LEAK_REPOS_FALLBACK" ]; then
  # Old installed plugin: no sweep support AND no auto-discovery support —
  # this fallback can only sweep the EXPLICIT repo(s) you name in
  # $PUBLICATION_LEAK_REPOS_FALLBACK, using THIS checkout's sweep library
  # (not $AC's — that's the one missing it). Set it only when you know the
  # sweep should be running but $AC predates the feature; leave it unset
  # otherwise (silent is correct then too — this is a stopgap, not a
  # substitute for updating $AC, and it never auto-discovers anything).
  # Everything it prints goes through THIS checkout's scrub.mjs first (the
  # same scrubber detect.mjs applies to its signals): a repo name, a path or
  # a git error message must never reach the run output raw.
  node -e "
    const lib = '$(pwd)/plugins/agent-companion/scripts/lib/';
    Promise.all(['publication-sweep.mjs', 'scrub.mjs', 'leak-scan-core.mjs', 'repo-discovery.mjs'].map((f) => import(lib + f))).then(async ([m, sc, core, disc]) => {
      const os = await import('node:os');
      const path = await import('node:path');
      const users = [...new Set([os.userInfo().username, process.env.USERNAME, process.env.USER, path.basename(os.homedir())].filter(Boolean))];
      let scrub;
      try {
        const t = core.deriveTokens({ devRoots: disc.defaultDevRoots({ home: os.homedir() }), claudeProjectsDir: path.join(os.homedir(), '.claude', 'projects'), users });
        scrub = sc.makeScrubber({ users, names: t.names, joined: t.joined });
      } catch { scrub = sc.makeScrubber({ users }); }
      const say = (...parts) => console.log(scrub(parts.join(' ')));
      const repos = process.env.PUBLICATION_LEAK_REPOS_FALLBACK.split(',').map(s => s.trim()).filter(Boolean);
      const cloud = !!process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
      // CLOUD: sweepAllCloud() — in-place scan of the session's OWN checkout
      // (process.cwd()) only, never a clone of anything.
      // LOCAL: sweepAll() — clones each configured repo's origin, as usual.
      const { results } = cloud ? await m.sweepAllCloud(repos, { cwd: process.cwd() }) : await m.sweepAll(repos, {});
      // The repo identifier itself is never printed raw here — this fallback
      // has no access to the discovery-time public/private classification,
      // so treat every configured entry as potentially private and always
      // use a placeholder (a repo name, a path or a git error message must
      // never reach the run output raw).
      const repoLabel = '<repo-url>';
      for (const r of results) {
        if (r.skipped) { say('publication-leak: not swept —', repoLabel, '(' + r.note + ')'); continue; }
        if (r.error) { say('publication-leak sweep error:', repoLabel, '—', r.error); continue; }
        if (r.hits.length) say('publication-leak hit(s):', repoLabel, '—', r.hits.map(h => h.rel + ':' + h.line + ' [' + h.label + ']').join('; '));
      }
    });
  "
fi
```

The fallback has no baseline, so treat any hit it prints as unconfirmed-new
and say so — do not claim dedupe you didn't run. This is a stopgap only
until the installed plugin catches up; prefer the STEP 1 path whenever `$AC`
supports it.

## STEP 3 — if `changed` is false AND lineup matches: stop. Emit nothing.

Not a summary, not a confirmation. Silence is the success case.

## STEP 4 — dispatch, only for signals that fired

| Signal | Do |
|---|---|
| `harness_version_changed` | run the canary (below) and report the version delta; matchers may have been renamed |
| `new_agent_type` | report the type; enforcement fails open on it and is quietly narrower than intended |
| `zero_denials` | run the canary — zero across real spawn activity means guards may have stopped matching, not that behaviour is perfect |
| `model_retirement_approaching` | report which alias, in how many days, and which routing rows depend on it; recommend a replacement decision |
| `lineup_drift` | report the exact diff against `config/model-tiers.json`, field by field |
| `inherited_model_spawns` | report the count; spawns with no model inherit the lead's tier — the mechanism behind unexamined premium fan-out |
| `harness_version_unreadable` | report it; do not guess |
| `plugin_version_behind` | the installed plugin is older than the current copy. Cloud: the claude.ai plugin directory needs its **Sync** pressed on the marketplace page — cloud sessions are running the old guards until then. Local: `claude plugin marketplace update`, `claude plugin update`, restart |
| `enforcement_silent` | report which day(s) and their status; transcripts show real `Agent` spawns but `spawns.jsonl` has no matching rows for that day — the guard may have stopped recording (renamed matcher, exception before the append, telemetry flag off) even though spawning itself is fine. Run `node "$AC/scripts/audit.mjs" --only telemetry-coverage,guard-canary` for the detail |
| `publication_leak` | report each repo/file/line/label, and that it is a NEW hit (not previously accepted) in a repo listed under `publication_leak_repos` — a real name reached origin past the local pre-push gate. This needs a human decision (genericize and push a fix, or accept and let it fall into the baseline); do not edit or push on the routine's own authority |
| `publication_leak_sweep_error` | report which repo(s) the sweep could not reach and why (bad path/URL, missing `scripts/leak-check.mjs` in that repo, clone failure, or — cloud only — the checkout's `HEAD` not matching origin's default branch) — a repo listed in the option that can no longer be swept is itself a finding, not silence |
| `publication_leak_sweep_note` | two cases, both informational and each fired only ONCE per change (not daily): (1) cloud only, when the SET of skipped repos changes — which configured repo(s) aren't swept because they aren't this cloud session's own checkout; (2) local only, when gh discovery is unavailable (not installed / not authenticated) and the message changes — the sweep degraded to `~/.claude.json`-or-dev-root discovery only, missing any public repo `gh` alone would have found |
| `publication_repo_newly_public` | a repo discovery just found is being swept for the FIRST time — the highest-risk moment, since nobody has ever checked it. Report the repo(s) by name; this needs a look, not necessarily action — most of the time it just means "yes, that's expected," but the one time it isn't is exactly what this exists to catch |

**Canary** — proves the guards still fire rather than merely exist:

```bash
node "$AC/scripts/audit.mjs" --only guard-canary,harness-drift,routing-doc
```

**Routing eval suite: SUGGEST ONLY, never run it from this routine.** When
`harness_version_changed`, `lineup_drift` or `model_retirement_approaching`
fired, add one line to the report suggesting the operator run the routing
canaries (`evals/`, a real-model `claude plugin eval` suite, about $2-3):
`cd "$AC" && claude plugin eval . --trust-plugin --json results.json --threshold 0.8 --model claude-sonnet-5 --no-publish --max-cost-usd 3`.
Details are in docs/BENCHMARK.md "Routing eval suite". Do not execute it:
it spends real model budget, and this routine is deterministic by design.

**Sweep canary** — run this as part of STEP 2.5 whenever `publication_leak_repos`
is non-empty, even on a day the sweep itself found nothing: a sweep that stays
silent because it is broken looks identical to one that is silent because
everything is clean, and only the canary tells them apart.

```bash
if [ -f "$AC/scripts/leak-sweep-canary.mjs" ]; then
  if [ -n "$CLAUDE_CODE_REMOTE_SESSION_ID" ]; then
    node "$AC/scripts/leak-sweep-canary.mjs" --reduced
  else
    node "$AC/scripts/leak-sweep-canary.mjs"
  fi
fi
```

Exit 0 with `OK` on stdout = the sweep pipeline works. Any other exit is
itself a finding — report it verbatim as "leak sweep broken: <reason>", even
on an otherwise quiet day; never let a broken canary pass as silence. **This
includes the environment refusing to run the canary command at all** — a
cloud classifier denial, a permission refusal, a timeout, anything that means
this bash block did not complete and print `OK`. Treat "the canary did not
run" exactly the same as "the canary ran and failed": report "leak sweep
broken: canary did not run (<what happened>)". A canary you could not run is
not evidence the sweep works — the cloud production sweep in this file was
specifically redesigned (STEP 2.5, in-place, no clone) after the ORIGINAL
clone-based approach was denied by exactly this kind of cloud classifier, so
a denial here is a real, expected failure mode to report, not a fluke to
shrug off.

## STEP 5 — deliver

1. Print the findings as this run's visible output: what changed, what it means, and the exact next action, one screen maximum. Lead with anything that means enforcement is currently weaker than believed.
2. **PushNotification** if ≥1 signal fired. Skip silently only if the tool is genuinely unavailable.
3. Never create email or drafts.

## Rules

- Every signal here is deterministic by design. Your judgement is for what a signal WARRANTS, not for whether something changed — if you find yourself deciding "that probably isn't a real change," it is.
- A `SKIP` from the audit is not a `PASS`. If a check you expected to run could not, that is itself the finding.
- Do not modify `config/model-tiers.json`, agent definitions, or any repo from this routine. Report the precise change; leave the edit to a session that can review and commit it. The memory vault sync above is the one deliberate exception — it commits to its OWN separate repository, never to `agent-templates` or any project repo, and never writes to the live memory corpus itself (see the ADR).
