# search-console-mcp

[![Licence: Apache 2.0](https://img.shields.io/badge/licence-Apache%202.0-305686?style=flat-square&labelColor=24292f)](LICENSE)

[![MCP server](https://img.shields.io/badge/MCP-server-305686?style=flat-square&labelColor=24292f&logo=modelcontextprotocol&logoColor=white)](https://modelcontextprotocol.io/)
[![Claude Code CLI + bun](https://img.shields.io/badge/Claude%20Code-bun-305686?style=flat-square&labelColor=24292f&logo=bun&logoColor=white)](#quick-start-bun--claude-code-cli)
[![Google Search Console API](https://img.shields.io/badge/Google%20Search%20Console-API-305686?style=flat-square&labelColor=24292f&logo=googlesearchconsole&logoColor=white)](https://developers.google.com/webmaster-tools)
[![22 tools](https://img.shields.io/badge/tools-22-305686?style=flat-square&labelColor=24292f)](#all-22-tools)
[![Privacy: local first](https://img.shields.io/badge/privacy-local%20first-305686?style=flat-square&labelColor=24292f&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI%2BPHJlY3Qgd2lkdGg9IjE4IiBoZWlnaHQ9IjExIiB4PSIzIiB5PSIxMSIgcng9IjIiIHJ5PSIyIi8%2BPHBhdGggZD0iTTcgMTFWN2E1IDUgMCAwIDEgMTAgMHY0Ii8%2BPC9zdmc%2BCg%3D%3D)](#what-makes-this-different-from-other-google-search-console-mcp-servers)

> **Credits.** search-console-mcp is a fork of [Suganthan's GSC MCP](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP) by [Suganthan Mohanadasan](https://suganthan.com/), Apache 2.0. All the original analysis tools are his work. This fork cuts it down for Claude Code CLI on bun, merges the open community PRs, and adds security fixes. See the [changelog](#changelog) and [NOTICE](NOTICE).

An MCP server for Google Search Console that lets you ask Claude questions about your search data and get real answers. Not raw API rows. Actual analysis.

22 tools for Claude Code CLI, run with bun. OAuth or service account. Free and open source. Runs on your machine: your data goes straight from this computer to Google, and nothing passes through anyone else's servers.

https://github.com/user-attachments/assets/ef131907-4461-4c6a-8080-770f8162dbf2

Also on [YouTube](https://www.youtube.com/watch?v=U0FGD6SXQt8).

> **Full setup guide with screenshots:** [suganthan.com/blog/google-search-console-mcp-server/](https://suganthan.com/blog/google-search-console-mcp-server/)


> **v2.4.0 update (August 2026):** new tool `genai_conversation_queries` finds the AI conversations leaking into your query report. People reply to Google's AI with things like "yes, go on", Google logs every follow-up as a new query, and this tool sorts all of it into seven classified buckets with landing pages and a monthly timeline. Full method and findings: ["Yes, Go On": The AI Conversations Leaking Into Your Search Console](https://suganthan.com/blog/ai-mode-queries-search-console/).

## See it in action

**"Audit the images on these pages"**


**"Which of my queries are actually AI conversations?"**

![Reply artefacts like yes and sure classified with impressions, clicks and landing pages](screenshots/genai-conversation-queries.jpg)

**"How is my site doing?"**

![Site snapshot with period comparison](screenshots/snapshot.jpg)

**"What are my quick win keywords?"**

![Quick wins analysis showing positions 4-15 with opportunity scores](screenshots/quick%20wins2.jpg)

**"Which pages are cannibalising each other?"**

![Cannibalisation detection across the site](screenshots/canni.jpg)

**"What content is slowly dying?"**

![Content decay detection over three consecutive periods](screenshots/dying.jpg)

**"Which pages lost traffic and why?"**

![Traffic drop diagnosis: ranking loss vs CTR collapse vs demand decline](screenshots/lost.jpg)

**"How does my CTR compare to benchmarks?"**

![CTR vs industry benchmarks by position](screenshots/CTR.jpg)

**"How is my blog cluster performing?"**

![Topic cluster performance for a URL path pattern](screenshots/topics.jpg)

## What you can ask

```
"What are my quick win keywords?"
"Which pages lost traffic this month and why?"
"What content is decaying?"
"Which pages are cannibalising each other?"
"Check for any SEO alerts in the last 7 days"
"Give me content recommendations"
"How does my CTR compare to benchmarks?"
"How is my /blog/ cluster performing?"
"Show me US mobile traffic for the last 90 days"
"Is /blog/my-post/ indexed? If not, why?"
"Generate a full performance report and save it"
"Show me a dashboard across all my sites"
"Submit this URL for indexing: https://mysite.com/new-post/"
"Batch submit all my new blog posts for indexing"
"List my sitemaps and their status"
"Verify that claim about my homepage clicks"
```

## Quick start (bun + Claude Code CLI)

Requires [bun](https://bun.sh) and the `claude` CLI. `bun run build` bundles the server into one file, `dist/search-console-mcp.js`, that needs no `node_modules` at runtime and starts in about 60 ms.

```bash
git clone <this repository> search-console-mcp
cd search-console-mcp && bun install && bun run build
bun dist/search-console-mcp.js setup
```

The wizard signs you in with Google, verifies the connection, lets you pick a property, and runs `claude mcp add` pointing at this checkout. Read only by default; choose full access for the sitemap and URL submission tools. You need your own Google OAuth client JSON (Google Cloud > enable **Search Console API** > Credentials > OAuth client ID > **Desktop app**).

Flags: `--client code|print`, `--scopes readonly|full`, `--site <property>`, `--secrets <path>`, `--reauth`, `--force`, `--dry-run`, `--help`.

### Development

| Command | What it does |
|---|---|
| `bun run start` | Run the server from source (no build) |
| `bun run build` | Bundle to `dist/search-console-mcp.js` |
| `bun run typecheck` | `tsc` (TypeScript 7) type check |
| `bun run lint` | Biome lint |
| `bun test` | Offline unit tests plus MCP tests against both source and the built bundle |
| `bun run check` | typecheck, lint and test |

### Manual registration

OAuth:

```bash
claude mcp add --scope user gsc \
  -e GSC_AUTH_MODE=oauth -e GSC_OAUTH_SECRETS_FILE=/path/to/client_secrets.json \
  -e GSC_SITE_URL=sc-domain:yoursite.com -e GSC_SCOPES=readonly \
  -- bun --no-env-file /path/to/search-console-mcp/dist/search-console-mcp.js
```

First use opens a browser for Google sign in; the token is cached owner-only at `~/.gsc-mcp/`.

Service account (add its email to your GSC property under Settings > Users and permissions):

```bash
claude mcp add --scope user gsc \
  -e GSC_KEY_FILE=/path/to/service-account.json -e GSC_SITE_URL=sc-domain:yoursite.com \
  -- bun --no-env-file /path/to/search-console-mcp/dist/search-console-mcp.js
```

### Generative AI (v2.4)

Google's Generative AI performance report has no API, no BigQuery export, and no searchAppearance value. But Google counts every AI Mode follow-up as a brand-new query and folds AI Mode and AI Overviews into the web search type, so AI-conversation exhaust leaks into the regular query dimension with real impressions, positions and clicks. This tool mines it.

| Tool | What it answers |
|---|---|
| `genai_conversation_queries` | Which of your queries are actually AI-conversation exhaust: bare replies to the AI ("yes", "go on"), "what about X" pivot follow-ups, conversational questions, AI-visibility tracker probes, and full agent prompts logged as queries. Seven classified buckets with landing pages, plus a monthly timeline showing when reply-artefacts first appeared on your property |

### Indexing API (optional)

To use `submit_url`, `submit_batch`, and `submit_sitemap`:

1. Enable the **Web Search Indexing API** in your [Google Cloud console](https://console.cloud.google.com/apis/library/indexing.googleapis.com)
2. Your service account (or OAuth credentials) need owner-level access in Search Console

Note: Google officially says the Indexing API is for JobPosting and BroadcastEvent schema types. In practice, it processes requests for all page types.

### Multi-site

For multiple properties, add `GSC_SITE_URLS`:

```json
"env": {
  "GSC_SITE_URL": "sc-domain:primarysite.com",
  "GSC_SITE_URLS": "sc-domain:primarysite.com,sc-domain:secondsite.com"
}
```

You can also point a single call at any property your credentials can see: every tool that queries a property takes an optional `site_url` parameter. Only `submit_url`/`submit_batch` (URL-based) and `multi_site_dashboard` (takes `site_urls`) go without it. Each result names the property in `_meta.site_url`.

## All 22 tools

### Analysis

| Tool | What it answers |
|---|---|
| `site_snapshot` | How is the site doing overall? Clicks, impressions, CTR, position with period comparison |
| `quick_wins` | Keywords at positions 4-15 with high impressions, scored by opportunity |
| `ctr_opportunities` | Pages with high impressions but CTR below expected for their position |
| `traffic_drops` | What lost traffic, and whether it's a ranking loss, CTR collapse, or demand decline |
| `content_gaps` | Topics with search demand but no real content targeting them |
| `cannibalization_check` | Keywords where multiple pages compete against each other |
| `content_decay` | Pages declining across three consecutive 30-day periods |
| `topic_cluster_performance` | Aggregated performance for all pages matching a URL path pattern |
| `ctr_vs_benchmark` | Your actual CTR per position vs industry benchmarks |
| `inspect_url` | Is this URL indexed? Last crawl date, canonical, robots/noindex issues |
| `check_alerts` | Position drops, CTR collapses, click losses, disappeared pages. Severity-rated |
| `content_recommendations` | Prioritised actions: pages to update, content to create, pages to consolidate |
| `advanced_search_analytics` | Custom queries with flexible dimensions and filters, including `brandedClassification`, multi-country / multi-device `filter_lists`, and `search_type: webMultimodal` |
| `branded_vs_non_branded` | Branded vs non-branded split from Google's own classification: totals, share, change vs the previous period, daily trend, top queries and pages per side |
| `multimodal_search_overview` | Google Lens, Circle to Search and image-upload performance: totals, size relative to web, top pages, countries, devices, daily trend |
| `multi_site_dashboard` | Health check across all properties in one command |

### Indexing

| Tool | What it does |
|---|---|
| `submit_url` | Submit a URL to Google's Indexing API for crawling |
| `submit_batch` | Batch submit up to 200 URLs (daily quota) |
| `submit_sitemap` | Notify Google of a new or updated sitemap |
| `list_sitemaps` | All submitted sitemaps with status, errors, and indexed counts |

### Safety

| Tool | What it does |
|---|---|
| `verify_claim` | Self-check: re-queries GSC data to verify a numeric claim before presenting it |


## What makes this different from other Google Search Console MCP servers

**Analysis, not just API access.** Most Google Search Console MCP servers wrap the raw API. This one ships with pre-built analysis: opportunity scoring, cannibalisation detection, decay tracking, CTR benchmarking, traffic drop diagnosis. You ask a question, it runs the analysis and tells you what to do.

**Local and private.** No hosted middleman, no account, no plan. The server runs on your machine, tokens are cached on your machine, and your Search Console data travels directly between your machine and Google. The developer operates no servers and receives nothing. Read only scope by default.

**Hallucination guardrails.** Every tool instructs Claude to base analysis only on returned data. Provenance metadata in every response. The `verify_claim` tool lets Claude fact-check its own numbers. Credit to [Krinal Mehta](https://www.linkedin.com/in/krinal/) for pushing this.

**Terminal friendly.** Built for Claude Code CLI: results come back as plain JSON for Claude to summarise.

**Fresh data.** Uses `dataState: 'all'` so data matches the GSC dashboard, not 2-3 days stale.

**Proactive, not reactive.** Alerting and content recommendations catch problems before you think to look.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `GSC_AUTH_MODE` | No | `oauth` or `service_account` (default: `service_account`) |
| `GSC_KEY_FILE` | Service account mode | Path to service account JSON key |
| `GSC_OAUTH_SECRETS_FILE` | OAuth mode | Path to OAuth client secrets JSON |
| `GSC_OAUTH_CLIENT_ID` | OAuth mode (alt) | OAuth client ID |
| `GSC_OAUTH_CLIENT_SECRET` | OAuth mode (alt) | OAuth client secret |
| `GSC_SITE_URL` | Yes | Primary GSC property URL |
| `GSC_SITE_URLS` | No | Comma-separated list for multi-site |
| `GSC_SCOPES` | No | `readonly` or `full` (default: `full`). Read only keeps the Google consent to a single view permission; submission tools then explain how to upgrade |

## Full guide

Step-by-step setup with screenshots, use cases, and examples:

**[suganthan.com/blog/google-search-console-mcp-server/](https://suganthan.com/blog/google-search-console-mcp-server/)**

## Changelog

**Unreleased (audit-fixes)** Claude Code CLI + bun only. Bun handles build (`bun build` bundles to a single `dist/search-console-mcp.js`), test (`bun test`), plus lint (Biome) and type checks (TypeScript 7), all run through bun. `googleapis` (209 MB) replaced by Google's per-API `@googleapis/searchconsole` and `@googleapis/indexing`, and `open` replaced by a few lines that call the OS browser opener: `node_modules` went from ~270 MB to ~55 MB and startup from 0.38 s / 165 MB to 0.06 s / 60 MB. Identical Search Analytics queries already in flight now share one download (`content_recommendations` used to fetch the same report twice). The URL-prefix property fallback now only triggers on a 403, not on quota or network errors. Date windows are computed in UTC, so they no longer shift a day across DST changes. Setup registers via `claude mcp add` with `bun --no-env-file`, so a project's `.env` can't override GSC settings. Removed `generate_report`, the image-search tools, `image_page_audit`, Claude Desktop setup and the `.mcpb` bundle. Merged PRs #16 (`site_url` on every tool), #17 (#12), #18, #19 (`inspect_url` URL-prefix fallback), #20 (branded / multimodal / filter lists). Fixed #15 (Indexing calls no longer replace the Search Console auth). The OAuth callback now checks `state`, and the token file is owner-only (0600).

**Unreleased** Support for the [Search Analytics API additions of 16 November 2026](https://developers.google.com/search/blog/2026/11/search-analytics-api-update). `branded_vs_non_branded` uses the new `brandedClassification` dimension to split performance into branded and non-branded traffic with Google's own classification, rather than a regex you maintain. `multimodal_search_overview` reads `type=webMultimodal` (Google Lens, Circle to Search on Android, image uploads in Search). `advanced_search_analytics` gains `filter_lists` for multi-country and multi-device filtering in one call (the API's `filterLists`), accepts `brandedClassification` and `searchAppearance` as dimensions and filters, and accepts `search_type: webMultimodal`. Limits that come from Google, verified against the live API: branded data starts on 2026-02-21 and exists only for top-level properties with enough volume (ineligible properties return no rows, reported as `eligible: false`); `brandedClassification` cannot be combined with a query filter; multimodal search cannot be grouped or filtered by query or by `brandedClassification`; filter lists accept only `country` and `device`, and a dimension cannot appear in both a filter and a filter list.

**v2.5.1** Three fixes from the issue queue. The sitemaps tools now call `sc-domain:` properties as-is, which the Sitemaps API supports and always has; the old URL-prefix rewrite manufactured a 403, blamed the API for it, and on some accounts silently returned a stale URL-prefix property's sitemap list instead of the domain property's. The rewrite survives only as a fallback for accounts whose permission genuinely lives on a URL-prefix property. Credit to [pauljlange](https://github.com/pauljlange) for proving the premise wrong with raw API calls. Service-account mode now requests the same scope set as the OAuth flow, so `submit_url` and `submit_batch` work with service accounts and the `GSC_SCOPES=readonly` tier applies there too; the OAuth half of this shipped earlier via [tomschmidty12-sys](https://github.com/tomschmidty12-sys)'s PR, after [stuli1989](https://github.com/stuli1989) reported it and sent the first fix for both modes in [#3](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP/pull/3). And the Google client libraries are bumped (googleapis 144 to 176, google-auth-library 10, gaxios 7) so token fetches use Node's native fetch; the old node-fetch path failed to decompress Google's gzip token responses on Node 22 and newer, which broke service accounts, most visibly on Windows. Credit to [wilotas](https://github.com/wilotas) for the full diagnosis and the verified fix. Also fixed: the one-click desktop bundle. Every previous `.mcpb` shipped without the googleapis package internals (the packer silently pruned them), so the extension could never start, and "Unable to connect to extension server" was this bug, not your config. The v2.5.1 bundle carries the complete production dependency tree and was runtime-tested against the live API before upload, which is why it is bigger. Credit to [VeloWulf](https://github.com/VeloWulf) for the report.

**v2.5.0** Image page audit. `image_page_audit` fetches up to 5 pages from your own site and audits every image on them against the on-page factors that decide image-search performance: missing, empty, generic, filename-as-alt or duplicate alt text, camera-default and stock-agency-default filenames (shutterstock_524347192.jpg tells Google nothing), missing width/height attributes, lazy loading on the LCP candidate, srcset coverage, file format and weight (flags photos shipped as PNG and anything over 500KB), intrinsic dimensions against Google's ~250x200 indexing minimum, ImageObject and licensable-field schema, primaryImageOfPage, max-image-preview, inline background images, and the metadata inside the image files via exifr: camera EXIF and GPS that should be stripped, IPTC Creator/Copyright/Caption that should survive your CMS, and XMP DigitalSourceType on AI-generated images. Returns per-image findings, page-level checks, and an ordered top_fixes list. Pairs with `image_impressions_no_clicks` and `image_search_quick_wins`: those name the pages, this names the reasons. Fetches only the URLs it is given, so the privacy model is unchanged: your data goes to Google and your own site and nowhere else. New dependencies: node-html-parser, image-size, exifr (all pure JS, no native builds). The 7 image-search analysis tools also gain the optional `site_url` override that `advanced_search_analytics` already had, so any of them can be pointed at any property your credentials can see without editing the config. Launch post with the full workflow on real client data: ["One Page Earned 102,657 Image Impressions and 2 Clicks"](https://suganthan.com/blog/gsc-mcp-image-seo-tools/).

![Per-image findings from image_page_audit](screenshots/image-page-audit.jpg)

**v2.4.0** Generative AI conversation queries. `genai_conversation_queries` finds the AI conversation fragments hiding in your regular query data and sorts them into seven kinds: reply artefacts ("yes", "go on"), pivot follow-ups ("what about resend?"), conversational questions, tracker probes, agent harnesses, pasted strings, and a review pile. Google counts every AI Mode follow-up as a brand new query, so these rows carry real impressions, positions and clicks, and the dedicated Generative AI report has no query view, which makes this the only query-level AI evidence available anywhere. One call classifies sixteen months of your queries, attaches landing pages via query and page grouping, and returns a monthly reply-artefact timeline. Plain Search Analytics API, no BigQuery, no new permissions. Full method and findings: [the launch post](https://suganthan.com/blog/ai-mode-queries-search-console/). Sparked by [Anastasia Kourou surfacing the queries](https://www.linkedin.com/posts/anastasia-kourou-4b393034_hi-john-mueller-i-am-noticing-some-unusual-share-7489988919229353984-FJ0m/) with John Mueller confirming the mechanism, and by [Ross Tavendale asking](https://x.com/rtavs/status/2084710985298780579) how to reverse engineer it.

![Reply artefact queries classified by the new tool](screenshots/genai-conversation-queries.jpg)

**v2.3.0** Image SEO suite and one command setup. 7 new tools that pass `type=image` to the GSC Search Analytics API, plus a `type` parameter on `advanced_search_analytics` covering all 6 GSC search surfaces (web, image, video, news, discover, googleNews). The image-search surface was invisible to most third-party SEO tools because they default to `type=web` and never expose the others; v2.3 makes it queryable end-to-end. Also new: `npx suganthan-gsc-mcp setup`, a wizard that signs you in, verifies the connection with a live call, and writes your Claude Desktop and Claude Code configs; a read only scope tier (`GSC_SCOPES=readonly`, now the setup default) so the standard consent asks for one view permission; and a one click Claude Desktop bundle (`.mcpb`) on the releases page.

**v2.2.2** Published to npm as `suganthan-gsc-mcp`. Config can now use `npx` instead of a local checkout path.

**v2.2.1** Fixed OAuth EADDRINUSE crash when multiple tool calls triggered concurrent authentication flows. The server now reuses the active auth session instead of spawning duplicate listeners. Thanks to [Rushabh Rathod](https://github.com/rushabhhh) for finding and reporting this.

**v2.2.0** Visual dashboard rendering. All analysis tools now produce rich, interactive visualisations in Claude Desktop with summary cards, colour coded indicators, bar charts, and tabbed sections instead of plain text output. No reinstall needed, just restart Claude Desktop.

![Visual dashboard rendering in Claude Desktop](screenshots/visual-dashboard.jpg)

**v2.1.0** Added Indexing API tools: submit\_url, submit\_batch, submit\_sitemap, list\_sitemaps. Request Google to crawl and index pages directly from Claude.

**v2.0.0** Added OAuth authentication, advanced search analytics, check\_alerts, content\_recommendations, generate\_report, multi\_site\_dashboard, verify\_claim. Server grew from 10 to 16 tools.

**v1.1.0** Added hallucination guardrails: explicit prompts in tool descriptions, data provenance metadata in responses, and verify\_claim self-checking tool. Thanks to [Krinal Mehta](https://www.linkedin.com/in/krinal/) for the feedback.

**v1.0.0** Initial release with 10 analysis tools and service account authentication.

## Licence

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for details. Use it, fork it, build on it. Just keep the attribution.

---

## Original author: Suganthan Mohanadasan

This project builds on [Suganthan's GSC MCP](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP). Credit for the original server and its analysis tools goes to him.

I write about organic search, AI, and the tools I build on [suganthan.com](https://suganthan.com/).

### Posts about this server

| Post | What it covers |
|---|---|
| [Google Search Console MCP setup guide](https://suganthan.com/blog/google-search-console-mcp-server/) | Step by step setup with screenshots, for OAuth and service accounts |
| ["Yes, Go On": The AI Conversations Leaking Into Your Search Console](https://suganthan.com/blog/ai-mode-queries-search-console/) | The research behind `genai_conversation_queries` (v2.4) |
| [One Page Earned 102,657 Image Impressions and 2 Clicks](https://suganthan.com/blog/gsc-mcp-image-seo-tools/) | The image SEO tools on real client data (v2.3 and v2.5) |
| [How my MCP calculates average position](https://suganthan.com/notes/gsc-average-position/) | The maths behind every position figure, and how to make Claude prove a number |

### Outgrowing the Search Console API?

The [BigQuery MCP Server](https://github.com/Suganthan-Mohanadasan/Suganthans-BigQuery-MCP-Server) reads your Search Console bulk export instead of the API, so large sites keep the rows the API cuts and you can see how much of your traffic sits behind anonymised queries. It has 33 tools, including ML forecasting, anomaly detection, and GA4 revenue per keyword. [Setup guide](https://suganthan.com/blog/bigquery-mcp-server/).

### Follow along

[![suganthan.com](https://img.shields.io/badge/suganthan.com-305686?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI%2BPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48cGF0aCBkPSJNMTIgMmExNC41IDE0LjUgMCAwIDAgMCAyMCAxNC41IDE0LjUgMCAwIDAgMC0yMCIvPjxwYXRoIGQ9Ik0yIDEyaDIwIi8%2BPC9zdmc%2BCg%3D%3D)](https://suganthan.com/)
[![Newsletter](https://img.shields.io/badge/Newsletter-305686?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI%2BPHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjE2IiB4PSIyIiB5PSI0IiByeD0iMiIvPjxwYXRoIGQ9Im0yMiA3LTguOTcgNS43YTEuOTQgMS45NCAwIDAgMS0yLjA2IDBMMiA3Ii8%2BPC9zdmc%2BCg%3D%3D)](https://suganthan.com/newsletter/)
[![Suganthan Mohanadasan on LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=for-the-badge&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0iI2ZmZiIgZD0iTTIwLjQ0NyAyMC40NTJoLTMuNTU0di01LjU2OWMwLTEuMzI4LS4wMjctMy4wMzctMS44NTItMy4wMzctMS44NTMgMC0yLjEzNiAxLjQ0NS0yLjEzNiAyLjkzOXY1LjY2N0g5LjM1MVY5aDMuNDE0djEuNTYxaC4wNDZjLjQ3Ny0uOSAxLjYzNy0xLjg1IDMuMzctMS44NSAzLjYwMSAwIDQuMjY3IDIuMzcgNC4yNjcgNS40NTV2Ni4yODZ6TTUuMzM3IDcuNDMzYTIuMDYyIDIuMDYyIDAgMDEtMi4wNjMtMi4wNjUgMi4wNjQgMi4wNjQgMCAxMTIuMDYzIDIuMDY1em0xLjc4MiAxMy4wMTlIMy41NTVWOWgzLjU2NHYxMS40NTJ6TTIyLjIyNSAwSDEuNzcxQy43OTIgMCAwIC43NzQgMCAxLjcyOXYyMC41NDJDMCAyMy4yMjcuNzkyIDI0IDEuNzcxIDI0aDIwLjQ1MUMyMy4yIDI0IDI0IDIzLjIyNyAyNCAyMi4yNzFWMS43MjlDMjQgLjc3NCAyMy4yIDAgMjIuMjIyIDBoLjAwM3oiLz48L3N2Zz4K)](https://www.linkedin.com/in/suganthan-mohanadasan/)
[![Follow @suganthan on X](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://x.com/suganthan)
[![Suganthan Mohanadasan on GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/Suganthan-Mohanadasan)
[![Follow Suganthan on Google](https://img.shields.io/badge/Google-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://profile.google.com/cp/Cg0vZy8xMXExX2pkY3Fi)

If you find it useful, star [the original project](https://github.com/Suganthan-Mohanadasan/Suganthans-GSC-MCP).
