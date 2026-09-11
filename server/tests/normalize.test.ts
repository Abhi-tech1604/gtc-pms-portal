import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, rigKey, serialKey } from '../src/excel/normalize.js';

test('rig numbers written differently in the field collapse to one key', () => {
  const variants = ['GTC-50-1', 'GTC 50-01', 'RIG-50-01', 'gtc#50#1', 'Rig 50-01', 'GTC50-01'];
  const keys = new Set(variants.map(rigKey));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(', ')}`);
});

test('different rigs keep different keys', () => {
  assert.notEqual(rigKey('GTC 50-01'), rigKey('GTC 50-02'));
  assert.notEqual(rigKey('GTC 100-01'), rigKey('GTC 1000-01'));
  assert.notEqual(rigKey('GTC 100-08'), rigKey('GTC 100-07'));
});

test('every rig in the seeded fleet has a distinct key', () => {
  const fleet = [
    'GTC 50-01', 'GTC 100-02', 'GTC 150-02', 'GTC 1000-01',
    'GTC 50-02', 'GTC 100-03', 'GTC 160-0', 'GTC 1000-02',
    'GTC 50-03', 'GTC 100-04', 'GTC 200-01', 'GTC 2000-01',
    'GTC 100-01', 'GTC 100-07', 'GTC 250-01', 'GTC 100-08',
  ];
  assert.equal(new Set(fleet.map(rigKey)).size, fleet.length);
});

test('serials ignore punctuation, case and placeholder text', () => {
  assert.equal(serialKey('JSC-08784'), serialKey('jsc08784'));
  assert.equal(serialKey('M/C Sr No: 2901750'), serialKey('2901750'));
  assert.equal(serialKey('NA'), '');
  assert.equal(serialKey('nil'), '');
  assert.equal(serialKey('  '), '');
});

test('machine names ignore spacing and punctuation drift', () => {
  assert.equal(nameKey('Rig Engine 1'), nameKey('rig  engine-1'));
  assert.equal(nameKey('DG set-2 125 kVA'), nameKey('DG SET 2 125 KVA'));
  assert.notEqual(nameKey('Rig Engine 1'), nameKey('Rig Engine 2'));
});
