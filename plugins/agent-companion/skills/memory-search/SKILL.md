---
name: memory-search
description: Search the operator's WHOLE memory corpus — every project's memory/*.md under ~/.claude/projects/*/memory/ (the "user" scope), plus the checked-out repository's own CLAUDE.md, .claude/, docs/, and lessons/ (the "repo" scope) — with BM25 lexical ranking. Use when a task smells previously-solved, when you hit an unfamiliar error and want to know if another project already hit it, when recalling why a past decision was made, or when onboarding to a repo you have not worked in before. Triggers - "have I solved this before", "did we hit this error in another project", "what did we decide about X", "is there prior art for this", recalling a past fix across repos.
---

# Memory search — cross-project technical recall

A BM25 index over two independent scopes, ranked by chunk (not whole file)
with a breadcrumb on every hit:

- **user** — every project's `memory/*.md` under `~/.claude/projects/*/memory/`.
  The operator's auto memory. Lives on this machine only.
- **repo** — the checked-out repository itself (`CLAUDE.md`, `CLAUDE.local.md`,
  `.claude/**/*.md`, `docs/**/*.md`, `lessons/**/*.md` by default, configurable).
  Covers content this plugin does not otherwise put in context: agent
  definitions that load only when that agent runs, skills that contribute only
  their description until invoked, nested `CLAUDE.md` files, and `docs/`.

Both are searched together by default. This exists for the gap neither this
project's own loaded memory nor the always-loaded instruction files can fill:
what got solved, decided, or learned somewhere else — or somewhere in this
same repo that just isn't in context right now.

## The cloud-session limitation

**In a cloud session there is no `~/.claude/projects` at all** — the user
scope comes back empty, always. The repo scope still works fully, because the
cloned repository is right there. This means cross-project recall (the
original point of this tool) is simply unavailable in the cloud; what remains
is recall within the current repo, which is still real and often enough
(agent/skill/docs content that is not in this session's context). Do not treat
an empty user-scope result in the cloud as "nothing was ever solved" — it may
just mean the machine that holds that memory is not this one.

## When to reach for it

- The task smells previously-solved — a config quirk, a flaky test, a deploy
  step that always trips people up.
- An error message or stack trace looks generic enough that another project
  has probably hit it too.
- A decision's *rationale* matters ("why did we pick X over Y") and is not
  written down in the code itself.
- Onboarding to a repo this session has not worked in before, where a scan of
  what's been learned beats re-discovering it from scratch.

## When NOT to

- The answer is in the code in front of you. Read that first.
- It's already in **this project's own `MEMORY.md`**, loaded at session start.
  Searching for what you already have in context wastes a call and adds
  nothing — this tool is for what is *not* already in front of you.

## Locate the plugin first

`${CLAUDE_PLUGIN_ROOT}` is set only inside hooks. In an ordinary shell it is
empty, so a command written with it collapses silently. Resolve it explicitly:

```bash
AC="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/agent-companion 2>/dev/null | head -1)"
[ -n "$AC" ] || AC="$(ls -d "$HOME"/.claude/plugins/cache/*/agent-companion/* 2>/dev/null | tail -1)"
[ -n "$AC" ] || { echo "agent-companion not found — is the plugin installed?"; }
```

PowerShell (forward slashes on purpose — they survive copy-paste):

```powershell
$AC = (Get-ChildItem "$env:USERPROFILE/.claude/plugins/marketplaces/*/plugins/agent-companion" -Directory | Select-Object -First 1).FullName
```

## How to invoke

```bash
node "$AC/scripts/memory-search.mjs" "<query>"                  # both scopes
node "$AC/scripts/memory-search.mjs" "<query>" --scope repo     # this repo only
node "$AC/scripts/memory-search.mjs" "<query>" --scope user     # user corpus only
node "$AC/scripts/memory-search.mjs" "<query>" --project best-sudoku
node "$AC/scripts/memory-search.mjs" "<query>" --limit 5 --json
node "$AC/scripts/memory-search.mjs" --stats
```

`--scope user|repo|all` picks which corpus to search; default `all` searches
both together as one ranked pool. `--project` is a case-insensitive substring
match against the user scope's project directory name — it has no effect on
repo-scope hits, which have no per-project structure. `--limit` defaults to
10. `--json` gives machine-readable hits (score, scope, place, file, heading,
snippet) for a caller that wants to post-process rather than read prose.
`--stats` reports both scopes' size separately (projects/files/chunks for
user; files/chunks/skipped-for-size/truncated for repo) with no query, useful
for sanity-checking that either corpus sees anything at all. `--cwd <path>`
resolves the repo scope from a directory other than the current one — the
spawn-time hook needs this since its cwd is the spawning agent's, not this
script's own.

## Repo scope: what it covers, and the worktree caveat

The repo scope resolves by walking up from cwd to the nearest `.git` and
indexes `CLAUDE.md`, `CLAUDE.local.md`, `.claude/**/*.md`, `docs/**/*.md`, and
`lessons/**/*.md` under that root by default (configurable via
`memory_search_repo_globs`; per-file and total-size caps apply and are
reported by `--stats`). **If that root is itself a git worktree**, its
`.git` is a file rather than a directory, and it has its own checked-out
branch distinct from the main checkout — a repo-scope hit found there is
labeled `[worktree:<branch>]` (or `[unmerged:<branch>]` in a spawn brief),
because that content is real and searchable but not yet on the main line. The
scope always excludes its own `.claude/worktrees/**` — those are SIBLING
checkouts of other branches, and indexing them from here would duplicate the
whole repository once per worktree and swamp the ranking.

## How to read results

Each hit is `score  place · heading trail`, followed by a snippet, where
`place` is `project · file` for a user-scope hit or `repo[:worktree tag] ·
file` (relative to the repo root) for a repo-scope hit. These are **pointers,
not the content itself** — open the file at the given heading for the real
thing before acting on it. Memories carry **no expiry**: a hit may describe a
decision that was later reversed, a bug since fixed, or a constraint that no
longer holds. Check the date and surrounding context in the file itself; do
not treat a hit as current just because it ranked highly.

## The honest limitation

This is **BM25 lexical ranking, not semantic search**. It matches shared
words, not shared meaning. A specific, multi-word technical query works well —
error strings, flag names, file names ("firebase emulator boot failure",
"ETIMEDOUT wrangler dev"). A vague conceptual query works poorly ("how do we
do deploys") because it shares few literal terms with whatever text actually
answers it. Query with the distinctive terms you'd expect the answer to
contain, not a prose description of what you want to know.

## Recovering a lead from session history

If the corpus above comes up empty, it may be because the answer was never
written down as a memory file — but a past session may still have solved it,
and left a trace at compaction time. `scripts/transcript-harvest.mjs` mines
that trace: not a transcript search tool (a separate tool elsewhere in the
operator's toolchain already does full-text transcript search), but a
harvester for the structured recap Claude Code writes for *itself* when a
conversation runs out of context and gets compacted.

```bash
node "$AC/scripts/transcript-harvest.mjs" --project <name> --limit 10
```

It writes a reviewable Markdown digest (plus a JSON sidecar) under the
plugin's data directory and prints the path — it never touches a `memory/`
directory itself. Treat everything in that digest as a **model's own
recollection of an earlier conversation, not a primary source**: it can be
incomplete, or simply wrong about its own history. Read it, verify anything
that looks relevant against the real files or commits, and only then propose
it as a memory through the normal memory-writing path — never copy a digest
entry straight into a memory file.
