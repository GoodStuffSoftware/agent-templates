// secret-scan.mjs -- standalone extraction of the "secrets gate" scanner
// used before committing a file into a backup store. Scans free-form text
// for patterns that look like leaked credentials.
//
// A match means the caller should exclude that file from the commit and
// report it by LABEL and FILE PATH only -- the matched text itself must
// never be logged, written, or returned from this module.

const SECRET_PATTERNS = [
  ['aws-access-key-id', /\bAKIA[0-9A-Z]{16}\b/],
  ['aws-secret-style', /\baws(.{0,20})?(secret|access)[_-]?key\b.{0,5}[:=]\s*['"]?[A-Za-z0-9/+=]{30,}/i],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai-api-key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['private-key-block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['jwt-like', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['connection-string-cred', /:\/\/[^/\s:@]+:[^/\s@]+@/],
  ['secret-assignment', /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/i],
];

export function scanForSecrets(text) {
  const hits = [];
  for (const [label, matcher] of SECRET_PATTERNS) {
    const isHit = typeof matcher === 'function' ? matcher(text) : matcher.test(text);
    if (isHit) hits.push(label);
  }
  return hits;
}
