# Vivino MCP Server

MCP server exposing Vivino wine data to Claude Code. Solo repo, push to main.

## Obsidian Context (read before working)

**Wine preferences & taste profile:** `~/Documents/Obsidian Vault/Claude/Memory/wine-preferences.md`

**Synced wine notes:** `~/Documents/Obsidian Vault/Knowledge/Wine/` (400+ notes)

## Known Pitfalls

- **Cookie name:** `_ruby-web_session` IS the correct Vivino session cookie (not a Rails default — don't "fix" it)
- **User ID:** `15328411`
- **No official API.** All endpoints are reverse-engineered from vivino.com. They break without notice.
- **Rate limits are load-bearing.** 700ms between requests, 60s on 429, 2s on 5xx. Don't reduce.
- **Vintage endpoint** uses a different URL pattern than the wine endpoint — check `src/client.ts` before assuming.
- **`/api/wines/{id}` is dead (404 for every wine, Nov 2026).** `fetchWineDetails` scrapes the wine page instead: `/w/{id}` 302s to the canonical slug URL, and the full wine object sits HTML-encoded in a `data-ssr-props` attribute under `pageInformation.wine` (`extractPageInformation`). Fallback: regex `"vintage":{"id":N}` from the page → `/api/vintages/{N}` (still works). `/api/wines/{id}/tastes` and `/reviews` still work.
- **Activities endpoint ignores `limit`** (returns ~10 per call). Paginate with the `start_from_id` cursor; `has_more` = cursor present.
- **Wine search uses the HTML page, not the API.** `/api/explore/explore?q=` IGNORES `q` (it's a discovery feed returning the same cult Cabernets for any query). Real text search is the server-rendered page `/search/wines?q=` (302s → `/en/explore`); `fetchWineSearch` fetches that HTML and `parseVivinoSearchHtml` (`src/tools/search.ts`) parses the `data-testid="vintagePageLink"` cards by stable class prefix. Don't "fix" it back to the API endpoint. The cards only expose id/winery/name/url (no rating/region/type), so search has no rating/country/grape/type filters — get rich data via `vivino_get_wine_details`.
- **Obsidian sync state** lives at `Knowledge/Wine/.sync-state.json` (plus `.manifest.json`) in the vault. Delete to force full re-sync.

## Build & Test

- `npm run build` → compiles to `dist/`
- `npm test` → Vitest
- Local test: `node dist/index.js` (stdio transport)
- Env: `.env` with `VIVINO_SESSION_COOKIE`, `VIVINO_USER_ID`, `OBSIDIAN_VAULT_PATH`, optional `EXA_API_KEY`
