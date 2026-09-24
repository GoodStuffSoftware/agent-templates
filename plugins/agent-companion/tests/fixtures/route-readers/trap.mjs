// Preload for the runtime reader check (scan.mjs): `node --import <this>`.
//
// Wraps JSON.parse so that every parsed object carrying `taskTypes` has each
// `taskTypes.<type>.override` replaced by an enumerable accessor. Reading it
// — by name, computed key, destructuring, Reflect.get, Object.entries, a
// spread or JSON.stringify — appends the reading frame to the file named by
// AC_OVERRIDE_TRAP_LOG. The value itself is unchanged, so the script behaves
// exactly as it would without the trap. An `armed` row records that a config
// was wrapped at all, so a run that never loaded one cannot pass silently.
import { appendFileSync } from 'node:fs';

const LOG = process.env.AC_OVERRIDE_TRAP_LOG;
const SELF = import.meta.url;
const realParse = JSON.parse;

function readerFrame() {
  const lines = String(new Error().stack || '').split('\n').slice(1);
  for (const raw of lines) {
    const l = raw.trim();
    if (l.includes(SELF)) continue;
    const m = /^at (?:(.*?) \()?(file:\/\/.+?):(\d+):(\d+)\)?$/.exec(l);
    if (!m) continue; // a native frame (Object.entries, JSON.stringify, ...)
    return { fn: m[1] || '<top-level>', file: m[2], line: Number(m[3]) };
  }
  return { fn: '<unknown>', file: '', line: 0 };
}

function log(row) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify(row) + '\n'); } catch { /* never break the script */ }
}

JSON.parse = function parse(text, reviver) {
  const v = realParse.call(this, text, reviver);
  const types = v && typeof v === 'object' ? v.taskTypes : null;
  if (types && typeof types === 'object') {
    let wrapped = 0;
    for (const [name, t] of Object.entries(types)) {
      if (!t || typeof t !== 'object' || !Object.prototype.hasOwnProperty.call(t, 'override')) continue;
      let value = t.override;
      Object.defineProperty(t, 'override', {
        enumerable: true,
        configurable: true,
        get() { log({ type: name, ...readerFrame() }); return value; },
        set(x) { value = x; },
      });
      wrapped += 1;
    }
    if (wrapped) log({ armed: true, wrapped });
  }
  return v;
};
