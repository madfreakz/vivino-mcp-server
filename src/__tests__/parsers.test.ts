import { describe, it, expect } from 'vitest';
import { parseTasteProfile, parseWineDetails } from '../tools/wines';
import { parseVivinoSearchHtml } from '../tools/search';
import { extractPageInformation } from '../client';

describe('parseTasteProfile', () => {
  it('normalizes Vivino 0–5 scale to 0–1', () => {
    const raw = { tastes: { structure: { acidity: 3.5, sweetness: 1.0, tannin: 2.5, intensity: 4.0, fizziness: 0.5 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(0.7);
    expect(result.structure.sweetness).toBe(0.2);
    expect(result.structure.tannin).toBe(0.5);
    expect(result.structure.intensity).toBe(0.8);
    expect(result.structure.fizziness).toBe(0.1);
  });

  it('clamps negative values to 0 (the original crash trigger)', () => {
    const raw = { tastes: { structure: { acidity: -3.1, sweetness: -0.5, tannin: -0.001 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(0);
    expect(result.structure.sweetness).toBe(0);
    expect(result.structure.tannin).toBe(0);
  });

  it('clamps values above the 0–5 scale to 1', () => {
    const raw = { tastes: { structure: { acidity: 6.2, intensity: 7.5 }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBe(1);
    expect(result.structure.intensity).toBe(1);
  });

  it('keeps null fields as null', () => {
    const raw = { tastes: { structure: { acidity: null, sweetness: undefined }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.sweetness).toBeNull();
  });

  it('returns all nulls when structure key is missing', () => {
    const raw = { tastes: { flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.fizziness).toBeNull();
  });

  it('handles d.tastes = null by falling back to d (??  operator)', () => {
    // null ?? d → d; structure would be {} → all nulls
    const raw = { tastes: null };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
  });

  it('returns NaN values as null (non-finite check)', () => {
    const raw = { tastes: { structure: { acidity: NaN, intensity: Infinity }, flavor: [] } };
    const result = parseTasteProfile(raw);
    expect(result.structure.acidity).toBeNull();
    expect(result.structure.intensity).toBeNull();
  });

  it('parses flavor groups', () => {
    const raw = {
      tastes: {
        structure: {},
        flavor: [
          { group: 'fruit', primary_keywords: [{ name: 'cherry' }, { name: 'plum' }] },
          { group: 'spice', primary_keywords: [{ name: 'pepper' }] },
        ],
      },
    };
    const result = parseTasteProfile(raw);
    expect(result.flavor_groups).toHaveLength(2);
    expect(result.flavor_groups[0].group).toBe('fruit');
    expect(result.flavor_groups[0].primary_keywords).toEqual(['cherry', 'plum']);
  });
});

describe('parseWineDetails', () => {
  const validRaw = {
    wine: {
      id: 12345,
      name: 'Cabernet Sauvignon',
      winery: { name: 'Chateau Test' },
      region: { name: 'Napa Valley', country: { name: 'United States' } },
      grapes: [{ name: 'Cabernet Sauvignon' }, { name: 'Merlot' }],
      alcohol: 14.5,
      statistics: { ratings_average: 4.2, ratings_count: 1500 },
      food: [{ name: 'beef' }, { name: 'lamb' }],
      style: { description: 'Full-bodied red with dark fruit' },
      seo_name: 'chateau-test-cabernet-sauvignon',
    },
  };

  it('parses a complete valid API response', () => {
    const result = parseWineDetails(validRaw);
    expect(result.wine_id).toBe(12345);
    expect(result.name).toBe('Cabernet Sauvignon');
    expect(result.winery).toBe('Chateau Test');
    expect(result.region).toBe('Napa Valley');
    expect(result.country).toBe('United States');
    expect(result.grape_varieties).toEqual(['Cabernet Sauvignon', 'Merlot']);
    expect(result.abv).toBe(14.5);
    expect(result.avg_rating).toBe(4.2);
    expect(result.ratings_count).toBe(1500);
    expect(result.food_pairings).toEqual(['beef', 'lamb']);
    expect(result.style_description).toBe('Full-bodied red with dark fruit');
    expect(result.vivino_url).toBe('https://www.vivino.com/w/12345');
  });

  it('returns nulls and empty arrays for missing optional fields', () => {
    const raw = { wine: { id: 1, name: 'Mystery', winery: { name: 'Unknown' } } };
    const result = parseWineDetails(raw);
    expect(result.region).toBeNull();
    expect(result.country).toBeNull();
    expect(result.grape_varieties).toEqual([]);
    expect(result.abv).toBeNull();
    expect(result.avg_rating).toBeNull();
    expect(result.ratings_count).toBeNull();
    expect(result.food_pairings).toEqual([]);
    expect(result.style_description).toBeNull();
    expect(result.image_url).toBeNull();
  });

  it('parses the wine-page shape (foods, protocol-relative image, captured URL)', () => {
    const raw = {
      vivino_url: 'https://www.vivino.com/en/us-anthill-farms-pinot-noir/w/7410659',
      wine: {
        id: 7410659, name: 'Pinot Noir', seo_name: 'pinot-noir',
        winery: { name: 'Anthill Farms' },
        region: { name: 'North Coast', country: { name: 'United States' } },
        statistics: { ratings_average: 4.1, ratings_count: 355 },
        foods: [{ name: 'Beef' }, { name: 'Poultry' }],
        image: { location: '//images.vivino.com/thumbs/abc_pl_480x640.png' },
        alcohol: 13,
      },
    };
    const result = parseWineDetails(raw);
    expect(result.vivino_url).toBe('https://www.vivino.com/en/us-anthill-farms-pinot-noir/w/7410659');
    expect(result.food_pairings).toEqual(['Beef', 'Poultry']);
    expect(result.image_url).toBe('https://images.vivino.com/thumbs/abc_pl_480x640.png');
    expect(result.avg_rating).toBe(4.1);
  });

  it('handles top-level wine object (no wrapper)', () => {
    const raw = { id: 99, name: 'Flat Wine', winery: { name: 'Flat Winery' } };
    const result = parseWineDetails(raw);
    expect(result.wine_id).toBe(99);
    expect(result.name).toBe('Flat Wine');
  });
});

describe('parseVivinoSearchHtml', () => {
  // Card markup captured from a live /search/wines?q= response (302s to
  // /en/explore). Each result is a `data-testid="vintagePageLink"` anchor
  // (href .../w/<id>) followed by a standalone `wineInfoVintage__truncate--<hash>`
  // winery div and a `wineInfoVintage__vintage--<hash>` name div. The hash
  // suffixes change per Vivino build. Vivino renders one card per vintage, so the
  // same wine_id repeats (the base/vintage-less card comes first). Includes an
  // entity (&amp;) and a malformed card (no winery/name) that must be skipped.
  const SEARCH_HTML = `
  <div class="explore">
    <a data-testid="vintagePageLink" href="/en/meiomi-pinot-noir/w/1136137?year=U.V.&price_id=1">
      <div class="wineInfoVintage__truncate--JwXCa">Meiomi</div>
      <div class="wineInfoVintage__vintage--2UdfY wineInfoVintage__truncate--JwXCa">Pinot Noir</div>
    </a>
    <a data-testid="vintagePageLink" href="/en/meiomi-pinot-noir/w/1136137?year=2021&price_id=2">
      <div class="wineInfoVintage__truncate--JwXCa">Meiomi</div>
      <div class="wineInfoVintage__vintage--2UdfY wineInfoVintage__truncate--JwXCa">Pinot Noir 2021</div>
    </a>
    <a data-testid="vintagePageLink" href="/en/caymus-cabernet-sauvignon/w/4242?price_id=3">
      <div class="wineInfoVintage__truncate--JwXCa">Caymus &amp; Sons</div>
      <div class="wineInfoVintage__vintage--2UdfY wineInfoVintage__truncate--JwXCa">Cabernet Sauvignon</div>
    </a>
    <a data-testid="vintagePageLink" href="/en/broken/w/9999"><div>no winery or name div</div></a>
  </div>`;

  it('extracts wine id, winery, name, and URL from a result card', () => {
    const results = parseVivinoSearchHtml(SEARCH_HTML);
    expect(results[0]).toEqual({
      wine_id: 1136137,
      name: 'Pinot Noir',
      winery: 'Meiomi',
      vivino_url: 'https://www.vivino.com/en/meiomi-pinot-noir/w/1136137',
    });
  });

  it('dedupes repeated vintages of the same wine, keeping the first card', () => {
    const results = parseVivinoSearchHtml(SEARCH_HTML);
    const meiomi = results.filter((r) => r.wine_id === 1136137);
    expect(meiomi).toHaveLength(1);
    expect(meiomi[0].name).toBe('Pinot Noir'); // base card, not "Pinot Noir 2021"
  });

  it('skips cards missing a winery or name div', () => {
    const results = parseVivinoSearchHtml(SEARCH_HTML);
    expect(results.some((r) => r.wine_id === 9999)).toBe(false);
    expect(results).toHaveLength(2); // Meiomi (deduped) + Caymus
  });

  it('decodes HTML entities in winery/name text', () => {
    const results = parseVivinoSearchHtml(SEARCH_HTML);
    const caymus = results.find((r) => r.wine_id === 4242);
    expect(caymus?.winery).toBe('Caymus & Sons');
  });

  it('matches the stable class prefix regardless of the per-build hash suffix', () => {
    const rehashed = SEARCH_HTML.replace(/JwXCa/g, 'ZZ999').replace(/2UdfY/g, 'QQ111');
    const results = parseVivinoSearchHtml(rehashed);
    expect(results[0].winery).toBe('Meiomi');
    expect(results[0].name).toBe('Pinot Noir');
  });

  it('returns [] for non-result HTML', () => {
    expect(parseVivinoSearchHtml('<html><body>no results</body></html>')).toEqual([]);
    expect(parseVivinoSearchHtml('')).toEqual([]);
  });
});

describe('extractPageInformation', () => {
  it('decodes pageInformation from an HTML-encoded data-react-props attribute', () => {
    const props = { locale: 'en', pageInformation: { wine: { id: 7, name: 'Tom &amp; "Jerry"' } } };
    const enc = JSON.stringify(props).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const html = `<div data-ssr-props="{&quot;other&quot;:1}"></div><div data-ssr-props="${enc}"></div>`;
    const pi = extractPageInformation(html);
    expect((pi?.wine as Record<string, unknown>).id).toBe(7);
    expect((pi?.wine as Record<string, unknown>).name).toBe('Tom &amp; "Jerry"');
  });

  it('returns null when no pageInformation blob exists', () => {
    expect(extractPageInformation('<html><body>nothing</body></html>')).toBeNull();
  });
});
