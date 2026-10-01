/**
 * Deal evaluation.
 *
 * Primary path  : an OpenAI-compatible Chat Completions endpoint returns a
 *                 structured verdict per listing (score, fair price, reasoning).
 * Fallback path : a deterministic heuristic that compares the asking price with
 *                 the median price of the same search and looks for red-flag /
 *                 bonus keywords. This keeps the site useful without an API key.
 */

import { chunk, clamp, log, median, quantile, round, truncate } from './util.mjs';

export const VERDICT_THRESHOLDS = {
  top: 85,
  good: 70,
  fair: 50,
};

const RED_FLAG_PATTERNS = [
  ['defekt', 'defekt'],
  ['bastler', 'Bastlerfahrzeug / Bastlerstück'],
  ['ersatzteil', 'Ersatzteilspender'],
  ['kaputt', 'kaputt'],
  ['beschädigt', 'beschädigt'],
  ['bruch', 'Bruchschaden'],
  ['riss', 'Riss'],
  ['ohne funktion', 'nicht funktionsfähig'],
  ['funktioniert nicht', 'funktioniert nicht'],
  ['nicht funktionsfähig', 'nicht funktionsfähig'],
  ['for parts', 'for parts'],
  ['kein netzteil', 'kein Netzteil'],
  ['ohne zubehör', 'ohne Zubehör'],
  ['keine garantie', 'keine Garantie'],
  ['replikat', 'Replikat / Nachbau'],
  ['fake', 'Fälschungsverdacht'],
];

const BONUS_PATTERNS = [
  ['originalverpackt', 'Originalverpackung'],
  ['ovp', 'Originalverpackung'],
  ['ungeöffnet', 'ungeöffnet'],
  ['neuwertig', 'neuwertig'],
  ['garantie', 'Restgarantie'],
  ['rechnung', 'Kaufbeleg vorhanden'],
  ['original', 'Original'],
  ['sealed', 'versiegelt'],
  ['wie neu', 'wie neu'],
  ['kaum genutzt', 'kaum genutzt'],
];

export function verdictFor(score) {
  if (score == null) return 'unknown';
  if (score >= VERDICT_THRESHOLDS.top) return 'top';
  if (score >= VERDICT_THRESHOLDS.good) return 'good';
  if (score >= VERDICT_THRESHOLDS.fair) return 'fair';
  return 'overpriced';
}

/**
 * Collects market statistics per search. Uses every listing the scanner knows
 * about (freshly crawled + previously stored ones) so the sample stays large.
 *
 * @param {Array<object>} listings
 */
export function buildMarketStats(listings) {
  const groups = new Map();

  for (const listing of listings) {
    if (!Number.isFinite(listing.price) || listing.price <= 0) continue;
    const key = listing.queryId ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(listing.price);
  }

  const stats = {};
  for (const [key, prices] of groups.entries()) {
    stats[key] = {
      count: prices.length,
      median: round(median(prices), 0),
      p25: round(quantile(prices, 0.25), 0),
      p75: round(quantile(prices, 0.75), 0),
      min: round(Math.min(...prices), 0),
      max: round(Math.max(...prices), 0),
    };
  }
  return stats;
}

function ratioToScore(ratio) {
  if (ratio <= 0.35) return 97;
  if (ratio <= 0.5) return 92;
  if (ratio <= 0.65) return 84;
  if (ratio <= 0.8) return 74;
  if (ratio <= 0.95) return 63;
  if (ratio <= 1.1) return 52;
  if (ratio <= 1.3) return 40;
  if (ratio <= 1.6) return 30;
  return 20;
}

function matchPatterns(text, patterns) {
  const haystack = String(text ?? '').toLowerCase();
  const hits = [];
  for (const [needle, label] of patterns) {
    if (haystack.includes(needle)) hits.push(label);
  }
  return hits;
}

export function savingsPct(price, fairPrice) {
  if (!Number.isFinite(price) || !Number.isFinite(fairPrice) || fairPrice <= 0) return null;
  return Math.round((1 - price / fairPrice) * 100);
}

/**
 * Deterministic scoring. Never throws and always returns a complete evaluation.
 * @param {object} listing
 * @param {Record<string, object>} marketByQuery
 */
