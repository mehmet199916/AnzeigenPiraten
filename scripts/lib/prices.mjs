/**
 * Observed asking-price database plus a legacy per-listing evaluation cache.
 *
 * `products` holds observed asking prices used for market comparisons plus a
 * permanent per-listing price history (`product.history`) that scans append to
 * but never overwrite; `product.stats.average` is derived from that history
 * and serves as the automatic reference price when no manual price is set.
 * `entries` and its helpers are retained for compatibility with older saved
 * evaluations; current scans do not invoke an evaluation model. Manual
 * per-product reference prices live separately in data/product-prices.json.
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
export function prunePriceDb(db, { maxEntries = 0, maxAgeDays = 0, maxHistoryPointsPerListing = 0, now = Date.now() } = {}) {
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
    // Products that still hold collected price history are never dropped: only
    // the comparison window above is pruned, the history itself is kept.
    if (!Object.keys(product.observations ?? {}).length && !Object.keys(product.history ?? {}).length) {
      delete db.products[productKey];
    }
  }

  if (maxEntries > 0 && allObservations.length > maxEntries) {
    allObservations.sort((a, b) => b.stamp - a.stamp);
    for (const { productKey, id } of allObservations.slice(maxEntries)) {
      delete db.products[productKey]?.observations?.[id];
      delete db.listingIndex[id];
    }
    for (const [key, product] of Object.entries(db.products)) {
      if (!Object.keys(product.observations ?? {}).length && !Object.keys(product.history ?? {}).length) {
        delete db.products[key];
      }
    }
  }

  // Optional safety valve for the permanent history (0 = keep everything).
  if (maxHistoryPointsPerListing > 0) {
    for (const product of Object.values(db.products ?? {})) {
      if (!product.history) continue;
      for (const [id, points] of Object.entries(product.history)) {
        if (points.length > maxHistoryPointsPerListing) {
          product.history[id] = points.slice(-maxHistoryPointsPerListing);
        }
      }
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
    const previousProduct = previousKey && previousKey !== productKey
      ? db.products[previousKey]
      : null;

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

    if (previousProduct) {
      // Keep collected history with the listing when its classification changes.
      const movedHistory = previousProduct.history?.[id];
      if (movedHistory) {
        product.history ??= {};
        product.history[id] = movedHistory;
        delete previousProduct.history[id];
        if (!Object.keys(previousProduct.history).length) delete previousProduct.history;
      }
      delete previousProduct.observations?.[id];
      if (!Object.keys(previousProduct.observations ?? {}).length
        && !Object.keys(previousProduct.history ?? {}).length) {
        delete db.products[previousKey];
      }
    }
  }
  db.updatedAt = timestamp;
  return db;
}

/**
 * Records the permanent price history of every product: one timeline of price
 * points per listing id under `product.history[listingId]`. Points are only
 * appended when a listing's price actually changes, and existing points are
 * never overwritten by later scans. Listings recorded before history existed
 * are seeded once from their stored observation so past data is not lost.
 *
 * @param {object} db
 * @param {Array} listings
 * @param {string} [timestamp]
 */
export function recordProductPriceHistory(db, listings, timestamp = new Date().toISOString()) {
  db.products ??= {};
  db.listingIndex ??= {};

  // Backfill: seed history from observations captured before history existed.
  for (const product of Object.values(db.products)) {
    product.history ??= {};
    for (const [id, observation] of Object.entries(product.observations ?? {})) {
      if (product.history[id]?.length) continue;
      const seedPrice = Number(observation.askingPrice);
      if (!Number.isFinite(seedPrice) || seedPrice <= 0) continue;
      product.history[id] = [{ price: seedPrice, at: observation.lastSeenAt ?? timestamp }];
    }
  }

  for (const listing of listings) {
    const id = String(listing.id);
    const productKey = listing.product?.key;
    const price = Number(listing.price);
    if (!productKey || productKey === 'unknown' || !Number.isFinite(price) || price <= 0) continue;

    const product = db.products[productKey] ?? {
      key: productKey,
      name: listing.product.name,
      category: listing.product.category,
      observations: {},
    };
    product.history ??= {};
    const points = product.history[id] ?? (product.history[id] = []);
    const last = points[points.length - 1];
    if (!last || Number(last.price) !== price) {
      points.push({ price, at: timestamp });
    }
    db.products[productKey] = product;
    db.listingIndex[id] = productKey;
  }

  db.updatedAt = timestamp;
  return db;
}

/**
 * Derives per-product statistics from the collected price history.
 * `stats.average` is the observed average asking price used as the automatic
 * reference price when a product has no manual `referencePrice`.
 *
 * @param {object} db
 * @param {string} [timestamp]
 */
export function refreshProductStats(db, timestamp = new Date().toISOString()) {
  db.products ??= {};
  for (const product of Object.values(db.products)) {
    let count = 0;
    let total = 0;
    let min = Infinity;
    let max = -Infinity;
    let listingsWithHistory = 0;

    for (const points of Object.values(product.history ?? {})) {
      if (points.length) listingsWithHistory += 1;
      for (const point of points) {
        const price = Number(point?.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        count += 1;
        total += price;
        if (price < min) min = price;
        if (price > max) max = price;
      }
    }

    if (!count) {
      delete product.stats;
      continue;
    }

    product.stats = {
      average: round(total / count, 2),
      count,
      listings: listingsWithHistory,
      min: round(min, 0),
      max: round(max, 0),
      updatedAt: timestamp,
    };
  }
  return db;
}

/** Total number of collected price-history points across all products. */
export function productHistoryPointCount(db) {
  let total = 0;
  for (const product of Object.values(db?.products ?? {})) {
    for (const points of Object.values(product.history ?? {})) total += points.length;
  }
  return total;
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
