---
id: seed-a-new-counter-from-measured-state
title: Seed a new counter from a measurement of the state that predates it, never from zero
scope: [universal]
requires: {}
status: active
since: 2026-08-24
provenance: [contrib-2]
corroborated: 1
---
A capped promotion needed a counter to enforce its ceiling, and the counter was being introduced after the promotion had already granted awards through two earlier paths — an administrative batch and a command-line tool, both predating the counter. Seeding at zero would have silently raised the real ceiling by however many winners already existed, and nothing would have reported it.

The arming step instead COUNTS the records already carrying the grant marker and starts there, recording what it measured on the counter document as an audit trail. That turns arming into something self-correcting rather than a number a human has to look up and type in, and it costs one aggregation on the single invocation that finds no counter — every later call finds one and skips.

**Why:** a counter introduced mid-life is a summary of history, and its initial value is a claim about history. Zero is the tempting default because it is what a counter means on day one — but day one already happened, through paths the counter never saw. The error is silent in both directions and permanent: nothing downstream can distinguish a correctly seeded counter from a wrong one.

**How to apply:**
- **Derive the seed by counting the durable evidence** (records holding the marker, rows in the ledger), not from a remembered number, a spreadsheet, or a config constant.
- **Record what the seed measured, on the artifact itself.** A field naming the count and its basis is what lets a later reader audit the ceiling instead of trusting it.
- **Re-check existence INSIDE the transaction that creates it**, so two concurrent first-invocations cannot both seed. The check-then-create window is exactly as wide as your slowest aggregation.
- **Keep the downstream refusal as a backstop, not as the arming gate.** The consumer should still refuse to proceed when the counter is missing — reaching it means seeding failed, and guessing zero *there* is precisely how an extra allocation escapes.
- **Price the measurement before choosing it.** A one-time aggregation on a cold path is cheap; the same count on every request is a different design. Say which one you built.
- Related: [[derive-at-read-time-over-storing]] (when a stored counter is not needed at all) and [[assert-the-guard-saw-something]] (a cap that never saw a record is not a cap).