export function heuristicEvaluate(listing, marketByQuery) {
  const stats = marketByQuery?.[listing.queryId] ?? null;
  const text = `${listing.title ?? ''} ${listing.description ?? ''}`.trim();
  const redFlags = matchPatterns(text, RED_FLAG_PATTERNS);
  const highlights = matchPatterns(text, BONUS_PATTERNS);

  let score = 55;
  let fairPrice = null;
  let basis = 'kein belastbarer Marktvergleich vorhanden';

  if (listing.price === 0) {
    score = 96;
    fairPrice = 0;
    basis = 'zu verschenken';
  } else if (Number.isFinite(listing.price) && stats && stats.count >= 4 && stats.median > 0) {
    const ratio = listing.price / stats.median;
    score = ratioToScore(ratio);
    fairPrice = stats.median;
    const deltaPct = Math.round((1 - ratio) * 100);
    basis = deltaPct >= 0
      ? `${deltaPct}% unter dem Median von ${stats.median} € (${stats.count} Angebote)`
      : `${Math.abs(deltaPct)}% über dem Median von ${stats.median} € (${stats.count} Angebote)`;
  }

  score -= Math.min(30, redFlags.length * 12);
  score += Math.min(18, highlights.length * 6);
  score = clamp(Math.round(score), 1, 99);

  const verdict = verdictFor(score);
  const reasoning = buildHeuristicReasoning({ verdict, basis, redFlags, highlights });

  return {
    dealScore: score,
    verdict,
    fairPrice,
    savingsPct: savingsPct(listing.price, fairPrice),
    reasoning,
    redFlags,
    highlights,
    engine: 'heuristic',
    evaluatedAt: new Date().toISOString(),
  };
}

function buildHeuristicReasoning({ verdict, basis, redFlags, highlights }) {
  const parts = [];
  switch (verdict) {
    case 'top':
      parts.push('Sehr attraktiver Preis');
      break;
    case 'good':
      parts.push('Guter Preis');
      break;
    case 'fair':
      parts.push('Marktüblicher Preis');
      break;
    default:
      parts.push('Preis wirkt zu hoch');
  }
  parts.push(`(${basis}).`);
  if (highlights.length) parts.push(`Positiv: ${highlights.join(', ')}.`);
  if (redFlags.length) parts.push(`Vorsicht: ${redFlags.join(', ')}.`);
  return parts.join(' ');
}

const SYSTEM_PROMPT = [
  'Du bist ein erfahrener Analyst für den deutschen Gebrauchtmarkt (kleinanzeigen.de).',
  'Bewerte, ob ein Angebot ein guter Deal ist.',
  'Berücksichtige Titel, Beschreibung, Preis, Zustandshinweise und - falls vorhanden - Marktstatistiken ähnlicher Angebote.',
  'Sei realistisch: berücksichtige Wertverlust, Zubehör, Garantie, Marken und typische Betrugsmuster.',
  'Antworte ausschließlich mit gültigem JSON, ohne Markdown und ohne erklärenden Text.',
  'Schema: {"evaluations": [{"index": 0, "dealScore": 0-100, "verdict": "top|good|fair|overpriced", "fairPrice": 123, "reasoning": "kurz auf Deutsch", "redFlags": ["..."]}]}',
  'dealScore: 100 = absoluter Schnäppchenalarm, 50 = marktüblich, 0 = völlig überteuert.',
  'fairPrice ist der geschätzte faire Marktwert in Euro (nur die Zahl) oder null, wenn nicht schätzbar.',
].join('\n');

function buildUserPrompt(items, currency) {
  const payload = {
    waehrung: currency,
    hinweis: 'fairPrice als Zahl in der angegebenen Währung.',
    angebote: items.map((item) => ({
      index: item.index,
      id: item.listing.id,
      titel: item.listing.title,
      preis: item.listing.priceRaw || item.listing.price,
      preis_zahl: item.listing.price,
      beschreibung: truncate(item.listing.description, item.maxDescriptionChars),
      ort: item.listing.location,
      suchbegriff: item.listing.queryLabel,
      markt: item.market,
    })),
  };
  return JSON.stringify(payload);
}

