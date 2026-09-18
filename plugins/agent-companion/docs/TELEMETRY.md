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
    version-notice-state.json    # per-session plugin-staleness notice state
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
| `caller_model` | string \| null | the CALLER's own model, read from the last assistant record of the caller's transcript (bounded tail-read) |
| `caller_effort` | string \| null | the CALLER's effort — what v1's `effort` field held |
| `spawn_effort` | string \| null | the SPAWNED agent's own effort: the agent definition's frontmatter effort if it has one; null if the resolved model takes no effort parameter (e.g. haiku); otherwise the caller's effort (built-in types run at the caller's effort) |
| `spawn_effort_source` | `definition` \| `inherited` \| `none` | which of the three rules above produced `spawn_effort` |
| `effort_definition` | string \| null | the effort named in the agent definition, if any |
| `declared_weight` | 1-5 or null | task weight declared in the brief (`WEIGHT:` or `WARRANT: weight N`) |
| `declared_kind` | string or null | task kind declared in the brief (`KIND:`) |
| `declared_consequence` | string or null | consequence declared in the brief (`CONSEQUENCE:` routine, elevated, critical) |
| `fit` | `over`, `under`, `fit`, `unknown`, or null | the spawn compared to the routing table for its declared weight; null when no weight was declared |
| `fit_expected` | string or null | what the table routed that weight to, e.g. `sonnet/high` |

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

Pairing this against `spawns.jsonl` shows requested-versus-started. A spawn
with no corresponding start was denied or failed.

### `denials.jsonl` — one record per guard firing

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the guard fired |
| `session_id` | string | session it fired in |
| `agent_type` | string | the agent whose call was denied |
| `tool_name` | string \| null | the tool the call was for (`Agent`, `Bash`, …) |
| `guard` | string | `delegation`, `fit`, `warrant`, or `premium-cap` |
| `outcome` | string | currently always `deny` |
| `detail` | string | short reason, truncated to 300 chars |

**A consumer must not treat a zero count here as good news.** A guard that
has silently stopped matching — after a harness rename, say — produces
exactly the same zero as a guard with nothing to deny. Zero denials across a
period of real spawn activity is a reason to run the canary, not a reason to
relax. See "Enforcement-silent coverage" below for the automated version of
this check.

Canary and fixture/verification sessions are excluded the same way as
`spawns.jsonl` — see Fixtures above.

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

### `scout-history.jsonl` — append-only scout run history

One line per `scripts/detect.mjs` run — the same object written to
`scout-latest.json` at that moment, which is itself overwritten every run and
keeps no history of its own.

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
