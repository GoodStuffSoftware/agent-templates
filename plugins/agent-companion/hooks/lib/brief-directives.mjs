// Brief directives: the "LABEL: value" lines a spawn brief declares
// (TYPE, WEIGHT, KIND, CONSEQUENCE, WARRANT, EFFORT), read by the spawn guard.
//
// Two rules (release-candidate review of 0.29.0, lead decision R1):
//   1. A line inside a fenced code block (``` or ~~~), an indented code
//      line, a > blockquote line, or a line inside an HTML comment
//      (<!-- ... -->) is NEVER a declaration. Pasted YAML, a quoted earlier
//      brief, a code sample or a hidden comment must not declare anything.
//   2. For each label, the FIRST line-anchored occurrence wins, whether or not
//      its value is valid. A later line never replaces it: a misspelt or
//      unknown header TYPE stays unknown instead of being replaced by a body
//      line ("type: explore" in pasted YAML) that down-routes the spawn and
//      skips the warrant and the cap. An invalid first value (WEIGHT: 9)
//      declares nothing for that label.
//
// The markdown reading (0.29.0 final review F4; CommonMark, simplified):
//   - Whitespace is normalised first: a BOM or zero-width character is
//     dropped, and a no-break or other Unicode space counts as a space, so
//     "\uFEFFTYPE: x" or "\u00A0TYPE: x" is the header it looks like.
//   - Indented code is 4 or more columns of indent (a tab reaching the next
//     multiple of 4) beyond the enclosing LIST ITEM's content column, or
//     beyond column 0 outside a list. So "    - CONSEQUENCE: critical" nested
//     under "- details" IS a declaration (a nested list item), while a
//     tab-indented "\tTYPE: x" at the top level is indented code and is not.
//   - Fences, blockquotes and HTML comments are recognised at up to 3 columns
//     beyond the enclosing list item's content column; a fence inside a list
//     item also ends where the item ends.
//   - Only a line that itself starts with ">" is quoted. A line right after
//     a quote is NOT taken as the quote's lazy continuation (lead decision
//     on F4): that would drop a real header written straight after a quote,
//     and its floor with it, while protecting nothing, since the same line
//     unquoted in the body counts anyway.
//   - An HTML comment runs from "<!--" to the first "-->", across lines; an
//     unclosed one runs to the end (as an unclosed fence does). Text before
//     a "<!--" opening mid-line is still read; inline `code` is not scanned.
//
// A declaration line: optional leading whitespace, an optional list marker
// (- or *), and an optional markdown-bold label and/or value ("**TYPE:** x",
// "**TYPE**: x", "__KIND:__ x"). Case-insensitive. The value check is the
// caller's regex source, applied to what follows the colon exactly as the
// single-regex form did before.

export const DIRECTIVE_LABELS = ['TYPE', 'WEIGHT', 'KIND', 'CONSEQUENCE', 'WARRANT', 'EFFORT'];

const BOLD = '(?:\\*\\*|__)?';
const LINE = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${BOLD}(${DIRECTIVE_LABELS.join('|')})${BOLD}[ \\t]*:(.*)$`, 'i');
// Relative to the enclosing container (indent already stripped):
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^([-*+]|\d{1,9}[.)])(?=[ \t]|$)/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

// The line with zero-width characters dropped, Unicode spaces made spaces,
// and its leading tabs expanded to the next multiple of 4 columns.
function normalise(line) {
  const s = line.replace(ZERO_WIDTH, '').replace(UNICODE_SPACE, ' ');
  let col = 0;
  let i = 0;
  for (; i < s.length; i += 1) {
    if (s[i] === ' ') col += 1;
    else if (s[i] === '\t') col += 4 - (col % 4);
    else break;
  }
  return ' '.repeat(col) + s.slice(i);
}

// The column a list item's content starts at, given its marker line.
function listContentColumn(indent, rel, marker) {
  let col = indent + marker.length;
  const after = rel.slice(marker.length);
  let spaces = 0;
  let i = 0;
  for (; i < after.length && (after[i] === ' ' || after[i] === '\t'); i += 1) {
    const w = after[i] === '\t' ? 4 - ((col + spaces) % 4) : 1;
    spaces += w;
  }
  // An empty item, or 5+ columns of spaces (indented code in the item):
  // content starts one column after the marker.
  if (i === after.length || spaces >= 5) return col + 1;
  col += spaces;
  return col;
}

// Whether `text` leaves an HTML comment open at its end, starting outside one
// (inside one when `open`). Inline code spans are not scanned.
function commentOpenAfter(text, open) {
  const s = open ? text : text.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, '');
  let i = 0;
  let inside = open;
  for (;;) {
    if (!inside) {
      const j = s.indexOf('<!--', i);
      if (j < 0) return false;
      inside = true;
      i = j + 2; // "<!-->" and "<!--->" close at once
    } else {
      const j = s.indexOf('-->', i);
      if (j < 0) return true;
      inside = false;
      i = j + 3;
    }
  }
}

// The lines of `text` that may carry a declaration, in order.
export function declarationLines(text) {
  const out = [];
  let fence = null; // { ch, len, col } while inside a fenced block
  let comment = false; // inside an HTML comment
  const lists = []; // content columns of the open list items, innermost last
  for (const raw of String(text || '').split(/\r\n|\n|\r/)) {
    const line = normalise(raw);
    const blank = !line.trim();
    const indent = blank ? 0 : line.length - line.trimStart().length;
    if (fence) {
      if (blank || indent >= fence.col) {
        const m = FENCE_CLOSE.exec(line.slice(Math.min(indent, fence.col)));
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
        continue;
      }
      fence = null; // the list item holding the fence ended
    }
    if (comment) {
      comment = commentOpenAfter(line, true);
      continue;
    }
    if (blank) continue;
    while (lists.length && indent < lists[lists.length - 1]) lists.pop();
    const col = lists.length ? lists[lists.length - 1] : 0;
    if (indent - col >= 4) continue; // indented code
    const rel = line.slice(indent);
    if (rel[0] === '>') continue; // a blockquote line
    const f = FENCE_OPEN.exec(rel);
    // A backtick fence's info string may not contain a backtick (CommonMark);
    // such a line is inline code, not a fence.
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      fence = { ch: f[1][0], len: f[1].length, col }; // unclosed: runs to the end
      continue;
    }
    if (rel.startsWith('<!--')) {
      comment = commentOpenAfter(rel, false);
      continue;
    }
    const li = THEMATIC_BREAK.test(rel) ? null : LIST_ITEM.exec(rel);
    if (li) lists.push(listContentColumn(indent, rel, li[1]));
    out.push(line);
    comment = commentOpenAfter(rel, false);
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
