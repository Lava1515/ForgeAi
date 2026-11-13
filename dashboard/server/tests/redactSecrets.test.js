import test from 'node:test';
import assert from 'node:assert/strict';
import { redactLogText } from '../routes/redact.js';

test('shared redaction removes common API tokens and PEM private key blocks', () => {
  const input = 'sk-ant-abcdefghijklmnop sk-abcdefghijklmnopqrstuvwxyz ghp_abcdefghijklmnopqrstuvwxyz0123456789\n-----BEGIN RSA PRIVATE KEY-----\nsecret-material\n-----END RSA PRIVATE KEY-----';
  const output = redactLogText(input);
  assert.doesNotMatch(output, /sk-ant-|\bsk-[A-Za-z]|ghp_|secret-material|BEGIN RSA PRIVATE KEY/);
  assert.equal((output.match(/\[redacted\]/g) ?? []).length, 3);
  assert.match(output, /\[redacted private key\]/);
});
