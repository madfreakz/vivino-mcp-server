import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import * as dotenv from 'dotenv';
dotenv.config();

import {
  VIVINO_BASE_URL,
  VIVINO_API_BASE,
  USER_AGENT,
  MIN_REQUEST_INTERVAL_MS,
  RETRY_AFTER_429_MS,
  RETRY_AFTER_5XX_MS,
  CACHE_TTL_WINE_DETAILS_MS,
  CACHE_TTL_TASTE_MS,
  DEFAULT_USERNAME,
} from './constants';

// ---- In-memory cache ----
interface CacheEntry<T> { data: T; expiresAt: number; }
const cache = new Map<string, CacheEntry<unknown>>();

async function getCached<T>(key: string, fetcher: () => Promise<T>, ttlMs: number): Promise<T> {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data as T;
  const data = await fetcher();
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  return data;
}

// ---- Rate limiter ----
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

// ---- Headers ----
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${VIVINO_BASE_URL}/en/users/${DEFAULT_USERNAME}`,
    'Origin': VIVINO_BASE_URL,
    ...extra,
  };
  const cookie = process.env.VIVINO_SESSION_COOKIE;
  if (cookie) h['Cookie'] = cookie;
  return h;
}

function xhrHeaders(csrf: string, extra: Record<string, string> = {}): Record<string, string> {
  return baseHeaders({
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-Token': csrf,
    'Accept': 'text/javascript, application/javascript',
    ...extra,
  });
}

// ---- Retry ----
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  await throttle();
  try {
    return await fn();
  } catch (err) {
    const e = err as AxiosError;
    if (e.response?.status === 429) {
      const wait = Number(e.response.headers['retry-after'] ?? 0) * 1000 || RETRY_AFTER_429_MS;
      await new Promise(r => setTimeout(r, wait));
      await throttle();
      return fn();
    }
    if (e.response && e.response.status >= 500) {
      await new Promise(r => setTimeout(r, RETRY_AFTER_5XX_MS));
      await throttle();
      return fn();
    }
    throw err;
  }
}

// ---- Session / user ID ----
let resolvedUserId: number | null = null;

export async function resolveUserId(): Promise<number> {
  if (resolvedUserId !== null) return resolvedUserId;

  const envId = process.env.VIVINO_USER_ID;
  if (envId && !isNaN(Number(envId)) && Number(envId) > 0) {
    resolvedUserId = Number(envId);
    return resolvedUserId;
  }

  if (!process.env.VIVINO_SESSION_COOKIE) {
    throw new Error(
      'Vivino requires authentication. Set VIVINO_SESSION_COOKIE in the MCP server env.\n\n' +
      'How to get it:\n' +
      '1. Log into vivino.com in Chrome\n' +
      '2. Open DevTools (⌘+Option+I) → Application tab → Cookies → https://www.vivino.com\n' +
      '3. Copy the "_vivino_production_session" value\n' +
      '4. Set VIVINO_SESSION_COOKIE=<that value> in Claude Desktop config env block\n' +
      '5. Also set VIVINO_USER_ID=<your_user_id> to skip auto-resolution'
    );
  }

  const res = await withRetry(() =>
    axios.get(`${VIVINO_API_BASE}/session`, { headers: baseHeaders({ Accept: 'application/json' }), timeout: 10_000 })
  );
  const id = (res.data?.user_session as Record<string, unknown> | undefined)?.id;
  if (id && Number(id) > 0) {
    resolvedUserId = Number(id);
    return resolvedUserId;
  }
  throw new Error('Could not resolve Vivino user ID from /api/session. Check VIVINO_SESSION_COOKIE.');
}

// ---- CSRF token ----
let cachedCsrf: string | null = null;

export async function fetchCsrfToken(): Promise<string> {
  if (cachedCsrf) return cachedCsrf;

  const res = await withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/en/users/${DEFAULT_USERNAME}`, {
      headers: baseHeaders(),
      timeout: 15_000,
    })
  );
  const html: string = res.data;
  const match = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/);
  if (!match) throw new Error('Could not extract CSRF token from Vivino profile page. Check VIVINO_SESSION_COOKIE.');
  cachedCsrf = match[1];
  return cachedCsrf;
}

export function invalidateCsrf(): void {
  cachedCsrf = null;
}

