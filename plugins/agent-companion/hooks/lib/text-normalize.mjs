// text-normalize.mjs — the ONE failure-text normalizer, shared by
// scripts/recurrence.mjs (dedup signatures) and hooks/gotcha-retrieval.mjs
// (literal symptom matching). See
// docs/adr/0002-stack-scoped-gotcha-retrieval.md, Decision part 3.
//
// stripNoisePrefixes() below is lifted verbatim (same regex, same repeated-
// strip loop) from what used to be a private, unexported copy inside
// recurrence.mjs — that file now imports it from here instead of defining
// its own, so there is exactly one implementation, not two that could drift
// apart. recurrence.mjs's own signature() still layers ADDITIONAL,
// dedup-specific transforms on top (path/hex/number placeholders,
// lowercasing, truncation) that this file deliberately does not apply —
// those exist to collapse many instances of "the same failure" into one
// signature, which is a different, more aggressive job than matching a
// human-authored symptoms: key against a live error.
//
// repairMojibake() is new: some of this operator's older session
// transcripts contain double-encoded UTF-8 (a character like an em dash was
// at some point mis-decoded as Windows-1252 and re-encoded), and a
// symptoms: key authored from clean text would otherwise never match a
// live tool_error sourced from a damaged transcript, or vice versa.
//
// Zero dependencies. Node builtins only.

// --- Noise-prefix stripping -------------------------------------------------
//
// Covers exactly the label-wrapper prefixes a failure message is commonly
// wrapped in (Error:/error TS####:, the errno codes, fatal:) — a bounded,
// named list, not a blanket "strip anything before a colon" rule that would
// also eat the error CLASS off SyntaxError:/TypeError:/etc. and wrongly
// treat genuinely different failures as the same one.
const NOISE_PREFIX_RE = /^(?:error\s*(?:ts\d+)?|enoent|eacces|eperm|econnrefused|etimedout|eaddrinuse|eexist|fatal)\s*:\s*/i;

export function stripNoisePrefixes(s) {
  let out = String(s).trim();
  // A message can stack more than one label ("Error: ENOENT: …") — strip
  // until nothing more matches. The equality check guarantees termination;
  // the iteration cap is defensive belt-and-braces, not load-bearing.
  for (let i = 0; i < 5; i++) {
    const next = out.replace(NOISE_PREFIX_RE, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

// --- Mojibake repair ---------------------------------------------------
//
// The common real-world shape: a UTF-8 byte sequence gets read back through
// the Windows-1252 codepage (the Windows ANSI default) instead of UTF-8,
// turning one real character into 2-4 garbage characters. Windows-1252 is
// NOT plain Latin-1 in the 0x80-0x9F range — it redefines those bytes to a
// set of printable punctuation characters (curly quotes, en/em dash, the
// euro sign, …) that all live OUTSIDE the 0-255 code-point range, so a naive
// "reinterpret each UTF-16 code unit as one Latin-1 byte" repair silently
// mishandles exactly the characters most likely to be the ones that got
// mangled. This table carries that remap by hand.
const CP1252_C1 = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
const CP1252_REVERSE = new Map(Object.entries(CP1252_C1).map(([k, v]) => [v, Number(k)]));

// A run of characters worth attempting repair on: the raw Latin-1
// supplement range (0xA0-0xFF, identical between Latin-1 and cp1252) plus
// the specific cp1252 C1 remaps above. Built from the reverse map so the
// two tables can never drift apart.
const MOJIBAKE_CHAR_RE = new RegExp(
  `[\\u00A0-\\u00FF${[...CP1252_REVERSE.keys()].map((cp) => `\\u${cp.toString(16).padStart(4, '0')}`).join('')}]{2,}`,
  'g',
);

// cp -> the cp1252 byte that produces it. Below 0x100 the byte IS the code
// point (Latin-1 supplement); above it, only the specific remapped
// punctuation characters in CP1252_REVERSE are representable at all.
function cp1252BytesFor(run) {
  const bytes = [];
  for (const ch of run) {
    const cp = ch.codePointAt(0);
    const byte = cp <= 0xff ? cp : CP1252_REVERSE.get(cp);
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  return bytes;
}

// Repairs only LOCALIZED runs of 2+ suspicious characters, never the whole
// string at once — a lone accented letter ("café", a real name) is left
// alone rather than risking corruption of legitimate Latin-1 text, and a
// string that is pure ASCII (the overwhelming common case for tool_error
// text) never pays for the regex-replace callback at all. A run is only
// ever replaced when re-decoding its recovered bytes as UTF-8 succeeds
// cleanly (no replacement characters) — anything else is left exactly as
// it was, because a failed "repair" that garbles further is worse than
// leaving real mojibake unrepaired (normalizeErrorText's caller still gets
// a usable, if imperfect, string either way).
export function repairMojibake(s) {
  const str = String(s ?? '');
  if (!str || !MOJIBAKE_CHAR_RE.test(str)) return str;
  MOJIBAKE_CHAR_RE.lastIndex = 0;
  return str.replace(MOJIBAKE_CHAR_RE, (run) => {
    const bytes = cp1252BytesFor(run);
    if (!bytes) return run;
    let repaired;
    try { repaired = Buffer.from(bytes).toString('utf8'); } catch { return run; }
    if (!repaired || repaired.includes('�')) return run;
    return repaired;
  });
}

// --- The one normalizer --------------------------------------------------
//
// Repair mojibake, strip a leading noise-label prefix, collapse internal
// whitespace (transcripts wrap tool output across lines; a key authored
// from a single-line paste must still match a message that arrived
// multi-line, and vice versa), trim. This is what
// hooks/gotcha-retrieval.mjs runs BOTH the live tool_error and every
// candidate symptoms: key text through before testing containment — never
// compare either side raw.
export function normalizeErrorText(s) {
  const repaired = repairMojibake(String(s ?? ''));
  const stripped = stripNoisePrefixes(repaired);
  return stripped.replace(/\s+/g, ' ').trim();
}
