/**
 * Talks to kleinanzeigen.de: builds search URLs, downloads result pages and
 * normalises everything into the internal listing shape used by the scanner.
 */

import { fetchWithRetry, log, randomBetween, sleep, uniqueBy } from './util.mjs';
import { normaliseRadius } from './config.mjs';
import { isRecentListing, WINDOW_MS } from '../../assets/listing-window.mjs';
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

/**
 * Parses the `/s-ort-empfehlungen.json` payload into entries:
 * `{"_0": "Deutschland", "_9668": "10115 Mitte"}` → `[{id,label}, …]`.
 * The `_0` entry is the country-wide fallback and keeps id `"0"`.
 */
export function parseLocationSuggestions(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.entries(payload)
    .map(([key, label]) => ({ id: key.replace(/^_/, ''), label: String(label ?? '').trim() }))
    .filter((entry) => entry.id && entry.label);
}

/**
 * Picks the best suggestion for a PLZ/place query: exact label prefix wins,
 * then a label containing the query; the country-wide entry (id "0") is only
 * used when nothing else matches. Returns null when nothing matches at all.
 */
export function pickLocation(suggestions, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle || !suggestions.length) return null;

  const scoped = suggestions.filter((entry) => entry.id !== '0');
  const candidates = scoped.length ? scoped : suggestions;
  return candidates.find((entry) => entry.label.toLowerCase().startsWith(needle))
    ?? candidates.find((entry) => entry.label.toLowerCase().includes(needle))
    ?? null;
}

/**
 * Resolves a PLZ or place name to a Kleinanzeigen location id via the site's
 * own suggestion endpoint. Throws when the query cannot be resolved, so a
 * typo never silently widens the search back to all of Germany.
 *
 * @param {string} query PLZ or place name
 * @param {object} config loaded dealfinder config
 * @returns {Promise<{id: string, label: string}>}
 */
export async function resolveLocation(query, config) {
  const url = `${BASE_URL}/s-ort-empfehlungen.json?query=${encodeURIComponent(query)}`;
  const response = await fetchWithRetry(url, {}, {
    attempts: config.http.attempts,
    timeoutMs: config.http.timeoutMs,
  });

  if (!response.ok) {
    throw new Error(`Location lookup for "${query}" failed with HTTP ${response.status}`);
  }

  const match = pickLocation(parseLocationSuggestions(await response.json()), query);
  if (!match) {
    throw new Error(`Location "${query}" could not be resolved on kleinanzeigen.de`);
  }
  return match;
}

/**
 * Applies the global location filter to one search. Values set on the search
 * itself win, so per-search `locationId`/`radius` overrides stay possible.
 */
export function applyLocation(search, location) {
  if (!location) return search;
  return {
    ...search,
    locationId: search.locationId || location.id,
    radius: search.radius || normaliseRadius(location.radius),
  };
}

/**
 * Retention check for previously stored feed rows while the global location
 * filter is active. Rows keep their crawl-time scope stamp in `locationScope`:
 *
 *  - no active filter              → keep everything (status quo),
 *  - stamp differs from the filter → the row belongs to another place (or to an
 *    earlier nationwide crawl) and leaves the feed immediately,
 *  - stamp matches                 → keep when the reported distance still fits
 *    the configured radius; without a radius ("ganzer Ort") the site reports
 *    no distances, so the stamp alone decides.
 *
 * Freshly crawled rows never pass through this check — the site already
 * applies the radius server-side.
 */
