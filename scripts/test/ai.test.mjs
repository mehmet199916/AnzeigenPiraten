import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { buildMarketStats, evaluateListings } from '../lib/evaluate.mjs';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function configFor(port, overrides = {}) {
  return {
    currency: 'EUR',
    ai: {
      enabled: true,
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'mock-model',
      temperature: 0,
      batchSize: 2,
      maxEvaluationsPerRun: 10,
      maxDescriptionChars: 200,
      timeoutMs: 5000,
      ...overrides,
    },
  };
}

function sampleListings() {
  return [
    { id: 'a', queryId: 'q', queryLabel: 'Q', title: 'A', description: 'desc', price: 100, priceRaw: '100 €' },
    { id: 'b', queryId: 'q', queryLabel: 'Q', title: 'B', description: 'desc', price: 200, priceRaw: '200 €' },
    { id: 'c', queryId: 'q', queryLabel: 'Q', title: 'C', description: 'desc', price: 300, priceRaw: '300 €' },
  ];
}

const MARKET = buildMarketStats([
  { queryId: 'q', price: 100 },
  { queryId: 'q', price: 200 },
  { queryId: 'q', price: 300 },
  { queryId: 'q', price: 400 },
]);

test('evaluateListings calls the OpenAI-compatible endpoint and maps its verdicts', async () => {
  const requests = [];

  const { server, port } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, parsed });

      const userPayload = JSON.parse(parsed.messages[1].content);
      const evaluations = userPayload.angebote.map((offer, index) => ({
        index,
        dealScore: 90 - index,
        verdict: 'top',
        fairPrice: 500,
        reasoning: 'Sehr günstig für den Zustand.',
        redFlags: [],
      }));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ evaluations }) } }],
      }));
    });
  });

  try {
    const items = sampleListings().map((listing) => ({ listing }));
    const result = await evaluateListings({
      items,
      marketByQuery: MARKET,
      config: configFor(port),
    });

    assert.equal(result.aiUsed, true);
    assert.equal(result.engine, 'ai:mock-model');
    assert.deepEqual(result.errors, []);
    assert.equal(result.results.size, 3);

    const first = result.results.get('a');
    assert.equal(first.dealScore, 90);
    assert.equal(first.verdict, 'top');
    assert.equal(first.fairPrice, 500);
    assert.equal(first.engine, 'ai:mock-model');
    assert.equal(first.savingsPct, 80);
    assert.match(first.reasoning, /günstig/);

    // 3 listings with batchSize 2 => two HTTP calls
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].parsed.model, 'mock-model');
    assert.equal(requests[0].parsed.response_format.type, 'json_object');
    assert.equal(requests[0].parsed.messages.length, 2);

    const sentOffer = JSON.parse(requests[0].parsed.messages[1].content).angebote[0];
    assert.equal(sentOffer.titel, 'A');
    assert.equal(sentOffer.markt.median, 250);
  } finally {
    server.close();
  }
});

test('evaluateListings falls back to the heuristic when the AI endpoint errors', async () => {
  const { server, port } = await startMockServer((req, res) => {
    req.resume();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });

  try {
    const items = sampleListings().map((listing) => ({ listing }));
    const result = await evaluateListings({
      items,
      marketByQuery: MARKET,
      config: configFor(port),
    });

    assert.equal(result.aiUsed, false);
    assert.equal(result.engine, 'heuristic');
    assert.equal(result.results.size, 3);
    assert.ok(result.errors.length >= 1);

    for (const evaluation of result.results.values()) {
      assert.equal(evaluation.engine, 'heuristic');
      assert.ok(evaluation.dealScore >= 1 && evaluation.dealScore <= 99);
    }
  } finally {
    server.close();
  }
});

test('evaluateListings tolerates AI output wrapped in markdown fences', async () => {
  const { server, port } = await startMockServer((req, res) => {
    req.resume();
    const content = '```json\n{"evaluations":[{"index":0,"dealScore":77,"verdict":"good","fairPrice":150,"reasoning":"ok","redFlags":[]}]}\n```';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });

  try {
    const result = await evaluateListings({
      items: [{ listing: sampleListings()[0] }],
      marketByQuery: MARKET,
      config: configFor(port, { batchSize: 5 }),
    });

    assert.equal(result.results.get('a').dealScore, 77);
    assert.equal(result.results.get('a').verdict, 'good');
  } finally {
    server.close();
  }
});

test('evaluateListings skips the AI entirely when no API key is configured', async () => {
  let called = false;
  const { server, port } = await startMockServer((req, res) => {
    called = true;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  try {
    const config = configFor(port, { apiKey: '' });
    const result = await evaluateListings({
      items: [{ listing: sampleListings()[0] }],
      marketByQuery: MARKET,
      config,
    });

    assert.equal(called, false);
    assert.equal(result.engine, 'heuristic');
    assert.equal(result.results.get('a').engine, 'heuristic');
  } finally {
    server.close();
  }
});