import * as dotenv from 'dotenv';
dotenv.config();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { ratingsInputSchema, getUserRatings } from './tools/ratings';
import { wineDetailsInputSchema, tasteProfileInputSchema, getWineDetails, getWineTasteProfile } from './tools/wines';
import { reviewsInputSchema, getWineReviews } from './tools/reviews';
import { searchInputSchema, searchWines } from './tools/search';
import { syncInputSchema, syncToObsidian } from './tools/obsidian';

const server = new McpServer({
  name: 'vivino-mcp-server',
  version: '1.0.0',
});

server.registerTool(
  'vivino_get_user_ratings',
  {
    title: 'Get My Vivino Ratings',
    description:
      "Fetch the user's personal wine ratings from Vivino. Returns wine IDs, names, wineries, " +
      'user ratings (1.0–5.0), personal tasting notes, and rated_at dates. Paginated — ' +
      'use page/per_page to iterate through all results. Filter with min_rating/max_rating. ' +
      'Use the since param to fetch only ratings newer than a given date. ' +
      'Wine IDs returned here can be used with vivino_get_wine_details, ' +
      'vivino_get_wine_taste_profile, and vivino_get_wine_reviews.',
    inputSchema: ratingsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getUserRatings
);

server.registerTool(
  'vivino_get_wine_details',
  {
    title: 'Get Wine Details',
    description:
      'Get comprehensive information about a specific wine by its Vivino ID. ' +
      'Returns grape varieties, region, country of origin, ABV, average community rating, ' +
      'total ratings count, food pairing suggestions, and style description. ' +
      'Requires a wine_id obtainable from vivino_get_user_ratings or vivino_search_wines.',
    inputSchema: wineDetailsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineDetails
);

server.registerTool(
  'vivino_get_wine_taste_profile',
  {
    title: 'Get Wine Taste Profile',
    description:
      'Get the structured sensory profile for a wine: acidity, sweetness, tannin, ' +
      'intensity, and fizziness scores (0–1 scale, where 1 = maximum), plus categorized ' +
      'flavor groups such as black_fruit, oak, earthy, floral, etc. with specific keywords. ' +
      'Requires a wine_id from vivino_get_user_ratings or vivino_search_wines.',
    inputSchema: tasteProfileInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineTasteProfile
);

server.registerTool(
  'vivino_get_wine_reviews',
  {
    title: 'Get Wine Reviews',
    description:
      'Get community and critic tasting notes for a specific wine. ' +
      'Returns reviewer name, numeric rating, review text, date, and language. ' +
      'Paginated. Requires a wine_id from vivino_get_user_ratings or vivino_search_wines.',
    inputSchema: reviewsInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  getWineReviews
);

server.registerTool(
  'vivino_search_wines',
  {
    title: 'Search Wines',
    description:
      "Search Vivino's wine catalog by name, winery, region, or grape variety. " +
      'Returns matching wines with their Vivino wine ID, winery, and URL. ' +
      'Use this to find the Vivino ID for a wine you can name, or to discover wines. ' +
      'For ratings, region, grapes, ABV, and taste data, pass a returned wine_id to vivino_get_wine_details.',
    inputSchema: searchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  searchWines
);

server.registerTool(
  'vivino_sync_to_obsidian',
  {
    title: 'Sync Wine Ratings to Obsidian',
    description:
      'Export Vivino wine ratings to Obsidian as individual markdown notes. ' +
      'By default runs incrementally — only fetches ratings newer than the last sync. ' +
      'Set full_sync=true for a complete re-fetch. ' +
      'Each note includes wine details, rating and notes, taste profile, and food pairings. ' +
      'Also writes Index.md sorted by rating and updates .sync-state.json. ' +
      'Requires OBSIDIAN_VAULT_PATH environment variable to be set. ' +
      'Use max_wines=3 for a test run before syncing everything.',
    inputSchema: syncInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  syncToObsidian
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Vivino MCP server running on stdio\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
