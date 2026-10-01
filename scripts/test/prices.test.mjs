import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  defaultPriceDb,
  hasPriceEntry,
  loadPriceDb,
  priceEntryCount,
  priceEntryFor,
  priceEntryFromEvaluation,
  prunePriceDb,
  savePriceDb,
  setPriceEntry,
} from '../lib/prices.mjs';

function evaluation(overrides = {}) {
  return {
    dealScore: 88,
    verdict: 'top',
    fairPrice: 820,
    savingsPct: 19,
    reasoning: 'günstig',
    redFlags: [],
    highlights: [],
    engine: 'ai:gpt-4o-mini',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'ap-prices-'));
}

test('loadPriceDb returns an empty database when the file does not exist', async () => {
  const dir = await tempDir();
  try {
    const db = await loadPriceDb(path.join(dir, 'prices.json'));
    assert.deepEqual(db.entries, {});
    assert.equal(db.version, 1);
    assert.equal(db.currency, 'EUR');
    assert.equal(priceEntryCount(db), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('setPriceEntry stores the AI price and save/load persists it', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'prices.json');
    const db = defaultPriceDb('EUR');
    const entry = priceEntryFromEvaluation(evaluation(), { id: '42', price: 700 });

    setPriceEntry(db, '42', entry, '2026-02-02T10:00:00.000Z');

    assert.equal(hasPriceEntry(db, '42'), true);
    assert.equal(hasPriceEntry(db, '99'), false);
    assert.equal(priceEntryCount(db), 1);
    assert.equal(db.updatedAt, '2026-02-02T10:00:00.000Z');

    await savePriceDb(file, db);
    const reloaded = await loadPriceDb(file);
    const stored = priceEntryFor(reloaded, 42); // numeric id works too
    assert.equal(stored.fairPrice, 820);
    assert.equal(stored.engine, 'ai:gpt-4o-mini');
    assert.equal(stored.evaluation.dealScore, 88);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('priceEntryFromEvaluation keeps the AI fair price and the asking price', () => {
  const entry = priceEntryFromEvaluation(evaluation({ fairPrice: 250 }), { price: 199 });
  assert.equal(entry.fairPrice, 250);
  assert.equal(entry.askingPrice, 199);
  assert.equal(entry.verdict, 'top');

  const noPrice = priceEntryFromEvaluation(evaluation({ fairPrice: null }), { price: null });
  assert.equal(noPrice.fairPrice, null);
  assert.equal(noPrice.askingPrice, null);

  assert.equal(priceEntryFromEvaluation(null, { price: 10 }), null);
});

test('prunePriceDb drops the oldest entries beyond maxEntries', () => {
  const db = defaultPriceDb('EUR');
  setPriceEntry(db, 'a', priceEntryFromEvaluation(evaluation({ evaluatedAt: '2026-01-01T00:00:00.000Z' }), { price: 1 }));
  setPriceEntry(db, 'b', priceEntryFromEvaluation(evaluation({ evaluatedAt: '2026-02-01T00:00:00.000Z' }), { price: 2 }));
  setPriceEntry(db, 'c', priceEntryFromEvaluation(evaluation({ evaluatedAt: '2026-03-01T00:00:00.000Z' }), { price: 3 }));

  prunePriceDb(db, { maxEntries: 2 });
  assert.deepEqual(Object.keys(db.entries).sort(), ['b', 'c']);
});

test('prunePriceDb removes stale entries by age', () => {
  const db = defaultPriceDb('EUR');
  const now = new Date('2026-06-01T00:00:00.000Z').getTime();
  setPriceEntry(db, 'old', priceEntryFromEvaluation(evaluation({ evaluatedAt: '2026-01-01T00:00:00.000Z' }), { price: 1 }));
  setPriceEntry(db, 'recent', priceEntryFromEvaluation(evaluation({ evaluatedAt: '2026-05-30T00:00:00.000Z' }), { price: 2 }));

  prunePriceDb(db, { maxAgeDays: 30, now });
  assert.deepEqual(Object.keys(db.entries), ['recent']);
});
