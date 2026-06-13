#!/usr/bin/env node
// leak-check.mjs — fails (exit 1) if any tracked file contains a real-world token.
//
// This library is meant to be vendor-agnostic and project-agnostic. The seed
// material was genericized from real Claude Code agent teams, so this guard
// exists to make sure no real name, path, domain, or git SHA ever survives a
// contribution back into the library.
//
// Zero dependencies. Run from the repo root:
//   node scripts/leak-check.mjs
//
// IMPORTANT DESIGN NOTE: the banned tokens below are assembled from hex byte
// sequences at runtime so that THIS source file does not itself contain any of
// the literal banned substrings (otherwise leak-check would flag itself). Do
// not paste the literal real-world strings into this file — add a new hex
// entry instead (see `fromHex`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Decode a space-separated hex byte string into UTF-8 text. Keeps the literal
// banned token out of this file's own source.
function fromHex(hex) {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex").toString("utf8");
}

// --- Banned literal substrings (case-insensitive), stored as hex ------------
// Each entry: [label, hexBytes]. Decode -> lowercase compare against file text.
const LITERAL_TOKENS = [
  ["project-name-A",         "676f6f647374756666736f667477617265"],                       // the studio site slug
  ["project-name-A-spaced",  "476f6f6420537475666620536f667477617265"],                   // the studio name with spaces
  ["project-name-A-domain",  "676f6f647374756666736f6674776172652e636f6d"],               // its .com domain
  ["product-B",              "626573747375646f6b75"],                                      // the sudoku product slug
  ["product-B-spaced",       "42657374 2053 75646f6b75"],                                  // the sudoku product, spaced
  ["product-B-domain",       "626573747375646f6b752e617070"],                             // its .app domain
  ["user-home-path",         "433a5c55736572735c6d73616e74"],                             // C:\Users\<handle>
  ["user-handle",            "6d73616e74"],                                                // the OS handle
  ["full-name",              "4d69636861656c2053616e746f726f"],                           // founder full name
  ["surname",                "53616e746f726f"],                                            // founder surname
  ["legacy-branch",          "636c617564652f7375 646f6b752d7675 652d617070"],             // an old cowork branch name
  ["user-email",             "73616e746f72 6f3132 40676d61696c2e636f6d"],                 // personal gmail
];

const banned = LITERAL_TOKENS.map(([label, hex]) => ({
  label,
  needle: fromHex(hex).toLowerCase(),
}));

// --- Ownership exemption (narrow, file- AND token-scoped) -------------------
// A license file legally MUST name its copyright holder, so the LICENSE file
// is allowed to contain the studio's own name — that is ownership metadata,
// not a project-specifics leak. The exemption is deliberately tiny:
//   * keyed by exact relative path (only `LICENSE`),
//   * and by the single token label the LICENSE text actually uses.
// The standard MIT copyright line contains only the SPACED company name, so
// that is the ONLY label exempted — the no-space slug and the .com domain do
// NOT appear in LICENSE and are NOT exempted (if a future attribution line
// needs one, add it then, with the same "only what's used" discipline).
// Everything else stays banned EVEN in LICENSE: the product name, the personal
// name/handle/email, user-home paths, and git-SHA-like hex. And the company
// name stays banned in every OTHER file. If you find yourself wanting to widen
// this map, that's the signal to genericize instead.
const EXEMPT = {
  LICENSE: new Set([
    "project-name-A-spaced", // the studio name with spaces (used in the copyright line)
  ]),
};

// --- Banned patterns (regex) ------------------------------------------------
// A bare git SHA: a standalone hex run 7-40 chars long. We require word
// boundaries and that the run is NOT inside a longer hex string (so it doesn't
// trip on, say, a CSS color or a base64 blob fragment that happens to be hex).
// Generic placeholder examples and {{TOKENS}} are fine — they aren't hex runs.
const SHA_RE = /\b[0-9a-f]{7,40}\b/gi;

// --- Files we scan ----------------------------------------------------------
const IGNORE_DIRS = new Set([".git", "node_modules"]);
// leak-check.mjs is allowed to mention hex (it's how the tokens are stored) and
// would otherwise self-trip on its own SHA_RE matches, so we skip scanning it.
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// Heuristic: skip obvious binaries by extension.
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|mov)$/i;

function isShaFalsePositive(match) {
  // All-digit runs (e.g. dates, ports, dimensions like 1200) are not SHAs.
  if (/^[0-9]+$/.test(match)) return true;
  // All-letter runs that are real words (e.g. "feedface" is borderline, but
  // common English hex-ish words) — be conservative: require at least one digit
  // OR length >= 12 to call it a SHA. Short all-letter hex (deed, cafe, face)
  // is almost always prose.
  if (/^[a-f]+$/i.test(match) && match.length < 12) return true;
  return false;
}

const hits = [];

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).split(sep).join("/");
  if (BINARY_EXT.test(file)) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable / binary
  }
  const lines = text.split(/\r?\n/);
  const isSelf = relative(ROOT, file) === SELF;

  lines.forEach((line, i) => {
    const lower = line.toLowerCase();

    for (const { label, needle } of banned) {
      // Skip a token only when THIS file is explicitly allowed to carry THIS
      // label (see EXEMPT above) — e.g. the company name in LICENSE.
      if (EXEMPT[rel]?.has(label)) continue;
      let idx = lower.indexOf(needle);
      while (idx !== -1) {
        hits.push({ rel, line: i + 1, label, text: line.trim() });
        idx = lower.indexOf(needle, idx + needle.length);
      }
    }

    if (!isSelf) {
      for (const m of line.matchAll(SHA_RE)) {
        if (isShaFalsePositive(m[0])) continue;
        hits.push({
          rel,
          line: i + 1,
          label: "git-sha-like",
          text: line.trim(),
        });
      }
    }
  });
}

if (hits.length === 0) {
  console.log("leak-check: OK — no real-world tokens found.");
  process.exit(0);
}

console.error(`leak-check: FAILED — ${hits.length} hit(s):\n`);
for (const h of hits) {
  console.error(`  ${h.rel}:${h.line}  [${h.label}]  ${h.text}`);
}
console.error(
  "\nGenericize these before committing (real specifics -> {{PLACEHOLDERS}} or generic examples like acme.com)."
);
process.exit(1);
