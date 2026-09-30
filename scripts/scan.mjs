#!/usr/bin/env node
/**
 * AnzeigenPiraten scanner.
 *
 * Runs inside a scheduled GitHub Actions workflow:
 *   1. crawl the configured Kleinanzeigen searches
 *   2. detect listings we have never seen (or whose price changed)
 *   3. evaluate those with AI (heuristic fallback if no API key is present)
 *   4. merge everything into data/deals.json + data/meta.json
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aiIsConfigured, loadConfig } from './lib/config.mjs';
import { collectListings } from './lib/kleinanzeigen.mjs';
import { buildMarketStats, evaluateListings } from './lib/evaluate.mjs';
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
};

const STATE_DEFAULT = { version: 1, updatedAt: null, seen: {} };
const DEALS_DEFAULT = { generatedAt: null, count: 0, queries: [], deals: [] };

function parseArgs(argv) {
  const args = { force: false };
  for (const arg of argv) {
    if (arg === '--force') args.force = true;
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

function summariseQueries(deals, stats) {
  const byQuery = new Map();

  for (const deal of deals) {
    const key = deal.queryId || 'unknown';
    if (!byQuery.has(key)) {
      byQuery.set(key, { id: key, label: deal.queryLabel || key, count: 0 });
    }
    byQuery.get(key).count += 1;
  }

  return [...byQuery.values()]
    .map((query) => ({
      ...query,
      medianPrice: stats[query.id]?.median ?? null,
      marketCount: stats[query.id]?.count ?? 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'de'));
}

async function main() {
  const startedAt = nowIso();
  const startedMs = Date.now();
  const args = parseArgs(process.argv.slice(2));

  const config = await loadConfig(PATHS.config);
  const previous = await readJson(PATHS.deals, DEALS_DEFAULT);
  const state = await readJson(PATHS.state, STATE_DEFAULT);

  state.seen = state.seen && typeof state.seen === 'object' ? state.seen : {};

  const previousDeals = Array.isArray(previous.deals) ? previous.deals : [];
  const previousById = new Map(previousDeals.map((deal) => [String(deal.id), deal]));

  log(`Scanning ${config.searches.length} searches (AI ${aiIsConfigured(config) ? 'enabled' : 'disabled'})…`);

  const { listings, errors: crawlErrors } = await collectListings(config);
  log(`Fetched ${listings.length} unique listings.`);

  // --- decide what needs an AI/heuristic evaluation ---------------------------
  const pendingEvaluation = [];
  for (const listing of listings) {
    const previousDeal = previousById.get(listing.id);
    const alreadySeen = Boolean(state.seen[listing.id]);
    const priceChanged = Boolean(
      previousDeal
      && previousDeal.price != null
      && listing.price != null
      && previousDeal.price !== listing.price,
    );

    if (args.force) {
      pendingEvaluation.push({ listing, isNew: !previousDeal, priceChanged });
    } else if (!previousDeal && !alreadySeen) {
      pendingEvaluation.push({ listing, isNew: true, priceChanged: false });
    } else if (priceChanged && config.scoring.recalculateOnPriceChange) {
      pendingEvaluation.push({ listing, isNew: false, priceChanged: true });
    }
  }

  // Brand-new listings beat price updates, then freshest first, so a tight
  // evaluation budget always covers the most interesting ads and no never-seen
  // listing can be starved by a backlog of price changes.
  pendingEvaluation.sort((a, b) => {
    if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    return new Date(b.listing.postedAt ?? 0).getTime() - new Date(a.listing.postedAt ?? 0).getTime();
  });

  const capped = pendingEvaluation.slice(0, config.ai.maxEvaluationsPerRun);
  if (capped.length < pendingEvaluation.length) {
    log(`Evaluation cap reached: evaluating ${capped.length} of ${pendingEvaluation.length} candidates.`);
  }

  // --- market context ---------------------------------------------------------
  const statsSource = [
    ...listings,
    ...previousDeals
      .filter((deal) => !listings.some((listing) => listing.id === String(deal.id)))
      .map((deal) => ({ queryId: deal.queryId, price: deal.price })),
  ];
  const marketByQuery = buildMarketStats(statsSource);

  const { results: evaluations, engine, aiUsed, errors: aiErrors } = await evaluateListings({
    items: capped,
    marketByQuery,
    config,
  });

  // --- merge ----------------------------------------------------------------
  const timestamp = nowIso();
  const merged = [];

  for (const listing of listings) {
    const previousDeal = previousById.get(listing.id);
    const evaluation = evaluations.get(listing.id);

    if (!previousDeal && !evaluation) continue; // brand-new but not evaluated this run
    if (!previousDeal && state.seen[listing.id]) continue; // already processed & pruned earlier

    const ai = evaluation ?? previousDeal?.ai ?? null;
    if (config.scoring.minScoreToKeep > 0 && ai?.dealScore != null
      && ai.dealScore < config.scoring.minScoreToKeep) {
      continue;
    }

    merged.push({
      ...listing,
      description: truncate(listing.description, 900),
      ai,
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
    merged.push({ ...previousDeal, stale: true });
    mergedIds.add(String(previousDeal.id));
  }

  merged.sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
  const deals = merged.slice(0, config.output.maxDeals);

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
    queries: summariseQueries(deals, marketByQuery),
    market: marketByQuery,
    deals,
  };

  const newDeals = deals.filter((deal) => !previousById.has(deal.id));
  const meta = {
    generatedAt: timestamp,
    startedAt,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedMs,
    engine,
    aiConfigured: aiIsConfigured(config),
    aiUsed,
    searches: config.searches.map((search) => search.label),
    fetchedListings: listings.length,
    previouslyStored: previousDeals.length,
    newDeals: newDeals.length,
    evaluated: capped.length,
    totalDeals: deals.length,
    market: marketByQuery,
    errors: [...crawlErrors, ...aiErrors],
  };

  await writeJson(PATHS.deals, dealsOutput);
  await writeJson(PATHS.meta, meta);
  await writeJson(PATHS.state, state);

  log(
    `Done in ${(meta.durationMs / 1000).toFixed(1)}s – ${newDeals.length} new, `
    + `${capped.length} evaluated (${engine}), ${deals.length} deals stored.`,
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

  const top = [...deals]
    .filter((deal) => deal.ai?.dealScore != null)
    .sort((a, b) => b.ai.dealScore - a.ai.dealScore)
    .slice(0, 10);

  const lines = [
    '## AnzeigenPiraten scan',
    '',
    `- **Engine:** ${meta.engine}${meta.aiConfigured ? '' : ' (no API key – heuristic only)'}`,
    `- **Listings fetched:** ${meta.fetchedListings}`,
    `- **New deals:** ${meta.newDeals}`,
    `- **Evaluated this run:** ${meta.evaluated}`,
    `- **Total deals stored:** ${meta.totalDeals}`,
    `- **Duration:** ${(meta.durationMs / 1000).toFixed(1)}s`,
    '',
    '### Top picks',
    '',
    '| Score | Title | Price | Fair |',
    '| --- | --- | --- | --- |',
  ];

  for (const deal of top) {
    const price = Number.isFinite(deal.price) ? `${round(deal.price, 0)} €` : '–';
    const fair = Number.isFinite(deal.ai.fairPrice) ? `${round(deal.ai.fairPrice, 0)} €` : '–';
    lines.push(`| ${deal.ai.dealScore} | ${String(deal.title).slice(0, 60)} | ${price} | ${fair} |`);
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