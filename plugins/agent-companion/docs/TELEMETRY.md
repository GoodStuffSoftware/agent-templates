# Telemetry format

`agent-companion` writes newline-delimited JSON. **These files are a public
contract.** Other tools read them, so the format is versioned and changes
follow the rules below.

## Location

Durable telemetry and state live under a fixed **state root**, separate from
the plugin data directory a plugin uninstall deletes:

```
${AGENT_COMPANION_STATE_DIR}                      # override, mostly for tests
  or ${CLAUDE_CONFIG_DIR}/agent-companion          # override
  or ~/.claude/agent-companion                     # normal default
```

```
~/.claude/agent-companion/
  README.txt                    # what this dir is, written on first use
  telemetry/
    spawns.jsonl                 # one record per subagent spawn (append-only)
    subagent-starts.jsonl        # one record per subagent actually starting
    denials.jsonl                 # one record per guard firing
    unknown-agent-types.jsonl    # harness drift signal
    fixtures.jsonl                # every row from a test/verify session (see Fixtures below)
  state/
    baseline.json                 # last-seen harness version + counters
    scout-latest.json            # most recent calibration-scout result (overwritten each run)
    scout-history.jsonl          # append-only: one line per scout run
    version-notice-state.json    # per-session plugin-staleness notice state, and each session's plugin-load time (loadedAt, loadedAtFrom)
    process-loads/                # one <pid>.json per Claude Code process: when it loaded its plugins, the session it runs now, and a SessionEnd "resume" it just raised
    ladder-rewrites.json          # per session: when the guard began recording every spawn (armedAt), the pending spawns, and whether the harness ignored a rewrite
    upload-state.json            # telemetry-upload cursor (opt-in feature)
    import-cursors.json          # legacy-import cursors, keyed by source file path
    migrated.json                 # written once, after the first legacy import
    model-tiers.json             # operator override (optional)
    agent-types/                  # one <type>-<hash>.seen marker file per seen unknown type
    sync.lock                     # transient; held only during an import
  migration/
    backup-<UTC stamp>/<legacy dir name>/...   # verbatim copy of each legacy dir's durable
                                                # files, taken before the FIRST import
```

**A plugin uninstall deletes `~/.claude/plugins/data/agent-companion-<marketplace>/`
only.** Nothing under `~/.claude/agent-companion/` is touched by an uninstall —
that is the whole point of this location. Two uninstalls in the same week
(2026-09-12 and 2026-09-18) destroyed telemetry history under the old
location before this change; this directory exists so that cannot happen
again.

**To reset all history:** delete `~/.claude/agent-companion/` entirely. The
plugin recreates it (empty) on next use.

**Still in the plugin data directory** (disposable, regenerable caches —
these do NOT need to survive an uninstall): `memory-index.json`,
`memory-index-repo-*.json`, `memory-merge-status-*.json`,
`refactor-prompt.md`, `transcript-harvest/`. See the README "State" table for
the full list.

## Recovering pre-0.17.0 history (the legacy import)

Before 0.17.0, durable state lived in the plugin data directory, split across
however many `agent-companion*` sibling directories a machine had accumulated
(one per marketplace, plus `-inline` for a dev load) — see the "THREE
resolvers" problem this version fixes. `hooks/lib/state-sync.mjs`
(`syncLegacy()`) imports that history into the new location:

- **Runs automatically** from the `scout-surface.mjs` SessionStart hook
  (before it reads anything), and at the start of `scripts/detect.mjs` and
  `scripts/audit.mjs`. Also available directly: `node scripts/state-sync.mjs
  [--json]`.
- **Idempotent and incremental.** A cursor per source file
  (`state/import-cursors.json`, keyed by absolute path: `{offset, size,
  head}`) means only new lines are read on later runs. The cursor resets if a
  source file shrank below the stored offset or its head hash changed (e.g.
  a reinstall recreated it).
- **Locked.** `state/sync.lock`, held for the duration of one sync; a lock
  older than 60s is treated as abandoned and taken over. A locked run returns
  immediately (`{skipped: 'locked'}`) rather than waiting.
- **Non-destructive.** A source file is never deleted, truncated, or
  modified. A session still running an old plugin copy can keep appending to
  it; a later sync just picks up the increment.
- **Deduplicated.** Spawns/denials/subagent-starts dedup on the sha1 of the
  trimmed raw line. `unknown-agent-types.jsonl` dedups on `agent_type`,
  keeping the earliest row and creating that type's marker file.
- **Backed up once.** Before the very first import, every legacy dir's
  durable files (the 4 streams, plus `baseline.json`, `scout-latest.json`,
  `version-notice-state.json`, `model-tiers.json`, `upload-state.json` when
  present) are copied verbatim to `migration/backup-<stamp>/<dirname>/`.
- **State-file merge rules** (first import only): `baseline.json` and
  `scout-latest.json` take whichever source has the greatest `checkedAt`;
  `version-notice-state.json` merges per-session keys, newest entry wins;
  `model-tiers.json` copies the most recently modified source, only if the
  destination doesn't already have one; `upload-state.json`'s offsets are set
  to the post-merge line counts, so already-imported history is never
  re-sent by an opt-in upload. `premium-window.json` and
  `delegation-streak.json` are never imported — short-lived rolling state
  that is fine to start fresh.
- **Fails open everywhere.** Any exception returns `{skipped: 'error:
  <message>'}`. A SessionStart hook must never block or throw because history
  recovery had a bad day.

Not built (out of scope for this change, tracked as a possible follow-up):
**backfilling days lost before this version shipped** from transcripts —
the coverage check (below) can tell you a day was silent, but it cannot
recreate a spawn row that was never written anywhere.

