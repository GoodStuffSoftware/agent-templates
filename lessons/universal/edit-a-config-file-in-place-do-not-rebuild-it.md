---
id: edit-a-config-file-in-place-do-not-rebuild-it
title: A CLI that edits a config file must change only the named entry in the raw file — rebuilding it from the parsed model drops what the model does not know
scope: [universal]
requires: {}
status: active
since: 2026-10-12
provenance: [contrib-2]
corroborated: 1
---
A rules CLI rewrote its JSON config by compiling every rule into its internal model and serialising the model back. On a real file that silently dropped fields the model did not carry (a scheduled-activation field and a top-level override on one entry). Nothing errored, and a copy-based test on a clean fixture would never show it.

**How to apply:**
- Read the raw file, locate the one entry, change only it, write the rest back byte-for-byte (unknown keys, comments if the format allows, ordering).
- Refuse, with an error, an existing file that cannot be parsed. Do not replace it; an empty file counts as "no entries".
- Make `add` refuse an id already present as a malformed entry instead of overwriting it.
- Test on a COPY of the real, hand-edited file and diff before and after: only the named entry may differ.

Related: [[correct-a-durable-record-explicitly]], [[a-tracker-field-may-silently-truncate-on-write]].
