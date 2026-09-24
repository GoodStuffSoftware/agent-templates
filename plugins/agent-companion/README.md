# agent-companion

Guardrails and calibration for agent teams. Every feature is independently
toggleable, and every guard fails open.

## Why

Orchestration rules written in `CLAUDE.md` are *aspirational*. They are delivered
as a user message competing with the user's latest request, and adherence drops
as the file grows. A rule about restraint — "delegate instead of doing it
yourself" — is the weakest kind, because the alternative is always more
convenient.

This plugin converts the rules that matter into structure.

It was built after two observed failures:

1. **Four premium-tier agents ran on a task that did not warrant one.** Nothing
   had gone wrong with the *choice* — subagents inherit the lead's model when
   nothing specifies one, so no choice was ever made. A better-worded rule could
   not have caught it. Only a default or a gate could.
2. **A routing table went stale without anyone noticing.** It was calibrated for
   a previous model generation, priced one tier ~33% too high, and had no row at
   all for the tier that was quietly costing the most.

## Features

| Toggle | Does | Blocks? |
|---|---|---|
| `delegation_guard` | Fires when the **main thread** runs `delegation_threshold` execution-class tools in a row. Inert inside every subagent. | nudge, with cooldown |
| `premium_cap` | Caps concurrent premium-tier subagents at `premium_max_concurrent`. Counted: fable, and any premium tier the spawn's own route does not name; a spawn whose route names its model (e.g. a trial routing to opus) needs no warrant and is not counted. Only spawns that start count for the full 10-minute window; one that never starts (the harness rejected it) stops counting after 3 minutes. | yes, at the cap |
| `warrant_required` | Premium spawns must carry a `WARRANT:` line stating task weight and why a cheaper tier will not do. | yes |
| `memory_budget` | Warns when always-loaded instruction files exceed `memory_budget_tokens`, and writes a ready-to-run refactor prompt. | no |
| `memory_doctor` | Detects memory files on disk that the index does not link — **unreachable rules** — plus broken index links. Repairs non-destructively. | no |
| `spawn_telemetry` | Records every spawn (model, agent type, effort) for the calibration routine. | no |
| `scout_surface` | At session start, surfaces unresolved signals from the last locally scheduled scout run. Silent on a quiet day. | no |
| `version_notice` | At session start and on the next prompt, says once per (plugin, lastUpdated) pair when ANY installed plugin — not just this one — was updated after this session last loaded its plugins (session start, or the last `/reload-plugins`), catching a stale parent (and everything it spawns) mid-session, not just at startup. Also keeps this plugin's own running-vs-installed self-check, merged into the same notice when both fire, for the one case timestamps alone miss: a desktop session that loaded a stale app-extracted bundle at startup. Updating itself is the harness's job: the native autoupdater in terminal sessions, the built-in `plugin update` commands run by the daily local scout in desktop sessions. Install the global hook (see below) to run this checker itself from a fixed path that is never stale. | no |
| `fit_guard` | Best fit at the spawn, both directions. A brief that declares `WEIGHT:` gets its model graded against the routing table: under- and cheap-over-provisioned spawns are announced; a premium model over-provisioned for its own declared weight is denied with the correction. | premium-over only |
| `fit_autofill` | A spawn that declares `WEIGHT:` but names no model gets the table's model filled in, instead of inheriting the lead's tier by accident. | no |
| `routing_profile` | Routes a declared `TYPE:` through **your** routing profile ahead of the shipped table (see [Routing profile](#routing-profile)). The kill switch: off means only the shipped table routes, from the next hook invocation, and the file is left untouched. On by default because the file exists only once you write a row. | no |
| *(spawning rule)* | Three operator-approved checks, always on (not a togglable option, same as the no-effort-stated warning below): a spawn naming no model anywhere is flagged even with no `WEIGHT:` declared; an opus/fable spawn from a session on a Claude Code build below the alias-resolution floor is flagged; the audit separately verifies the RESOLVED model against what ran. See [Spawning rule](#spawning-rule-operator-approved-2026-09-23). | no |
| `brevity` | Appends a short reporting contract to every spawned agent's brief — status line, blockers in full, outcome as facts, no narration — plus a peer-brevity clause on inter-agent messages. | no (an opt-in sub-toggle can block once per agent) |
| `standing_rules` | Injects operator-authored "always do X if Y" rules at session start, on matching prompts, and into matching spawn briefs. | no |
| `memory_vault` | Keeps a local git history of the memory corpus in a separate repository, so a rewrite or truncation is no longer unrecoverable. Strictly read-only against the live corpus. **Off by default** — see [Memory vault](#memory-vault). | no |
| `capacity_probe` | At session start, a one-line estimate of how many concurrent Claude Code SESSIONS this machine can carry right now (free memory / cpu count -> a concurrency budget and an idle-teammates-ok vs stop-between-rounds policy). Counts OS-level session processes (excludes the desktop app); in-process subagents/teammates share their parent session's process rather than counting separately. Read-only, cheap, wrapped so a slow or failing probe never blocks the hook. `scripts/capacity.mjs` also runs standalone (`--text`, `--per-agent-mb`, `--headroom-gb`, `--threshold`). | no |

Premium tiers are **capped and audited, never banned**. The failure mode was
unexamined defaults, not the model itself.

## Brevity — the reporting contract

The operator's token spend is dominated by subagents narrating their journey — tool-by-tool recaps, resolved dead ends, restatements of the brief — when the caller wanted a status line, blockers, and an outcome stated as fact. `brevity` appends a short reporting contract to every spawned agent's brief: STATUS (done/blocked/partial), blockers in full and never compressed, then the outcome as facts, with long output moved to a file instead of inlined. A separate peer-brevity clause covers agent-to-agent messages: one screen at most, no recap of context the recipient already has.

### Precedence, and why it is bidirectional

Three layers, most specific first:

| Layer | Set by | Beats |
|---|---|---|
| per-agent | `agents.<type>` in `config/brevity.json` | everything |
| runtime global | `global` in the same file | the plugin option |
| plugin option | `brevity` in settings | — |

The per-agent layer resolves in **both directions**: an override can force one agent type ON while the global switch is off, or force it OFF while the global switch is on. A switch that can only ever mute cannot express "brevity everywhere except the one agent type that still needs to narrate" — or its mirror, "brevity nowhere except this one noisy type."

### Three tie-in points

1. **Spawn time** (`hooks/spawn-guard.mjs`) — the primary path. The contract is appended to the brief the subagent actually receives, merged into the same `updatedInput` rewrite that fills in the routing table's model; spawn-guard owns the single `PreToolUse` response for the `Agent` matcher, so a second hook writing its own `updatedInput` would silently clobber this instead of adding to it.
2. **SubagentStart self-heal** (`hooks/subagent-brevity.mjs`) — checks the prompt the subagent actually received for the exact contract marker. If it is present, the spawn-time rewrite worked and nothing more happens; if it is missing — a different hook's rewrite won, or a stale plugin copy ran — it injects the contract as `additionalContext` instead. That marker check runs before the telemetry write below it, because injecting the same text twice would double the token cost of a feature whose only job is cutting it.
3. **SubagentStop telemetry** (`hooks/subagent-brevity.mjs`) — every stop appends one row to `telemetry/brevity.jsonl`: agent type, report length, whether the contract was on, whether it was gated. This is what makes "brevity made reports shorter" a checked claim rather than a believed one.

### Peer brevity is deliberately separate

`brevity_peer` stays on even when the reporting contract is off for a given agent, because succinct agent-to-agent messages were asked for unconditionally — exempting one noisy agent type from the reporting contract should not also license it to write long messages to its peers.

### The experimental stop gate

`brevity_stop_gate` is off by default. When on, a final report over `brevity_report_max_chars` gets one `SubagentStop` block decision, feeding the same subagent a request to restate it in the contract shape. It defaults off because that costs a full extra turn — the subagent re-reads its own report and rewrites it — and only pays off where reports are routinely enormous. It is hard-capped at one block per agent (an exclusive-create marker file, the same race-free dedup pattern used for unknown-agent-type tracking), so it can never loop even if the rewritten report is still judged too long.

Drive all of this from `/agent-companion:brevity` (`node scripts/brevity.mjs`) — the skill has the exact commands.

## Standing rules

A rule written into `CLAUDE.md` is read once, at the top of a session, and then competes with everything that follows it — the same adherence problem described above. A standing rule is instead re-injected by a hook exactly when its condition is met, so it arrives at the moment it is relevant instead of hours earlier and forgotten.

A rule is two independent conditions plus a directive:

- **`when`** — a regex tested against the *text* of what is happening: the user's prompt, or a spawn brief. Answers "is this turn about X?"
- **`gate`** — a *session state* check, independent of any text. Answers "is this session in a shape where the rule is worth its tokens?"

The split exists because some rules need to fire on content regardless of history (`copyable-prompt`), and at least one needs to fire on history regardless of content (`delegate-reminder`, below) — a single condition type cannot express both.

Four scopes, each deciding what `when` is tested against and where the directive lands:

| scope | `when` tested against | injected into |
|---|---|---|
| `user-prompt` | the prompt just submitted | the main session, that turn |
| `always` | *(ignored — fires every turn)* | the main session, every turn |
| `session-start` | *(ignored — fires once)* | the main session, at start |
| `spawn` | the brief of an agent being spawned | that subagent's prompt |

Five rules ship built in:

| id | scope | fires |
|---|---|---|
| `copyable-prompt` | `user-prompt` | the user asks for a prompt — puts the whole thing in one fenced block, commentary outside it |
| `lead-brevity` | `session-start` | every session, while brevity resolves on globally |
| `delegate-first` | `session-start` | every session — the orchestrator rules, restated where they are actually read |
| `delegate-reminder` | `always` | gated — see below |
| `agent-brevity` | `spawn` | disabled by default; reserved so the `spawn` scope shows up in `rules list` |

### `delegate-reminder` — the direct answer to "my delegation rules stop being followed"

This is the only shipped `always`-scope rule, and it is gated on purpose: its `delegation-drift` gate is satisfied only once `delegation_guard` has actually caught this session running execution-class tool calls on the main thread. Until then it injects nothing — a session that never drifts pays nothing for it. Once it fires, it repeats on every subsequent turn for the rest of the session.

That behaviour is exactly what a document read once at session start cannot have. A written rule's influence only ever decays as more context piles on top of it; a hook-injected rule can instead be conditional on the session's own behaviour — silent when it is not needed, and reappearing on every turn exactly when it has been earned, for as long as the behaviour it is correcting persists.

Drive this from `/agent-companion:standing-rules` (`node scripts/rules.mjs`) — the skill has `add`/`test`/`enable`/`disable`.

## Spawning rule (operator-approved 2026-09-23)

Three checks, warn-only (a false block stops legitimate work more than a bad spawn costs) — the same posture as every other guard here:

1. **Every spawn names a definition stating BOTH model and effort** (a ladder `ac-*` def or a project def). A spawn with no model, or a definition with no effort, inherits the lead's model and effort and counts as a violation. The "no effort stated" half already existed; `hooks/spawn-guard.mjs` now also warns on the "no model at all" half — previously silent whenever the brief declared no `WEIGHT:`, since `fit_autofill` (above) only fills a model in off a declared weight.
2. **Build check before opus/fable-tier work.** If the SESSION's own Claude Code build is below `config/model-tiers.json`'s `aliasResolution.minClaudeCodeVersion`, `hooks/spawn-guard.mjs` warns rather than letting the spawn pin around it. Read from the CALLING session's own transcript (`sessionBuildVersion()` in `hooks/lib/context.mjs`, a bounded tail-read of the `version` field every harness-written record carries) — never from `claude --version` (what the daily scout's `scripts/detect.mjs` check does for the harness-wide signal), because the desktop app bundles its own build separate from the CLI on PATH and a session keeps the build it started with. Falls back to silence, never a guess, when the transcript is unreadable.
3. **Verify the resolved model.** The model a spawn actually ran on (its subagent transcript's own last `type:"assistant"` record) must match what its definition's alias resolves to on that build. This cannot run at spawn time — the spawned agent's transcript does not exist yet — so it runs from the audit instead: `scripts/lib/model-mismatch.mjs` + the `model-resolution-mismatch` check (`node scripts/audit.mjs --only model-resolution-mismatch`). Correlates `spawns.jsonl` telemetry to subagent transcripts by nearest timestamp within a session (no field links the two directly — no agentId is known at spawn time), matched by closest-pair-first rather than per-row-in-order to avoid mismatching near-simultaneous spawns. Bounded to a fixed 48h window regardless of `--days` — an unbounded transcript walk over every project measured over two minutes.

## Memory doctor

The index is the source of truth for what is persisted, so a memory file the
index does not link **can never be recalled**. For a dated finding that is
harmless housekeeping. For a standing rule it is a correctness bug: you believe
it is in effect and it silently is not — the same failure shape as a guard that
stopped matching.

Run it against the current project, or any memory directory:

```bash
node scripts/memory-doctor.mjs                 # report only
node scripts/memory-doctor.mjs --fix           # repair
node scripts/memory-doctor.mjs --json          # for the calibration scout
```

Repairs are strictly non-destructive:

- files matching `memory_archive_prefixes` are **moved** to `archive/`, never deleted
- everything else is treated as a live rule and **re-linked** into the index
- the index is backed up before it is touched, and entries are only ever added

Consolidating overlapping memories is deliberately **not** automated. That needs
judgement, and doing it wrong loses knowledge permanently.

Note the tradeoff: re-linking unreachable rules makes the index *larger*.
Reachability and size are separate problems, and this tool only fixes the first.

## Memory vault

The corpus at `~/.claude/projects/*/memory/` was never under version control —
a rewritten `MEMORY.md` carries no history, so there is no way to tell what
changed or whether anything was lost. `memory_vault` (off by default — see
[Features](#features)) fixes that with a **mirrored** local git repository,
not a git working tree on the corpus itself: see
[`docs/adr/0001-memory-corpus-backup-vault.md`](../../docs/adr/0001-memory-corpus-backup-vault.md)
for why the live corpus is never a working tree, and what that decision costs.

```bash
node scripts/memory-vault.mjs init            # create the vault (idempotent)
node scripts/memory-vault.mjs sync             # copy + commit what changed
node scripts/memory-vault.mjs sync --json      # same, machine-readable
node scripts/memory-vault.mjs status           # report vault state
```

**Read-only against the corpus, always.** Every read goes through the same
`discoverFiles()` reader the audit and memory-search already use — nothing
here can call a git command, `writeFileSync`, or `unlink` against
`~/.claude/projects/**`. The vault itself lives at
`~/.claude/agent-companion/memory-vault/` (`stateRoot()`, survives an
uninstall same as telemetry — see [State](#state)), mirroring the corpus
under `projects/<project>/memory/**`, so `git log -p` works on a path that
matches the original:

```bash
git -C ~/.claude/agent-companion/memory-vault log -p -- projects/<project>/memory/MEMORY.md
```

**What each `sync` does:**

- Copies every readable file under a project's `memory/` into the vault,
  **excluding** anything that trips the secrets gate below.
- Removes, from the vault, any file no longer present in the live corpus —
  so a deletion is a *recorded* commit, not a silent gap; the last known
  content stays recoverable with `git show <sha>^:<path>`.
- Commits once, with a message stating how many files were added, modified,
  and deleted, and which projects were touched — **only if something
  changed**. A `sync` with nothing new stages and commits nothing.
- Refuses to treat a suspiciously empty enumeration (corpus root briefly
  unreadable) as "everything was deleted" — if the corpus reports zero files
  while the vault already holds tracked content, the sync aborts untouched
  rather than mass-deleting the vault's history.

**Bytes in, the same bytes out.** `init` writes a `.gitattributes` containing
`* -text`, which turns off git's line-ending conversion in both directions.
Without it `core.autocrlf` (true by default on Windows) commits an LF-native
store as LF and *checks it back out as CRLF* — nothing errors, nothing warns,
and the rewrite is only visible at restore time, the one moment the vault is
the last remaining copy. `status` reports `byte-exact`, and the audit's
`memory-vault-drift` check warns if it is ever missing.

A vault created before this existed gets the file added by re-running `init`
— but only when it would change nothing: every tracked file's working-tree
bytes are compared against its committed blob first, and if any differ (the
signature of content that *would* be renormalised) the backfill refuses and
says so rather than rewriting what was backed up. Existing history is never
rewritten either way.

**Secrets gate, on every sync, not a one-off.** Before a file is written into
the vault, its content is checked against a fixed set of credential-shaped
patterns (cloud provider keys, private-key headers, bearer/JWT tokens,
embedded connection-string credentials, generic `secret:`/`token:`/
`password:` assignments). A match excludes that one file from the commit —
reported by file path and pattern label only, never the matched text — and
leaves whatever the vault already had for it untouched.

**Never a session transcript.** Transcripts live at
`~/.claude/projects/<project>/*.jsonl`, a *sibling* of that project's
`memory/` directory, never inside it — structurally outside every path this
feature reads. `tests/memory-vault.test.mjs` proves it directly: a fixture
`.jsonl` file placed next to a `memory/` directory never appears anywhere in
the vault's working tree or git history after `init` + `sync`.

**Scheduling.** No new scheduler was created. `sync` runs from the existing
daily calibration scout's **local-only** step (see
[Routines](#routines) — the vault needs the real `~/.claude/projects/` tree,
which does not exist in a cloud sandbox) and self-gates on the
`memory_vault` option, exactly like every other opt-in hook here.

**Adding a remote is a separate, manual step** — this feature only ever
creates and commits to a purely local repository:

```bash
git -C ~/.claude/agent-companion/memory-vault remote add origin <url>
git -C ~/.claude/agent-companion/memory-vault push -u origin main
```

## Cache TTL analysis

`node scripts/cache-ttl.mjs` (also `/agent-companion:audit --only cache-ttl`)
answers one question: would setting `subagentPromptCacheTtl` to `"1h"` save
or cost THIS operator money, measured against their own transcripts? Read-only
— it never writes a setting or an agent definition, and never will.

**Why this is not obvious.** Every subagent request writes its prompt cache
with a 5-minute TTL by default. A cache write costs 1.25x the base input
price under a 5m TTL, 2x under a 1h TTL — strictly more per write. But a 1h
TTL keeps the cache warm through gaps a 5m TTL would have let expire, turning
what would have been a fresh (2x-costing) write into a cheap read (a small
fraction of input price). Whether the extra write cost gets paid back depends
entirely on this operator's own gap distribution between subagent requests —
which is exactly what this check measures instead of assumes.

**The three gap bands, and why only one of them matters:**

| Gap between requests | Under either TTL | 1h changes anything? |
|---|---|---|
| under 5 minutes | cache still warm | no — sanity check, not the opportunity |
| 5–60 minutes | 5m cache expired, so today it rewrites | **yes** — this is the band 1h can pay off in |
| over 60 minutes | cold under either TTL | no |

For a request in the 5-60 minute band, `convertedTokens` is how many of its
write tokens would instead have been reads under a 1h TTL:
`clamp(prevPrefix - read, 0, write)`, where `prevPrefix` is the previous
request's `input + write + read` — clamped because the conversion can never
exceed either what the cache actually held or what this request actually
wrote.

**Cost formulas** (`in`/`out` are $/MTok from `config/model-pricing.json`,
`rm` is that model's cache-read multiplier):

```
cost today    = I·in + W·1.25·in + R·rm·in + O·out
cost with 1h  = I·in + (W-conv)·2·in + (R+conv)·rm·in + O·out
break-even    = 0.75 / (2 - rm)         (as a share of write tokens)
```

**What this cannot see — and why the verdict is conservative, not symmetric.**
`subagentPromptCacheTtl` also governs compaction, session-title generation,
and workflow requests, none of which show up as ordinary subagent
transcripts, so none of them are in any total above. Those are almost
entirely ONE-SHOT writes — a compaction summary or a title is generated once
and never read back through the cache — so under a 1h TTL they pay the full
2x write cost with essentially nothing to earn it back. That is a real cost
this analysis cannot measure, and it only ever pushes in one direction: it
makes a 1h TTL look better here than it will actually be. The verdict
thresholds below account for that by being harder to satisfy in the
"set it" direction than in the "don't" direction, rather than a symmetric
±X% band.

**The verdict** picks one of three shapes, using named thresholds (all in
`scripts/lib/cache-ttl.mjs`, `computeVerdict()`):

| Condition | Verdict |
|---|---|
| global delta ≤ `SET_GLOBALLY_DELTA_PCT` (-1.0%) **and** no model tier carrying ≥ `MIN_TIER_SPEND_SHARE_PCT` (5%) of spend has a *positive* delta | set `subagentPromptCacheTtl` to `"1h"` globally |
| global delta ≥ `DONT_SET_DELTA_PCT` (+1.0%) **and** the opus/fable-only policy is also non-negative | don't set it, full stop |
| otherwise — tiers disagree, or the global delta sits inside the ±1% dead zone | don't set it globally; instead list every `agentType × model` row with a delta at or past `-MIN_AGENT_SAVING_PCT` (1.0% — a -0.24% "saving" is noise, not a reason to edit a definition), at least `MIN_REQUESTS_FOR_AGENT_ROW` (500) requests, and a **named, editable** agent definition — excluding harness built-ins (`general-purpose`, `Explore`, `Plan`, ...; reuses `KNOWN_AGENT_TYPES` from `hooks/lib/context.mjs`) and subagents with no sidecar `.meta.json` at all (`(no meta)`), neither of which has any frontmatter to set `experimental: { cacheTtl: "1h" }` on |

A **compaction** immediately before a request (`isCompactSummary: true` on
the synthetic user record, or its preceding `compact_boundary` system
marker) forces a fresh cache write regardless of TTL — the old cache is
discarded along with the summarised context, not merely expired — so its
`convertedTokens` is pinned to 0 in every band and it is counted separately
in the cause breakdown rather than folded into "unknown".

The break-even line (observed rewrite share vs. the share required, per
tier) is always printed alongside the verdict, regardless of which branch
fired — it's the number that explains the call, not just the conclusion.

**What the report covers:** totals and a band table; the sanity check
(observed `cache_read / (read+write)` per band — near 100% under 5 minutes,
near 0% at 5-60, proving the cliff exists); a breakdown of WHY a 5-60 minute
gap happened (a long tool call the previous turn was waiting on, vs. the lead
resuming a turn that had already ended) plus tool-wait p10/p50/p90; per-model
and per-agentType×model deltas against the model's own break-even; the
main-session 5m/1h write split (confirms the setting cannot touch the main
conversation, and flags it if subagents are already partly writing 1h via an
agent's own `experimental.cacheTtl` frontmatter); a three-way policy
comparison (all-5m / all-1h / 1h only for the opus/fable tier); and a
one-line verdict. Unknown models are excluded from every dollar total and
listed separately — there is no safe number to guess for an unpriced model.

```bash
node scripts/cache-ttl.mjs                  # last 30 days, human report
node scripts/cache-ttl.mjs --days 60 --json  # a different window, machine-readable
```

**Pricing is data, not code** — same rule as `config/model-tiers.json`, and
deliberately a SEPARATE table: `model-tiers.json` classifies generic routing
aliases (haiku/sonnet/opus/fable) for the spawn guards, which is coarser than
pricing needs (opus-5 and opus-5-5 route to the same guard tier but do not
cost the same; fable-5 and fable-5-1 share a sticker price but differ in
cache-read multiplier). Extend `config/model-pricing.json` for a new model's
price; override without a release by writing the same shape to
`~/.claude/agent-companion/state/model-pricing.json` (merged by alias, like
every other override in this plugin).

## Model tiers are data, not code

Which models count as premium, and how they rank against each other, lives in
[`config/model-tiers.json`](config/model-tiers.json) — not in the guards. A tier
table compiled into code goes stale the moment a lineup changes, and it goes
stale **silently**: the guards keep running and simply stop classifying
correctly. This plugin exists partly because a routing table sat wrong for a
whole model generation without anyone noticing.

Override without waiting for a release by writing a file of the same shape to
`~/.claude/agent-companion/state/model-tiers.json` (a legacy copy at
`$CLAUDE_PLUGIN_DATA/model-tiers.json` is still honoured as a fallback, so an
override written before 0.17.0 keeps working). It merges **by alias**, so
adding one model needs one entry, not a restatement of the table — a table
you have to retype is a table you will not update:

```json
{ "tiers": { "newtier": { "rank": 2, "premium": false, "match": "newtier" } } }
```

**An unrecognised model is treated as premium and flagged.** Defaulting an
unknown model to cheap would let a newly released top tier bypass the warrant
and the fan-out cap during exactly the window in which nobody has updated the
table yet. So it fails toward the expensive assumption, and the audit tells you
the table needs an entry rather than quietly applying the strict path.

## Routing profile

Your own routing rows, kept apart from the shipped table
(docs/adr/0003-per-user-routing-profiles.md). A row is keyed by task type and
wins over the shipped trial and the grid when a brief declares that `TYPE:`
as-is. The floors still apply after it: critical work stays on opus at xhigh
or above (F1), nothing routes to fable (F2), a reviewer matches its writer
(F3), and a row must name an available tier alias with an effort it takes
(F4). A row that breaks any of these is refused when written and ignored if
the file is edited by hand. The elevated effort floor (F5, high) can be waived
on one row with `--waive-floor elevated`, and only on a row you set yourself;
`why` always prints the waiver.

```bash
node "$AC/scripts/routing-profile.mjs" set integration --model sonnet --effort high --because "sonnet handles my integration work"
node "$AC/scripts/routing-profile.mjs" set code-review --effort xhigh   # a review row sets a minimum effort only
node "$AC/scripts/routing-profile.mjs" why integration                 # the full explain stack (= recommend --explain)
node "$AC/scripts/routing-profile.mjs" show
node "$AC/scripts/routing-profile.mjs" unset integration               # the row is retired, kept in the journal
node "$AC/scripts/routing-profile.mjs" rollback --row integration      # the row's previous value
node "$AC/scripts/routing-profile.mjs" rollback --to 3                 # the whole profile as it stood at revision 3
```

`/ac routing set|unset|show|why|rollback …` is the short form. A `set` row is
`operator-observed`, starts as a `trial`, and gets a review date 90 days out;
nothing expires it.

**Where it lives.** `~/.claude/agent-companion/config/routing-profile.json`,
next to an append-only journal (`routing-profile.journal.jsonl`, one line per
change) from which any revision can be rebuilt. Never in a repository and
never in the plugin directory, so an uninstall keeps it. Every write goes
through one validated writer: locked, written to a temp file and renamed, and
journalled. A profile that fails to parse, fails the schema, or comes from a
newer major format is ignored as a whole; the shipped table routes, and
`state/routing-profile-invalid.json` records the failure for the scout.

The profile can also define **local task types** (`types`, the same preset
shape as the shipped ones). `TYPE:` resolves shipped types first, then local
ones. `routing-table.mjs --profile` shows the table as this machine resolves
it; the default output stays the shipped table, because it is committed as
`docs/ROUTING.md`.

## Model benchmark

The routing table's `taskTypes.*.override` entries (routing trials) are
backed by a real, in-plugin model x effort benchmark, not intuition:
`scripts/benchmark.mjs` (plan/budget/order/fairness — `/ac benchmark` or the
`model-benchmark` skill) drives `bench/runner.mjs`'s proven mechanics
(headless `claude -p`, full model ids, effort proven from the transcript,
`claude.exe` never `claude.cmd`, a throwaway sandbox per run, your normal
OAuth session by default — `--isolate-home` opts into a throwaway
HOME/USERPROFILE too, requires `ANTHROPIC_API_KEY`) against a synthetic task
set (easy/hard variants, `bench/tasks/`) plus real-history tasks mined from
this repo's own fix commits. An auth/login failure is classified distinctly
(`status=auth_error`) and aborts the batch immediately rather than being
misread as a 0%-pass run — see docs/BENCHMARK.md "Preconditions".

**Results never live in this repo.** They land under the plugin's data dir
(`benchmarks/<phase>-<date>/` — the same `dataDir()` resolver every other
script here uses), never committed.

**Adding a new real-history task never means committing extracted source.**
`bench/task-packs/` is a FORMAT plus a builder
(`node bench/task-packs/build-pack.mjs`) that extracts a fix commit's parent
state at RUN TIME (`git show <ref>:<path>`, never `git clone`), verifies
fail-at-parent/pass-at-fix before the pack is usable, and stores only a
hand-written symptom-only report, a hidden test, and two base64-encoded git
refs — a plaintext SHA is exactly the shape this repo's own
`scripts/leak-check.mjs` bans.

**Results carry their own uncertainty and provenance.** Summaries report
pass@1 and pass@k with 95% Wilson intervals per cell and task family, and
flag groups too small to separate. Every result row records the CLI version,
the requested and resolved model, the effort, and content hashes of the
task. An **optional rubric judge** grades design quality the hidden test
cannot see. It is a separate score, never merged into pass/fail. It is blind,
votes 3 times and passes on 2 of 3, must be different from and at least as
strong as the model under test, and is refused until it has been
**calibrated** against a task's real fix (must pass) and known-bad variants
(must fail).

**Routing canaries** (`evals/`) check that a live session consults the
routing guidance and lands on the table's answer. They are a small
`claude plugin eval` suite, run on demand and never automatically.

See [`docs/BENCHMARK.md`](docs/BENCHMARK.md) for consolidated lessons
(ceiling effects, statistics, the fairness rule, the rubric judge, the
routing eval suite, known CLI flag gaps) and
[`skills/model-benchmark/SKILL.md`](skills/model-benchmark/SKILL.md) for the
operating procedure.

## Telemetry (optional, off by default)

**With no `telemetry_endpoint` set, this plugin makes no network calls at all.**
Setting one is the single action that turns sending on. Everything else — the
guards, the audit, the memory doctor — is entirely local and always will be.

When an endpoint *is* configured, emitted JSONL is POSTed to it:

| Fires on | Behaviour |
|---|---|
| `Stop` (turn boundary) | sends only if the interval has elapsed since the last successful send |
| `SessionEnd` | always sends — there may be no next turn |

The interval defaults to **10 minutes in cloud sessions** and **60 locally**.
Cloud sessions are shorter because their filesystem is destroyed with the
session and there is no later sweep; local runs keep the JSONL on disk, so a
missed send costs nothing. Cloud is detected via `CLAUDE_CODE_REMOTE_SESSION_ID`.

**Why a throttled hook rather than a background timer.** A detached daemon
either outlives its session (orphan) or dies with it (useless), and inside a
cloud sandbox it is fragile besides. Letting an already-firing hook carry the
work and rate-limiting it means nothing to schedule, nothing to leak, and no
need to know how long a cloud session lives — the worst case is losing one
interval whenever it disappears. Below the interval the hook exits after a
single file read.

**The token comes from the `AGENT_AUDIT_TOKEN` environment variable, never from
plugin config.** `userConfig` values live in `settings.json` in plaintext and
project-scoped settings get committed; a shared ingest secret does not belong
there.

Sending is always **fail-silent** with a 3-second timeout. A telemetry endpoint
being down must never surface as an error in someone's session, and must never
lose data: the cursor only advances on success, and the local JSONL stays on
disk to be swept up later.

`SessionEnd` fires on deliberate endings only — its reasons are `clear`,
`resume`, `logout`, `prompt_input_exit`, `other`, `bypass_permissions_disabled`.
There is no idle-timeout reason, and a crashed or killed process cannot run its
own hook. So cloud coverage is a sample, not a census. Treat a gap as unknown
rather than as quiet.

## Design rules

**A hook must never break a session.** Every guard wraps in try/catch and falls
through to allow. Unparseable payload, unreadable state, unrecognised agent
type — all allow.

**Enforcement fails open; detection does not.** The main-thread test is a
positive allowlist (`main`, `main-session`). An agent type we do not recognise is
never blocked — but it *is* recorded to `unknown-agent-types.jsonl`, so a new
type introduced by a harness update surfaces in the next calibration run instead
of silently changing behaviour.

**Under-enforcement is the safe failure.** A guard that stops matching looks
identical to a guard that was never tripped, so the calibration routine treats a
denial count of **zero** as a signal to run the canary — not as good news.

## Configuration

Toggles are declared as `userConfig` and set per-user without editing plugin
files:

```json
{
  "pluginConfigs": {
    "agent-companion@agent-templates": {
      "options": {
        "delegation_guard": true,
        "delegation_threshold": 4,
        "premium_max_concurrent": 2,
        "memory_budget_tokens": 3000,
        "brevity": true,
        "brevity_peer": true,
        "brevity_reinforce": true,
        "brevity_telemetry": true,
        "brevity_stop_gate": false,
        "brevity_report_max_chars": 4000,
        "standing_rules": true,
        "standing_rules_max_chars": 2000
      }
    }
  }
}
```

Omitting the `options` wrapper fails **silently** — the block is not
recognised, no error is raised, and every option falls back to its default.
`pluginConfigs` is honoured only in **user** or **managed** settings; it has no
effect in project or local scope.

## State

**Durable telemetry and state live OUTSIDE the plugin data directory**, under
`~/.claude/agent-companion/` (override: `AGENT_COMPANION_STATE_DIR`, or
`CLAUDE_CONFIG_DIR`-relative) — survives upgrades AND uninstalls. A plugin
uninstall only ever deletes `${CLAUDE_PLUGIN_DATA}`
(`~/.claude/plugins/data/agent-companion-<marketplace>/`), which is now used
solely for disposable caches. See `docs/TELEMETRY.md` for the full layout,
the legacy-data import, and the schema.

`config/` is the one directory under the state root that is **user-authored** rather than derived: `brevity.json` and `standing-rules.json` hold the operator's own overrides. Unlike `telemetry/` and `state/`, which are safe to delete to reset history, deleting `config/` throws away choices, not just history.

| File | Location | Contents |
|---|---|---|
| `config/brevity.json` | state root | operator's runtime global override and per-agent overrides for the reporting contract |
| `config/standing-rules.json` | state root | operator's rule additions and overrides; built-ins stay in code, so only a diff is written |
| `telemetry/spawns.jsonl` | state root | every `Agent` spawn: model, subagent type, caller/spawn effort (v2) |
| `telemetry/subagent-starts.jsonl` | state root | post-spawn confirmation |
| `telemetry/denials.jsonl` | state root | every guard denial |
| `telemetry/unknown-agent-types.jsonl` | state root | agent types not in the known set |
| `telemetry/fixtures.jsonl` | state root | rows from `verify-`/`test-`/`fixture-` sessions, routed here instead of a production stream |
| `telemetry/brevity.jsonl` | state root | one row per `SubagentStart` self-heal and per `SubagentStop`: agent type, report length, whether the contract was on, whether it was gated |
| `state/delegation-streak.json` | state root | per-session main-thread streak counter |
| `state/premium-window.json` | state root | rolling window used to approximate premium concurrency; read-modify-written only under `premium-window.json.lock` (a transient lock both hooks share, via hooks/lib/file-lock.mjs: it names its owner, and is broken only when that process is gone and the lock is over 5 s old) |
| `state/baseline.json` | state root | previous harness version + counters, for daily drift detection; also the publication-leak sweep's per-repo hit fingerprints (keyed HMACs, not guessable hashes), so an accepted finding doesn't re-fire daily, and its repo-visibility cache (only public answers kept, for 24h; not-public and unknown ones are rechecked every run, so a repo made public is swept on the next run) |
| `leak-fingerprint.key` | state root | per-machine random key for those hit fingerprints, created on the first sweep (owner-only permissions) |
| `state/scout-latest.json` | state root | most recent calibration-scout result (overwritten each run) |
| `state/scout-history.jsonl` | state root | append-only: one line per scout run |
| `state/version-notice-state.json` | state root | per-session `loadedAt`, which (plugin, lastUpdated) pairs already got the staleness notice, and — once the global hook is installed — the `loadedVersion` recorded for the self-check handoff; pruned after a week |
| `state/upload-state.json` | state root | opt-in telemetry-upload cursor |
| `state/import-cursors.json` | state root | legacy-import cursors, keyed by source file path |
| `state/migrated.json` | state root | written once, after the first legacy-data import |
| `state/model-tiers.json` | state root | operator override of `config/model-tiers.json` (optional); a legacy copy under the plugin data dir is still honoured as a fallback |
| `state/agent-types/*.seen` | state root | one marker file per seen unknown agent type (race-free dedup) |
| `memory-vault/` | state root | the vault repo itself — a separate git repository, see [Memory vault](#memory-vault) |
| `state/memory-vault-sync.lock` | state root | held for the duration of one `memory-vault.mjs sync`; stale after 120s and taken over |
| `state/memory-vault-status.json` | state root | fast-read cache of the vault's last sync outcome, plus a record of every sync ATTEMPT — including the ones turned away before doing any work, which is how a sync that silently stopped running becomes reportable (git history is the source of truth for content, not this file) |
| `migration/backup-<stamp>/...` | state root | verbatim backup of each legacy dir's durable files, taken before the first import |
| `refactor-prompt.md` | plugin data dir | generated when an instruction file is over budget or memory is unreachable |
| `memory-index*.json`, `memory-merge-status-*.json` | plugin data dir | disposable, regenerable memory-search caches |
| `transcript-harvest/` | plugin data dir | human-reviewed transcript digests |

## Install

Installing turns on the hooks. It does **not** schedule the scout — that is a
separate, two-environment step (a desktop scheduled task for the stateful
signals, a claude.ai routine for the web-facing lineup diff). The `setup`
skill walks it: `Run /agent-companion:setup`.

Add the marketplace once per machine, then install:

```bash
claude plugin marketplace add GoodStuffSoftware/agent-templates
```

```bash
claude plugin install agent-companion@agent-templates
```

**Desktop app:** install from the plugin directory UI. It shells out to the same
CLI and reads the same `~/.claude/plugins/` cache, so everything below applies.

**Cloud sessions:** install there too — cloud clones fresh, so it always gets
the current version of `main`.

**Development, without installing** (never self-updates — use only for testing):

```bash
claude --plugin-dir ./plugins/agent-companion
```

### Updating — read this before debugging a "broken" fix

`marketplace add` clones **once and then pins**. An installed plugin does *not*
track `main` on its own. Push a fix and every machine keeps running the old code
until its marketplace cache is refreshed:

```bash
claude plugin marketplace update agent-templates
```

The desktop UI's sync button does the same thing. This bit us on the very first
publish: three install attempts failed against a manifest that had already been
fixed on `main`, because the cache was pinned to the commit before the fix and
the error said nothing about staleness.

**So when a machine shows old behaviour, suspect a stale cache before suspecting
the fix.** Verify what is actually cached rather than assuming:

```bash
git -C ~/.claude/plugins/marketplaces/agent-templates log --oneline -1
```

### Hot-loading into a running session

Skills and hooks load differently, and the difference matters when you are
trying to help an agent that is already mid-task:

- **Skills hot-load on their own.** `audit` and `calibration-scout` become
  available in already-running sessions shortly after install, no restart.
- **Hooks do not.** They are bound at session start, so a session that predates
  the install has no guards — silently, since nothing reports their absence.

Where it is available, bind them into the running session with:

```
/reload-plugins
```

(`--force` also rebuilds the conversation cache rather than reusing it.) A
long-running agent can then gain the guards without losing its context.

**That command is not available in every environment** — some surfaces report
`/reload-plugins isn't available in this environment`. There, the only way to
arm hooks is to start a new session. Skills still hot-load either way, so an
in-flight agent keeps the diagnostics regardless; it is only the *enforcement*
that waits.

### Global hook — never itself stale

`version_notice`'s own checker lives inside the plugin, so it is bound to
whatever installed-plugin-cache folder a session loaded at startup, same as
every other hook — a stale session runs a stale checker. Installing the
staleness shim as a **user-level** hook fixes that: it runs from a fixed path
(`~/.claude/hooks/agent-companion-staleness.mjs`) that never needs updating,
and re-resolves the currently installed agent-companion fresh on every
invocation instead of running whatever copy this session happened to load.

```bash
node "$AC/scripts/install-global-hooks.mjs"           # install
node "$AC/scripts/install-global-hooks.mjs" --dry-run  # preview, touches nothing
node "$AC/scripts/install-global-hooks.mjs" --uninstall
```

Idempotent, backs up `settings.json` before writing, and once installed the
plugin-registered hook defers to it instead of duplicating the notice — see
`hooks/self-update.mjs` for the handoff. Optional: `version_notice` already
catches most staleness without it, just one `/reload-plugins` (or restart)
behind.

### Five separate stale-state traps

Updating this plugin touches five independent caches, and skipping any one
leaves you running old code **with no error at all**:

| # | Step | Symptom if skipped |
|---|---|---|
| 1 | `claude plugin marketplace update <marketplace>` | installs re-run the old commit; a fix that is already on `main` appears not to work |
| 2 | `claude plugin update <plugin>@<marketplace>` | cache is current, installed version is not |
| 3 | `/reload-plugins`, or a new session | new version installed, old hooks still bound |
| 4 | check the running session's own age | a session predating the install never had hooks at all |
| 5 | remove and re-add the marketplace on claude.ai | cloud sessions keep loading the previous version's hooks and skills while every local check — `claude plugin list`, the marketplace cache commit, the manifest check — reports the new version |

Three traps within the traps: `claude plugin update` needs the **fully qualified**
`plugin@marketplace` — the bare name fails with a misleading *"Plugin not
found"*. `claude plugin details` reads the **cache**, not the installed copy,
so it will happily describe components that are not actually running. And the
local verification commands above cannot see the claude.ai cache at all —
"verified locally" says nothing about what a cloud session is running. A
version bump alone does not invalidate it either; the marketplace has to be
removed and re-added on the claude.ai side.

Verify what is real rather than what is reported:

```bash
git -C ~/.claude/plugins/marketplaces/<marketplace> log --oneline -1
claude plugin list
```

### Verifying it is actually running

After installing or reloading:

```bash
ls ~/.claude/agent-companion/telemetry/
```

Files there mean hooks have fired. A missing or empty directory after real work
means they registered but never ran — which looks exactly like "found no
issues". Confirm with the canary rather than trusting silence:

```bash
node "$AC/scripts/audit.mjs" --only guard-canary
```

## Skills

| Skill | Short form | Answers |
|---|---|---|
| `recommend` | `/ac recommend --type <task-type>` | what should this task run on: model, effort, warrant, reviewer |
| `evaluate` | `/ac evaluate --model <alias> --type <task-type>` | is what is running (or being spawned) right for it: over, under, or fit |
| `routing-table` | `/ac routing` | the current table, rendered from config; `/ac routing set`, `unset`, `show`, `why` and `rollback` manage your routing profile |
| `audit` | `/ac audit --dir <project>` | the composable hygiene audit; `--fix` for the fixable checks |
| `brevity` | `/ac brevity` | is the reporting contract on, for whom, and which layer is winning |
| `standing-rules` | `/ac rules` | which "always do X if Y" rules exist, and whether one would fire on given text |
| `setup` | `/ac setup` | the setup steps on a new machine, both scouts included |
| `calibration-scout` | `/ac scout` | the daily drift scout, run by hand |
| `model-benchmark` | `/ac benchmark` | re-running the model x effort benchmark: plan, budget, order, fairness, reporting |

The full form is `/agent-companion:<skill>`. `/ac` is a user-level forwarder
that the setup skill installs from `shims/ac/`; a skill inside a plugin is
always namespaced by the plugin name, so the short form has to live outside it.

## Routines

The skills are the prompt source of record, so a scheduled cloud routine needs
only a one-line prompt — and it updates whenever the plugin does, instead of
drifting in a hand-maintained file the scheduler happens to point at.

| Routine | Cadence | Prompt |
|---|---|---|
| Calibration scout | daily | `Run /agent-companion:calibration-scout` |
| Project audit | weekly, or on demand | `Run /agent-companion:audit for <project path>` |

The calibration scout's **local-only** step also drives `memory_vault`'s
`sync` (see [Memory vault](#memory-vault)) — no second scheduler was added
for it; it self-gates on the option and is silent when off or unchanged.

The scout is deliberately silent when nothing changed — it reports only on a
real signal, so a daily cadence does not become noise you learn to ignore.
Detection is deterministic (version strings, file hashes, counters); the model
only decides which heavier routine a signal warrants.

## Known limits

- Premium concurrency is **approximated** by a 10-minute rolling window, not by
  tracking live agents. A legitimate burst may need the cap raised rather than
  worked around.
- Token counts are estimated at ~4 chars/token. Fine for a budget alarm, not for
  billing.
- The warrant check is deterministic (it looks for the line). It verifies that a
  justification was *stated*, not that it is *good* — the audit does that.
