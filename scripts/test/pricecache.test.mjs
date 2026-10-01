import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { evaluateListings } from '../lib/evaluate.mjs';
import {
  defaultPriceDb,
  hasPriceEntry,
  priceEntryFor,
  priceEntryFromEvaluation,
  setPriceEntry,
} from '../lib/prices.mjs';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function configFor(port) {
  return {
    currency: 'EUR',
    ai: {
      enabled: true,
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      temperature: 0,
      batchSize: 8,
      maxEvaluationsPerRun: 10,
      maxDescriptionChars: 200,
      timeoutMs: 5000,
    },
  };
}

/**
 * Mirrors the exact decision the scanner makes: an article is only offered to
 * the AI when it is not already present in the price database.
 */
function candidatesFor(db, listings) {
  return listings.filter((listing) => !hasPriceEntry(db, listing.id)).map((listing) => ({ listing }));
}

test('each article is sent to the AI only once across two scan runs', async () => {
  let calls = 0;

  const { server, port } = await startMockServer((req, res) => {
    calls += 1;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const payload = JSON.parse(parsed.messages[1].content);
      const evaluations = payload.angebote.map((offer, index) => ({
        index,
        dealScore: 70,
        verdict: 'good',
        fairPrice: 300,
        reasoning: 'ok',
        redFlags: [],
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evaluations }) } }] }));
    });
  });

  const config = configFor(port);
  const listings = [
    { id: 'a', queryId: 'q', queryLabel: 'Q', title: 'A', description: 'x', price: 100, priceRaw: '100 €' },
    { id: 'b', queryId: 'q', queryLabel: 'Q', title: 'B', description: 'x', price: 200, priceRaw: '200 €' },
  ];

  try {
    // --- run 1: empty database -> both articles are evaluated and stored -------
    const db = defaultPriceDb('EUR');
    const run1 = await evaluateListings({
      items: candidatesFor(db, listings),
      marketByQuery: {},
      config,
    });

    assert.equal(calls, 1);
    assert.equal(run1.aiEvaluations.size, 2);

    for (const [id, evaluation] of run1.aiEvaluations) {
      const listing = listings.find((item) => item.id === id);
      setPriceEntry(db, id, priceEntryFromEvaluation(evaluation, listing), '2026-01-01T00:00:00.000Z');
    }
    assert.equal(hasPriceEntry(db, 'a'), true);

    // --- run 2: database populated -> no further AI call -----------------------
    const run2Candidates = candidatesFor(db, listings);
    assert.equal(run2Candidates.length, 0);

    const run2 = await evaluateListings({ items: run2Candidates, marketByQuery: {}, config });
    assert.equal(calls, 1);
    assert.equal(run2.aiEvaluations.size, 0);

    // The verdict now comes straight from the database.
    const cached = priceEntryFor(db, 'a').evaluation;
    assert.equal(cached.dealScore, 70);
    assert.equal(cached.engine, 'ai:mock-model');
    assert.equal(priceEntryFor(db, 'a').fairPrice, 300);
  } finally {
    server.close();
  }
});
