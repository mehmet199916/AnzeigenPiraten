/** Product classification for listings. This module identifies products only;
 * it deliberately does not inspect asking prices or estimate market values.
 */

import { chunk, clamp, log, truncate } from './util.mjs';

const PRODUCT_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          category: { type: 'string' },
          productName: { type: 'string' },
          variant: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['index', 'category', 'productName', 'variant', 'confidence'],
      },
    },
  },
  required: ['classifications'],
};

const SYSTEM_PROMPT = [
  'Du ordnest Kleinanzeigen-Anzeigen einem konkreten Produkttyp oder Modell zu.',
  'Deine Aufgabe ist ausschließlich Produktidentifikation und Kategorisierung.',
  'Bewerte niemals Preis, Deal-Qualität, Marktwert oder Ersparnis.',
  'Nutze Titel, Beschreibung, Suchbegriff und Anzeigenattribute, um Marke und Modell zu erkennen.',
  'Trenne Produkte, die leicht verwechselt werden: zum Beispiel PS5-Konsole und PS5-Controller.',
  'Identifiziere den angebotenen Gegenstand selbst: Reparatur-/Dienstleistungsanzeigen sind Dienstleistungen, Spiele sind Spiele/Software, Zubehör bleibt Zubehör und eine Lampe bleibt eine Lampe.',
  'Erfinde keine Marke oder ein Modell. Nutze nur Informationen aus dem Titel, der Beschreibung, dem Suchbegriff und den Attributen. Bei Schreibfehlern darfst du eine offensichtliche Korrektur vornehmen, aber nicht raten.',
  'Wenn ein Modell im Titel erkennbar ist, verwende es auch wenn Generation oder Zustand fehlen. Für eindeutige Produktfamilien wie „MacBook Pro“ darf die Familie selbst der Produktname sein; ergänze kein nicht genanntes Baujahr oder Untermodell.',
  'Unbekanntes Produkt ist nur für unidentifizierbare Mehrprodukt-/Sammelanzeigen oder wenn kein angebotenes Produkt erkennbar ist. Für generische, aber klare Arten wie „PlayStation Spiele“ benenne genau diese Produktart statt eine Konsole zu raten.',
  'Gib einen stabilen, kanonischen productName mit Marke und möglichst genauer Modellbezeichnung aus, z. B. "Apple iPhone 13", "Apple iPhone 14 Pro Max", "Sony PlayStation 5 Konsole" oder "Sony DualSense Controller für PlayStation 5".',
  'Wichtige kaufpreisrelevante Ausführungen wie Speichergröße gehören in productName; Farbe, Zustand und Zubehör gehören nicht in productName.',
  'Wenn das Modell nicht zuverlässig erkennbar ist, gib "Unbekanntes Produkt" als productName aus und setze confidence niedrig.',
  'Schreibe category als kurze Oberkategorie, z. B. Smartphones, Spielekonsolen, Controller, Fahrräder, Kameras oder Computer.',
  'Schreibe variant nur für klar erkennbare ergänzende Merkmale, sonst einen leeren String.',
  'confidence ist eine Zahl zwischen 0 und 1. Antworte ausschließlich im vorgegebenen JSON-Format.',
].join('\n');

export function productKeyForName(productName) {
  const key = String(productName ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(\d+(?:[.,]\d+)?)\s*(gb|tb)\b/gi, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return key || 'unknown';
}

function normaliseClassification(entry, listing, engine) {
  let name = truncate(String(entry?.productName ?? '').trim(), 120);
  if (!name || /^unbekannt(es)? produkt$/i.test(name)) name = 'Unbekanntes Produkt';
  const category = truncate(String(entry?.category ?? '').trim(), 60) || 'Unsortiert';
  let variant = truncate(String(entry?.variant ?? '').trim(), 100);
  const listingText = `${listing.title ?? ''} ${listing.description ?? ''}`;
  const storage = variant.match(/\b\d+(?:[.,]\d+)?\s?(?:GB|TB)\b/i)?.[0]
    ?? listingText.match(/\b\d+(?:[.,]\d+)?\s?(?:GB|TB)\b/i)?.[0];
  if (name !== 'Unbekanntes Produkt' && storage && !/\b\d+(?:[.,]\d+)?\s?(?:GB|TB)\b/i.test(name)) {
    name = truncate(`${name} ${storage}`, 120);
    variant = variant.replace(storage, '').replace(/^[\s,;|]+|[\s,;|]+$/g, '').trim();
  }
  const confidence = Number(entry?.confidence);

  return {
    key: name === 'Unbekanntes Produkt' ? 'unknown' : productKeyForName(name),
    name,
    category,
    variant,
    confidence: Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0,
    engine,
    classifiedAt: new Date().toISOString(),
  };
}

function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* invalid model output */ }
    }
    return null;
  }
}