## Fixtures

A session whose `session_id` matches `/^(canary|verify-|test-|fixture-)/i` is
never treated as real activity:

- **`canary...`** rows are dropped entirely — a guard-canary probe (see
  `checks.mjs`'s `guard-canary` check) must not inflate the very metric it is
  checked against. Unchanged from before this version.
- **`verify-...`, `test-...`, `fixture-...`** rows are recorded, but into
  `telemetry/fixtures.jsonl` — never a production stream — with a `stream`
  field naming which stream they would have gone to. This closes the exact
  bug that motivated this change: a verification run's session ids
  (`verify-opt-case-test-1`, `verify-nudge-session`) once landed directly in
  production `spawns.jsonl`.

This applies at every write path (`appendLog`, `recordDenial`,
`noteAgentType`) and during the legacy import.

## Versioning

Every emitted record carries `v`, the schema version that wrote it.

- **Additive changes** (a new optional field) keep `v` the same. Consumers
  MUST tolerate unknown fields rather than rejecting the record.
- **Breaking changes** (removing a field, changing a type, changing the
  meaning of an existing field) increment `v`.
- Consumers MUST skip records whose major version they do not understand
  rather than guessing. Misreading a record is worse than ignoring it — a
  wrong number on a dashboard is acted on, a missing one is investigated.

Current version: **2**. Records written before versioning was introduced have
no `v` field; treat a missing `v` as version 0 and read it as version 1 with
fields possibly absent. **v1's `effort` field held the CALLER's effort**
(ambiguous — see below); v2 replaces it with `caller_effort` /
`spawn_effort` / `spawn_effort_source`, which say explicitly whose effort is
whose.

## Files

### `spawns.jsonl` — one record per subagent spawn, written before it starts

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the spawn was requested |
| `session_id` | string | the session that requested it |
| `guard_version` | string \| null | the plugin version of the spawn-guard copy that wrote this row (its own `plugin.json`). Rows written before this field existed have no key at all |
| `guard_source` | `cache` \| `checkout` \| `bundle` \| null | where that copy runs from: `cache` is an installed copy under the plugin cache (current or orphaned), `checkout` a source work tree with a `.git` entry (the operator's own tree, never judged stale), `bundle` anywhere else, such as an app-extracted desktop bundle (a `--plugin-dir` copy that is not a work tree also counts as `bundle`). Before round 3 every copy outside the cache was written as `checkout` |
| `loaded_at` | ISO 8601 string \| null | when this session last loaded its plugins, from a trusted source only: self-update's per-session record when it came from a startup, a fresh-process resume, an in-process /resume (the process's own load time) or a /reload-plugins marker; else this process's own load record (`CLAUDE_PID`), only while that record says the process is running this session; else null, never "now". The scout judges a session against what was installed at this time |
| `guard_scope` | string \| null | the install scope that applies to the spawn's cwd in `installed_plugins.json`: `user`, or `project:<hash>` / `local:<hash>` (first 12 hex of sha256 of the normalised project path, never the path); null when nothing is installed. The daily scout compares `guard_version` against the version installed for this scope (`stale_copy_loaded`, `session_outdated`) |
| `subagent_type_rewritten_to` | string \| null | the ladder rung best-fit autofill rewrote a general-purpose (or unnamed) spawn to, so its effort is pinned too (`fit_autofill_ladder`); null when not rewritten. `subagent_type` keeps the type as the caller wrote it |
| `spawned_by_agent_type` | string | what requested it — `main`, `subagent`, `teammate`, … |
| `model` | string | the requested model, or the literal `(inherited)` |
| `model_declared` | string or null | the model named at the spawn site, if any |
| `model_definition` | string or null | the model named in the agent definition frontmatter, if any |
| `model_autofilled` | boolean | the guard set `model` from the routing table because the spawn named none and declared a weight |
| `inherited` | boolean | true only when neither the spawn nor the definition named a model — the real hazard |
| `subagent_type` | string \| null | the named agent type, if one was given |
| `run_in_background` | boolean \| null | `tool_input.run_in_background`; null when unset |
| `isolation` | string \| null | `tool_input.isolation`; null when unset |
| `name` | string \| null | `tool_input.name`; null when unset |
| `team_name` | string \| null | `tool_input.team_name`; null when unset |
| `desc_sha` | string \| null | first 16 hex chars of sha256(`tool_input.description`) — **hashed, never stored raw**. Join to a transcript by hashing its description the same way |
| `desc_len` | number \| null | the description's length, or null |
| `caller_is_subagent` | boolean | true when the payload carries `agent_id` (the caller is itself a subagent) |
| `caller_agent_id` | string \| null | `agent_id` of the caller, when it is a subagent |
| `caller_model` | string \| null | the CALLER's own model, read from the last assistant record of the caller's transcript (bounded tail-read). The harness writes the CURRENT assistant turn to the transcript only after PreToolUse hooks return, so this is the model of the caller's PREVIOUS turn. A spawn made on a session's very first turn therefore logs `null`, and a `/model` switch shows up one turn late. |
| `caller_effort` | string \| null | the CALLER's effort — what v1's `effort` field held |
| `spawn_effort` | string \| null | the SPAWNED agent's own effort: the agent definition's frontmatter effort if it has one; null if the resolved model takes no effort parameter (e.g. haiku); otherwise the caller's effort (built-in types run at the caller's effort) |
| `spawn_effort_source` | `definition` \| `inherited` \| `none` | which of the three rules above produced `spawn_effort` |
| `effective_effort` | string \| null | what will ACTUALLY run: the agent definition's own effort when it names one (same value as `spawn_effort` in that case); otherwise `"inherited(<parent session's effort, or 'unknown'>)"`. CORRECTED 2026-09-23: an earlier version of this field recorded a model API default (`"unset(model-default:<level>)"`) for the no-effort case — per Claude Code's sub-agents docs (code.claude.com/docs/en/sub-agents), a definition with no `effort` frontmatter actually **inherits the orchestrating session's current effort**, not any model default, so that was wrong. `null` when the resolved model takes no effort parameter at all (haiku). Exists so a later join against a transcript's `output_tokens` can compute tokens-per-effort per model — transcripts do not record effort themselves. |
| `effort_definition` | string \| null | the effort named in the agent definition, if any |
| `declared_weight` | 1-5 or null | task weight declared in the brief (`WEIGHT:` or `WARRANT: weight N`). Every brief declaration (`TYPE:`, `WEIGHT:`, `WARRANT:`, `KIND:`, `CONSEQUENCE:`, `WRITER:`) is read only from a line of its own, which may be list-marked (`-`, `*`) and/or markdown-bold (`**TYPE:** x`); the same words mid-sentence are prose, not declarations, and so is any line inside fenced code, indented code (4+ columns) or a `>` blockquote. The first line declaring each label wins, whether or not its value is valid (`WEIGHT: 9` declares no weight, and a later `WEIGHT:` line does not replace it) |
| `declared_kind` | string or null | task kind declared in the brief (`KIND:`) |
| `declared_consequence` | string or null | consequence declared in the brief (`CONSEQUENCE:` routine, elevated, critical) |
| `fit` | `over`, `under`, `fit`, `unknown`, or null | the spawn compared to the routing table for its declared weight; null when no weight was declared. A parity-sized type (`code-review`) with a usable `WRITER:` line is compared to its parity route (the writer's model and effort, after the floors; effort above it is `fit`, never `over`). With no writer, one declared `CONSEQUENCE: critical` is `under` below the F1 floor (opus/xhigh) and null otherwise |
| `fit_expected` | string or null | what the table routed that weight to, e.g. `sonnet/high`; for a review with a writer, its parity route; for the critical parity case above, the F1 floor it fell below |
| `routed` | boolean | true when the spawn's model came from a routing choice: the model a resolved route names (or one the guard filled in from it), a ladder rung's or other agent definition's own pin (not overridden by a different model on the spawn), or a reviewer on its parity route (its `WRITER:`'s model after the floors, never merely the raw writer's). false when the model was inherited from the lead or set per-spawn with no route naming it, and always false for fable (nothing routes to fable, whatever pinned it) and for a model the tier table does not know. A provenance fact, broader than the premium cap's exemptions: the cap still counts `ac-opus-max`, another plugin's agent and a definition named like a built-in type, all of which are `routed`. Absent on rows written before 0.29.19 |
| `declared_writer` | string or null | the brief's `WRITER:` line resolved to `<model>/<effort>` (just `<model>` when no effort is stated or the effort could not be read), whether it was written that way (`opus/xhigh`, `opus xhigh`, `opus at xhigh`) or as an agent name read from its definition; null when there is no such line, it could not be used, or the brief's `TYPE:` is not parity-sized (the line is read only on a review). Only the resolved pair is logged, never the line's text. A writer inferred from the caller is in `inferred_writer`, never here |
| `inferred_writer` | string or null | for a parity-sized review spawned by a subagent with no `WRITER:` line: the writer read from the caller's own definition (`agent_type` -> its agent file's `model`/`effort`), as `<model>/<effort>` or just `<model>`; null when a `WRITER:` line was present, the caller is the main thread, or nothing could be inferred (a built-in or missing `agent_type`, a definition that pins no model or `model: inherit`, or the caller's own transcript shows it running on a different model than its definition). A definition with no effort takes the effort the caller was seen running at, when known. Absent on rows written before the self-review change (2026-09-28) |
| `tool_use_id` | string \| null | the `Agent` call's own id (the PreToolUse payload's `tool_use_id`). The harness names the same id in the spawned agent's sidecar (`<session>/subagents/agent-<agent_id>.meta.json`, `toolUseId`), which is how a later spawn by that agent finds this row. null when the payload carried none. Absent on rows written before 2026-09-28 |
| `parent_agent_id` | string \| null | the agent that made this spawn: the same value as `caller_agent_id`, named for lineage; null for the main thread. Absent on rows written before 2026-09-28 |
| `self_review` | boolean | a parity-sized review spawned by a subagent whose own spawn row was FOUND and declares a type listed in `selfReview.types`: an architect-class writer reviewing its own work, the population the self-review flow is measured on. Absent on rows written before 2026-09-28 |
| `review_by_subagent` | boolean | the broad count: a parity-sized review spawned by a subagent whose own row is not positively a review (found or not, any writer type). Absent on rows written before 2026-09-28 |
| `self_review_expected` | boolean \| null | for a spawn whose `TYPE:` is listed in `config/model-tiers.json` `selfReview.types`: true when the spawned definition carries the generated self-review protocol, or the guard appended it to the brief, and the brief has no `REVIEW: lead` line; false when it opted out, or the writer is a built-in type (or a pair no rung matches) that gets no protocol; null for any other type, and for an agent file this plugin does not generate (a project agent may carry its own wording) |
| `self_review_injected` | boolean | the protocol was appended to this writer's brief: a listed type on a ladder rung whose definition does not carry it, sized to the rung that matches what runs. Absent on rows written before 2026-09-28 |
| `caller_tool_use_id` | string \| null | for a parity-sized review spawned by a subagent: the caller's own Agent call id, from its sidecar. Joins the review's row to its writer's row (that row's `tool_use_id`) from `spawns.jsonl` alone; null when not looked up or the sidecar names none |
| `consequence_from_caller` | boolean | `declared_consequence` "critical" was taken from the caller's own spawn row (its `TYPE:` preset is critical, e.g. `critical-change`), so F1 floors the review; the brief stated no `CONSEQUENCE:` line. Absent on rows written before 2026-09-28 |
| `caller_row_found` | boolean \| null | for a parity-sized review spawned by a subagent: whether the caller's own spawn row was found (caller `agent_id` -> sidecar `toolUseId` -> the row with that `tool_use_id` in the same session, rows agreeing on `declared_type`); null when not looked up |
| `caller_declared_type` | string \| null | that row's `declared_type`, when found. A parity-sized value here is what the `review-recursion` deny fires on |
| `declared_type` | string or null | the task type named on the brief's `TYPE:` line (a `config/model-tiers.json` `taskTypes` name, or an unknown name exactly as written, lower-cased; with several `TYPE:` lines, only the first counts, known or not); null when the brief names none or its first `TYPE:` value is not a name. Only the name is logged, never brief text. When set, `declared_weight`/`declared_kind`/`declared_consequence` are filled from that type's preset where the brief did not state them |
| `fit_trial` | boolean | true when the fit judgement used a shipped ROUTING TRIAL (`taskTypes.<type>.override`) rather than the plain grid; equivalent to `route_layer == "trial"` |
| `route_layer` | `profile` \| `trial` \| `grid` \| null | which layer of `resolveRoute()` answered for this spawn (see docs/adr/0003-per-user-routing-profiles.md §2): a per-user routing-profile row, the shipped trial, or the grid (which includes reviewer parity). null when no route was resolved (no TYPE or WEIGHT declared, `fit_guard` off, or a parity type with no usable `WRITER:` line). `profile` means a row of the operator's routing profile won (`routing_profile` on, the row applicable). Only the enum is logged, never a row's content |
| `route_profile_rev` | number or null | the routing-profile `revision` behind a `profile` answer; null for every other layer (including when a profile exists but its row did not win) |
| `memory_addition_mode` | `nudge` \| `pointers` \| `nudge(unrecognised:<value>)` \| null | which `memory_brief_mode` behaviour ran for this spawn; null when `memory_search`/`memory_brief` are off or mode is `"off"` — distinct from `memory_addition_attached: false`, which means it ran and had nothing to say |
| `memory_addition_attached` | boolean \| null | whether a nudge line or pointers block was actually appended to the spawn's prompt |
| `memory_addition_here_count` | number \| null | nudge mode only: file count `resolveMemoryScopeDir()` found for THIS project's own memory store |
| `memory_addition_other_count` | number \| null | nudge mode only: how many OTHER projects have a memory store |
| `memory_addition_repo_count` | number \| null | nudge/pointers: repo-scope file count matched (see `memory_search_repo_globs`) |
| `memory_addition_hit_count` | number \| null | pointers mode only: how many ranked hits were included in the block |
| `memory_addition_top_score` | number \| null | pointers mode only: the top BM25 score that cleared `memory_brief_min_score` |
| `memory_addition_here_source` | string \| null | which precedence candidate `resolveMemoryScopeDir()` used: `env:CLAUDE_CODE_PROJECT_DIR_NAME`, `settings:autoMemoryDirectory`, `worktree-main`, `literal`, or `none`. A worktree spawn showing `worktree-main` here is the worktree-scope bug fix (see hooks/lib/memory-index.mjs) working as intended — `literal` on a worktree spawn would mean it regressed. |
| `gate1_mode` | `off` \| `warn` \| `block` | the configured `foreground_guard` mode at spawn time |
| `gate1_applicable` | boolean | true when the caller is the main session (`caller_is_subagent` false) and `run_in_background` is not `true` — the raw population Gate 1 considers, before the exemption |
| `gate1_exempt` | boolean | applicable, but excused: the resolved `model` (post-autofill) classifies as the plugin's own cheapest known tier (haiku) per `config/model-tiers.json` |
| `gate1_action` | `none` \| `warn` \| `block` | what THIS spawn actually got, after mode and exemption: `none` when not applicable, exempt, mode is `off`, or a `block`-mode spawn carried a `FOREGROUND:` justification |
| `gate2_fired` | boolean | `name` and `isolation` were both set — per agent-teams.md this spawn is an ordinary subagent, not a teammate, despite being named |
| `gate3_fired` | boolean | neither `name` nor `isolation` was set (after namegate's own autofill, if any — see `gate4_action`) — this spawn shares the lead's own working tree and has no address to re-brief it later |
| `gate4_applicable` | boolean | main-session caller, `run_in_background` explicitly `true`, no `name`, and `namegate` is on — the population namegate (track "namegate", operator decision 2026-09-25) considers |
| `gate4_action` | `none` \| `hint` \| `autofill` | what THIS spawn actually got: `none` when not applicable; `hint` when applicable but `namegate_autofill` is off; `autofill` when the guard set `name` via `updatedInput` |
| `name_autofilled` | boolean | `gate4_action === 'autofill'` — namegate set the spawn's name via `updatedInput` |
| `name_effective` | string \| null | what the spawn actually ran under: `name` as declared, or namegate's autofilled name when `name_autofilled` is true |

**`model: "(inherited)"` is the field that matters most.** It means no model
was specified, so the spawn silently ran at the *lead's* tier. That is the
mechanism behind unexamined premium fan-out, and it is invisible in any cost
report that groups only by resolved model name.

Canary probes (session ids beginning `canary`) are deliberately **not**
recorded. Fixture/verification sessions (`verify-`, `test-`, `fixture-`) are
recorded, but into `telemetry/fixtures.jsonl` instead — see Fixtures above.

### `subagent-starts.jsonl` — one record per subagent actually starting

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it started |
| `session_id` | string | owning session |
| `agent_id` | string | harness agent id |
| `agent_type` | string | resolved agent type |
| `effort` | string \| null | the effort the harness reported AT SubagentStart (the started subagent's own, once resolved — distinct from `caller_effort` on `spawns.jsonl`, which is the CALLER's) |
| `transcript_path` | string \| null | the payload's transcript path, when present |
| `agent_transcript_path` | string \| null | the payload's agent-specific transcript path, when present |
| `rewrite_ignored` | string, only when set | the ladder rung the spawn guard rewrote this spawn to, when this start is positively tied to that rewritten spawn and shows it ran as its original type instead (the session had been recording every spawn for at least 3 minutes, so no other spawn of that type was unaccounted for; otherwise nothing is written; a repeat start of an agent_id that already started in this session, as when a worker is continued with SendMessage, is never flagged and changes nothing); the guard then stops rewriting for the rest of that session (`state/ladder-rewrites.json`) |

Pairing this against `spawns.jsonl` shows requested-versus-started. A spawn
with no corresponding start was denied or failed.

### `denials.jsonl` — one record per guard firing

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the guard fired |
| `session_id` | string | session it fired in |
| `agent_type` | string \| absent | the payload's `agent_type`; absent on a main-thread call, which carries none |
| `tool_name` | string \| null | the tool the call was for (`Agent`, `Bash`, …) |
| `guard` | string | `delegation`, `fit`, `warrant`, `premium-cap`, `foreground`, `inherit` (`inherit_guard: block`), or `review-recursion` (a reviewer spawning a reviewer, `review_recursion_guard`) |
| `outcome` | string | `deny`, or `warn` for a `delegation_guard: warn` firing (the guard matched and did not stop the call). A consumer counting blocked calls filters on `deny`; any row proves the guard still fires |
| `detail` | string | short reason, truncated to 300 chars. A `delegation` row ends with the scope and what the call's env said for `CLAUDE_CODE_SESSION_ATTENDED` (`scope attended, attended 1`) |

**A consumer must not treat a zero count here as good news.** A guard that
has silently stopped matching — after a harness rename, say — produces
exactly the same zero as a guard with nothing to deny. Zero denials across a
period of real spawn activity is a reason to run the canary, not a reason to
relax. See "Enforcement-silent coverage" below for the automated version of
this check.

Canary and fixture/verification sessions are excluded the same way as
`spawns.jsonl` — see Fixtures above.

### `session-budget.jsonl` — one record per session budget notice

Written when the plan units a whole session has used (the lead plus every
subagent) cross another multiple of `session_budget_units`
(`hooks/lib/session-budget.mjs`). One row per notice the lead is queued; a
total that skips several multiples at once still writes one.

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the crossing was seen |
| `session_id` | string | the lead session |
| `event` | string | `crossing` |
| `units` | number | the session's plan units at that moment (tokens at Sonnet 5 rates times the model's plan multiplier) |
| `level` | number | the multiple of the threshold just passed, in units |
| `threshold` | number | `session_budget_units` as set |
| `week_pct` | number | `units` as a percentage of `weeklyPlanUnits` in `config/session-budget.json` |
| `transcripts` | number | transcripts read: the lead's plus its subagents' |
| `scan_complete` | boolean | false when the scan stopped at its deadline and `units` is a lower bound |
| `estimated_turns` | number | requests counted at their own API list price because their tier has no measured plan multiplier (haiku, fable) |
| `unpriced_turns` | number | requests on a model with no price at all, counted as zero |