// ---- Activities (ratings) ----
// Returns the raw jQuery/HTML response body.
// Uses user ID in the path and start_from_id for cursor pagination (discovered via browser network inspection).
export async function fetchActivities(limit: number, startFrom?: string): Promise<string> {
  const csrf = await fetchCsrfToken();
  const userId = await resolveUserId();
  const params: Record<string, string | number> = { limit };
  if (startFrom) params['start_from_id'] = startFrom;

  try {
    const res = await withRetry(() =>
      axios.get(`${VIVINO_BASE_URL}/users/${userId}/activities`, {
        params,
        headers: xhrHeaders(csrf),
        timeout: 20_000,
      })
    );
    return String(res.data);
  } catch (err) {
    const e = err as AxiosError;
    if (e.response?.status === 422) {
      // CSRF expired — invalidate and retry once
      invalidateCsrf();
      const freshCsrf = await fetchCsrfToken();
      const res = await withRetry(() =>
        axios.get(`${VIVINO_BASE_URL}/users/${userId}/activities`, {
          params,
          headers: xhrHeaders(freshCsrf),
          timeout: 20_000,
        })
      );
      return String(res.data);
    }
    throw err;
  }
}

// ---- Wine detail API (may work with valid session cookie) ----
const apiHttp = axios.create({
  baseURL: VIVINO_API_BASE,
  timeout: 15_000,
  headers: baseHeaders({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
});

// ---- Wine details (scraped from the server-rendered wine page) ----
// IMPORTANT: /api/wines/{id} is DEAD — it 404s for every wine (verified 2026-11).
// The wine page embeds the full wine object as HTML-encoded JSON in a React
// props attribute (`data-ssr-props` → `pageInformation.wine`), so we fetch the page and read that.
// /w/{id} 302s to the canonical slug URL, so a wine ID alone is enough.
// Fallback if the props blob moves: regex the real vintage ID out of the page
// (`"vintage":{"id":N}`) and call /api/vintages/{N}, which still works.
export function extractPageInformation(html: string): Record<string, unknown> | null {
  const $ = cheerio.load(html);
  let found: Record<string, unknown> | null = null;
  $('[data-ssr-props], [data-react-props]').each((_, el) => {
    if (found) return;
    const raw = $(el).attr('data-ssr-props') ?? $(el).attr('data-react-props');
    if (!raw || !raw.includes('pageInformation')) return;
    try {
      const props = JSON.parse(raw) as Record<string, unknown>;
      const pi = props.pageInformation as Record<string, unknown> | undefined;
      if (pi?.wine) found = pi;
    } catch { /* not JSON — keep looking */ }
  });
  return found;
}

export async function fetchWineDetails(wineId: number, wineUrl?: string | null): Promise<unknown> {
  const pagePath = wineUrl || `/w/${wineId}`;
  return getCached(`wine:${pagePath}`, async () => {
    const res = await withRetry(() =>
      axios.get(`${VIVINO_BASE_URL}${pagePath}`, { headers: baseHeaders(), timeout: 20_000 })
    );
    const html = String(res.data);
    const finalUrl: string | undefined = res.request?.res?.responseUrl;
    const vivinoUrl = (finalUrl ?? `${VIVINO_BASE_URL}/w/${wineId}`).split('?')[0];

    const pi = extractPageInformation(html);
    if (pi) return { wine: pi.wine, vivino_url: vivinoUrl };

    const m = html.match(/"vintage":\{"id":(\d+)/);
    if (!m) throw new Error(`Could not extract wine data from Vivino page: ${pagePath}`);
    const vres = await withRetry(() => apiHttp.get(`/vintages/${m[1]}`));
    return { ...(vres.data as Record<string, unknown>), vivino_url: vivinoUrl };
  }, CACHE_TTL_WINE_DETAILS_MS);
}

export async function fetchWineTastes(wineId: number): Promise<unknown> {
  return getCached(`tastes:${wineId}`, async () => {
    const res = await withRetry(() => apiHttp.get(`/wines/${wineId}/tastes`));
    return res.data;
  }, CACHE_TTL_TASTE_MS);
}

export async function fetchWineReviews(wineId: number, page: number, perPage: number): Promise<unknown> {
  await throttle();
  const res = await withRetry(() =>
    apiHttp.get(`/wines/${wineId}/reviews`, { params: { per_page: perPage, page } })
  );
  return res.data;
}

// ---- Wine text search (server-rendered HTML page) ----
// IMPORTANT: /api/explore/explore IGNORES the `q` text query — it's a discovery
// feed that returns the same wines (cult Cabernets) for any query. Vivino's real
// text search is the server-rendered page /search/wines?q= (302s to
// /en/explore?search_term=). We fetch that HTML and let the caller parse the
// result cards (see parseVivinoSearchHtml in tools/search.ts). Returns raw HTML.
export async function fetchWineSearch(query: string): Promise<string> {
  const res = await withRetry(() =>
    axios.get(`${VIVINO_BASE_URL}/search/wines`, {
      params: { q: query },
      headers: baseHeaders(),
      timeout: 20_000,
    })
  );
  return String(res.data);
}

export function clearCache(): void {
  cache.clear();
  resolvedUserId = null;
  cachedCsrf = null;
}
