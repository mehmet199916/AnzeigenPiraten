import test from 'node:test';
import assert from 'node:assert/strict';
import { dealDifference, meetsDealDifference, sortByDealDifference } from '../../assets/deal-differences.mjs';

const deal = (id, difference, referencePrice = 500, differencePct) => ({
  id,
  referencePriceCheck: difference === null ? null : { difference, referencePrice, differencePct },
});

test('calculates percentages from reference value when no rounded percentage exists', () => {
  assert.equal(dealDifference(deal('a', 125, 500), 'pct'), 25);
  assert.equal(dealDifference(deal('b', 80, 500, 15.9), 'pct'), 15.9);
});

test('sorts largest positive savings first and missing references last', () => {
  const input = [deal('small', 20), deal('missing', null), deal('large', 100), deal('overpriced', -40)];
  assert.deepEqual(sortByDealDifference(input, 'eur').map(({ id }) => id), ['large', 'small', 'overpriced', 'missing']);
  assert.deepEqual(sortByDealDifference([deal('a', 100, 500), deal('b', 80, 200)], 'pct').map(({ id }) => id), ['b', 'a']);
});

test('filters by a minimum amount and excludes missing or invalid references', () => {
  assert.equal(meetsDealDifference(deal('ok', 20, 100), 'pct', 15), true);
  assert.equal(meetsDealDifference(deal('small', 20, 100), 'eur', 25), false);
  assert.equal(meetsDealDifference(deal('missing', null), 'eur', 0), false);
  assert.equal(dealDifference(deal('zero', 5, 0), 'pct'), null);
});
