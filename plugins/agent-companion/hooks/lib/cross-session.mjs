// A message from another Claude session reaches a session as a user turn. The
// harness writes it as
//   Another Claude session sent a message:\n<cross-session-message from="..." name="...">\n...
// Named agents arrive as <agent-message from="name">, and a teammate relay uses
// <teammate-message teammate_id="...">. None of these is typed by the operator, so
// no hook may score one as an operator prompt or harvest directives from it.
// Pure string work, no I/O.

const LEAD_IN = 'Another Claude session sent a message';
export const TAGS = ['cross-session-message', 'agent-message', 'teammate-message'];
const OPEN = new RegExp(`<(${TAGS.join('|')})\\b`);
const OPEN_TAG = new RegExp(`<(?:${TAGS.join('|')})\\b([^>]*)>`, 'g');
const ATTR = /\b(from|name|from-name|from-session|teammate_id)="([^"]*)"/g;

// True when `text` is, or starts with, a cross-session message. Also true when
// the wrapper tag opens within the first 200 characters (a relay may prepend a line).
export function isCrossSessionMessage(text) {
  const t = String(text ?? '').trimStart();
  if (!t) return false;
  if (t.startsWith(LEAD_IN)) return true;
  return OPEN.test(t.slice(0, 200));
}

// Strict form for trusting a sender: the turn BEGINS with the lead-in or a wrapper tag.
export function startsWithCrossSessionMessage(text) {
  const t = String(text ?? '').trimStart();
  return t.startsWith(LEAD_IN) || new RegExp(`^<(${TAGS.join('|')})\\b`).test(t);
}

// True when any of the wrapper tags appears anywhere in `text`.
export function mentionsCrossSessionTag(text) {
  return OPEN.test(String(text ?? ''));
}

// Names a reply may be addressed to: the from, name, from-name, from-session and
// teammate_id attributes of every wrapper opening tag.
export function crossSessionSenders(text) {
  const out = [];
  for (const tag of String(text ?? '').matchAll(OPEN_TAG)) {
    for (const a of tag[1].matchAll(ATTR)) if (a[2]) out.push(a[2]);
  }
  return [...new Set(out)];
}
