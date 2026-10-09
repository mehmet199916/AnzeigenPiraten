/**
 * Loads `config/dealfinder.config.json`, applies defaults and lets a handful of
 * environment variables override the values that must stay out of the repo
 * (API keys, model names, base URLs).
 */

import { readFile } from 'node:fs/promises';

export const CONFIG_DEFAULTS = {
  currency: 'EUR',
  searches: [],
  http: {
    requestDelayMs: 1200,
    timeoutMs: 20000,
    attempts: 3,
    enrichDetails: false,
  },
  ai: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    batchSize: 8,
    maxClassificationsPerRun: 80,
    maxDescriptionChars: 700,
    timeoutMs: 60000,
    // Optional reasoning_effort for OpenAI-compatible classification endpoints.
    reasoningEffort: '',
  },
  output: {
    maxDeals: 600,
    maxAgeHours: 336,
  },
  state: {
    maxSeenIds: 40000,
  },
  database: {
    maxEntries: 20000,
    maxAgeDays: 90,
    // Per-listing price-history points kept in data/prices.json.
    // 0 = keep the full history forever (points are never overwritten).
    historyMaxPointsPerListing: 0,
    // Collected prices needed before the observed average is used as reference.
    minSamplesForReference: 1,
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively merges `source` into `target`, returning a new object. */
export function deepMerge(target, source) {
  if (!isPlainObject(target)) return source;
  if (!isPlainObject(source)) return source ?? target;

  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    result[key] = isPlainObject(value) && isPlainObject(target[key])
      ? deepMerge(target[key], value)
      : value;
  }
  return result;
}

/** Normalises a single search definition so the rest of the code can rely on it. */
export function normaliseSearch(search, index) {
  const keywords = String(search?.keywords ?? '').trim();
  if (!keywords) {
    throw new Error(`searches[${index}] is missing "keywords"`);
  }

  return {
    id: String(search.id ?? keywords).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: String(search.label ?? keywords).trim(),
    keywords,
    categoryId: String(search.categoryId ?? ''),
    locationId: String(search.locationId ?? ''),
    radius: String(search.radius ?? ''),
    minPrice: String(search.minPrice ?? ''),
    maxPrice: String(search.maxPrice ?? ''),
    adType: String(search.adType ?? 'OFFER'),
    posterType: String(search.posterType ?? ''),
    sortingField: String(search.sortingField ?? 'SORTING_DATE'),
    maxPages: Math.max(1, Math.min(5, Number(search.maxPages) || 1)),
  };
}

function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * @param {string} configPath absolute path to the JSON config file
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function loadConfig(configPath, env = process.env) {
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  const config = deepMerge(CONFIG_DEFAULTS, parsed);

  config.searches = (config.searches ?? []).map(normaliseSearch);
  config.ai.baseUrl = String(env.AI_BASE_URL || config.ai.baseUrl).replace(/\/+$/, '');
  config.ai.model = String(env.AI_MODEL || config.ai.model);
  config.ai.apiKey = String(env.AI_API_KEY || env.OPENAI_API_KEY || '');
  config.ai.reasoningEffort = String(env.AI_REASONING_EFFORT || config.ai.reasoningEffort || '');
  // Ollama ignores the bearer token, but the shared AI path uses a non-empty
  // key as its enabled signal. Only supply a placeholder for loopback hosts.
  if (!config.ai.apiKey && isLoopbackUrl(config.ai.baseUrl)) config.ai.apiKey = 'ollama';
  config.ai.enabled = Boolean(config.ai.enabled);

  return config;
}

/** Whether the AI path can actually be used for this run. */
export function aiIsConfigured(config) {
  return Boolean(config?.ai?.enabled && config?.ai?.apiKey);
}
