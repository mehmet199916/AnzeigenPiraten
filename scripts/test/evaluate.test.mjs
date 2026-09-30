import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMarketStats,
  heuristicEvaluate,
  parseJsonLoose,
  savingsPct,
  verdictFor,
} from '../lib/evaluate.mjs';

function listing(overrides = {}) {
  return {
    id: '1',
    queryId: 'iphone',
    queryLabel: 'iPhone',
    title: 'iPhone 13',
    description: 'Guter Zustand',
    price: 400,
    priceRaw: '400 €',
    ...overrides,
  };
}

test('buildMarketStats aggregates prices per search', () => {
  const stats = buildMarketStats([
    { queryId: 'iphone', price: 100 },
    { queryId: 'iphone', price: 200 },
    { queryId: 'iphone', price: 300 },
    { queryId: 'iphone', price: 400 },
    { queryId: 'iphone', price: null },
    { queryId: 'macbook', price: 900 },
  ]);

  assert.equal(stats.iphone.count, 4);
  assert.equal(stats.iphone.median, 250);
  assert.equal(stats.iphone.min, 100);
  assert.equal(stats.iphone.max, 400);
  assert.equal(stats.macbook.count, 1);
});

test('verdictFor maps scores onto the four verdict buckets', () => {
  assert.equal(verdictFor(95), 'top');
  assert.equal(verdictFor(85), 'top');
  assert.equal(verdictFor(75), 'good');
  assert.equal(verdictFor(55), 'fair');
  assert.equal(verdictFor(20), 'overpriced');
  assert.equal(verdictFor(null), 'unknown');
});

test('heuristicEvaluate rewards listings far below the market median', () => {
  const market = buildMarketStats([
    { queryId: 'iphone', price: 400 },
    { queryId: 'iphone', price: 450 },
    { queryId: 'iphone', price: 500 },
    { queryId: 'iphone', price: 550 },
  ]);

  const cheap = heuristicEvaluate(listing({ price: 200 }), market);
  assert.ok(cheap.dealScore >= 85, `expected a top score, got ${cheap.dealScore}`);
  assert.equal(cheap.verdict, 'top');
  assert.equal(cheap.fairPrice, 475);
  assert.ok(cheap.savingsPct > 0);
  assert.equal(cheap.engine, 'heuristic');

  const expensive = heuristicEvaluate(listing({ price: 900 }), market);
  assert.ok(expensive.dealScore < 40);
  assert.equal(expensive.verdict, 'overpriced');
});

test('heuristicEvaluate lowers the score for red-flag keywords', () => {
  const market = buildMarketStats([
    { queryId: 'iphone', price: 400 },
    { queryId: 'iphone', price: 450 },
    { queryId: 'iphone', price: 500 },
    { queryId: 'iphone', price: 550 },
  ]);

  const clean = heuristicEvaluate(listing({ price: 300 }), market);
  const broken = heuristicEvaluate(
    listing({ price: 300, title: 'iPhone 13 defekt', description: 'Display kaputt, Bastler' }),
    market,
  );

  assert.ok(broken.dealScore < clean.dealScore);
  assert.ok(broken.redFlags.length >= 2);
});

test('heuristicEvaluate raises the score for bonus keywords', () => {
  const market = buildMarketStats([
    { queryId: 'iphone', price: 400 },
    { queryId: 'iphone', price: 450 },
    { queryId: 'iphone', price: 500 },
    { queryId: 'iphone', price: 550 },
  ]);

  const plain = heuristicEvaluate(listing({ price: 450 }), market);
  const premium = heuristicEvaluate(
    listing({ price: 450, description: 'Neuwertig, Originalverpackung, Rechnung vorhanden' }),
    market,
  );

  assert.ok(premium.dealScore > plain.dealScore);
  assert.ok(premium.highlights.length >= 1);
});

test('heuristicEvaluate handles free listings and missing market data', () => {
  const free = heuristicEvaluate(listing({ price: 0, priceRaw: 'Zu verschenken' }), {});
  assert.equal(free.dealScore, 96);
  assert.equal(free.verdict, 'top');

  const noMarket = heuristicEvaluate(listing({ price: 400 }), {});
  assert.equal(noMarket.fairPrice, null);
  assert.ok(noMarket.dealScore >= 1 && noMarket.dealScore <= 99);
  assert.match(noMarket.reasoning, /Marktvergleich/);
});

test('savingsPct is null when there is no reference price', () => {
  assert.equal(savingsPct(100, 200), 50);
  assert.equal(savingsPct(300, 200), -50);
  assert.equal(savingsPct(100, null), null);
  assert.equal(savingsPct(0, 200), 100);
});

test('parseJsonLoose tolerates markdown fences and surrounding prose', () => {
  const payload = { evaluations: [{ index: 0, dealScore: 90 }] };
  assert.deepEqual(parseJsonLoose(JSON.stringify(payload)), payload);
  assert.deepEqual(parseJsonLoose('```json\n' + JSON.stringify(payload) + '\n```'), payload);
  assert.deepEqual(parseJsonLoose(`Hier: ${JSON.stringify(payload)} fertig`), payload);
  assert.equal(parseJsonLoose('not json at all'), null);
  assert.equal(parseJsonLoose(''), null);
});