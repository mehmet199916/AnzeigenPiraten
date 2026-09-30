/**
 * Parsing helpers for Kleinanzeigen markup.
 *
 * Kleinanzeigen currently ships two flavours of search-result markup:
 *
 *  1. A modern Astro frontend that embeds the structured result set as JSON in
 *     `<astro-island props="…">` attributes (`resultAds[].organicAdPreview`).
 *  2. The classic server-rendered `<article class="aditem" data-adid="…">` list.
 *
 * Both are handled here without any third-party dependency: everything works on
 * plain strings so the scanner stays npm-install-free.
 */

const ENTITY_MAP = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&amp;': '&',
};

const CDN_BASE = 'https://www.kleinanzeigen.de';

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Decodes HTML entities (single pass, so `&amp;quot;` becomes `&quot;`). */
export function decodeEntities(input) {
  if (input == null) return '';
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(quot|apos|lt|gt|nbsp|amp);/g, (match) => ENTITY_MAP[match] ?? match);
}

const BLOCK_CLOSE_RE = /<\/(p|div|li|h[1-6]|tr|section|article)>/gi;
const LINE_BREAK_RE = /<br\s*\/?>/gi;
const ZERO_WIDTH_RE = /[\u200b-\u200f\ufeff]/g;

/**
 * Removes tags, decodes entities and strips zero-width marks.
 *
 * By default every kind of whitespace (including line breaks) is collapsed into
 * a single space, which is what titles, prices and locations need. Pass
 * `{ preserveLineBreaks: true }` for descriptions, where `<br>` and block
 * boundaries should survive as real newlines.
 *
 * @param {string} html
 * @param {{ preserveLineBreaks?: boolean }} [options]
 */
export function stripTags(html, options = {}) {
  if (html == null) return '';

  const text = decodeEntities(
    String(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(LINE_BREAK_RE, '\n')
      .replace(BLOCK_CLOSE_RE, '\n')
      .replace(/<[^>]*>/g, ' '),
  ).replace(ZERO_WIDTH_RE, '');

  if (options.preserveLineBreaks) {
    return text
      .split('\n')
      .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  return text.replace(/\s+/g, ' ').trim();
}

function* iterateTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b`, 'gi');
  let match;
  while ((match = re.exec(html)) !== null) {
    const end = html.indexOf('>', match.index);
    if (end === -1) return;
    yield html.slice(match.index, end + 1);
    re.lastIndex = end + 1;
  }
}

/** Reads an attribute value (double or single quoted) from a single tag string. */
export function readAttribute(tagHtml, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = String(tagHtml).match(re);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? '');
}

/**
 * Astro serialises island props as nested `[typeIndex, value]` tuples.
 * This unwraps them back into plain JS values.
 */
export function unwrapAstro(value) {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number') {
      return unwrapAstro(value[1]);
    }
    return value.map(unwrapAstro);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = unwrapAstro(nested);
    }
    return out;
  }
  return value;
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const value = typeof candidate === 'string' ? candidate : String(candidate);
    if (value.trim()) return value.trim();
  }
  return '';
}

function numberOrNull(value) {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(num) ? num : null;
}

function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${CDN_BASE}${url}`;
  return `${CDN_BASE}/${url}`;
}

/**
 * Kleinanzeigen image URLs carry a transformation rule such as `?rule=$_2.JPG`.
 * `$_57.JPG` is the largest variant, used for the detail view.
 */
export function upscaleImageUrl(url) {
  if (!url) return '';
  return url.replace(/rule=\$_\d+\.(jpg|jpeg|png|webp)/i, 'rule=$_57.JPG');
}

function pickImage(ad) {
  const list = Array.isArray(ad.imageList) ? ad.imageList : [];
  for (const entry of list) {
    const url = firstString(
      entry?.adTableThumbnailPrioUrl,
      entry?.adTableThumbnailUrl,
      entry?.xLargeUrl,
      entry?.url,
      entry?.src,
    );
    if (url) return absoluteUrl(url);
  }

  const single = firstString(ad.image, ad.imageUrl, ad.picture, ad.thumbnail, ad.thumbnailUrl);
  if (single) return absoluteUrl(single);

  if (typeof ad.seoContent === 'string') {
    try {
      const seo = JSON.parse(ad.seoContent);
      if (seo?.contentUrl) return absoluteUrl(seo.contentUrl);
    } catch {
      /* ignore malformed seo payloads */
    }
  }

  return '';
}

function buildLocation(ad) {
  const parts = [firstString(ad.locationName, ad.zipCode), firstString(ad.parentLocationName)]
    .filter(Boolean);
  const location = parts.join(' ').trim();
  const distance = numberOrNull(ad.distanceInKilometers);
  if (location && distance != null && distance > 0) return `${location} (${distance} km)`;
  return location;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[a-z]{2,}/gi;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g;
const PHONE_RE = /(?:\+49|0049|0)\d[\d\s/().-]{7,}\d/g;

/**
 * Removes contact details from free-text fields before they end up in a public
 * repository. Kleinanzeigen truncates search-result snippets, but a full detail
 * description (see `http.enrichDetails`) can contain phone numbers or IBANs.
 */
export function scrubPersonalData(text) {
  return String(text ?? '')
    .replace(EMAIL_RE, '[E-Mail entfernt]')
    .replace(IBAN_RE, '[IBAN entfernt]')
    .replace(PHONE_RE, (match) => (
      match.replace(/\D/g, '').length >= 9 ? '[Telefonnummer entfernt]' : match
    ));
}

function mapAttributes(attributes) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    const out = {};
    for (const entry of attributes) {
      const key = firstString(entry?.key, entry?.name, entry?.label);
      const value = firstString(entry?.value, entry?.text);
      if (key && value) out[key] = value;
    }
    return out;
  }
  if (typeof attributes === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(attributes)) {
      const text = firstString(value);
      if (text) out[key] = text;
    }
    return out;
  }
  return {};
}

