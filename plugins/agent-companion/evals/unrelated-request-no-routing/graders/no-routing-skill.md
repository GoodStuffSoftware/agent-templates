---
# Negative trigger: the recommend skill must NOT fire on an unrelated question. arm: both scores this in both arms (a must-not-fire check is fair to the baseline, which can never fire it either).
type: tool_used
tool: Skill
input_match: '"skill"\s*:\s*"(?:[\w-]+:)?recommend"'
min: 0
max: 0
arm: both
---
