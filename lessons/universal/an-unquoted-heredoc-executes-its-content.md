---
id: an-unquoted-heredoc-executes-its-content
title: An unquoted heredoc executes its content — quote the delimiter and substitute placeholders afterwards
scope: [universal]
requires: {}
status: active
since: 2026-09-14
provenance: [contrib-2]
corroborated: 1
---
Writing a log entry with an unquoted heredoc delimiter, in order to interpolate a date, also interpolated everything else. Every backtick-quoted word in the prose — which in Markdown means every identifier, path, and command name — was executed as a command, and its output (usually nothing) replaced the word in the written text. The entry landed with holes in it, and the shell had run a handful of commands nobody wrote.

**The rule: quote the delimiter.** `<<'MARKER'` disables interpolation entirely; `<<MARKER` enables command substitution, variable expansion, and backslash escapes on every line of the body.

**When you need one dynamic value in an otherwise literal block:**
1. Compute the value into a variable first.
2. Write the block with a **quoted** delimiter, carrying a placeholder token where the value goes.
3. Substitute the placeholder afterwards with a stream editor.

This is not a style preference. Prose destined for a file — a changelog entry, a report, a commit message, a lesson — is exactly the content most likely to contain backticks, dollar signs, and backslashes, and it is the content where a silent partial execution is hardest to notice, because the result still looks like text.

**Related hazards in the same family:** a command message written through a shell that adds a byte-order mark, and a document whose content is passed as a command-line argument rather than as file content. In every case, the fix is to stop routing literal text through an interpreting layer.

Related: [[powershell-pipe-bom-breaks-json]], [[validate-cli-args-against-injection]], [[shell-read-encoding-double-encodes]].