export function isNearbyDeal(deal, location) {
  if (!location) return true;
  if (String(deal?.locationScope ?? '') !== String(location.id)) return false;

  const radius = Number(location.radius);
  if (!Number.isFinite(radius) || radius <= 0) return true;

  const distance = Number(deal?.distanceKm);
  if (!Number.isFinite(distance) || distance <= 0) return true;
  return distance <= radius;
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
    // Scope stamp: the location id this listing was crawled under (empty for
    // nationwide crawls). Used to age old nationwide rows out of the feed
    // once a location filter becomes active.
    locationScope: String(search.locationId || ''),
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
  const listings = parseSearchResults(html);
  // A login, challenge or changed markup must not masquerade as an empty search.
  if (!listings.length && !/keine (?:anzeigen|ergebnisse)|keine passenden|0 Treffer/i.test(html)) {
    throw new Error('Keine Ergebnisse lesbar; Seitenende nicht bestätigt (Blockierung oder geändertes HTML möglich)');
  }
  return listings;
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
  const coverage = { windowDays: 7, complete: true, searches: [] };
  const referenceTime = Date.now();

  // Resolve the configured PLZ/place once per scan and apply it to every
  // search that does not pin its own locationId. A failed resolution aborts
  // the scan instead of silently widening the search back to all of Germany.
  let location = null;
  const plz = config.location?.plz ?? '';
  if (plz) {
    const resolved = await resolveLocation(plz, config);
    location = {
      id: resolved.id,
      label: resolved.label,
      plz,
      radius: config.location.radius ?? '',
    };
    log(`location "${plz}" resolved to ${location.label} (id ${location.id}), `
      + `radius ${location.radius ? `${location.radius} km` : 'ganzer Ort'}`);
  }

  for (const search of config.searches) {
    const effective = applyLocation(search, location);
    const report = { id: search.id, pages: 0, stopReason: null, missingDates: 0 };
    coverage.searches.push(report);
    const seenIds = new Set();
    let oldPages = 0;
    for (let page = 1; !effective.maxPages || page <= effective.maxPages; page += 1) {
      const url = buildSearchUrl(effective, page);

      try {
        const pageListings = await fetchSearchPage(url, config);
        log(`search "${effective.keywords}" page ${page}: ${pageListings.length} listings`);

        report.pages = page;
        if (!pageListings.length) { report.stopReason = 'source_empty'; break; }
        const normalised = pageListings.map(listing => normaliseListing(listing, effective));
        const fresh = normalised.filter(listing => !seenIds.has(listing.id));
        if (!fresh.length) {
          report.stopReason = 'repeated_results';
          errors.push(`search "${effective.keywords}": Quelle wiederholt Ergebnisse auf Seite ${page}; Erfassung unvollständig`);
          break;
        }
        normalised.forEach(listing => seenIds.add(listing.id));
        report.missingDates += fresh.filter(listing => !Number.isFinite(Date.parse(listing.postedAt || ''))).length;
        raw.push(...pageListings.filter(listing => isRecentListing(normaliseListing(listing, effective), referenceTime))
          .map(listing => ({ listing, search: effective })));
        // Two entirely old pages avoid stopping on a single promoted/old result.
        const allOld = fresh.every(listing => {
          const stamp = Date.parse(listing.postedAt || '');
          return Number.isFinite(stamp) && stamp < referenceTime - WINDOW_MS;
        });
        oldPages = allOld ? oldPages + 1 : 0;
        if (oldPages >= 2) { report.stopReason = 'date_boundary'; break; }
      } catch (error) {
        const message = `search "${effective.keywords}" page ${page} failed: ${error.message}`;
        errors.push(message);
        log(message);
        report.stopReason = 'request_failed';
        break;
      }

      if (!effective.maxPages || page < effective.maxPages) {
        await sleep(randomBetween(config.http.requestDelayMs, config.http.requestDelayMs * 1.6));
      }
    }

    if (!report.stopReason) report.stopReason = 'configured_page_limit';
    if (report.missingDates) errors.push(`search "${effective.keywords}": ${report.missingDates} Anzeigen ohne lesbares Datum ausgeschlossen`);
    if (!['date_boundary', 'source_empty'].includes(report.stopReason) || report.missingDates) coverage.complete = false;
    if (report.stopReason === 'configured_page_limit') errors.push(`search "${effective.keywords}": konfiguriertes Seitenlimit erreicht`);
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
  return { listings, errors, location, coverage };
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