function mapAstroAd(ad) {
  const rawId = firstString(ad.id, ad.adId, ad.listingId);
  if (!rawId) return null;

  const numericId = rawId.replace(/[^\d]/g, '') || rawId;
  const url = absoluteUrl(firstString(ad.url, ad.link, ad.seoUrl))
    || `${CDN_BASE}/s-anzeige/${numericId}`;

  return {
    id: numericId,
    title: firstString(ad.title, ad.heading, ad.name),
    description: firstString(ad.description, ad.shortDescription, ad.teaser, ad.snippet),
    priceRaw: firstString(ad.price, ad.priceFormatted, ad.priceDisplay),
    location: buildLocation(ad),
    distanceKm: numberOrNull(ad.distanceInKilometers),
    postedRaw: firstString(ad.sortingDate, ad.postedAt, ad.createdAt, ad.date),
    image: pickImage(ad),
    url,
    category: firstString(ad.categoryName, ad.category, ad.categoryPath),
    attributes: mapAttributes(ad.attributes),
  };
}

function parseAstroResults(html) {
  const out = [];

  for (const tag of iterateTags(html, 'astro-island')) {
    const propsRaw = readAttribute(tag, 'props');
    if (!propsRaw) continue;

    let data;
    try {
      data = JSON.parse(propsRaw);
    } catch {
      continue;
    }

    const props = unwrapAstro(data);
    const resultAds = props?.resultAds;
    if (!Array.isArray(resultAds)) continue;

    for (const entry of resultAds) {
      const ad = entry?.organicAdPreview ?? entry?.adPreview ?? entry;
      if (!ad || typeof ad !== 'object' || Array.isArray(ad)) continue;
      const mapped = mapAstroAd(ad);
      if (mapped) out.push(mapped);
    }
  }

  return out;
}

