#!/usr/bin/env node
/**
 * AnzeigenPiraten scanner.
 *
 * Runs inside a scheduled GitHub Actions workflow:
 *   1. crawl the configured Kleinanzeigen searches
 *   2. detect listings without a product classification
 *   3. identify products (never evaluate listing prices)
 *   4. merge everything into data/deals.json + data/meta.json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aiIsConfigured, loadConfig } from './lib/config.mjs';
import { collectListings } from './lib/kleinanzeigen.mjs';
import { classifyListings } from './lib/products.mjs';
import {
  compareProductPrice,
  loadPriceDb,
  prunePriceDb,
  savePriceDb,
  updateProductPriceDb,
} from './lib/prices.mjs';
import { readJson, writeJson } from './lib/store.mjs';
import { log, nowIso, round, truncate } from './lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');

const PATHS = {
  config: process.env.DEALFINDER_CONFIG || path.join(ROOT_DIR, 'config', 'dealfinder.config.json'),
  deals: path.join(DATA_DIR, 'deals.json'),
  meta: path.join(DATA_DIR, 'meta.json'),
  state: path.join(DATA_DIR, 'state.json'),
  prices: path.join(DATA_DIR, 'prices.json'),
};

const STATE_DEFAULT = { version: 1, updatedAt: null, seen: {} };
const DEALS_DEFAULT = { generatedAt: null, count: 0, queries: [], deals: [] };

function parseArgs(argv) {
  const args = { force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
    if (arg === '--local') {
      process.env.AI_BASE_URL = 'http://127.0.0.1:11434/v1';
      process.env.AI_MODEL = 'qwen3:4b';
      process.env.AI_API_KEY = 'ollama';
      // Qwen3's native Ollama endpoint disables thinking for structured output.
      process.env.AI_REASONING_EFFORT = process.env.AI_REASONING_EFFORT || 'none';
    }
  }
  if (process.env.INPUT_FORCE === 'true') args.force = true;
  return args;
}

function isExpired(deal, maxAgeHours, referenceTime) {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) return false;
  const stamp = deal.lastSeenAt || deal.firstSeenAt || deal.postedAt;
  if (!stamp) return false;
  const age = referenceTime - new Date(stamp).getTime();
  return age > maxAgeHours * 60 * 60 * 1000;
}

function pruneSeen(seen, maxEntries) {
  const entries = Object.entries(seen);
  if (entries.length <= maxEntries) return seen;

  entries.sort((a, b) => new Date(b[1]).getTime() - new Date(a[1]).getTime());
  return Object.fromEntries(entries.slice(0, maxEntries));
}

function summariseQueries(deals) {
  const byQuery = new Map();

  for (const deal of deals) {
    const key = deal.queryId || 'unknown';
    if (!byQuery.has(key)) {
      byQuery.set(key, { id: key, label: deal.queryLabel || key, count: 0 });
    }
    byQuery.get(key).count += 1;
  }

  return [...byQuery.values()].sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

async function main() {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const config = await loadConfig(PATHS.config);
  const previous = await readJson(PATHS.deals, DEALS_DEFAULT);
  const state = await readJson(PATHS.state, STATE_DEFAULT);
  const priceDb = await loadPriceDb(PATHS.prices, config.currency);
  state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {};

  const previousDeals = Array.isArray(previous.deals) ? previous.deals : [];
  const previousById = new Map(previousDeals.map((deal) => [String(deal.id), deal]));

  log(`Scanning ${config.searches.length} searches (AI ${aiIsConfigured(config) ? 'enabled' : 'disabled'})…`);

  const { listings, errors: crawlErrors } = await collectListings(config);
  log(`Fetched ${listings.length} unique listings.`);

  // --- classify listings that have no product identity yet -------------------
  const pendingClassification = [];
  const fetchedIds = new Set(listings.map((listing) => String(listing.id)));
  for (const listing of listings) {
    const previousDeal = previousById.get(listing.id);
    const product = previousDeal?.product;
    if (args.force || !product || product.key === 'unknown') pendingClassification.push({ listing });
  }
  // Work through retained feed rows too; a listing can age out of the crawl
  // window before it reaches the model's per-run classification cap.
  for (const previousDeal of previousDeals) {
    if (fetchedIds.has(String(previousDeal.id))) continue;
    if (isExpired(previousDeal, config.output.maxAgeHours, Date.now())) continue;
    if (args.force || !previousDeal.product || previousDeal.product.key === 'unknown') {
      pendingClassification.push({ listing: previousDeal });
    }
  }

  pendingClassification.sort((a, b) => (
    new Date(a.listing.postedAt ?? 0).getTime() - new Date(b.listing.postedAt ?? 0).getTime()
  ));
  const capped = pendingClassification.slice(0, config.ai.maxClassificationsPerRun);
  if (capped.length < pendingClassification.length) {
    log(`Classification cap reached: classifying ${capped.length} of ${pendingClassification.length} listings.`);
  }

  const {
    results: freshClassifications,
    engine,
    aiUsed,
    errors: aiErrors,
  } = await classifyListings({
    items: capped,
    config,
  });

  // --- merge ----------------------------------------------------------------
  const timestamp = nowIso();
  const merged = [];

  for (const listing of listings) {
    const previousDeal = previousById.get(listing.id);
    const product = freshClassifications.get(String(listing.id)) ?? previousDeal?.product ?? {
      key: 'unknown',
      name: 'Unbekanntes Produkt',
      category: listing.queryLabel || 'Unsortiert',
      variant: '',
      confidence: 0,
      engine: 'unclassified',
      classifiedAt: null,
    };

    merged.push({
      ...listing,
      description: truncate(listing.description, 900),
      product,
      firstSeenAt: previousDeal?.firstSeenAt ?? timestamp,
      lastSeenAt: timestamp,
      priceHistory: buildPriceHistory(previousDeal, listing, timestamp),
    });
  }

  // Keep previously stored deals that did not show up in this crawl's result
  // window but are still recent, so the feed does not flicker.
  const mergedIds = new Set(merged.map((deal) => deal.id));
  for (const previousDeal of previousDeals) {
    if (mergedIds.has(String(previousDeal.id))) continue;
    if (isExpired(previousDeal, config.output.maxAgeHours, Date.now())) continue;
    const retainedDeal = { ...previousDeal };
    const freshProduct = freshClassifications.get(String(previousDeal.id));
    if (freshProduct) retainedDeal.product = freshProduct;
    delete retainedDeal.ai;
    delete retainedDeal.heuristic;
    merged.push({ ...retainedDeal, stale: true });
    mergedIds.add(String(previousDeal.id));
  }

  merged.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
  const limitedDeals = merged.slice(0, config.output.maxDeals);

  // Store asking prices by canonical product key and compare each listing only
  // against other listings for the same model/variant.
  updateProductPriceDb(priceDb, limitedDeals, timestamp);
  prunePriceDb(priceDb, {
    maxEntries: config.database.maxEntries,
    maxAgeDays: config.database.maxAgeDays,
  });
  const deals = limitedDeals.map((deal) => ({
    ...deal,
    priceComparison: compareProductPrice(priceDb, deal.product?.key, deal.id, deal.price),
  }));

  // --- persist --------------------------------------------------------------
  for (const deal of merged) {
    if (!state.seen[deal.id]) state.seen[deal.id] = timestamp;
  }
  state.seen = pruneSeen(state.seen, config.state.maxSeenIds);
  state.updatedAt = timestamp;

  const dealsOutput = {
    generatedAt: timestamp,
    engine,
    count: deals.length,
    queries: summariseQueries(deals),
    deals,
  };

  const newDeals = deals.filter((deal) => !previousById.has(deal.id));
  const meta = {
    generatedAt: timestamp,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedMs,
    engine,
    classifierConfigured: aiIsConfigured(config),
    aiUsed,
    searches: config.searches.map((search) => search.label),
    fetchedListings: listings.length,
    previouslyStored: previousDeals.length,
    newDeals: newDeals.length,
    classified: freshClassifications.size,
    totalDeals: deals.length,
    priceDatabase: {
      products: Object.keys(priceDb.products ?? {}).length,
      observations: Object.values(priceDb.products ?? {})
        .reduce((total, product) => total + Object.keys(product.observations ?? {}).length, 0),
      comparableListings: deals.filter((deal) => (
        ['below_observed_range', 'within_observed_range', 'above_observed_range']
          .includes(deal.priceComparison?.status)
      )).length,
    },
    errors: [...crawlErrors, ...aiErrors],
  };

  await writeJson(PATHS.deals, dealsOutput);
  await writeJson(PATHS.meta, meta);
  await writeJson(PATHS.state, state);
  await savePriceDb(PATHS.prices, priceDb);
  log(
    `Done in ${(meta.durationMs / 1000).toFixed(1)}s – ${newDeals.length} new, `
    + `${capped.length} classified (${engine}), `
    + `${deals.length} deals stored.`,
  );

  await writeStepSummary(meta, deals);
}

function buildPriceHistory(previousDeal, listing, timestamp) {
  const history = Array.isArray(previousDeal?.priceHistory) ? [...previousDeal.priceHistory] : [];
  const last = history[history.length - 1];

  if (Number.isFinite(listing.price) && listing.price >= 0) {
    if (!last || last.price !== listing.price) {
      history.push({ price: listing.price, at: timestamp });
    }
  }

  return history.slice(-10);
}

async function writeStepSummary(meta, deals) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const latest = [...deals].slice(0, 10);

  const lines = [
    '## AnzeigenPiraten scan',
    '',
    `- **Classifier:** ${meta.engine}${meta.classifierConfigured ? '' : ' (AI unavailable)'}`,
    `- **Listings fetched:** ${meta.fetchedListings}`,
    `- **New deals:** ${meta.newDeals}`,
    `- **Classified this run:** ${meta.classified}`,
    `- **Products in price DB:** ${meta.priceDatabase.products} (${meta.priceDatabase.observations} observations; ${meta.priceDatabase.comparableListings} comparable listings)`,
    `- **Total deals stored:** ${meta.totalDeals}`,
    `- **Duration:** ${(meta.durationMs / 1000).toFixed(1)}s`,
    '',
    '### Latest product classifications',
    '',
    '| Product | Listing | Asking price |',
    '| --- | --- | --- |',
  ];

  for (const deal of latest) {
    const price = Number.isFinite(deal.price) ? `${round(deal.price, 0)} €` : '–';
    lines.push(`| ${deal.product?.name ?? 'Unbekannt'} | ${String(deal.title).slice(0, 60)} | ${price} |`);
  }

  if (meta.errors.length) {
    lines.push('', '### Warnings', '');
    for (const error of meta.errors.slice(0, 15)) lines.push(`- ${error}`);
  }

  const { appendFile } = await import('node:fs/promises');
  await appendFile(summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
