// Read cap for subagents (0.31.62): a worker that Reads a whole large text file fills its context (about 21 worker runs hit the 110K
// hand-off on 2026-11-21, mostly that way). A Read with no `limit` on a text file longer than `read_cap_lines` (default 300) is
// rewritten to `limit: <read_cap_lines>` and the agent is told, in the same reply, how many lines the file has and how to read the rest.
//
// Output (hooks docs, PreToolUse decision control, checked 2026-11-21): hookSpecificOutput.updatedInput REPLACES the whole input
// object (so the original fields are carried over) and hookSpecificOutput.additionalContext is added next to the tool result. Neither
// needs a permissionDecision, so none is sent and a permission prompt is never skipped (tests/no-allow-decision.test.mjs).
//
// Untouched: the main thread (callerIsSubagent: payloads from inside a subagent carry agent_id), a Read that has a limit or pages,
// images, PDFs, notebooks, a file with a NUL byte near the start, a file that does not exist, and any file with at most
// `read_cap_lines` lines left to read from the offset. read_cap (default true) is the opt-out; CLAUDE_PLUGIN_OPTION_READ_CAP=0 also works.
// Fails open: any error lets the Read run unchanged. Read-dedupe (hooks/read-dedupe.mjs) is registered beside this and records what the
// Read actually returned, so a capped Read is not mistaken for a whole-file one.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { readStdin, opt, passthrough, writeAndExit, callerIsSubagent } from './lib/context.mjs';
import { isServedCall } from './lib/delegation.mjs';

const READ_CAP_LINES_DEFAULT = 300;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.avif', '.pdf', '.ipynb']);

// Line count of a file by chunked reads; null when the first 8 KB hold a NUL byte (binary). A last line without a newline counts.
function countLines(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    let lines = 0;
    let lastByte = 10;
    let first = true;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      if (first) { first = false; if (buf.subarray(0, Math.min(n, 8192)).includes(0)) return null; }
      const chunk = buf.subarray(0, n);
      for (let j = chunk.indexOf(10); j >= 0; j = chunk.indexOf(10, j + 1)) lines += 1; // native scan, not a JS byte loop
      lastByte = buf[n - 1];
    }
    return lastByte === 10 ? lines : lines + 1;
  } catch { return null; } finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } } }
}

// null: let the Read run as it is. Else { updatedInput, text }.
function capRead(p, cap) {
  if (!p || p.tool_name !== 'Read' || !callerIsSubagent(p) || isServedCall(p)) return null;
  const input = p.tool_input;
  if (!input || typeof input !== 'object' || typeof input.file_path !== 'string' || !input.file_path) return null;
  if (input.limit !== undefined && input.limit !== null) return null;
  if (input.allow_large === true) return null; // the worker asked for the whole file on purpose
  if (input.pages !== undefined && input.pages !== null && input.pages !== '') return null;
  if (SKIP_EXT.has(extname(input.file_path).toLowerCase())) return null;
  const offset = Number.isInteger(input.offset) && input.offset >= 1 ? input.offset : 1;
  const file = resolve(typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd(), input.file_path);
  const st = statSync(file);
  if (!st.isFile() || st.size <= cap) return null; // at least one byte per line: at most `cap` lines
  const total = countLines(file);
  if (total === null || total - (offset - 1) <= cap) return null;
  const end = offset + cap - 1;
  const text = `[agent-companion] read cap: ${input.file_path} has ${total} lines, so this Read was capped to lines ${offset}-${end} (limit ${cap}) to keep your context small. `
    + `For the rest, Read with offset=${end + 1} and a limit of at most ${cap}, or grep -n for the names you need first and Read only those lines (offset and limit of at most 80).`;
  return { updatedInput: { ...input, limit: cap }, text };
}

try {
  if (!opt('read_cap', true)) passthrough();
  let cap = Number(opt('read_cap_lines', READ_CAP_LINES_DEFAULT));
  if (!Number.isFinite(cap) || cap < 1) cap = READ_CAP_LINES_DEFAULT;
  const r = capRead(readStdin(), Math.floor(cap));
  if (!r) passthrough();
  writeAndExit(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: r.updatedInput, additionalContext: r.text } }));
} catch {
  passthrough();
}