function matchClassBlock(html, classFragment) {
  const re = new RegExp(
    `<([a-z0-9]+)\\b[^>]*class="[^"]*${classFragment}[^"]*"[^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  );
  const match = html.match(re);
  return match ? match[2] : '';
}

function parseClassicResults(html) {
  const out = [];
  const articleRe = /<article\b([^>]*)>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRe.exec(html)) !== null) {
    const attrs = match[1];
    const inner = match[2];
    const adId = (attrs.match(/\bdata-adid\s*=\s*"([^"]+)"/i)?.[1] ?? '').trim();
    if (!adId) continue;

    const titleBlock = inner.match(/<h2\b[^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i);
    const title = stripTags(titleBlock?.[1] ?? '');

    const priceRaw = stripTags(
      matchClassBlock(inner, 'aditem-main--middle--price-shipping--price')
      || matchClassBlock(inner, 'aditem-main--middle--price'),
    );

    const description = stripTags(
      matchClassBlock(inner, 'aditem-main--middle--description'),
      { preserveLineBreaks: true },
    );
    const location = stripTags(matchClassBlock(inner, 'aditem-main--top--left'));
    const postedRaw = stripTags(matchClassBlock(inner, 'aditem-main--top--right'));

    const imgTag = inner.match(/<img\b[^>]*>/i)?.[0] ?? '';
    const image = absoluteUrl(
      readAttribute(imgTag, 'src')
      || readAttribute(imgTag, 'data-imgsrc')
      || readAttribute(imgTag, 'data-src')
      || '',
    );

    const href = inner.match(/<a\b[^>]*href="([^"]+)"/i)?.[1] ?? '';

    out.push({
      id: adId,
      title,
      description,
      priceRaw,
      location,
      distanceKm: null,
      postedRaw,
      image,
      url: absoluteUrl(href) || `${CDN_BASE}/s-anzeige/${adId}`,
      category: '',
      attributes: {},
    });
  }

  return out;
}

/** Parses a Kleinanzeigen search result page into a list of raw listings. */
export function parseSearchResults(html) {
  if (!html) return [];
  const fromAstro = parseAstroResults(html);
  if (fromAstro.length) return dedupeById(fromAstro);
  return dedupeById(parseClassicResults(html));
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

const PRICE_PATTERN = /(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|eur)/i;
const PRICE_PATTERN_REVERSED = /(?:€|eur)\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;

function germanNumberToFloat(raw) {
  let value = raw;
  if (value.includes('.') && value.includes(',')) {
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (value.includes(',')) {
    value = value.replace(',', '.');
  } else if (/\.\d{3}\b/.test(value)) {
    value = value.replace(/\./g, '');
  }
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parses a raw price string such as "450 € VB", "1.200 €" or "Zu verschenken".
 * @returns {{text:string, amount:number|null, free:boolean, negotiable:boolean, trade:boolean}}
 */
export function parsePrice(raw) {
  const text = stripTags(raw ?? '');
  const result = {
    text,
    amount: null,
    free: false,
    negotiable: /\bvb\b|verhandlungsbasis|vhs\b|preis vorschlag|\bobp\b/i.test(text),
    trade: /tausch|tauschen/i.test(text),
  };

  if (!text) return result;

  if (/verschenken|geschenkt|gratis|\bfree\b/i.test(text)) {
    result.amount = 0;
    result.free = true;
    return result;
  }

  if (result.trade && !/\d/.test(text)) {
    return result;
  }

  const match = text.match(PRICE_PATTERN) ?? text.match(PRICE_PATTERN_REVERSED);
  if (match) {
    const amount = germanNumberToFloat(match[1]);
    if (amount != null) result.amount = Math.round(amount * 100) / 100;
  }

  return result;
}

function atLocalTime(reference, hours, minutes, daysAgo) {
  const date = new Date(reference.getTime());
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

/**
 * Parses the relative German date strings Kleinanzeigen uses ("Heute, 06:24",
 * "Gestern, 23:38", "05.09.2025") plus ISO timestamps.
 * @returns {string|null} ISO timestamp or null when unparsable
 */
export function parsePostedAt(raw, reference = new Date()) {
  const text = stripTags(raw ?? '');
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  let match = text.match(/heute,?\s*(\d{1,2}):(\d{2})/i);
  if (match) return atLocalTime(reference, Number(match[1]), Number(match[2]), 0);

  match = text.match(/gestern,?\s*(\d{1,2}):(\d{2})/i);
  if (match) return atLocalTime(reference, Number(match[1]), Number(match[2]), 1);

  match = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Extracts the JSON-LD `Product` payload from a listing detail page. */
export function parseDetailPage(html) {
  if (!html) return null;

  const blocks = html.match(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  if (!blocks) return null;

  for (const block of blocks) {
    const json = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      if (entry?.['@type'] !== 'Product') continue;
      return {
        title: stripTags(entry.name ?? ''),
        description: stripTags(entry.description ?? '', { preserveLineBreaks: true }),
        priceRaw: String(entry.offers?.price ?? ''),
        currency: String(entry.offers?.priceCurrency ?? 'EUR'),
        image: absoluteUrl(String(entry.image ?? '')),
      };
    }
  }

  return null;
}