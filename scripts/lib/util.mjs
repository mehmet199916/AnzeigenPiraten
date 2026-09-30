/**
 * Small, dependency-free helpers shared by the scanner.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function nowIso() {
  return new Date().toISOString();
}

export function log(...args) {
  console.log(`[${nowIso()}]`, ...args);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min, max) {
  return Math.round(min + Math.random() * (max - min));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toNumber(value) {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(num) ? num : null;
}

export function chunk(array, size) {
  const sizeSafe = Math.max(1, Math.floor(size) || 1);
  const out = [];
  for (let i = 0; i < array.length; i += sizeSafe) {
    out.push(array.slice(i, i + sizeSafe));
  }
  return out;
}

export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Median of a numeric array (ignores null/NaN). Returns null for empty input. */
export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
}

export function quantile(values, q) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const pos = clamp(q, 0, 1) * (nums.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return nums[lower];
  return nums[lower] + (nums[upper] - nums[lower]) * (pos - lower);
}

export function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Ensures the output directory exists. */
export async function ensureDir(dir, fsPromises) {
  await fsPromises.mkdir(dir, { recursive: true });
}

/**
 * fetch() with retries, a browser-like User-Agent and a hard timeout.
 * Retries on network errors, HTTP 429 and 5xx responses.
 */
export async function fetchWithRetry(url, options = {}, retryConfig = {}) {
  const {
    attempts = 3,
    baseDelayMs = 800,
    timeoutMs = 20000,
    headers = {},
    fetchImpl = globalThis.fetch,
  } = retryConfig;

  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: 'follow',
        ...options,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'de-DE,de;q=0.9,en;q=0.6',
          ...headers,
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after'));
        lastError = new Error(`HTTP ${response.status} for ${url}`);
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * attempt;
        await sleep(waitMs);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(baseDelayMs * attempt);
      }
    }
  }

  throw lastError ?? new Error(`Request failed: ${url}`);
}