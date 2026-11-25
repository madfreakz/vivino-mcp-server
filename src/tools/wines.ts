import { z } from 'zod';
import { fetchWineDetails, fetchWineTastes } from '../client';
import { VivinoWineDetails, VivinoTasteProfile } from '../types';

export const wineDetailsInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID (numeric). Obtain from vivino_get_user_ratings or vivino_search_wines.'),
};

export const tasteProfileInputSchema = {
  wine_id: z.number().int().positive()
    .describe('Vivino wine ID (numeric). Obtain from vivino_get_user_ratings or vivino_search_wines.'),
};

export function parseWineDetails(raw: unknown): VivinoWineDetails {
  const d = raw as Record<string, unknown>;
  // Vintage endpoint returns { vintage: { wine: {...}, statistics: {...} } }
  const vintageObj = d.vintage as Record<string, unknown> | undefined;
  const wine = (vintageObj?.wine ?? d.wine ?? d) as Record<string, unknown>;
  const winery = wine.winery as Record<string, unknown> | undefined;
  const region = wine.region as Record<string, unknown> | undefined;
  const country = region?.country as Record<string, unknown> | undefined;
  const stats = (vintageObj?.statistics ?? wine.statistics) as Record<string, unknown> | undefined;
  const grapes = (wine.grapes as Array<Record<string, unknown>>) ?? [];
  // Wine page / vintage API use `foods`; older API responses used `food`.
  const food = ((wine.foods ?? wine.food) as Array<Record<string, unknown>>) ?? [];
  const style = wine.style as Record<string, unknown> | undefined;

  return {
    wine_id: Number(wine.id),
    name: String(wine.name ?? ''),
    winery: String(winery?.name ?? ''),
    region: region ? String(region.name) : null,
    country: country ? String(country.name) : null,
    grape_varieties: grapes.map(g => String(g.name ?? '')).filter(Boolean),
    abv: wine.alcohol != null ? Number(wine.alcohol) : null,
    avg_rating: stats?.ratings_average != null ? Number(stats.ratings_average) : null,
    ratings_count: stats?.ratings_count != null ? Number(stats.ratings_count) : null,
    style_description: style?.description ? String(style.description) : null,
    food_pairings: food.map(f => String(f.name ?? '')).filter(Boolean),
    image_url: normalizeImageUrl(
      wine.label_image_url ??
      (wine.image as Record<string, unknown> | undefined)?.location ??
      (vintageObj?.image as Record<string, unknown> | undefined)?.location
    ),
    // Prefer the canonical page URL captured by fetchWineDetails. wine.seo_name is
    // only the wine's own slug (e.g. "pinot-noir"), not a routable path, so fall
    // back to /w/{id}, which Vivino redirects to the canonical page.
    vivino_url: typeof d.vivino_url === 'string' ? d.vivino_url
      : wine.id != null ? `https://www.vivino.com/w/${wine.id}` : null,
  };
}

function normalizeImageUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return v.startsWith('//') ? `https:${v}` : v;
}

function normalizeTasteVal(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  // Vivino returns structure values on a 0–5 scale
  return Math.max(0, Math.min(1, n / 5));
}

export function parseTasteProfile(raw: unknown): VivinoTasteProfile {
  const d = raw as Record<string, unknown>;
  const tastes = (d.tastes ?? d) as Record<string, unknown>;
  const structure = (tastes.structure ?? {}) as Record<string, unknown>;
  const flavors = (tastes.flavor ?? []) as Array<Record<string, unknown>>;

  return {
    structure: {
      acidity: normalizeTasteVal(structure.acidity),
      fizziness: normalizeTasteVal(structure.fizziness),
      intensity: normalizeTasteVal(structure.intensity),
      sweetness: normalizeTasteVal(structure.sweetness),
      tannin: normalizeTasteVal(structure.tannin),
    },
    flavor_groups: flavors.map(group => ({
      group: String(group.group ?? ''),
      primary_keywords: ((group.primary_keywords ?? []) as Array<Record<string, unknown>>)
        .map(k => String(k.name ?? '')).filter(Boolean),
    })).filter(g => g.group),
  };
}

export async function getWineDetails(
  args: { wine_id: number }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineDetails(args.wine_id);
    const details = parseWineDetails(raw);
    return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching wine details: ${message}` }] };
  }
}

export async function getWineTasteProfile(
  args: { wine_id: number }
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const raw = await fetchWineTastes(args.wine_id);
    const profile = parseTasteProfile(raw);
    return { content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error fetching taste profile: ${message}` }] };
  }
}
