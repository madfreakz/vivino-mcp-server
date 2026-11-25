import { z } from 'zod';
import { fetchWineSearch } from '../client';
import { VivinoSearchResult } from '../types';

export const searchInputSchema = {
  query: z.string().min(1)
    .describe('Search term: wine name, winery, region, grape variety, or style'),
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based) over the matched wines'),
  per_page: z.number().int().min(1).max(50).default(25)
    .describe('Results per page (max 50)'),
};

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&rsquo;': "'",
  '&nbsp;': ' ',
};
/** Decode the handful of HTML entities that show up in winery/name text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => HTML_ENTITIES[e] ?? e);
}

/**
 * Parse Vivino's server-rendered search HTML (/search/wines?q=… → /en/explore)
 * into wine results. Each result card is an anchor `data-testid="vintagePageLink"`
 * with `href="/<lang>/<slug>/w/<wineId>"`, a standalone
 * `wineInfoVintage__truncate--<hash>` winery div, and a
 * `wineInfoVintage__vintage--<hash>` name div. The CSS hash suffixes change per
 * Vivino build, so we match on the stable class prefixes. Vivino renders one card
 * per vintage, so the same wine_id repeats — we dedupe, keeping the first (the
 * vintage-less base card). Skips cards missing any of id / winery / name.
 */
export function parseVivinoSearchHtml(html: string): VivinoSearchResult[] {
  const results: VivinoSearchResult[] = [];
  const seen = new Set<number>();
  for (const card of html.split('data-testid="vintagePageLink"').slice(1)) {
    const idStr = card.match(/\/w\/(\d+)/)?.[1];
    const winery = card.match(/class="wineInfoVintage__truncate--\w+">([^<]+)</)?.[1];
    const name = card.match(/class="wineInfoVintage__vintage--\w+[^"]*">([^<]+)</)?.[1];
    if (!idStr || !winery || !name) continue;
    const wine_id = Number(idStr);
    if (seen.has(wine_id)) continue;
    seen.add(wine_id);
    const href = card.match(/href="(\/[a-z]{2}\/[^"]+?\/w\/\d+)/)?.[1];
    results.push({
      wine_id,
      name: decodeEntities(name).trim(),
      winery: decodeEntities(winery).trim(),
      vivino_url: href ? `https://www.vivino.com${href}` : null,
    });
  }
  return results;
}

export async function searchWines(args: {
  query: string;
  page: number;
  per_page: number;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const html = await fetchWineSearch(args.query);
    const all = parseVivinoSearchHtml(html);
    const start = (args.page - 1) * args.per_page;
    const results = all.slice(start, start + args.per_page);
    const result = {
      query: args.query,
      page: args.page,
      per_page: args.per_page,
      total_matches: all.length,
      has_more: start + args.per_page < all.length,
      results,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error searching wines: ${message}` }] };
  }
}
