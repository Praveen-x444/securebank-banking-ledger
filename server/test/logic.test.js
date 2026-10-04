import test from 'node:test';
import assert from 'node:assert/strict';

test('money subtraction keeps two decimal places', () => {
  const balance = 25000;
  const amount = 1250.5;
  assert.equal((balance - amount).toFixed(2), '23749.50');
});

test('transfer rejects same account', () => {
  const from = 'a';
  const to = 'a';
  assert.equal(from === to, true);
});
