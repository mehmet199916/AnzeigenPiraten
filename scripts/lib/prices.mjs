/**
 * Persistent price database.
 *
 * A tiny JSON-backed "database" (no external service, in keeping with the
 * dependency-free, static architecture of this project) that stores the
 * AI-evaluated fair price for every article the scanner has ever seen.
 *
 * Because the file lives in `data/` and is committed alongside the rest of the
 * feed, an article is only ever sent to the AI once: every later run reuses the
 * stored evaluation ("only evaluate what is not in the DB yet").
 */

import { readJson, writeJson } from './store.mjs';
import { median, quantile, round } from './util.mjs';

export const PRICE_DB_VERSION = 1;

/** Empty database skeleton. */
export function defaultPriceDb(currency = 'EUR') {
  return {
    version: PRICE_DB_VERSION,
    updatedAt: null,
    currency,
    entries: {},
    products: {},
    listingIndex: {},
  };
}

/**
 * Loads the price database, tolerating a missing or malformed file.
 *
 * @param {string} filePath absolute path to `data/prices.json`
 * @param {string} [currency]
 */
export async function loadPriceDb(filePath, currency = 'EUR') {
  const parsed = await readJson(filePath, defaultPriceDb(currency));
  return {
    ...defaultPriceDb(currency),
    ...(parsed ?? {}),
    entries: parsed && typeof parsed.entries === 'object' && parsed.entries
      ? parsed.entries
      : {},
    products: parsed && typeof parsed.products === 'object' && parsed.products
      ? parsed.products
      : {},
    listingIndex: parsed && typeof parsed.listingIndex === 'object' && parsed.listingIndex
      ? parsed.listingIndex
      : {},
  };
}

/** Returns the stored entry for a listing id, or null. */
export function priceEntryFor(db, id) {
  if (!db?.entries) return null;
  return db.entries[String(id)] ?? null;
}

/** Whether the database already holds an evaluation for a listing id. */
export function hasPriceEntry(db, id) {
  return Boolean(priceEntryFor(db, id));
}

/** Number of stored entries. */
export function priceEntryCount(db) {
  return db?.entries ? Object.keys(db.entries).length : 0;
}

/**
 * Builds a database entry from an AI evaluation plus the listing it came from.
 * Returns null when there is nothing worth storing.
 */
export function priceEntryFromEvaluation(evaluation, listing) {
  if (!evaluation) return null;

  return {
    // The AI-evaluated fair market value – this is "the price of the article".
    fairPrice: Number.isFinite(evaluation.fairPrice) ? evaluation.fairPrice : null,
    // The asking price that was evaluated (kept for reference / audits).
    askingPrice: Number.isFinite(listing?.price) ? listing.price : null,
    dealScore: evaluation.dealScore ?? null,
    verdict: evaluation.verdict ?? null,
    engine: evaluation.engine ?? null,
    evaluatedAt: evaluation.evaluatedAt ?? new Date().toISOString(),
    evaluation,
  };
}

/** Writes an entry (upsert) into the database. */
export function setPriceEntry(db, id, entry, timestamp = new Date().toISOString()) {
  if (!entry) return db;
  db.entries[String(id)] = entry;
  db.updatedAt = timestamp;
  return db;
}

/**
 * Caps the database size so the committed file cannot grow without bound.
 * Oldest entries (by evaluation time) are dropped first.
 *
 * @param {object} db
 * @param {{ maxEntries?: number, maxAgeDays?: number, now?: number }} [options]
 */
