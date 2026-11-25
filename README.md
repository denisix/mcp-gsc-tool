# mcp-gsc-tool

Google Search Console MCP server for **Claude Code CLI**, run with **bun**. 22 analysis tools, one runtime dependency (`zod`), runs locally: your data goes straight from your machine to Google.

> **Credits.** A fork of [Suganthan's GSC MCP](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP) by [Suganthan Mohanadasan](https://suganthan.com/) (Apache 2.0). The analysis tools are his work; this fork trims it to Claude Code + bun, merges the open community PRs and adds security fixes. See [NOTICE](NOTICE).

## Install

Needs [bun](https://bun.sh) and the `claude` CLI.

```bash
git clone <this repository> mcp-gsc-tool
cd mcp-gsc-tool && bun install && bun run build
```

## Connect to Google (pick one)

### A. OAuth: your own Google account (easiest)

1. In [Google Cloud console](https://console.cloud.google.com/), create or select a project, then **APIs & Services > Library**: enable **Google Search Console API**.
2. **APIs & Services > OAuth consent screen**: user type *External*, fill in the app name and your email, and add your Google account under **Test users**.
3. **Credentials > Create credentials > OAuth client ID > Desktop app**, then download the JSON.
4. Run the wizard. It opens the browser, verifies access, lets you pick a property, and registers the server with Claude Code:

   ```bash
   bun dist/mcp-gsc-tool.js setup --secrets ~/Downloads/client_secret_XXXX.json
   ```

The token is cached owner-only in `~/.mcp-gsc-tool/`. Re-run with `--reauth` to sign in again or change scopes.
Note: while the consent screen is in *Testing* mode, Google expires refresh tokens after 7 days. Click **Publish app** on the consent screen to avoid weekly sign-ins (no verification is needed for your own use).

### B. Service account: servers, CI, many sites

1. Enable **Google Search Console API** as above.
2. **IAM & Admin > Service accounts > Create**, then **Keys > Add key > JSON**, and download it.
3. In [Search Console](https://search.google.com/search-console), go to **Settings > Users and permissions > Add user** and add the service account's email. *Full* is enough to read; *Owner* is needed for `submit_sitemap`, `submit_url` and `submit_batch`.
4. Register it:

   ```bash
   claude mcp add --scope user mcp-gsc-tool \
     -e GSC_KEY_FILE=/path/to/key.json -e GSC_SITE_URL=sc-domain:example.com \
     -- bun --no-env-file /path/to/mcp-gsc-tool/dist/mcp-gsc-tool.js
   ```

**URL submission (optional).** `submit_url` and `submit_batch` also need the **Web Search Indexing API** enabled, and OAuth needs full scopes (`setup --scopes full`).

Then start `claude` and ask something like *"What are my quick wins?"* or *"Which pages lost traffic this month and why?"*.

## Configuration

| Variable | Purpose |
|---|---|
| `GSC_SITE_URL` | Default property: `sc-domain:example.com` or `https://www.example.com/` (required) |
| `GSC_AUTH_MODE` | `oauth` or `service_account` (default) |
| `GSC_KEY_FILE` | Service account JSON key |
| `GSC_OAUTH_SECRETS_FILE` | OAuth client JSON (or `GSC_OAUTH_CLIENT_ID` + `GSC_OAUTH_CLIENT_SECRET`) |
| `GSC_SCOPES` | `readonly` or `full` (default). Read only can't submit sitemaps or URLs |
| `GSC_SITE_URLS` | Comma-separated properties for `multi_site_dashboard` |
| `GSC_TOKEN_DIR` | Where the OAuth token is cached (default `~/.mcp-gsc-tool`; an older `~/.gsc-mcp` token is still read) |

Every tool that queries a property also accepts `site_url` per call, so one server covers all properties your credentials can see.

Setup flags: `--client code|print`, `--scopes readonly|full`, `--site <property>`, `--secrets <path>`, `--reauth`, `--force`, `--dry-run`.

## Tools

| Analysis | |
|---|---|
| `site_snapshot` | Clicks, impressions, CTR and position vs the previous period |
| `quick_wins` | Queries at positions 4–15 with high impressions |
| `ctr_opportunities` | Pages whose CTR is below expected for their position |
| `traffic_drops` | What lost traffic: ranking loss, CTR collapse or demand decline |
| `content_gaps` | Demand with no real content (position > 20) |
| `cannibalization_check` | Queries where several of your pages compete |
| `content_decay` | Pages declining three 30-day periods in a row |
| `topic_cluster_performance` | Totals for all pages under a URL path |
| `ctr_vs_benchmark` | Your CTR per position vs industry benchmarks |
| `check_alerts` | Severity-rated drops, CTR collapses, disappeared pages |
| `content_recommendations` | Prioritised update / create / consolidate actions |
| `branded_vs_non_branded` | Branded vs non-branded split (Google's classification) |
| `multimodal_search_overview` | Google Lens, Circle to Search and image-upload traffic |
| `genai_conversation_queries` | AI Mode / AI Overview conversation queries hiding in your data |
| `advanced_search_analytics` | Custom dimensions, filters, filter lists and search types |
| `multi_site_dashboard` | Health check across several properties |
| `verify_claim` | Re-queries GSC to check a number before Claude states it |

| Indexing | |
|---|---|
| `inspect_url` | Indexed or not, last crawl, canonical, robots/noindex |
| `list_sitemaps` / `submit_sitemap` | Sitemap status and submission |
| `submit_url` / `submit_batch` | Indexing API notifications (200/day quota) |

## Development

| Command | |
|---|---|
| `bun run start` | Run from source |
| `bun run build` | Bundle to `dist/mcp-gsc-tool.js` (161 KB, no `node_modules` needed) |
| `bun run check` | Type check (TypeScript 7), lint (Biome) and `bun test` |

## Changelog (this fork)

- Claude Code CLI + bun only. Removed the report generator, image tools and Claude Desktop packaging.
- Only one runtime dependency, `zod`. The Google API client and the MCP server are small in-house modules (`src/google.ts`, `src/mcp.ts`). Startup is 0.03 s.
- Merged upstream PRs #16–#20. Fixed issues #9, #12 and #15.
- Security: OAuth `state` check and PKCE, owner-only token file, `--no-env-file`, URL-prefix property fallback only on a 403, duplicate API requests merged.

For the original project's history, see [its README](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP#changelog).

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Original work © Suganthan Mohanadasan. If it's useful, star [the original project](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP).
