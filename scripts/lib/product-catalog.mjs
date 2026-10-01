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

/** Compare a listing's asking price with its manually maintained product price. */
export function checkProductPrice(catalog, productKey, askingPrice) {
  if (!productKey || productKey === 'unknown') return { status: 'unknown_product' };

  const product = catalog?.products?.[productKey];
  if (!product) return { status: 'product_not_in_catalog', productKey };

  const referencePrice = Number(product.referencePrice);
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    return { status: 'reference_price_missing', productKey, productName: product.name ?? productKey };
  }
  if (!Number.isFinite(askingPrice) || askingPrice < 0) {
    return { status: 'asking_price_missing', productKey, productName: product.name ?? productKey, referencePrice };
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
    productKey,
    productName: product.name ?? productKey,
    askingPrice,
    referencePrice,
    difference,
    differencePct,
  };
}

export async function saveProductCatalog(filePath, catalog) {
  await writeJson(filePath, catalog);
}
