/**
 * Talks to kleinanzeigen.de: builds search URLs, downloads result pages and
 * normalises everything into the internal listing shape used by the scanner.
 */

import { fetchWithRetry, log, randomBetween, sleep, uniqueBy } from './util.mjs';
import {
  parseDetailPage,
  parsePostedAt,
  parsePrice,
  parseSearchResults,
  scrubPersonalData,
  upscaleImageUrl,
} from './parse.mjs';

export const BASE_URL = 'https://www.kleinanzeigen.de';

/**
 * Builds the classic search-request URL. These query parameters are the ones the
 * site itself uses for `/s-suchanfrage.html`.
 */
export function buildSearchUrl(search, page = 1) {
  const params = new URLSearchParams();
  params.set('keywords', search.keywords);
  params.set('categoryId', search.categoryId ?? '');
  params.set('locationId', search.locationId ?? '');
  params.set('radius', search.radius ?? '');
  params.set('sortingField', search.sortingField || 'SORTING_DATE');
  params.set('adType', search.adType || 'OFFER');
  params.set('posterType', search.posterType ?? '');
  params.set('pageNum', String(page));
  params.set('maxPrice', search.maxPrice ?? '');
  params.set('minPrice', search.minPrice ?? '');
  params.set('buyNowEnabled', 'false');
  params.set('shipping', '');
  params.set('shippingCarrier', '');

  return `${BASE_URL}/s-suchanfrage.html?${params.toString()}`;
}

/** Normalises a raw parsed listing into the scanner's internal shape. */
export function normaliseListing(raw, search) {
  const price = parsePrice(raw.priceRaw);

  return {
    id: String(raw.id),
    queryId: search.id,
    queryLabel: search.label,
    title: scrubPersonalData(raw.title || ''),
    description: scrubPersonalData(raw.description || ''),
    price: price.amount,
    priceRaw: price.text || raw.priceRaw || '',
    currency: 'EUR',
    priceTags: {
      free: price.free,
      negotiable: price.negotiable,
      trade: price.trade,
    },
    location: raw.location || '',
    distanceKm: raw.distanceKm ?? null,
    postedAt: parsePostedAt(raw.postedRaw) ?? null,
    postedRaw: raw.postedRaw || '',
    image: raw.image || '',
    imageLarge: upscaleImageUrl(raw.image || ''),
    url: raw.url || `${BASE_URL}/s-anzeige/${raw.id}`,
    category: raw.category || '',
    attributes: raw.attributes ?? {},
  };
}

/** Downloads and parses a single search-result page. */
export async function fetchSearchPage(url, config) {
  const response = await fetchWithRetry(url, {}, {
    attempts: config.http.attempts,
    timeoutMs: config.http.timeoutMs,
  });

  if (!response.ok) {
    throw new Error(`Kleinanzeigen responded with HTTP ${response.status} for ${url}`);
  }

  const html = await response.text();
  return parseSearchResults(html);
}

/** Optionally fetches a listing detail page to obtain the full description. */
export async function fetchDetail(id, config) {
  const response = await fetchWithRetry(`${BASE_URL}/s-anzeige/${id}`, {}, {
    attempts: config.http.attempts,
    timeoutMs: config.http.timeoutMs,
  });
  if (!response.ok) return null;
  return parseDetailPage(await response.text());
}

/**
 * Runs every configured search, parses the result pages and returns a
 * de-duplicated, normalised list of listings.
 *
 * @param {object} config loaded dealfinder config
 * @param {{ onProgress?: (info: object) => void }} [options]
 */
export async function collectListings(config, options = {}) {
  const raw = [];
  const errors = [];

  for (const search of config.searches) {
    for (let page = 1; page <= search.maxPages; page += 1) {
      const url = buildSearchUrl(search, page);

      try {
        const pageListings = await fetchSearchPage(url, config);
        log(`search "${search.keywords}" page ${page}: ${pageListings.length} listings`);

        if (!pageListings.length) break;
        raw.push(...pageListings.map((listing) => ({ listing, search })));
      } catch (error) {
        const message = `search "${search.keywords}" page ${page} failed: ${error.message}`;
        errors.push(message);
        log(message);
      }

      if (page < search.maxPages) {
        await sleep(randomBetween(config.http.requestDelayMs, config.http.requestDelayMs * 1.6));
      }
    }

    await sleep(randomBetween(config.http.requestDelayMs, config.http.requestDelayMs * 1.6));
  }

  let listings = uniqueBy(
    raw.map(({ listing, search }) => normaliseListing(listing, search)),
    (listing) => listing.id,
  );

  if (config.http.enrichDetails) {
    listings = await enrichDescriptions(listings, config);
  }

  options.onProgress?.({ count: listings.length, errors });
  return { listings, errors };
}

async function enrichDescriptions(listings, config) {
  const enriched = [];

  for (const listing of listings) {
    const needsDetails = !listing.description || listing.description.length < 80;
    if (!needsDetails) {
      enriched.push(listing);
      continue;
    }

    try {
      const detail = await fetchDetail(listing.id, config);
      if (detail) {
        enriched.push({
          ...listing,
          title: scrubPersonalData(listing.title || detail.title),
          description: scrubPersonalData(detail.description || listing.description),
          image: listing.image || detail.image,
          imageLarge: upscaleImageUrl(listing.image || detail.image || ''),
        });
      } else {
        enriched.push(listing);
      }
    } catch (error) {
      log(`detail ${listing.id} failed: ${error.message}`);
      enriched.push(listing);
    }

    await sleep(randomBetween(400, 900));
  }

  return enriched;
}