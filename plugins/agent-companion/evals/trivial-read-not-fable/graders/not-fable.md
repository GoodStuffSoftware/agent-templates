---
# The ROUTE line never names fable for a trivial read.
type: regex
pattern: 'ROUTE:\s*\**\s*`?\s*(?:claude-)?fable'
flags: i
match: not_contains
---
