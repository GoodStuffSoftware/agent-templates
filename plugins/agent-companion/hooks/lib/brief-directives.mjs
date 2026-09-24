// Brief directives: the "LABEL: value" lines a spawn brief declares
// (TYPE, WEIGHT, KIND, CONSEQUENCE, WARRANT, EFFORT), read by the spawn guard.
//
// Two rules (release-candidate review of 0.29.0, lead decision R1):
//   1. A line inside a fenced code block (``` or ~~~), an indented code line
//      (4+ columns of leading whitespace, a tab counting to the next multiple
//      of 4) or a > blockquote is NEVER a declaration. Pasted YAML, a quoted
//      earlier brief or a code sample must not declare anything.
//   2. For each label, the FIRST line-anchored occurrence wins, whether or not
//      its value is valid. A later line never replaces it: a misspelt or
//      unknown header TYPE stays unknown instead of being replaced by a body
//      line ("type: explore" in pasted YAML) that down-routes the spawn and
//      skips the warrant and the cap. An invalid first value (WEIGHT: 9)
//      declares nothing for that label.
//
// A declaration line: optional leading whitespace (under 4 columns), an
// optional list marker (- or *), and an optional markdown-bold label and/or
// value ("**TYPE:** x", "**TYPE**: x", "__KIND:__ x"). Case-insensitive.
// The value check is the caller's regex source, applied to what follows the
// colon exactly as the single-regex form did before.

export const DIRECTIVE_LABELS = ['TYPE', 'WEIGHT', 'KIND', 'CONSEQUENCE', 'WARRANT', 'EFFORT'];

const BOLD = '(?:\\*\\*|__)?';
const LINE = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${BOLD}(${DIRECTIVE_LABELS.join('|')})${BOLD}[ \\t]*:(.*)$`, 'i');
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;

function indentColumns(line) {
  let col = 0;
  for (const ch of line) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// The lines of `text` that may carry a declaration, in order.
export function declarationLines(text) {
  const out = [];
  let fence = null; // { ch, len } while inside a fenced block
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (!line.trim()) continue;
    if (indentColumns(line) >= 4) continue; // indented code
    if (BLOCKQUOTE.test(line)) continue;
    const f = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain a backtick (CommonMark);
    // such a line is inline code, not a fence.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length }; // unclosed: runs to the end
      continue;
    }
    out.push(line);
  }
  return out;
}

// { LABEL: { rest, line } } — the first declaration line per label. `rest`
// is the text after the colon.
export function briefDeclarations(text) {
  const found = {};
  for (const line of declarationLines(text)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const label = m[1].toUpperCase();
    if (!found[label]) found[label] = { rest: m[2], line };
  }
  return found;
}

// The first declaration of `label` checked against `valueSrc` (a regex
// source whose first group is the value): the match, or null when the label
// was not declared or its first declaration's value is not valid.
export function declarationValue(decls, label, valueSrc) {
  const d = decls[label];
  if (!d) return null;
  return new RegExp(`^[ \\t]*${BOLD}[ \\t]*${valueSrc}`, 'i').exec(d.rest);
}
