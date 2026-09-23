import test from 'node:test';
import assert from 'node:assert/strict';
import { scanForSecrets } from '../src/secret-scan.mjs';

// --- pre-existing suite: must still pass ---
test('a real-shaped anthropic key still flags anthropic-api-key', () => {
  const text = 'ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(30);
  assert.ok(scanForSecrets(text).includes('anthropic-api-key'));
});

test('plain prose with no secret shapes flags nothing', () => {
  assert.deepEqual(scanForSecrets('This is just a note about deployment steps.'), []);
});

// --- new tests from the fix: private-key-block false positive ---

test('a PEM header quoted in prose (single line, no END marker, no body) does not flag private-key-block', () => {
  const text = 'A clap-based CLI rejects a positional value beginning with `-`; for '
    + 'example, passing `-----BEGIN PRIVATE KEY-----` as a bare argument is parsed '
    + 'as an unknown flag rather than a value.';
  assert.ok(!scanForSecrets(text).includes('private-key-block'));
});

test('a PEM header inside an SDK call signature with an elided body does not flag private-key-block', () => {
  const text = 'client = RESTClient(api_key="...", api_secret="-----BEGIN EC PRIVATE KEY-----\n...")';
  assert.ok(!scanForSecrets(text).includes('private-key-block'));
});

test('a fabricated, real-shaped PEM block (BEGIN + multi-line base64 body + END) still flags private-key-block', () => {
  const fakeLine = 'X'.repeat(64);
  const text = `Rotated the deploy key:\n-----BEGIN RSA PRIVATE KEY-----\n${fakeLine}\n${fakeLine}\n-----END RSA PRIVATE KEY-----\n`;
  assert.ok(scanForSecrets(text).includes('private-key-block'));
});

test('a mismatched BEGIN/END key type with a plausible body does not flag (not a valid PEM block)', () => {
  const fakeLine = 'Y'.repeat(64);
  const text = `-----BEGIN RSA PRIVATE KEY-----\n${fakeLine}\n${fakeLine}\n-----END EC PRIVATE KEY-----\n`;
  assert.ok(!scanForSecrets(text).includes('private-key-block'));
});

// --- new tests from the fix: AWS documented example credential ---

test("AWS's own canonical example access key id does not flag aws-access-key-id", () => {
  const text = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE  # from the SigV4 docs, not a real key';
  assert.ok(!scanForSecrets(text).includes('aws-access-key-id'));
});

test("AWS's own canonical example secret access key does not flag aws-secret-style", () => {
  const text = 'aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
  assert.ok(!scanForSecrets(text).includes('aws-secret-style'));
});

test('an AKIA-shaped key that is NOT the documented example still flags aws-access-key-id', () => {
  const text = 'export AWS_ACCESS_KEY_ID=AKIAZZZZZZZZZZZZZZZZ';
  assert.ok(scanForSecrets(text).includes('aws-access-key-id'));
});

test('an aws-secret-key-shaped value that is NOT the documented example still flags aws-secret-style', () => {
  const text = `aws_secret_access_key: "${'z'.repeat(40)}"`;
  assert.ok(scanForSecrets(text).includes('aws-secret-style'));
});
