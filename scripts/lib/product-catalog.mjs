import { readJson, writeJson } from './store.mjs';
import { round } from './util.mjs';

export function defaultProductCatalog(currency = 'EUR') {
  return { version: 1, currency, updatedAt: null, products: {} };
}

export async function loadProductCatalog(filePath, currency = 'EUR') {
  const parsed = await readJson(filePath, defaultProductCatalog(currency));
  return {
    ...defaultProductCatalog(currency),
    ...(parsed ?? {}),
    products: parsed?.products && typeof parsed.products === 'object' ? parsed.products : {},
  };
}

/** Keep one manually priced catalog record for every canonical product key. */
export function syncProductCatalog(catalog, listings, timestamp = new Date().toISOString()) {
  catalog.products ??= {};
  let changed = false;

  for (const listing of listings) {
    const product = listing.product;
    if (!product?.key || product.key === 'unknown') continue;

    const current = catalog.products[product.key];
    if (!current) {
      catalog.products[product.key] = {
        name: product.name,
        category: product.category,
        referencePrice: null,
        updatedAt: null,
      };
      changed = true;
      continue;
    }

    if (current.name !== product.name || current.category !== product.category) {
      current.name = product.name;
      current.category = product.category;
      changed = true;
    }
    if (!Object.hasOwn(current, 'referencePrice')) {
      current.referencePrice = null;
      changed = true;
    }
    if (!Object.hasOwn(current, 'updatedAt')) {
      current.updatedAt = null;
      changed = true;
    }
  }

  if (changed) catalog.updatedAt = timestamp;
  return catalog;
}

/**
 * Compare a listing's asking price with its product reference price.
 *
 * A manually entered `referencePrice` always wins. When no manual price is
 * set, the observed average of the collected price history
 * (`observedStats.average`) becomes the reference, so a product gets a usable
 * reference as soon as prices have been collected for it.
 *
 * @param {object} catalog
 * @param {string} productKey
 * @param {number} askingPrice
 * @param {{ average?: number, count?: number } | null} [observedStats]
 * @param {number} [minSamples] minimum collected prices before the observed
 *   average is trusted as a reference
 */
export function checkProductPrice(catalog, productKey, askingPrice, observedStats = null, minSamples = 1) {
  if (!productKey || productKey === 'unknown') return { status: 'unknown_product' };

  const product = catalog?.products?.[productKey];
  if (!product) return { status: 'product_not_in_catalog', productKey };

  const observedCount = Number(observedStats?.count) || 0;
  const manualPrice = Number(product.referencePrice);
  let referencePrice = null;
  let referenceSource = null;
  if (Number.isFinite(manualPrice) && manualPrice > 0) {
    referencePrice = manualPrice;
    referenceSource = 'manual';
  } else {
    const average = Number(observedStats?.average);
    const requiredSamples = Math.max(1, Number(minSamples) || 1);
    if (observedCount >= requiredSamples && Number.isFinite(average) && average > 0) {
      referencePrice = average;
      referenceSource = 'average';
    }
  }

  const base = { productKey, productName: product.name ?? productKey, observedCount };
  if (referencePrice === null) {
    return { status: 'reference_price_missing', ...base };
  }
  if (!Number.isFinite(askingPrice) || askingPrice < 0) {
    return { status: 'asking_price_missing', ...base, referencePrice, referenceSource };
  }

  const difference = round(referencePrice - askingPrice, 0);
  const differencePct = Math.round((difference / referencePrice) * 1000) / 10;
  const status = askingPrice < referencePrice
    ? 'good_price'
    : askingPrice === referencePrice
      ? 'at_reference_price'
      : 'above_reference_price';

  return {
    status,
    ...base,
    askingPrice,
    referencePrice,
    referenceSource,
    difference,
    differencePct,
  };
}

export async function saveProductCatalog(filePath, catalog) {
  await writeJson(filePath, catalog);
}