function removePrices(text) {
  return String(text ?? '')
    .replace(/(?:preis|kosten|kostet|uvp|vb)\s*:?\s*\d[\d.,\s]*(?:€|eur|euro)?/giu, '[Preis ausgeblendet]')
    .replace(/\d[\d.\s]*(?:,\d{1,2})?\s*(?:€|eur|euro)(?![\p{L}])/giu, '[Preis ausgeblendet]');
}

function buildPayload(items) {
  return JSON.stringify({
    hinweis: 'Preise wurden absichtlich ausgelassen. Identifiziere nur das Produkt.',
    angebote: items.map((item) => ({
      index: item.index,
      id: item.listing.id,
      titel: removePrices(item.listing.title),
      beschreibung: truncate(removePrices(item.listing.description), item.maxDescriptionChars),
      suchbegriff: removePrices(item.listing.queryLabel),
      attribute: Object.fromEntries(
        Object.entries(item.listing.attributes ?? {})
          .filter(([key]) => !/(?:price|preis|eur|euro)/i.test(key))
          .map(([key, value]) => [key, typeof value === 'string' ? removePrices(value) : value]),
      ),
    })),
  });
}

function ollamaNativeEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/api/chat';
  url.search = '';
  return url.toString();
}

async function callClassifier({ config, items }) {
  const payload = buildPayload(items);
  const isOllama = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(new URL(config.ai.baseUrl).hostname);
  const endpoint = isOllama
    ? ollamaNativeEndpoint(config.ai.baseUrl)
    : `${config.ai.baseUrl}/chat/completions`;
  const body = isOllama
    ? {
      model: config.ai.model,
      stream: false,
      think: false,
      format: PRODUCT_SCHEMA,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payload },
      ],
      options: { temperature: config.ai.temperature, num_predict: Math.max(300, items.length * 180) },
    }
    : {
      model: config.ai.model,
      temperature: config.ai.temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: payload },
      ],
    };

  if (!isOllama && config.ai.reasoningEffort) body.reasoning_effort = config.ai.reasoningEffort;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Product classification failed (HTTP ${response.status}) ${truncate(await response.text(), 300)}`);
  }

  const json = await response.json();
  const content = isOllama ? json?.message?.content : json?.choices?.[0]?.message?.content;
  const parsed = parseJsonLoose(content);
  if (!Array.isArray(parsed?.classifications)) throw new Error('AI returned invalid product classifications');
  return parsed.classifications;
}

/**
 * Assigns a product identity to each listing. No asking price or market data is
 * sent to the model; missing/failed classifications remain explicitly unknown.
 */
export async function classifyListings({ items, config }) {
  const results = new Map();
  const errors = [];
  const aiEnabled = Boolean(config.ai.enabled && config.ai.apiKey);
  const engine = aiEnabled ? `ai:${config.ai.model}` : 'unclassified';
  if (!items.length) return { results, engine, aiUsed: false, errors };

  if (!aiEnabled) {
    for (const item of items) {
      results.set(String(item.listing.id), normaliseClassification({}, item.listing, 'unclassified'));
    }
    return { results, engine, aiUsed: false, errors };
  }

  const indexed = items.map((item, index) => ({
    index,
    listing: item.listing,
    maxDescriptionChars: config.ai.maxDescriptionChars,
  }));
  let aiUsed = false;
  for (const batch of chunk(indexed, config.ai.batchSize)) {
    try {
      const classifications = await callClassifier({ config, items: batch });
      for (const entry of classifications) {
        const target = batch.find((item) => item.index === Number(entry?.index));
        if (!target) continue;
        results.set(String(target.listing.id), normaliseClassification(entry, target.listing, engine));
      }
      aiUsed = true;
    } catch (error) {
      errors.push(`Product classification failed: ${error.message}`);
      log(`Product classification failed: ${error.message}`);
    }
  }

  for (const item of indexed) {
    const id = String(item.listing.id);
    if (!results.has(id)) results.set(id, normaliseClassification({}, item.listing, 'unclassified'));
  }
  return { results, engine: aiUsed ? engine : 'unclassified', aiUsed, errors };
}
