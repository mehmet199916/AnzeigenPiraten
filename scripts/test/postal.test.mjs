import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { postalCodeOf, postalDistance } from '../../assets/postal.mjs';
const { postalCodes } = JSON.parse(await readFile(new URL('../../data/postal-centres.json', import.meta.url), 'utf8'));

test('German postal codes are extracted without losing leading zeroes', () => {
  assert.equal(postalCodeOf('01067 Dresden'), '01067');
  assert.equal(postalCodeOf('86424 Dinkelscherben'), '86424');
  assert.equal(postalCodeOf('Dresden'), null);
  assert.equal(postalCodeOf('123456'), null);
});

test('50 km around 86424 includes Augsburg and excludes Berlin', () => {
  assert.ok(postalDistance(postalCodes, '86424', '86150') < 50);
  assert.ok(postalDistance(postalCodes, '86424', '10115') > 50);
  assert.equal(postalDistance(postalCodes, '86424', '86424'), 0);
});

test('unknown postal codes never become a zero-distance match', () => {
  assert.equal(postalDistance(postalCodes, '86424', null), null);
  assert.equal(postalDistance(postalCodes, '00000', '86150'), null);
  assert.equal(postalDistance({}, '86424', '86150'), null);
});
