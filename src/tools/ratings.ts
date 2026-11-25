import { z } from 'zod';
import * as cheerio from 'cheerio';
import { resolveUserId, fetchActivities } from '../client';
import { VivinoUserRating } from '../types';
import { MAX_PER_PAGE, DEFAULT_PER_PAGE } from '../constants';

export const ratingsInputSchema = {
  page: z.number().int().min(1).default(1)
    .describe('Page number (1-based). Each page fetches up to per_page activities from Vivino.'),
  per_page: z.number().int().min(1).max(MAX_PER_PAGE).default(DEFAULT_PER_PAGE)
    .describe('Number of ratings per page (max 100)'),
  min_rating: z.number().min(1).max(5).optional()
    .describe('Filter: only return wines rated at or above this score (1.0–5.0)'),
  max_rating: z.number().min(1).max(5).optional()
    .describe('Filter: only return wines rated at or below this score (1.0–5.0)'),
  since: z.string().optional()
    .describe('ISO 8601 date — only return ratings newer than this date (e.g. "2025-01-01")'),
  start_from: z.string().optional()
    .describe('Activity ID to paginate from (returned as next_start_from in previous response). Leave empty for first page.'),
};

// Extract HTML from jQuery .append('...') response
function extractHtml(body: string): string {
  const start = body.indexOf(".append('");
  if (start === -1) return body; // may already be raw HTML
  const contentStart = start + ".append('".length;
  const end = body.lastIndexOf("');");
  const escaped = body.slice(contentStart, end === -1 ? undefined : end);
  return escaped
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// Parse "Sat, Mar 28th at 17:26:00 UTC" → ISO string.
// Vivino titles omit the year, so we try the current year and walk back until the date is not in the future.
function parseVivinoDate(title: string): string {
  try {
    const cleaned = title
      .replace(/(\d+)(st|nd|rd|th)/g, '$1')
      .replace(' at ', ' ');
    const now = new Date();
    for (let offset = 0; offset <= 10; offset++) {
      const year = now.getFullYear() - offset;
      // Insert year after the day number: "Sat, Mar 28 17:26:00 UTC" → "Sat, Mar 28 2026 17:26:00 UTC"
      const withYear = cleaned.replace(/^(\w+,\s+\w+\s+\d+)/, `$1 ${year}`);
      const d = new Date(withYear);
      if (!isNaN(d.getTime()) && d <= now) return d.toISOString();
    }
  } catch { /* fall through */ }
  return new Date().toISOString();
}

export function parseActivitiesBody(body: string): { ratings: VivinoUserRating[]; lastActivityId: string | null } {
  const html = extractHtml(body);
  const $ = cheerio.load(html);
  const ratings: VivinoUserRating[] = [];
  let lastActivityId: string | null = null;

  $('[id^="user-activity-"]').each((_, el) => {
    const item = $(el);
    const actId = (item.attr('id') ?? '').replace('user-activity-', '');
    if (actId) lastActivityId = actId;

    // Star rating: sum icon-{N}-pct values (each represents N/100 of a star fill)
    let rating = 0;
    item.find('[class*="icon-"][class*="-pct"]').each((_, icon) => {
      const cls = $(icon).attr('class') ?? '';
      const m = cls.match(/icon-(\d+)-pct/);
      if (m) rating += parseInt(m[1]) / 100;
    });
    rating = Math.round(rating * 10) / 10;

    // Skip non-rating activities (e.g. cellar additions with 0 rating)
    if (rating === 0) return;

    // Wine card: links are [0]=wine page, [1]=winery, [2]=wine name, [3]=region, [4]=country
    const card = item.find('.activity-wine-card');
    const links = card.find('a');
    const wineUrl = links.eq(0).attr('href') ?? null;
    const winery = links.eq(1).text().trim();
    const wineName = links.eq(2).text().trim();
    const region = links.eq(3).text().trim();
    const country = links.eq(4).text().trim();

    if (!winery || !wineName) return;

    // Wine ID from URL: /en/{seo}/w/{id}
    const wineIdMatch = wineUrl?.match(/\/w\/(\d+)/);
    const wineId = wineIdMatch ? parseInt(wineIdMatch[1]) : 0;

    // Vintage: first 4-digit year in text
    const fullText = item.text();
    const vintageMatch = fullText.match(/\b(19|20)\d{2}\b/);
    const vintage = vintageMatch ? parseInt(vintageMatch[0]) : null;

    // Rated at: from the time link's title attribute
    const timeTitle = item.find('a[title]').first().attr('title') ?? '';
    const ratedAt = timeTitle ? parseVivinoDate(timeTitle) : new Date().toISOString();

    // User notes: look for a review/note block
    const noteText = item.find('.activity-note, .note-text, [class*="tasting-note"]').text().trim() || null;

    ratings.push({
      wine_id: wineId,
      wine_name: wineName,
      winery_name: winery,
      vintage,
      user_rating: rating,
      user_notes: noteText,
      rated_at: ratedAt,
      wine_url: wineUrl,
    });
  });

  return { ratings, lastActivityId };
}

export async function getUserRatings(args: {
  page: number;
  per_page: number;
  min_rating?: number;
  max_rating?: number;
  since?: string;
  start_from?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    await resolveUserId(); // validates auth early
    const body = await fetchActivities(args.per_page, args.start_from);
    let { ratings, lastActivityId } = parseActivitiesBody(body);

    if (args.min_rating !== undefined) ratings = ratings.filter(r => r.user_rating >= args.min_rating!);
    if (args.max_rating !== undefined) ratings = ratings.filter(r => r.user_rating <= args.max_rating!);
    if (args.since) {
      const sinceMs = new Date(args.since).getTime();
      ratings = ratings.filter(r => new Date(r.rated_at).getTime() > sinceMs);
    }

    const result = {
      page: args.page,
      per_page: args.per_page,
      count: ratings.length,
      next_start_from: lastActivityId,
      // Vivino ignores `limit` (returns ~10 activities per call), so has_more is
      // driven by the cursor: Vivino returns no activities once exhausted.
      has_more: lastActivityId !== null,
      ratings,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching ratings: ${message}` }] };
  }
}
