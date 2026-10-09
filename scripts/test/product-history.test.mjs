import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProductPrice, syncProductCatalog } from '../lib/product-catalog.mjs';
import {
  defaultPriceDb,
  productHistoryPointCount,
  prunePriceDb,
  recordProductPriceHistory,
  refreshProductStats,
  updateProductPriceDb,
} from '../lib/prices.mjs';

function listing(id, price, productKey = 'apple-iphone-13') {
  return {
    id: String(id),
    title: `Listing ${id}`,
    price,
    product: { key: productKey, name: 'Apple iPhone 13', category: 'Smartphones' },
  };
}

test('price history appends per listing and never repeats an unchanged price', () => {
  const db = defaultPriceDb('EUR');

  recordProductPriceHistory(db, [listing('1', 400)], '2026-01-01T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('1', 400)], '2026-01-02T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('1', 380)], '2026-01-03T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('2', 500)], '2026-01-03T00:00:00.000Z');

  const history = db.products['apple-iphone-13'].history;
  assert.deepEqual(history['1'].map((point) => point.price), [400, 380]);
  assert.equal(history['1'][0].at, '2026-01-01T00:00:00.000Z');
  assert.equal(history['1'][1].at, '2026-01-03T00:00:00.000Z');
  assert.deepEqual(history['2'].map((point) => point.price), [500]);
  assert.equal(productHistoryPointCount(db), 3);
});

test('history is seeded once from observations recorded before history existed', () => {
  const db = defaultPriceDb('EUR');
  updateProductPriceDb(db, [listing('9', 250)], '2026-01-05T00:00:00.000Z');
  assert.equal(db.products['apple-iphone-13'].history, undefined);

  // No current listings in this run: the backfill still preserves the data.
  recordProductPriceHistory(db, [], '2026-01-06T00:00:00.000Z');
  assert.deepEqual(db.products['apple-iphone-13'].history['9'], [
    { price: 250, at: '2026-01-05T00:00:00.000Z' },
  ]);
});

test('products keep their history when observation pruning empties the window', () => {
  const db = defaultPriceDb('EUR');
  const stale = '2026-01-01T00:00:00.000Z';
  updateProductPriceDb(db, [listing('1', 400)], stale);
  recordProductPriceHistory(db, [listing('1', 400)], stale);

  // Observations older than the window are dropped; the history is not.
  prunePriceDb(db, { maxAgeDays: 30, now: new Date('2026-06-01T00:00:00.000Z').getTime() });

  const product = db.products['apple-iphone-13'];
  assert.ok(product, 'product must survive with history only');
  assert.deepEqual(product.observations, {});
  assert.equal(product.history['1'].length, 1);
});

test('products without history are still removed when the window empties', () => {
  const db = defaultPriceDb('EUR');
  updateProductPriceDb(db, [listing('1', 400)], '2026-01-01T00:00:00.000Z');

  prunePriceDb(db, { maxAgeDays: 30, now: new Date('2026-06-01T00:00:00.000Z').getTime() });
  assert.equal(db.products['apple-iphone-13'], undefined);
});

test('history moves with the listing when its product classification changes', () => {
  const db = defaultPriceDb('EUR');
  recordProductPriceHistory(db, [listing('1', 400, 'apple-iphone-13')], '2026-01-01T00:00:00.000Z');

  updateProductPriceDb(db, [listing('1', 420, 'apple-iphone-14')], '2026-01-02T00:00:00.000Z');

  assert.equal(db.products['apple-iphone-13'], undefined);
  assert.deepEqual(db.products['apple-iphone-14'].history['1'], [
    { price: 400, at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(db.products['apple-iphone-14'].observations['1'].askingPrice, 420);
});

test('prunePriceDb can cap history points per listing when configured', () => {
  const db = defaultPriceDb('EUR');
  recordProductPriceHistory(db, [listing('1', 100)], '2026-01-01T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('1', 200)], '2026-01-02T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('1', 300)], '2026-01-03T00:00:00.000Z');

  prunePriceDb(db, { maxHistoryPointsPerListing: 2 });
  assert.deepEqual(db.products['apple-iphone-13'].history['1'].map((point) => point.price), [200, 300]);
});

test('stats.average is computed from all collected price points', () => {
  const db = defaultPriceDb('EUR');
  recordProductPriceHistory(db, [listing('1', 400)], '2026-01-01T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('1', 420)], '2026-01-02T00:00:00.000Z');
  recordProductPriceHistory(db, [listing('2', 500)], '2026-01-02T00:00:00.000Z');

  refreshProductStats(db, '2026-01-03T00:00:00.000Z');

  const stats = db.products['apple-iphone-13'].stats;
  assert.equal(stats.count, 3);
  assert.equal(stats.listings, 2);
  assert.equal(stats.average, 440);
  assert.equal(stats.min, 400);
  assert.equal(stats.max, 500);
  assert.equal(stats.updatedAt, '2026-01-03T00:00:00.000Z');
});

test('the observed average becomes the reference when no manual price is set', () => {
  const catalog = { version: 1, currency: 'EUR', updatedAt: null, products: {} };
  syncProductCatalog(catalog, [listing('1', 400)], '2026-01-01T00:00:00.000Z');
  assert.equal(catalog.products['apple-iphone-13'].referencePrice, null);

  const check = checkProductPrice(catalog, 'apple-iphone-13', 400, { average: 440, count: 3 });
  assert.equal(check.status, 'good_price');
  assert.equal(check.referenceSource, 'average');
  assert.equal(check.referencePrice, 440);
  assert.equal(check.observedCount, 3);
  assert.equal(check.difference, 40);
});

test('a manual reference price always wins over the observed average', () => {
  const catalog = {
    products: {
      'apple-iphone-13': { name: 'Apple iPhone 13', referencePrice: 500, updatedAt: null },
    },
  };

  const check = checkProductPrice(catalog, 'apple-iphone-13', 600, { average: 440, count: 3 });
  assert.equal(check.status, 'above_reference_price');
  assert.equal(check.referenceSource, 'manual');
  assert.equal(check.referencePrice, 500);
});

test('the average reference requires the configured number of samples', () => {
  const catalog = {
    products: {
      'apple-iphone-13': { name: 'Apple iPhone 13', referencePrice: null },
    },
  };

  const missing = checkProductPrice(catalog, 'apple-iphone-13', 400, { average: 440, count: 1 }, 3);
  assert.equal(missing.status, 'reference_price_missing');
  assert.equal(missing.observedCount, 1);

  const none = checkProductPrice(catalog, 'apple-iphone-13', 400, null);
  assert.equal(none.status, 'reference_price_missing');
});