export function prunePriceDb(db, { maxEntries = 0, maxAgeDays = 0, now = Date.now() } = {}) {
  if (!db?.entries) return db;

  let entries = Object.entries(db.entries);
  const stampOf = (entry) => new Date(entry?.evaluatedAt ?? 0).getTime();

  if (maxAgeDays > 0) {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    entries = entries.filter(([, entry]) => {
      const stamp = stampOf(entry);
      return Number.isNaN(stamp) || stamp >= cutoff;
    });
  }

  if (maxEntries > 0 && entries.length > maxEntries) {
    entries.sort((a, b) => stampOf(b[1]) - stampOf(a[1]));
    entries = entries.slice(0, maxEntries);
  }

  db.entries = Object.fromEntries(entries);

  const cutoff = maxAgeDays > 0 ? now - maxAgeDays * 24 * 60 * 60 * 1000 : -Infinity;
  const allObservations = [];
  for (const [productKey, product] of Object.entries(db.products ?? {})) {
    for (const [id, observation] of Object.entries(product.observations ?? {})) {
      const stamp = new Date(observation.lastSeenAt ?? 0).getTime();
      if (stamp < cutoff && !Number.isNaN(stamp)) {
        delete product.observations[id];
        delete db.listingIndex[id];
        continue;
      }
      allObservations.push({ productKey, id, stamp });
    }
    if (!Object.keys(product.observations ?? {}).length) delete db.products[productKey];
  }

  if (maxEntries > 0 && allObservations.length > maxEntries) {
    allObservations.sort((a, b) => b.stamp - a.stamp);
    for (const { productKey, id } of allObservations.slice(maxEntries)) {
      delete db.products[productKey]?.observations?.[id];
      delete db.listingIndex[id];
    }
    for (const [key, product] of Object.entries(db.products)) {
      if (!Object.keys(product.observations ?? {}).length) delete db.products[key];
    }
  }
  return db;
}

/** Upserts asking-price observations under each listing's canonical product. */
export function updateProductPriceDb(db, listings, timestamp = new Date().toISOString()) {
  db.products ??= {};
  db.listingIndex ??= {};
  for (const listing of listings) {
    const id = String(listing.id);
    const productKey = listing.product?.key;
    if (!productKey || productKey === 'unknown' || !Number.isFinite(listing.price) || listing.price <= 0) continue;

    const previousKey = db.listingIndex[id];
    if (previousKey && previousKey !== productKey) {
      delete db.products[previousKey]?.observations?.[id];
      if (!Object.keys(db.products[previousKey]?.observations ?? {}).length) delete db.products[previousKey];
    }

    const product = db.products[productKey] ?? {
      key: productKey,
      name: listing.product.name,
      category: listing.product.category,
      observations: {},
    };
    product.name = listing.product.name;
    product.category = listing.product.category;
    product.observations ??= {};
    product.observations[id] = {
      listingId: id,
      askingPrice: listing.price,
      title: String(listing.title ?? '').slice(0, 180),
      lastSeenAt: listing.lastSeenAt ?? timestamp,
    };
    db.products[productKey] = product;
    db.listingIndex[id] = productKey;
  }
  db.updatedAt = timestamp;
  return db;
}

/** Compares an asking price with other observed listings of the same product. */
export function compareProductPrice(db, productKey, listingId, askingPrice, minComparables = 3) {
  if (!Number.isFinite(askingPrice) || askingPrice <= 0 || !productKey || productKey === 'unknown') return null;
  const product = db?.products?.[productKey];
  const prices = Object.values(product?.observations ?? {})
    .filter((observation) => String(observation.listingId) !== String(listingId))
    .map((observation) => observation.askingPrice)
    .filter((price) => Number.isFinite(price) && price > 0);
  if (!prices.length) return { comparableCount: 0, status: 'insufficient_data' };

  const mid = median(prices);
  const p25 = round(quantile(prices, 0.25), 0);
  const p75 = round(quantile(prices, 0.75), 0);
  const status = prices.length < minComparables
    ? 'insufficient_data'
    : askingPrice < p25
      ? 'below_observed_range'
      : askingPrice > p75
        ? 'above_observed_range'
        : 'within_observed_range';

  return {
    comparableCount: prices.length,
    median: round(mid, 0),
    p25,
    p75,
    min: round(Math.min(...prices), 0),
    max: round(Math.max(...prices), 0),
    differencePct: mid > 0 ? Math.round((askingPrice / mid - 1) * 100) : null,
    minComparables,
    status,
  };
}

/** Persists the database (atomic write via the shared store helper). */
export async function savePriceDb(filePath, db) {
  await writeJson(filePath, db);
}
