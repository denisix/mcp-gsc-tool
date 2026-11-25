# mcp-gsc-tool

Google Search Console MCP server for **Claude Code CLI**, run with **bun**. Also covers Bing Webmaster and Yandex Webmaster. 36 tools (44 with Bing and Yandex) and 3 guided prompts, one runtime dependency (`zod`), runs locally: your data goes straight from your machine to Google.

> **Credits.** A fork of [Suganthan's GSC MCP](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP) by [Suganthan Mohanadasan](https://suganthan.com/) (Apache 2.0). The analysis tools are his work; this fork trims it to Claude Code + bun, merges the open community PRs and adds security fixes. See [NOTICE](NOTICE).

## Install

Needs [bun](https://bun.sh) (the runtime and package manager this project uses instead of Node/npm) and the `claude` CLI. Install bun:

```bash
curl -fsSL https://bun.sh/install | bash    # macOS / Linux; Windows: powershell -c "irm bun.sh/install.ps1 | iex"
```

The server is the npm package [`@denisixnpm/mcp-gsc-tool`](https://www.npmjs.com/package/@denisixnpm/mcp-gsc-tool). Nothing to install up front: `bunx` fetches it, and Claude Code starts it with `bunx @denisixnpm/mcp-gsc-tool`. To pin a copy instead, `bun add -g @denisixnpm/mcp-gsc-tool` and use `mcp-gsc-tool` in place of `bunx @denisixnpm/mcp-gsc-tool` below.

From source (for development): `git clone https://github.com/denisix/mcp-gsc-tool && cd mcp-gsc-tool && bun install && bun run build`, then `bun dist/mcp-gsc-tool.js` in place of `bunx @denisixnpm/mcp-gsc-tool`.

## Connect to Google (pick one)

### A. OAuth: your own Google account (easiest)

1. In [Google Cloud console](https://console.cloud.google.com/), create or select a project, then **APIs & Services > Library**: enable **Google Search Console API**.
2. **APIs & Services > OAuth consent screen**: user type *External*, fill in the app name and your email, and add your Google account under **Test users**.
3. **Credentials > Create credentials > OAuth client ID > Desktop app**, then download the JSON.
4. Run the wizard. It opens the browser, verifies access, lets you pick a property, and registers the server with Claude Code (as `bunx @denisixnpm/mcp-gsc-tool`):

   ```bash
   bunx @denisixnpm/mcp-gsc-tool setup --secrets ~/Downloads/client_secret_XXXX.json --scopes full
   ```

   `--scopes readonly` if you only want to read. Set `BING_API_KEY`, `YANDEX_WEBMASTER_TOKEN` (see Configuration) in the shell first to include Bing and Yandex. For PageSpeed tools, also enable **PageSpeed Insights API** in the same project.

The token is cached owner-only in `~/.claude/mcp-gsc-tool/`. Re-run with `--reauth` to sign in again or change scopes.
Note: while the consent screen is in *Testing* mode, Google expires refresh tokens after 7 days. Click **Publish app** on the consent screen to avoid weekly sign-ins (no verification is needed for your own use).

### B. Service account: servers, CI, many sites

1. Enable **Google Search Console API** as above.
2. **IAM & Admin > Service accounts > Create**, then **Keys > Add key > JSON**, and download it.
3. In [Search Console](https://search.google.com/search-console), go to **Settings > Users and permissions > Add user** and add the service account's email. *Full* is enough to read; *Owner* is needed for `submit_sitemap`, `submit_url` and `submit_batch`.
4. Register it:

   ```bash
   claude mcp add mcp-gsc-tool --scope user \
     -e GSC_KEY_FILE=/path/to/key.json -e GSC_SITE_URL=sc-domain:example.com \
     -- bunx @denisixnpm/mcp-gsc-tool
   ```

**URL submission (optional).** `submit_url` and `submit_batch` also need the **Web Search Indexing API** enabled, and OAuth needs full scopes (`setup --scopes full`).

Check with `claude mcp get mcp-gsc-tool` (or `/mcp` inside Claude Code). Bunx ignores the project's `.env` here: the package runs with `--no-env-file`, so a repo's `.env` can't override these settings.

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
| `GSC_READ_ONLY` | `1` hides every tool that changes something at Google (submit, delete, add) |
| `BING_API_KEY` | Bing Webmaster API key (Bing Webmaster Tools > Settings > API access). Enables the `bing_*` tools |
| `BING_SITE_URL` | Bing site as verified, e.g. `https://www.example.com/` (default: derived from `GSC_SITE_URL`) |
| `YANDEX_WEBMASTER_TOKEN` | Yandex OAuth token with `webmaster:hostinfo` (+ `webmaster:verify` for recrawl): register an app at oauth.yandex.ru, then open `https://oauth.yandex.ru/authorize?response_type=token&client_id=<id>`. Enables the `yandex_*` tools |
| `YANDEX_HOST` | Yandex host, e.g. `https://example.com` (default: derived from `GSC_SITE_URL`) |
| `PSI_API_KEY` | PageSpeed Insights key. Not needed with OAuth: enable **PageSpeed Insights API** in your Cloud project and sign in with `setup` (it requests `openid`), and PSI calls use your project's quota. Without either, the shared keyless quota is often exhausted (HTTP 429) |
| `GSC_TOKEN_DIR` | Where the OAuth token is cached (default `~/.claude/mcp-gsc-tool`, or `$CLAUDE_CONFIG_DIR/mcp-gsc-tool`; tokens in the older `~/.mcp-gsc-tool` and `~/.gsc-mcp` are still read) |

`setup` copies any of the optional variables above that are set in your shell into the Claude Code entry, e.g. `BING_API_KEY=... bunx @denisixnpm/mcp-gsc-tool setup --secrets ...`. To add one later: `claude mcp remove mcp-gsc-tool` and register again.

Every tool that queries a property also accepts `site_url` per call (Bing / Yandex tools: `site`), so one server covers all sites your credentials can see. `list_sites` lists them for all three engines; a bare `example.com` is matched to the site as verified in Bing / Yandex, and `compare_engines` with `site_url` uses that site on every engine.

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
| `compare_periods` | Period-over-period or year-over-year: gainers, losers, new and lost queries/pages |
| `page_queries` | Queries for one page, or pages ranking for one query |
| `export_csv` | Full report (up to 1M rows) written to a local CSV instead of the chat |
| `pagespeed` | Core Web Vitals: CrUX field data + Lighthouse lab metrics (PageSpeed Insights) |

| Indexing | |
|---|---|
| `inspect_url` / `batch_inspect_urls` | Indexed or not, last crawl, canonical, robots/noindex (batch: up to 50 URLs) |
| `indexing_coverage` | Sitemap URLs vs pages with impressions: what is in the sitemap but invisible, and the reverse |
| `list_sitemaps` / `get_sitemap` / `submit_sitemap` / `delete_sitemap` | Sitemap status, submission and removal |
| `list_sites` / `add_site` / `delete_site` | Properties and permission levels (`list_sites` also lists Bing and Yandex sites) |
| `submit_url` / `submit_batch` / `indexing_status` | Indexing API notifications (200/day quota; officially only JobPosting / BroadcastEvent pages) |

| Bing and Yandex | Shown only when their credentials are set |
|---|---|
| `bing_query_stats` / `bing_traffic` / `bing_url_info` / `bing_submit_urls` | Bing queries, daily traffic + crawl stats, URL status, URL submission |
| `yandex_popular_queries` / `yandex_site_health` / `yandex_recrawl` | Yandex queries, SQI + diagnostics + indexing trends, recrawl queue |
| `compare_engines` | Google vs Bing vs Yandex: totals, click share, top queries (always available; skips unconfigured engines) |

Prompts: `weekly_seo_report`, `diagnose_traffic_drop`, `indexing_audit`.

Read-only API calls retry on 429/5xx with backoff; submissions are never resent. Period comparisons end 3 days back, because the most recent days are still partial. Dates follow Pacific Time, as GSC does.

## Development

| Command | |
|---|---|
| `bun run start` | Run from source |
| `bun run build` | Bundle to `dist/mcp-gsc-tool.js` (about 200 KB, no `node_modules` needed) |
| `bun run check` | Type check (TypeScript 7), lint (Biome) and `bun test` |
| `bun pm version patch && git push --follow-tags` | Release: CI checks and publishes `@denisixnpm/mcp-gsc-tool` to the npm registry via Trusted Publishing (no token) |
| `bun run install:claude` | Build and copy the bundle to `~/.claude/mcp-gsc-tool/`; run `setup` from there once so Claude Code points at it, then re-run this after changes |

## Changelog (this fork)

- Claude Code CLI + bun only. Removed the report generator, image tools and Claude Desktop packaging.
- Only one runtime dependency, `zod`. The Google API client and the MCP server are small in-house modules (`src/google.ts`, `src/mcp.ts`). Startup is 0.03 s.
- Merged upstream PRs #16–#20. Fixed issues #9, #12 and #15.
- Security: OAuth `state` check and PKCE, owner-only token file, `--no-env-file`, URL-prefix property fallback only on a 403, duplicate API requests merged.

For the original project's history, see [its README](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP#changelog).

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Original work © Suganthan Mohanadasan. If it's useful, star [the original project](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP).
