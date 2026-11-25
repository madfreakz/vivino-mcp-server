import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// vi.hoisted runs before vi.mock hoisting, so these are safe to reference in factories
const { mockResolveUserId, mockFetchActivities, mockFetchWineDetails, mockFetchWineTastes } = vi.hoisted(() => ({
  mockResolveUserId: vi.fn().mockResolvedValue(12345),
  mockFetchActivities: vi.fn(),
  mockFetchWineDetails: vi.fn(),
  mockFetchWineTastes: vi.fn(),
}));

vi.mock('../client', () => ({
  resolveUserId: mockResolveUserId,
  fetchActivities: mockFetchActivities,
  fetchWineDetails: mockFetchWineDetails,
  fetchWineTastes: mockFetchWineTastes,
}));

// We also need to mock the OBSIDIAN_VAULT_PATH constant so files go to temp dir.
// We intercept it via module-level override after import.
let tmpDir: string;

vi.mock('../constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('../constants')>();
  return {
    ...original,
    get OBSIDIAN_VAULT_PATH() { return tmpDir; },
  };
});

// Import after mocks are set up
import { syncToObsidian } from '../tools/obsidian';
import { parseActivitiesBody } from '../tools/ratings';

// ---- Helpers ----

function makeRating(overrides: Partial<{
  wine_id: number; wine_name: string; winery_name: string;
  vintage: number | null; user_rating: number; rated_at: string;
}> = {}) {
  return {
    wine_id: overrides.wine_id ?? 1001,
    wine_name: overrides.wine_name ?? 'Test Rouge',
    winery_name: overrides.winery_name ?? 'Test Winery',
    vintage: overrides.vintage ?? 2020,
    user_rating: overrides.user_rating ?? 4.0,
    user_notes: null,
    rated_at: overrides.rated_at ?? '2026-01-15T10:00:00.000Z',
    wine_url: null,
  };
}

function makeDetails() {
  return {
    wine: {
      id: 1001,
      name: 'Test Rouge',
      winery: { name: 'Test Winery' },
      region: { name: 'Bordeaux', country: { name: 'France' } },
      grapes: [{ name: 'Merlot' }],
      alcohol: 13.5,
      statistics: { ratings_average: 3.8, ratings_count: 200 },
      food: [{ name: 'beef' }],
      style: { description: 'A lovely test wine.' },
      seo_name: 'test-winery-test-rouge',
    },
  };
}

function makeTastes(overrides: Record<string, number | null> = {}) {
  return {
    tastes: {
      structure: {
        acidity: overrides.acidity ?? 0.6,
        sweetness: overrides.sweetness ?? 0.1,
        tannin: overrides.tannin ?? 0.7,
        intensity: overrides.intensity ?? 0.8,
        fizziness: overrides.fizziness ?? null,
      },
      flavor: [
        { group: 'fruit', primary_keywords: [{ name: 'plum' }] },
      ],
    },
  };
}

// parseActivitiesBody requires HTML that matches Vivino's markup — easier to
// stub the entire activities fetch to return pre-parsed ratings directly.
// We do this by making fetchActivities return a sentinel and then mocking
// parseActivitiesBody is harder. Instead we provide a real-ish HTML fixture.

// Minimal Vivino activity HTML that parseActivitiesBody can parse:
function makeActivityHtml(ratings: ReturnType<typeof makeRating>[]): string {
  const items = ratings.map(r => {
    const pct = Math.round(r.user_rating * 100); // simplified: 4.0 → 400 pct icons
    const iconsHtml = `<span class="icon-${pct}-pct"></span>`;
    return `
      <div id="user-activity-act${r.wine_id}" class="activity">
        ${iconsHtml}
        <div class="activity-wine-card">
          <a href="/en/wines/w/${r.wine_id}">wine</a>
          <a>${r.winery_name}</a>
          <a>${r.wine_name}</a>
          <a>Region</a>
          <a>Country</a>
        </div>
        <div>${r.vintage ?? ''}</div>
        <a title="Sat, Jan 15th at 10:00:00 UTC" href="/activities/1">1 hour ago</a>
      </div>`;
  }).join('\n');

  // Wrap in jQuery .append() format that Vivino returns
  const escaped = items.replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `$("#activities").append('${escaped}');`;
}

// ---- Tests ----

// Empty Vivino response: parseActivitiesBody finds no user-activity-* divs,
// lastActivityId stays null, paginated loop exits on !lastActivityId.
const EMPTY_ACTIVITIES_HTML = `$("#activities").append('');`;