/** Tolerantly parses model output that may be wrapped in markdown fences. */
export function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to bracket extraction */
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function callChatCompletion({ config, items, logContext }) {
  const endpoint = `${config.ai.baseUrl}/chat/completions`;
  const body = {
    model: config.ai.model,
    temperature: config.ai.temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(items, config.currency) },
    ],
  };

  // Ollama (and some other providers) disable the slow "thinking" mode of
  // models like qwen3 when reasoning_effort is set to "none". Providers that do
  // not understand the field are only affected when it is explicitly configured.
  if (config.ai.reasoningEffort) {
    body.reasoning_effort = config.ai.reasoningEffort;
  }

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
    const detail = await response.text().catch(() => '');
    throw new Error(`AI request failed (HTTP ${response.status}) ${truncate(detail, 300)}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonLoose(content);

  if (!parsed || !Array.isArray(parsed.evaluations)) {
    throw new Error(`AI returned unparsable payload for ${logContext}`);
  }

  return parsed.evaluations;
}

function normaliseAiEvaluation(entry, engine, price) {
  const score = clamp(Math.round(Number(entry?.dealScore ?? entry?.score ?? 50)), 0, 100);
  const fairPriceValue = Number(entry?.fairPrice);
  const fairPrice = Number.isFinite(fairPriceValue) && fairPriceValue > 0 ? fairPriceValue : null;
  const redFlags = Array.isArray(entry?.redFlags)
    ? entry.redFlags.map((flag) => String(flag)).filter(Boolean).slice(0, 6)
    : [];
  const highlights = Array.isArray(entry?.highlights)
    ? entry.highlights.map((item) => String(item)).filter(Boolean).slice(0, 6)
    : [];

  return {
    dealScore: score,
    verdict: entry?.verdict && ['top', 'good', 'fair', 'overpriced'].includes(entry.verdict)
      ? entry.verdict
      : verdictFor(score),
    fairPrice,
    savingsPct: savingsPct(price, fairPrice),
    reasoning: truncate(String(entry?.reasoning ?? ''), 400),
    redFlags,
    highlights,
    engine,
    evaluatedAt: new Date().toISOString(),
  };
}

/** Reads a cached evaluation out of either a Map or a plain object. */
function lookupKnown(known, id) {
  if (!known) return null;
  if (known instanceof Map) return known.get(String(id)) ?? null;
  return known[String(id)] ?? null;
}

/**
 * Evaluates a batch of listings.
 *
 * Every item always receives a deterministic heuristic evaluation; the AI is
 * only consulted for items that are not already covered by `knownEvaluations`
 * (i.e. the persistent price database). This is what makes "only evaluate what
 * is not in the DB yet" work.
 *
 * @param {object} params
 * @param {Array<{listing: object, priceChanged?: boolean, isNew?: boolean}>} params.items
 * @param {Record<string, object>} params.marketByQuery
 * @param {object} params.config
 * @param {Map<string, object>|Record<string, object>|null} [params.knownEvaluations]
 * @returns {Promise<{
 *   results: Map<string, object>,
 *   heuristicResults: Map<string, object>,
 *   aiEvaluations: Map<string, object>,
 *   engine: string,
 *   aiUsed: boolean,
 *   reused: number,
 *   errors: string[],
 * }>}
 */
export async function evaluateListings({ items, marketByQuery, config, knownEvaluations = null }) {
  const results = new Map();
  const heuristicResults = new Map();
  const aiEvaluations = new Map();
  const errors = [];
  const aiEnabled = Boolean(config.ai.enabled && config.ai.apiKey);
  const engineName = `ai:${config.ai.model}`;

  if (!items.length) {
    return {
      results,
      heuristicResults,
      aiEvaluations,
      engine: aiEnabled ? engineName : 'heuristic',
      aiUsed: false,
      reused: 0,
      errors,
    };
  }

  const indexed = items.map((item, index) => ({
    index,
    listing: item.listing,
    market: marketByQuery?.[item.listing.queryId] ?? null,
    maxDescriptionChars: config.ai.maxDescriptionChars,
    known: lookupKnown(knownEvaluations, item.listing.id),
  }));

  // The heuristic is free and deterministic, so every item gets one.
  for (const item of indexed) {
    heuristicResults.set(item.listing.id, heuristicEvaluate(item.listing, marketByQuery));
  }

  let aiUsed = false;
  let reused = 0;

  if (aiEnabled) {
    const fresh = indexed.filter((item) => !item.known);

    for (const batch of chunk(fresh, config.ai.batchSize)) {
      try {
        const evaluations = await callChatCompletion({
          config,
          items: batch,
          logContext: `${batch.length} listings`,
        });

        for (const evaluation of evaluations) {
          const target = batch.find((item) => item.index === Number(evaluation?.index))
            ?? batch.find((item) => String(evaluation?.id) === item.listing.id);
          if (!target) continue;
          const normalised = normaliseAiEvaluation(evaluation, engineName, target.listing.price);
          results.set(target.listing.id, normalised);
          aiEvaluations.set(target.listing.id, normalised);
        }
        aiUsed = true;
      } catch (error) {
        errors.push(`AI batch failed, using heuristic instead: ${error.message}`);
        log(`AI batch failed: ${error.message}`);
      }
    }

    // Listings already present in the price database reuse their stored verdict.
    for (const item of indexed) {
      if (!item.known) continue;
      results.set(item.listing.id, item.known);
      reused += 1;
    }
  }

  for (const item of indexed) {
    if (results.has(item.listing.id)) continue;
    results.set(item.listing.id, heuristicResults.get(item.listing.id));
  }

  return {
    results,
    heuristicResults,
    aiEvaluations,
    engine: (aiUsed || reused > 0) ? engineName : 'heuristic',
    aiUsed,
    reused,
    errors,
  };
}