### `subagent-context.jsonl` — one record per subagent context notice

Written when a subagent's own context passes `subagent_context_notice_tokens`
or the subagent has just compacted. Each kind fires once per subagent (a
compaction once per compaction).

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it fired |
| `session_id` | string | the lead session |
| `agent_id` | string | the subagent |
| `agent_type` | string \| absent | the subagent's type |
| `model` | string \| null | the model of its latest request |
| `kind` | string | `size` (past the threshold) or `compaction` (a `compact_boundary` just behind it) |
| `phase` | string | `mid-run`: injected into the subagent by the PreToolUse hook. `stop`: the hook never saw it (it crossed on the subagent's last turn, or it made no tool call), found at SubagentStop, so the subagent was not told |
| `tokens` | number | the subagent's context size at its latest request (input + cache read + cache write) |
| `threshold` | number | `subagent_context_notice_tokens` as set |
| `trigger`, `pre_tokens` | string, number; `compaction` only | the boundary's `compactMetadata.trigger` (`auto` or `manual`) and the context it held before compacting |

### `bash-tail.jsonl` — the Bash output tail

Three kinds of row, told apart by `event`. Read with `node scripts/bash-tail-report.mjs`.
`wrapped` and `skipped` are written by the PreToolUse hook (`hooks/bash-tail.mjs`);
`result` is written by the rewritten command itself, in the shell, when the
command finishes (so it is absent for a run that is still going, was killed, or
ran in a fixture session, whose results are kept out of this file).

| field | type | on | meaning |
|---|---|---|---|
| `v` | number | all | schema version |
| `at` | ISO 8601 string | all | when it was written |
| `event` | `wrapped` \| `skipped` \| `result` | all | |
| `id` | string | `wrapped`, `result` | the run's id; the output file is `<id>.log`. Joins a `wrapped` row to its `result` |
| `session_id`, `agent_type`, `caller_is_subagent` | string, string \| absent, boolean | `wrapped`, `skipped` | who ran it |
| `runner` | string | `wrapped`, `skipped` | the known runner that matched, e.g. `npm test`, `cargo build` |
| `command_chars` | number | `wrapped` | length of the original command (the command text is never logged) |
| `reason` | string | `skipped` | why a known runner was left alone: comma-separated blockers (`pipe`, `redirect`, `background`, `subshell`, `substitution`, `unterminated`, `output-flag`, `compound`, `shell-word:<word>`, `never-ends:<what>` for a dev server, watcher or interactive command anywhere in the chain, `other-command:<name>` for a chain segment that is not a known runner) or `permission_mode:<mode>` or `permission-rule:deny` / `permission-rule:ask` (a settings rule could match the original or a helper the wrapper adds) |
| `rc` | number | `result` | the command's exit status |
| `lines`, `bytes` | number | `result` | what the command wrote (stdout and stderr merged) |
| `shown_chars` | number | `result` | characters returned to context: the whole output for a short run, header plus tail otherwise |
| `truncated` | 0 \| 1 | `result` | 1 when the tail form was returned |

The effect for a review: `sum(bytes) - sum(shown_chars)` is what stayed out of
context, per wrapped run. Characters, not tokens; convert with a measured ratio.

### `git-brief.jsonl` — the git brief (trial)

One row per hook injection and one per script run (`hooks/git-brief.mjs`, `scripts/git-brief.mjs`). Written through the same `appendLog` as every other stream, so fixture and canary sessions land in `fixtures.jsonl`. With `git_brief` off the hook writes nothing; a script run still logs.

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it was written |
| `session_id` | string | the session (the hook's payload; for a script run, `CLAUDE_SESSION_ID` when the shell has it, else `""`) |
| `agent_type` | string \| absent | the subagent's type; absent for the main session and for script runs |
| `event` | `inject-session` \| `inject-subagent` \| `run` \| `landed` | a SessionStart injection, a SubagentStart injection, a script run with no subcommand, a `landed` run |
| `chars` | number | characters injected (the whole additionalContext text) or returned (stdout, newline included); 0 when there was nothing to say (not a repository, an error) |
| `fetched` | boolean | whether this run attempted a fetch (false when one ran inside the 5-minute window, when none is possible, or with `--no-fetch`) |
| `duration_ms` | number | wall time of the git work |
| `start_ms` | number \| absent | injection rows only: process start to the hook's first line (node start-up and imports), the part of the start-up cost `duration_ms` leaves out |
| `outcome` | string | `ok`, `not-repo`, `no-default-branch` (landed only), `no-target` (landed only), `git-error`, `timeout` (the run's deadline or a git step's timeout hit), `error`. Separates "nothing to say" (`chars` 0, `not-repo`) from "could not say" |
| `fetch_outcome` | string | `ok`, `fail`, `timeout`, `fresh-skip` (a fetch inside the 5-minute window, injection only), `no-remote`, `skipped` (`--no-fetch`, or no fetch was asked for) |
| `fetch_age_ms` | number \| null | how old the previous fetch stamp was before this run; null when there was none |
| `steps_ms` | object | wall time per git subcommand (`fetch`, `rev-list`, ...), summed when one ran twice |
| `answer` | `YES` \| `NOT` \| `UNKNOWN` \| absent | `landed` rows only: the verdict printed |
| `target_hash` | string \| absent | `landed` rows only: first 8 hex characters of the SHA-256 of the target argument (the argument itself is never logged) |
| `stamp_age_ms` | number \| null \| absent | `landed` rows only: the age of the last successful fetch as of the answer; 0 right after a fetch that succeeded, null when none did |
| `rechecked_after_NOT` | boolean \| absent | `landed` rows only: the answer was NOT and a fresh fetch had just succeeded, so the NOT is not a stale one |

The review: `sum(chars)` over `inject-*` rows is the context added per session and subagent; a drop in Bash `git status` / `git fetch` / `git rev-list` calls per agent (counted from transcripts) with the switch on, against off, is what it bought. `fetched` and `fetch_outcome` over `inject-*` rows show how often the 5-minute window absorbed the fetch and how often a fetch failed or timed out, and `duration_ms` plus `start_ms` the start-up cost. A `landed` run always fetches, so `answer` over `landed` rows with `rechecked_after_NOT` true is the rate of a NOT that survived a fresh fetch; with `fetch_outcome` not `ok` the line carries a staleness note.

### `read-dedupe.jsonl` — the Read dedupe

Written by the hook (`hooks/read-dedupe.mjs`): a row per denial, per denied
request that was repeated and ran, per repeat-eligible read that was allowed
(the denominator of the denial rate), and per lock that could not be taken. A
first read, and a read of a changed file, writes nothing. The path is never
logged, only a hash. State is one file per (session, agent), so agents never
contend for a lock.

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it was written |
| `session_id` | string | the session |
| `agent_id` | string | the agent's id, `main` for the lead thread |
| `agent_type` | string \| absent | the subagent's type, when the payload names one |
| `tool_use_id` | string \| absent | the tool call's id, to join with a transcript |
| `hook_event` | `pre` \| `post` \| `invalidate` \| `reset` | which registration wrote the row; a `lock-timeout` can come from any of them |
| `path_hash` | string | first 12 hex characters of the SHA-256 of the normalised absolute path; one file keeps one hash across rows; empty for a `reset` |
| `range` | string | the lines the request covered, `first-last`, clamped to the file's length |
| `est_chars_avoided` | number | `deny`: estimated characters the denied read would have returned (lines x (average line length + 7)); every other outcome: 0 |
| `est_chars` | number \| absent | the same estimate, kept on `allow` and `retry-ran` rows too: what that read cost, or would have cost had it been denied |
| `outcome` | `deny` \| `retry-ran` \| `allow` \| `lock-timeout` | `deny`: the read was refused. `retry-ran`: the same request came again after a denial and ran. `allow`: a repeat-eligible read ran (see `allow_reason`). `lock-timeout`: the state lock was not taken within its wait, the hook failed open (for a `post`, a read went unrecorded) |
| `deny_chars` | number \| absent | `deny` only: characters of the denial text the model received (the cost side of `est_chars_avoided`) |
| `age_ms` | number \| absent | `deny`, `allow` (repeat-eligible) and `retry-ran`: the time since the file's original read was recorded |
| `deny_at` | ISO 8601 string \| absent | `retry-ran` only: when the denial that was retried happened |
| `allow_reason` | string \| absent | `allow` only: `builtin-last` (the exact repeat of the last read, left to the built-in stub), `aged` (the record outlived the age cap), `uncovered` (the lines were not all in earlier reads), `small` (under the size threshold) |
| `read_index` | number \| absent | how many Reads this agent had made in the session, counting this one: how deep into its session the event fell (the PreToolUse count, so absent on `post`, `invalidate` and `reset` rows) |
| `lock_wait_ms` | number | time spent waiting for the state lock |
| `duration_ms` | number | wall time of the hook, process start to the row |
| `transcript_bytes` | number \| absent | the size of the agent's transcript file at that moment: how deep into the session the read fell |

The effect for a review: `sum(est_chars_avoided) - sum(deny_chars)` is what stayed
out of context, a ceiling, because a `retry-ran` row means the agent did not have
the content after all. `retry-ran` / `deny` is the false-denial rate to watch;
`deny` / (`deny` + `allow`) is how much of the repeat-eligible reads the rule
caught, and `allow_reason` says where the rest slipped through. Any `lock-timeout`
row is a miss to count: with per-agent state files it should be rare. The toggle
is `read_dedupe`.

### `pr-wait.jsonl` — the PR and CI wait script

Two rows per run of `scripts/pr-wait.mjs`, both written by the script itself: a `start` row as the wait begins and an `end` row when it exits. A `start` with no matching `end` is a run killed outright (a foreground call cut at the harness's two-minute limit, for one): that is the signal that the hint's `run_in_background` advice was not followed. A usage error exits before the wait begins and writes only an `end` row. Written whether or not the `pr_wait` hint option is on: that option only hides the discoverability line. A fixture session's row goes to `fixtures.jsonl`, as for every stream.

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the row was written |
| `event` | `start` \| `end` | which row |
| `session_id` | string \| absent | the session, from `CLAUDE_SESSION_ID` or `CLAUDE_CODE_SESSION_ID` when the harness exports one |
| `mode` | `pr` \| `run` | `--run` selects `run` |
| `target_hash` | string \| absent | first 8 hex characters of the SHA-256 of the PR or branch argument; absent on a usage error. The argument itself is never logged |
| `repo_hash` | string \| absent | the same hash of the repository (`owner/name`), once known |
| `timeout_ms` | number | `start` only: the wait's overall timeout |
| `polls` | number | `end` only: gh calls made while waiting, a retried failure counting. A PR poll is three calls (`pr view`, check runs, commit status), a `--run` poll one |
| `cycles` | number | `end` only: rounds of polling. `polls` / `cycles` is the gh cost of one round |
| `settle_waits` | number | `end` only: rounds spent holding a green result until it was stable, under the settle rule (the same check set on two polls at least `PR_WAIT_SETTLE_MS` apart, default 20000) |
| `duration_ms` | number | `end` only: wall time from start to exit |
| `outcome` | string | `end` only: `passed`, `failed`, `merged`, `closed`, `no-checks` (no check appeared within the grace period: nothing was observed, nothing failed), `timeout`, `gh-error`, `usage`, `interrupted`, `help` (`--help`) |
| `exit_code` | number | `end` only: 0 passed or merged (or no checks), 1 failed or closed, 2 timeout, 3 usage or gh error, 130 interrupted |
| `head_sha` | string \| absent | `end` only: the head commit the verdict is bound to (a later push restarts the wait) |
| `error_class` | `permanent` \| `transient` \| absent | `end` only, on exit 3: `permanent` will not heal (no gh, not a repository, no such PR), `transient` is a retry budget used up |

The effect for a review: each `end` row stands for `polls` gh calls that never reached the model, and one tool call in place of the repeated `gh` and sleep calls an agent would otherwise have made. Compare transcript counts of those calls with the hint on and off. A `passed` PR row always has `settle_waits` of at least 1 (the first green round only starts the clock); a high count means the check set kept changing, which is the late-registering check the settle rule exists for. `start` rows with no `end` count the runs the harness cut off.

### `unknown-agent-types.jsonl` — harness drift signal

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it was seen |
| `agent_type` | string | an agent type not in the known set |

Guards **allow** unrecognised agent types (never break a worker) but record
them here, at most once per type: a `state/agent-types/<type>-<hash>.seen`
marker (created with an atomic `wx` open) makes the dedup race-free — several
hook processes racing on the same brand-new type can no longer produce more
than one row for it. A new entry means the harness introduced something the
guards do not yet classify — enforcement may be quietly narrower than
intended.

### `fixtures.jsonl` — every row from a fixture/verification session

Same record shape as whichever stream it would have gone to, plus a `stream`
field naming that stream (`spawns.jsonl`, `denials.jsonl`,
`subagent-starts.jsonl`, or `unknown-agent-types.jsonl`). Never read by any
audit or scout check — it exists purely so a verification run leaves a trail
without ever touching production numbers.

### `baseline.json` — last-seen state for drift detection

Not append-only. Holds the last observed Claude Code version and rolling
counters. Rewritten each run of the calibration scout. Has exactly ONE writer
path now (`stateFile('baseline.json')`), used identically by
`scripts/detect.mjs` and the `harness-drift` audit check, so the two can no
longer disagree about what the baseline is.

**`ciStatusCache`** (object, keyed by `<owner>/<repo>` lowercased —
`scripts/lib/ci-status.mjs`'s `repoCacheKey()`): the `main_ci_red` signal's
own 10-minute cache, written by `scripts/detect.mjs`'s `ci_status_signal`
check and read (cache only, never a `gh` call) by `hooks/scout-surface.mjs`'s
SessionStart note. Each entry:

| field | type | meaning |
|---|---|---|
| `checkedAt` | ISO 8601 string | when this entry was last written |
| `ok` | boolean | `false` means `gh` was missing/unauthenticated/erroring (offline included) for this repo this run — `red`/`workflows` are absent |
| `red` | boolean | present when `ok` is true: whether at least one active workflow's latest completed run on the default branch is in a red streak |
| `workflows` | array | present when `ok` is true: the RED workflows only (never the green ones), each `{ name, redSince, latestUrl, failingRunCount, boundedByPage }` — see `checkRepoCiStatus()` in `scripts/lib/ci-status.mjs` |

Entries persist across runs within the 10-minute TTL; a stale entry is
replaced (not merged) on the next check, whether that check succeeds or
degrades. Safe to delete like the rest of this file — the next run rebuilds
whatever entries it covers.

### `scout-history.jsonl` — append-only scout run history

One line per `scripts/detect.mjs` run — the same object written to
`scout-latest.json` at that moment, which is itself overwritten every run and
keeps no history of its own.

## Spawn nesting depth — NOT logged, and why

`spawns.jsonl` does not carry a `depth` field (how many spawn-levels deep this
subagent is: 0 for a main-session spawn, 1 for a subagent's own spawn, and so
on). This was checked against the actual PreToolUse payload rather than
assumed missing:

- The payload carries `agent_id` (set only when the CALLER is itself a
  subagent) and, via `callerTranscriptPath()`, at most ONE level of nested
  transcript path (`<dirname>/<basename>/subagents/agent-<id>.jsonl`). That
  scheme has no slot for a grandparent id — a subagent-of-a-subagent's
  transcript path does not encode its own caller's caller, so the path alone
  cannot be walked upward to recover full lineage.
- `caller_is_subagent` (already logged) is therefore only a **1-bit**
  signal — "this spawn's caller was itself a subagent" — not a depth count.
  A caller at depth 1 and a caller at depth 4 both log `caller_is_subagent:
  true` with nothing to tell them apart.
- No other field in the PreToolUse payload (`p`) carries an integer depth,
  a parent chain, or a session-lineage id at all.

**What would be needed:** either (a) the harness adding a `depth` (or
`agent_depth`) integer to the PreToolUse payload directly, so this hook could
log it verbatim with no inference, or (b) the harness encoding full lineage
in the transcript path scheme (e.g. `.../subagents/agent-<id>/subagents/agent-<id2>.jsonl`)
so `callerTranscriptPath()` could walk it and count segments. Neither exists
in the harness surface this plugin can observe today (checked 2026-09-23).
Tracked as a gap, not silently worked around with a value that looks like
depth but is not one.

**Update 2026-09-28.** The harness now writes a sidecar next to each
subagent transcript, `<session>/subagents/agent-<agent_id>.meta.json`, that
names the `Agent` call which started it (`toolUseId`), its `spawnDepth`, and
for a nested agent its `parentAgentId`. The spawn guard reads only
`toolUseId` from it (the `review_recursion_guard` lookup) and logs every
spawn's own `tool_use_id`, so a row can be joined to the agent it started.
Logging depth itself from the sidecar is still open.

## Enforcement-silent coverage

`spawns.jsonl` going quiet looks identical whether nothing was spawned or the
guard stopped recording (a renamed matcher, an exception before the append, a
config flag flipped off). `scripts/lib/coverage.mjs`'s `telemetryCoverage()`
answers this independently, by counting real `Agent` tool_use calls in
session transcripts (ground truth the guard cannot influence) and comparing
against `spawns.jsonl` day by day:

- `status: 'silent'` — transcripts show spawns that day, `spawns.jsonl` has
  none.
- `status: 'partial'` — `spawns.jsonl` has fewer than half of what transcripts
  show (`coverage_partial_ratio`, default 0.5).
- `status: 'ok'` or `'idle'` otherwise. **Today is never reported as
  `silent`** (marked `partialDay: true` instead) — a day still in progress is
  not evidence.

Surfaced two ways: the `telemetry-coverage` audit check (`node
scripts/audit.mjs --only telemetry-coverage`), and the `enforcement_silent`
scout signal in `scripts/detect.mjs` (capped at 20s / 5,000 files / 2GB so
the daily scout's quiet-day fast path stays fast; `truncated: true` when a
cap applies).

## Reading these files

- Treat every line as independent. A truncated final line is possible if a
  hook was interrupted; skip unparseable lines rather than failing the whole
  file.
- Never assume the files exist. Absence means no hook has fired yet — which
  is *not* the same as "no activity", and should be reported as unknown
  rather than zero.
- These files are per machine. Aggregating across machines is the consumer's
  job; nothing here is deduplicated or synchronised.
- **No rotation or size cap.** `spawns.jsonl`, `denials.jsonl`,
  `subagent-starts.jsonl`, and `unknown-agent-types.jsonl` grow unbounded
  forever — nothing in this plugin trims them. Worth knowing before treating
  this directory as permanent infrastructure on a long-lived machine.

## Stability promise

Fields documented above will not be removed or repurposed within a major
version. Anything not documented here is internal and may change without
notice.