describe('syncToObsidian', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vivino-test-'));
    vi.clearAllMocks();
    mockResolveUserId.mockResolvedValue(12345);
    // Default fall-through for the paginated loop after the test's mockResolvedValueOnce
    mockFetchActivities.mockResolvedValue(EMPTY_ACTIVITIES_HTML);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: writes wine notes and index', async () => {
    const ratings = [makeRating({ wine_id: 1001 }), makeRating({ wine_id: 1002, wine_name: 'Test Blanc' })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockResolvedValue(makeDetails());
    mockFetchWineTastes.mockResolvedValue(makeTastes());

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false });
    const text = result.content[0].text;

    expect(text).toContain('Written: 2');
    expect(text).toContain('Errors: 0');
    expect(fs.existsSync(path.join(tmpDir, 'Index.md'))).toBe(true);
  });

  it('does not crash when taste values are negative (the original bug)', async () => {
    const ratings = [makeRating({ wine_id: 2001 })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('HTTP 403'));
    mockFetchWineTastes.mockResolvedValue(makeTastes({ acidity: -3.1, tannin: -2.8, intensity: -3.0 }));

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false });
    const text = result.content[0].text;

    expect(text).not.toContain('Sync failed');
    expect(text).toContain('Written: 1');
    expect(text).toContain('Errors: 0');
  });

  it('does not crash when taste values exceed 1', async () => {
    const ratings = [makeRating({ wine_id: 2002 })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('HTTP 403'));
    mockFetchWineTastes.mockResolvedValue(makeTastes({ acidity: 3.1, intensity: 2.0 }));

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false });
    expect(result.content[0].text).toContain('Written: 1');
    expect(result.content[0].text).toContain('Errors: 0');
  });

  it('writes note without Details section when details fetch fails', async () => {
    const ratings = [makeRating({ wine_id: 3001 })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('HTTP 403 Forbidden'));
    mockFetchWineTastes.mockRejectedValue(new Error('HTTP 403 Forbidden'));

    await syncToObsidian({ full_sync: true, overwrite_existing: false });

    const noteFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md') && f !== 'Index.md');
    expect(noteFiles).toHaveLength(1);
    const content = fs.readFileSync(path.join(tmpDir, noteFiles[0]), 'utf-8');
    expect(content).toContain('## My Rating');
    expect(content).not.toContain('## Wine Details');
    expect(content).not.toContain('## Taste Profile');
  });

  it('surfaces error message in log when details fetch fails (Fix 3)', async () => {
    const ratings = [makeRating({ wine_id: 3002 })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('Request failed with status code 403'));
    mockFetchWineTastes.mockRejectedValue(new Error('ignored'));

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false });
    expect(result.content[0].text).toContain('403');
  });

  it('respects max_wines limit', async () => {
    const ratings = Array.from({ length: 8 }, (_, i) => makeRating({ wine_id: 4000 + i, wine_name: `Wine ${i}` }));
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('no auth'));
    mockFetchWineTastes.mockRejectedValue(new Error('no auth'));

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false, max_wines: 3 });
    const text = result.content[0].text;

    const noteFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md') && f !== 'Index.md');
    expect(noteFiles).toHaveLength(3);
    expect(text).toContain('Written: 3');
  });

  it('skips existing files when overwrite_existing is false', async () => {
    const ratings = [makeRating({ wine_id: 5001 })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));
    mockFetchWineDetails.mockRejectedValue(new Error('no auth'));
    mockFetchWineTastes.mockRejectedValue(new Error('no auth'));

    // Pre-create the file
    fs.writeFileSync(path.join(tmpDir, 'Test Winery Test Rouge 2020.md'), 'existing content', 'utf-8');

    const result = await syncToObsidian({ full_sync: true, overwrite_existing: false });
    expect(result.content[0].text).toContain('Skipped: 1');
    expect(result.content[0].text).toContain('Written: 0');
    // Existing content should be untouched
    expect(fs.readFileSync(path.join(tmpDir, 'Test Winery Test Rouge 2020.md'), 'utf-8')).toBe('existing content');
  });

  it('incremental sync skips ratings older than last sync date', async () => {
    // Write a sync state that is newer than the rating date
    const syncState = { last_sync_at: '2026-06-01T00:00:00.000Z', last_activity_id: null, total_wines_synced: 0 };
    fs.writeFileSync(path.join(tmpDir, '.sync-state.json'), JSON.stringify(syncState), 'utf-8');

    const ratings = [makeRating({ wine_id: 6001, rated_at: '2026-01-15T10:00:00.000Z' })];
    mockFetchActivities.mockResolvedValueOnce(makeActivityHtml(ratings));

    const result = await syncToObsidian({ full_sync: false, overwrite_existing: false });
    const text = result.content[0].text;

    expect(text).toContain('Written: 0');
    const noteFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.md') && f !== 'Index.md');
    expect(noteFiles).toHaveLength(0);
  });
});
