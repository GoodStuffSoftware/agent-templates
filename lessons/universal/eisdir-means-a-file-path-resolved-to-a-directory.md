---
id: eisdir-means-a-file-path-resolved-to-a-directory
title: EISDIR means the path you opened as a file IS a directory — the bug is upstream, in how the path was built or selected
scope: [universal]
requires: {}
status: active
since: 2026-09-22
provenance: [contrib-2]
corroborated: 1
symptoms: [illegal operation on a directory]
sessions: 35
---
`EISDIR` / "illegal operation on a directory, read '<path>'" fires when code calls a file-read operation (`fs.readFile`, a tool that expects one file, a glob match assumed to be a leaf) and the path it resolved to is actually a directory. Measured at 35 distinct sessions across 21 projects on this operator's own corpus — common enough to be worth recognizing on sight rather than re-deriving each time.

**Why:** the error is entirely accurate about the mechanism (you cannot `read()` a directory as a byte stream) but says nothing about why a directory ended up where a file was expected. That is almost always one of: a glob or directory walk that did not filter out directories before treating every match as a file; a path variable that was supposed to point at a specific file inside a directory but got truncated one segment short; or a directory and a file sharing a name stem (e.g. `config` the directory vs. `config.json` the file) where the wrong one was selected.

**How to apply:**
- Before assuming the read call is broken, `stat` the resolved path and confirm whether it is actually a directory — this settles the question in one step instead of re-reading the calling code first.
- If the path came from a glob or a directory walk, check that the walk excludes directory entries (`entry.isFile()`) before handing candidates to a file-reading step — a walk that only checks the name pattern, not the entry type, is the most common root cause.
- If the path was built by joining segments, print the fully resolved path before the failing call — a dropped final segment (the actual filename) is easy to introduce in a join/concat and easy to miss by eye in the source.
