# Telemetry format

`agent-companion` writes newline-delimited JSON to its plugin data directory.
**These files are a public contract.** Other tools read them, so the format is
versioned and changes follow the rules below.

Location (per machine, survives plugin upgrades, removed on uninstall):

```
${CLAUDE_PLUGIN_DATA}          # normally ~/.claude/plugins/data/agent-companion/
```

## Versioning

Every emitted record carries `v`, the schema version that wrote it.

- **Additive changes** (a new optional field) keep `v` the same. Consumers MUST
  tolerate unknown fields rather than rejecting the record.
- **Breaking changes** (removing a field, changing a type, changing the meaning
  of an existing field) increment `v`.
- Consumers MUST skip records whose major version they do not understand rather
  than guessing. Misreading a record is worse than ignoring it — a wrong number
  on a dashboard is acted on, a missing one is investigated.

Current version: **1**.

Records written before versioning was introduced have no `v` field. Treat a
missing `v` as version 0 and read it as version 1 with fields possibly absent.

## Files

### `spawns.jsonl` — one record per subagent spawn, written before it starts

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when the spawn was requested |
| `session_id` | string | the session that requested it |
| `spawned_by_agent_type` | string | what requested it — `main`, `subagent`, `teammate`, … |
| `model` | string | the requested model, or the literal `(inherited)` |
| `subagent_type` | string \| null | the named agent type, if one was given |
| `effort` | string \| null | effort level, when the harness reported one |

**`model: "(inherited)"` is the field that matters most.** It means no model was
specified, so the spawn silently ran at the *lead's* tier. That is the mechanism
behind unexamined premium fan-out, and it is invisible in any cost report that
groups only by resolved model name.

Canary probes (session ids beginning `canary`) are deliberately **not** recorded.
A guard that logs its own test inflates the metric it is checked against.

### `subagent-starts.jsonl` — one record per subagent actually starting

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it started |
| `session_id` | string | owning session |
| `agent_id` | string | harness agent id |
| `agent_type` | string | resolved agent type |
| `effort` | string \| null | effort level, when reported |

Pairing this against `spawns.jsonl` shows requested-versus-started. A spawn with
no corresponding start was denied or failed.

### `unknown-agent-types.jsonl` — harness drift signal

| field | type | meaning |
|---|---|---|
| `v` | number | schema version |
| `at` | ISO 8601 string | when it was seen |
| `agent_type` | string | an agent type not in the known set |

Guards **allow** unrecognised agent types (never break a worker) but record them
here. A new entry means the harness introduced something the guards do not yet
classify — enforcement may be quietly narrower than intended.

### `baseline.json` — last-seen state for drift detection

Not append-only. Holds the last observed Claude Code version and rolling
counters. Rewritten each run of the calibration scout.

## Reading these files

- Treat every line as independent. A truncated final line is possible if a hook
  was interrupted; skip unparseable lines rather than failing the whole file.
- Never assume the files exist. Absence means no hook has fired yet — which is
  *not* the same as "no activity", and should be reported as unknown rather than
  zero.
- These files are per machine. Aggregating across machines is the consumer's
  job; nothing here is deduplicated or synchronised.

## Stability promise

Fields documented above will not be removed or repurposed within a major
version. Anything not documented here is internal and may change without notice.
