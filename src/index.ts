#!/usr/bin/env -S bun --no-env-file

import { McpServer, type ToolResult } from "./mcp.js";
import { z } from "zod";

import { GUARDRAIL_SUFFIX, POSITION_CAVEAT, withMeta } from "./guardrails.js";
import { withSiteUrl } from "./auth.js";
import { quickWins } from "./tools/quick-wins.js";
import { ctrOpportunities } from "./tools/ctr-opportunities.js";
import { trafficDrops } from "./tools/traffic-drops.js";
import { contentGaps } from "./tools/content-gaps.js";
import { siteSnapshot } from "./tools/site-snapshot.js";
import { inspectUrlTool } from "./tools/inspect-url.js";
import { cannibalizationCheck } from "./tools/cannibalization-check.js";
import { contentDecay } from "./tools/content-decay.js";
import { topicClusterPerformance } from "./tools/topic-cluster-performance.js";
import { ctrVsBenchmark } from "./tools/ctr-vs-benchmark.js";
import { verifyClaim } from "./tools/verify-claim.js";
import { advancedSearchAnalytics } from "./tools/advanced-search-analytics.js";
import { checkAlerts } from "./tools/check-alerts.js";
import { contentRecommendations } from "./tools/content-recommendations.js";
import { multiSiteDashboard } from "./tools/multi-site-dashboard.js";
import { submitUrl, submitBatch, getIndexingStatus } from "./tools/submit-url.js";
import { submitSitemap, listSitemaps, getSitemap, deleteSitemap } from "./tools/submit-sitemap.js";
import { listAllSites, addSite, deleteSite } from "./tools/sites.js";
import { comparePeriods } from "./tools/compare-periods.js";
import { drilldown } from "./tools/drilldown.js";
import { batchInspectUrls, MAX_BATCH_INSPECT } from "./tools/batch-inspect.js";
import { indexingCoverage } from "./tools/indexing-coverage.js";
import { MAX_AUDIT_PAGES, pageSpeed, siteAudit } from "./tools/pagespeed.js";
import { exportCsv } from "./tools/export-csv.js";
import { bingConfigured } from "./bing.js";
import { yandexConfigured } from "./yandex.js";
import { bingQueryStats, bingTraffic, bingUrlInfo, bingSiteIssues, bingSubmitUrls } from "./tools/bing.js";
import { yandexPopularQueries, yandexSiteHealth, yandexRecrawl } from "./tools/yandex.js";
import { compareEngines } from "./tools/compare-engines.js";
// v2.3 image SEO tools — paired with the Image SEO post on suganthan.com.
// v2.4 generative AI tools — the Generative AI report has no API, but AI Mode
// conversation exhaust leaks into the regular query dimension. See the tool
// file for the mechanism and sources.
import { genaiConversationQueries } from "./tools/genai-conversation-queries.js";
// v2.5: the bridge from "which pages fail in image search" to "why". Fetches
// the user's own pages and audits the on-page image factors.
// Search Analytics API additions of November 2026: branded classification,
// multimodal search (type=webMultimodal) and multi-value filter lists.
import { brandedVsNonBranded } from "./tools/branded-vs-non-branded.js";
import { multimodalSearchOverview } from "./tools/multimodal-search-overview.js";

const filterListsSchema = z
  .array(
    z.object({
      dimension: z.enum(["country", "device"]).describe("Dimension to filter. Google accepts only country and device here"),
      expressions: z.array(z.string()).min(1).describe("Values to match (OR). Country: ISO 3166-1 alpha-3 codes such as usa, gbr, deu. Device: DESKTOP, MOBILE, TABLET"),
    })
  )
  .default([])
  .describe("Multi-value filters: keep rows matching ANY listed value, e.g. [{dimension:'country',expressions:['deu','aut','che']}]. A dimension cannot appear in both filters and filter_lists");


const server = new McpServer({
  name: "mcp-gsc-tool",
  version: "2.5.1",
});

// Every tool that queries a property takes an optional `site_url`. The wrapper
// adds it to the schema and runs the handler inside withSiteUrl(), so
// getConfig() returns it for the whole call. Excluded: tools with no property
// in play: the Indexing API (URL-based) and multi_site_dashboard (takes site_urls).
const SITE_URL_PARAM = z
  .string()
  .optional()
  .describe(
    "GSC property for this call, e.g. sc-domain:example.com or https://www.example.com/. " +
    "Omit to use the default property (GSC_SITE_URL). Your credentials must have access to it."
  );
const NO_PROPERTY_TOOLS = new Set([
  "multi_site_dashboard", "submit_url", "submit_batch", "indexing_status", "pagespeed", "list_sites", "add_site", "delete_site",
  "bing_query_stats", "bing_traffic", "bing_url_info", "bing_site_issues", "bing_submit_urls", "yandex_popular_queries", "yandex_site_health", "yandex_recrawl",
]);
// Tools that change state at Google. GSC_READ_ONLY=1 leaves them unregistered.
const WRITE_TOOLS = new Set(["submit_url", "submit_batch", "submit_sitemap", "delete_sitemap", "add_site", "delete_site", "bing_submit_urls", "yandex_recrawl"]);
const READ_ONLY = ["1", "true", "yes"].includes((process.env.GSC_READ_ONLY ?? "").toLowerCase());

/** Registers a tool; property tools get `site_url` and run inside withSiteUrl(). */
function tool(name: string, description: string, shape: z.ZodRawShape, handler: (args: any) => ToolResult | Promise<ToolResult>) {
  if (READ_ONLY && WRITE_TOOLS.has(name)) return;
  if (NO_PROPERTY_TOOLS.has(name)) return server.tool(name, description, shape, handler);
  server.tool(name, description, { ...shape, site_url: SITE_URL_PARAM }, (args) => withSiteUrl(args.site_url, () => handler(args)));
}

// 1. Quick Wins
tool(
  "quick_wins",
  "Find keywords you're almost ranking for that could be pushed to page one. Returns queries at positions 4-15 with high impressions, sorted by traffic opportunity." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    min_impressions: z.number().default(100).describe("Minimum impressions threshold"),
    max_position: z.number().default(15).describe("Maximum position to include"),
  },
  async ({ days, min_impressions, max_position }) => {
    const results = await quickWins(days, min_impressions, max_position);
    const wrapped = withMeta(results, "quick_wins", { days, min_impressions, max_position });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 2. CTR Opportunities
tool(
  "ctr_opportunities",
  "Find pages with high impressions but CTR significantly below expected for their position. These are title/meta description optimisation candidates." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    min_impressions: z.number().default(500).describe("Minimum impressions threshold"),
  },
  async ({ days, min_impressions }) => {
    const results = await ctrOpportunities(days, min_impressions);
    const wrapped = withMeta(results, "ctr_opportunities", { days, min_impressions });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 3. Traffic Drops
tool(
  "traffic_drops",
  "Find pages that lost the most traffic recently. Compares current period vs prior period and diagnoses whether each drop is a ranking loss, CTR collapse, or demand decline." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days per period to compare"),
  },
  async ({ days }) => {
    const results = await trafficDrops(days);
    const wrapped = withMeta(results, "traffic_drops", { days });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 4. Content Gaps
tool(
  "content_gaps",
  "Find topics you should create content for. Returns queries where you get impressions but rank beyond position 20, meaning there is search demand but no real content targeting it." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(90).describe("Number of days to analyse"),
    min_impressions: z.number().default(50).describe("Minimum impressions threshold"),
    min_position: z.number().default(20).describe("Minimum position (queries ranking worse than this)"),
  },
  async ({ days, min_impressions, min_position }) => {
    const results = await contentGaps(days, min_impressions, min_position);
    const wrapped = withMeta(results, "content_gaps", { days, min_impressions, min_position });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 5. Site Snapshot
tool(
  "site_snapshot",
  "Get a quick overview of how the site is performing. Returns total clicks, impressions, CTR, and position with a comparison to the prior period." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days per period"),
  },
  async ({ days }) => {
    const results = await siteSnapshot(days);
    const wrapped = withMeta(results, "site_snapshot", { days });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 6. Inspect URL
tool(
  "inspect_url",
  "Check if a URL is indexed and why or why not. Returns indexing status, last crawl date, canonical info, robots/noindex issues, and mobile usability in one answer." + GUARDRAIL_SUFFIX,
  {
    url: z.string().describe("The full URL to inspect"),
  },
  async ({ url }) => {
    const results = await inspectUrlTool(url);
    const wrapped = withMeta(results, "inspect_url", { url });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 7. Cannibalization Check
tool(
  "cannibalization_check",
  "Find keywords where multiple pages from your site compete against each other. Shows which page ranks higher, the position gap, and combined impressions being split." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    min_impressions: z.number().default(50).describe("Minimum combined impressions for a query"),
  },
  async ({ days, min_impressions }) => {
    const results = await cannibalizationCheck(days, min_impressions);
    const wrapped = withMeta(results, "cannibalization_check", { days, min_impressions });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 8. Content Decay
tool(
  "content_decay",
  "Find pages that are slowly dying with consistent traffic decline over three consecutive 30-day periods. One bad month is noise; three consecutive bad months is a problem." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {},
  async () => {
    const results = await contentDecay();
    const wrapped = withMeta(results, "content_decay", {});
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 9. Topic Cluster Performance
tool(
  "topic_cluster_performance",
  "See how a group of pages performs as a whole. Aggregates clicks, impressions, CTR, and position for all pages matching a URL path pattern, plus top 5 pages and queries." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    path_pattern: z.string().describe("URL path pattern to match (e.g. /blog/seo)"),
    days: z.number().default(28).describe("Number of days to analyse"),
  },
  async ({ path_pattern, days }) => {
    const results = await topicClusterPerformance(path_pattern, days);
    const wrapped = withMeta(results, "topic_cluster_performance", { path_pattern, days });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 10. CTR vs Benchmark
tool(
  "ctr_vs_benchmark",
  "Compare your actual CTR per page against industry benchmarks by position. Flags pages significantly underperforming for their ranking position." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    min_impressions: z.number().default(200).describe("Minimum impressions threshold"),
  },
  async ({ days, min_impressions }) => {
    const results = await ctrVsBenchmark(days, min_impressions);
    const wrapped = withMeta(results, "ctr_vs_benchmark", { days, min_impressions });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 11. Verify Claim
tool(
  "verify_claim",
  "Verify a specific numeric claim against live GSC data. Use this to self-check your analysis before presenting findings. Pass the claim text, the metric to check, the expected value, and optionally a URL or query to filter by. Returns whether the claim is verified and any discrepancy found.",
  {
    claim: z.string().describe("The claim to verify, e.g. 'Homepage gets 500 clicks per month'"),
    metric: z.enum(["clicks", "impressions", "ctr", "position"]).describe("Which metric to check"),
    expected_value: z.number().describe("The numeric value you claimed"),
    url: z.string().optional().describe("Filter to a specific URL"),
    query: z.string().optional().describe("Filter to a specific search query"),
    days: z.number().default(28).describe("Number of days to check"),
  },
  async ({ claim, metric, expected_value, url, query, days }) => {
    const results = await verifyClaim(claim, metric, expected_value, url, query, days);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// 12. Advanced Search Analytics
tool(
  "advanced_search_analytics",
  "Run a custom search analytics query with flexible dimensions and filters. Supports country, device, query, page, searchAppearance and brandedClassification, multi-country / multi-device filter lists, and search type (web/image/video/news/discover/googleNews/webMultimodal). Google rejects some combinations: brandedClassification cannot be combined with a query filter, and webMultimodal cannot be grouped or filtered by query or brandedClassification. For power users who need specific data cuts." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    dimensions: z.array(z.string()).default(["query"]).describe("Dimensions to group by: query, page, country, device, date, searchAppearance, brandedClassification (BRANDED / NON_BRANDED, data from 2026-02-21, eligible top-level properties only)"),
    filters: z.array(z.object({
      dimension: z.string().describe("Dimension to filter: query, page, country, device, searchAppearance, brandedClassification (equals BRANDED or NON_BRANDED only)"),
      operator: z.string().describe("Operator: contains, notContains, equals, notEquals, includingRegex, excludingRegex"),
      expression: z.string().describe("Filter value"),
    })).default([]).describe("Dimension filters to apply"),
    row_limit: z.number().default(100).describe("Maximum rows to return (max 500)"),
    order_by: z.string().default("clicks").describe("Sort by: clicks, impressions, ctr, position"),
    order_direction: z.string().default("descending").describe("Sort direction: ascending, descending"),
    search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews", "webMultimodal"]).optional().describe("Filter by GSC search surface. Defaults to web. Use 'image' for Google Images, 'webMultimodal' for Google Lens, Circle to Search and image uploads."),
    filter_lists: filterListsSchema,
    hourly: z.boolean().default(false).describe("Hourly data (dataState hourly_all, adds the 'hour' dimension). Covers only the last ~10 days, including today's partial data. Use to check a release or incident on the same day"),
  },
  async ({ days, dimensions, filters, row_limit, order_by, order_direction, search_type, filter_lists, hourly }) => {
    const results = await advancedSearchAnalytics(days, dimensions, filters, row_limit, order_by, order_direction, search_type, filter_lists, hourly);
    const wrapped = withMeta(results, "advanced_search_analytics", { days, dimensions, filters, filter_lists, row_limit, order_by, search_type, hourly });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 13. Check Alerts
tool(
  "check_alerts",
  "Check for SEO alerts: position drops, CTR collapses, click losses, and pages that disappeared from search results. Returns severity-rated alerts so you know what needs attention first." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(7).describe("Number of days per period to compare"),
    position_drop_threshold: z.number().default(20).describe("Alert if position drops more than this many spots"),
    ctr_drop_threshold: z.number().default(50).describe("Alert if CTR drops more than this percentage"),
    click_drop_threshold: z.number().default(30).describe("Alert if clicks drop more than this percentage"),
  },
  async ({ days, position_drop_threshold, ctr_drop_threshold, click_drop_threshold }) => {
    const results = await checkAlerts(days, position_drop_threshold, ctr_drop_threshold, click_drop_threshold);
    const wrapped = withMeta(results, "check_alerts", { days, position_drop_threshold, ctr_drop_threshold, click_drop_threshold });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 14. Content Recommendations
tool(
  "content_recommendations",
  "Get actionable content recommendations by cross-referencing quick wins, content gaps, and cannibalisation data. Returns prioritised actions: pages to update, content to create, and pages to consolidate." + GUARDRAIL_SUFFIX,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    max_recommendations: z.number().default(10).describe("Maximum number of recommendations"),
  },
  async ({ days, max_recommendations }) => {
    const results = await contentRecommendations(days, max_recommendations);
    const wrapped = withMeta(results, "content_recommendations", { days, max_recommendations });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 15. Generate Report

// 16. Multi-Site Dashboard
tool(
  "multi_site_dashboard",
  "Health check across multiple GSC properties in one view. Shows clicks, impressions, CTR, and position for each site with period comparison and health status. Agency essential." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    site_urls: z.array(z.string()).optional().describe("Array of GSC property URLs. Falls back to GSC_SITE_URLS env var."),
    days: z.number().default(28).describe("Number of days per period"),
  },
  async ({ site_urls, days }) => {
    const results = await multiSiteDashboard(site_urls, days);
    const wrapped = withMeta(results, "multi_site_dashboard", { site_urls, days });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 17. Submit URL for Indexing
tool(
  "submit_url",
  "Submit a URL to Google's Indexing API to request crawling and indexing. Google only supports the Indexing API for pages with JobPosting or BroadcastEvent (livestream) structured data; for other pages it may be ignored, and submit_sitemap is the supported route." + GUARDRAIL_SUFFIX,
  {
    url: z.string().describe("The full URL to submit for indexing"),
    action: z.enum(["URL_UPDATED", "URL_DELETED"]).default("URL_UPDATED").describe("URL_UPDATED for new/changed content, URL_DELETED for removed pages"),
  },
  async ({ url, action }) => {
    const results = await submitUrl(url, action);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// 18. Batch Submit URLs
tool(
  "submit_batch",
  "Submit up to 200 URLs to Google's Indexing API in one go. Daily quota is 200 URL notifications. Use for bulk indexing requests after publishing multiple pages or a site-wide update." + GUARDRAIL_SUFFIX,
  {
    urls: z.array(z.string()).describe("Array of URLs to submit (max 200)"),
    action: z.enum(["URL_UPDATED", "URL_DELETED"]).default("URL_UPDATED").describe("URL_UPDATED for new/changed content, URL_DELETED for removed pages"),
  },
  async ({ urls, action }) => {
    const results = await submitBatch(urls, action);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// 19. Submit Sitemap
tool(
  "submit_sitemap",
  "Notify Google of a new or updated sitemap. Triggers Google to recrawl the sitemap and discover new pages." + GUARDRAIL_SUFFIX,
  {
    sitemap_url: z.string().optional().describe("Full sitemap URL (defaults to {site_url}/sitemap.xml)"),
  },
  async ({ sitemap_url }) => {
    const results = await submitSitemap(sitemap_url);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }
);

// 20. List Sitemaps
tool(
  "list_sitemaps",
  "List all sitemaps submitted for the site, with status, errors, warnings, and indexed page counts." + GUARDRAIL_SUFFIX,
  {},
  async () => {
    const results = await listSitemaps();
    const wrapped = withMeta(results, "list_sitemaps", {});
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// v2.3 IMAGE SEO TOOLS
//
// These tools all pass type=image to the GSC Search Analytics API, which most
// third-party tools never expose. Paired with the Image SEO technical guide
// on suganthan.com (link in README). All 7 reuse the existing fetchAllRows
// plumbing; the only meaningfully new logic is the join in compare_web_vs_image.
// ---------------------------------------------------------------------------

// 21. Image Keyword Overview

// 22. Image Search Quick Wins

// 23. Compare Web vs Image

// 24. Image Pages Overview

// 25. Image Keyword Trends

// 26. Image Impressions No Clicks

// 27. Image Content Decay

// 28. Generative AI Conversation Queries
tool(
  "genai_conversation_queries",
  "Surface AI-conversation exhaust hiding in your regular query data: bare replies to Google's AI ('yes', 'go on'), 'what about X' pivot follow-ups, conversational questions, AI-visibility tracker probes, and full agent prompts logged as queries. Google counts every AI Mode follow-up as a new query and folds AI Mode/AI Overviews into the web search type, so these fragments carry real impressions, positions and clicks. The dedicated Generative AI report has no query dimension; this is the only query-level AI evidence available anywhere. Classifies every match into seven buckets with landing pages, plus a monthly timeline showing when reply-artefacts first appeared on your site. Treat probe and harness buckets as machine traffic, not demand." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(480).describe("Days to analyse (default 480, the full 16 months GSC retains)"),
    min_impressions: z.number().default(1).describe("Minimum impressions for a query to be listed (single-impression rows are evidence, not noise, so the default keeps them)"),
    max_rows_per_bucket: z.number().default(50).describe("Maximum rows returned per bucket; totals always cover everything"),
    include_timeline: z.boolean().default(true).describe("Include the monthly artefact timeline (one extra API call)"),
  },
  async ({ days, min_impressions, max_rows_per_bucket, include_timeline }) => {
    const results = await genaiConversationQueries(days, min_impressions, max_rows_per_bucket, include_timeline);
    const wrapped = withMeta(results, "genai_conversation_queries", { days, min_impressions, max_rows_per_bucket, include_timeline });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 29. Image Page Audit

// 30. Branded vs Non-Branded
tool(
  "branded_vs_non_branded",
  "Split search performance into branded and non-branded traffic using Google's own query classification. Returns clicks, impressions, CTR, position and share for each side, change against the previous period, a daily trend, and the top queries and pages on each side. Only top-level properties with enough query volume are classified, and only from 2026-02-21; when eligible is false the data is unavailable, not zero." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(28).describe("Number of days to analyse"),
    row_limit: z.number().default(25).describe("Maximum top queries and pages to return per side"),
    filter_lists: filterListsSchema,
    include_trend: z.boolean().default(true).describe("Include the daily branded / non-branded trend"),
    search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search surface. Defaults to web. Multimodal search has no branded classification"),
  },
  async ({ days, row_limit, filter_lists, include_trend, search_type }) => {
    const results = await brandedVsNonBranded(days, row_limit, filter_lists, include_trend, search_type);
    const wrapped = withMeta(results, "branded_vs_non_branded", { days, row_limit, filter_lists, include_trend, search_type });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// 31. Multimodal Search Overview
tool(
  "multimodal_search_overview",
  "Performance in multimodal search: Google Lens, Circle to Search on Android, and image uploads in Google Search. Returns totals with change against the previous period, the size of multimodal relative to web search, top pages, countries, devices and a daily trend. Google provides no queries for this surface, so there is no keyword breakdown." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().default(90).describe("Number of days to analyse (multimodal is low volume, default 90)"),
    row_limit: z.number().default(25).describe("Maximum pages and countries to return"),
    filter_lists: filterListsSchema,
  },
  async ({ days, row_limit, filter_lists }) => {
    const results = await multimodalSearchOverview(days, row_limit, filter_lists);
    const wrapped = withMeta(results, "multimodal_search_overview", { days, row_limit, filter_lists });
    return {
      content: [{ type: "text", text: JSON.stringify(wrapped, null, 2) }],
    };
  }
);

// ---------------------------------------------------------------------------
// Properties, sitemaps, indexing status
// ---------------------------------------------------------------------------
const json = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
const searchTypeSchema = z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().describe("Search surface. Defaults to web");
const filtersSchema = z.array(z.object({
  dimension: z.string().describe("query, page, country, device or searchAppearance"),
  operator: z.string().describe("contains, notContains, equals, notEquals, includingRegex, excludingRegex"),
  expression: z.string(),
})).default([]).describe("Dimension filters (AND)");

tool(
  "list_sites",
  "List every site these credentials can access: Search Console properties with permission level (siteOwner, siteFullUser, siteRestrictedUser, siteUnverifiedUser), plus Bing and Yandex sites when configured. Pass a listed site as site_url (Google) or site (bing_* / yandex_*) to query it.",
  {},
  async () => json(await listAllSites())
);

tool(
  "add_site",
  "Add a property to Search Console (it must still be verified before it returns data)." + GUARDRAIL_SUFFIX,
  { property: z.string().describe("e.g. sc-domain:example.com or https://www.example.com/") },
  async ({ property }) => json(await addSite(property))
);

tool(
  "delete_site",
  "Remove a property from this account's Search Console. Data is kept by Google and returns if the property is re-added. Confirm with the user first." + GUARDRAIL_SUFFIX,
  { property: z.string().describe("e.g. sc-domain:example.com or https://www.example.com/") },
  async ({ property }) => json(await deleteSite(property))
);

tool(
  "get_sitemap",
  "Status of one submitted sitemap: last submitted/downloaded, pending, warnings, errors, and submitted vs indexed counts per content type." + GUARDRAIL_SUFFIX,
  { sitemap_url: z.string().optional().describe("Full sitemap URL (defaults to {site_url}/sitemap.xml)") },
  async ({ sitemap_url }) => json(withMeta(await getSitemap(sitemap_url), "get_sitemap", { sitemap_url }))
);

tool(
  "delete_sitemap",
  "Remove a sitemap from Search Console (Google stops reading it; already indexed pages are not removed). Confirm with the user first." + GUARDRAIL_SUFFIX,
  { sitemap_url: z.string().describe("Full URL of the submitted sitemap") },
  async ({ sitemap_url }) => json(await deleteSitemap(sitemap_url))
);

tool(
  "indexing_status",
  "Last Indexing API notification Google recorded for a URL (latest URL_UPDATED / URL_DELETED and when). Shows what was submitted, not whether the page is indexed: use inspect_url for that." + GUARDRAIL_SUFFIX,
  { url: z.string().describe("Full URL") },
  async ({ url }) => json(await getIndexingStatus(url))
);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
tool(
  "compare_periods",
  "Period-over-period (or year-over-year) comparison: totals with % change, plus per query/page top gainers, top losers, new and lost items. Both windows end 3 days back so partial recent data does not read as a drop." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    days: z.number().int().min(1).max(240).default(28).describe("Days per period"),
    dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]).default("query").describe("What to compare"),
    limit: z.number().int().min(1).max(200).default(25).describe("Rows per list (gainers, losers, new, lost)"),
    filters: filtersSchema,
    search_type: searchTypeSchema,
    year_over_year: z.boolean().default(false).describe("Compare against the same window 52 weeks earlier instead of the previous period (removes seasonality)"),
  },
  async ({ days, dimension, limit, filters, search_type, year_over_year }) =>
    json(withMeta(await comparePeriods(days, dimension, limit, filters, search_type, year_over_year), "compare_periods", { days, dimension, filters, search_type, year_over_year }))
);

tool(
  "page_queries",
  "Drill down: pass `page` to get the queries that bring it traffic, or `query` to get the pages that rank for it (several pages for one query = possible cannibalization)." + GUARDRAIL_SUFFIX + POSITION_CAVEAT,
  {
    page: z.string().optional().describe("Exact page URL as GSC reports it"),
    query: z.string().optional().describe("Exact search query"),
    days: z.number().default(28).describe("Number of days to analyse"),
    limit: z.number().int().min(1).max(1000).default(50).describe("Maximum rows returned"),
    search_type: searchTypeSchema,
  },
  async ({ page, query, days, limit, search_type }) =>
    json(withMeta(await drilldown({ page, query, days, limit, searchType: search_type }), "page_queries", { page, query, days }))
);

tool(
  "batch_inspect_urls",
  `Run URL Inspection on up to ${MAX_BATCH_INSPECT} URLs (3 at a time): indexed or not, coverage state, last crawl, canonical match and issues, with a summary. Stops and returns partial results if the daily inspection quota (2,000 per property) runs out.` + GUARDRAIL_SUFFIX,
  { urls: z.array(z.string()).min(1).max(MAX_BATCH_INSPECT).describe("URLs on this property") },
  async ({ urls }) => json(withMeta(await batchInspectUrls(urls), "batch_inspect_urls", { count: urls.length }))
);

tool(
  "indexing_coverage",
  "Cross-check the sitemap against search visibility: sitemap URLs with no impressions (likely not indexed or never shown), pages with impressions missing from the sitemap, and coverage %. Reads the property's submitted sitemaps (or sitemap_url), follows sitemap indexes, handles .xml.gz. Optionally URL-inspects a sample of the no-impression URLs." + GUARDRAIL_SUFFIX,
  {
    sitemap_url: z.string().optional().describe("Sitemap or sitemap index URL. Defaults to every sitemap submitted in GSC"),
    days: z.number().default(90).describe("Days of search data to compare against"),
    limit: z.number().int().min(1).max(1000).default(50).describe("URLs listed per group (totals always cover everything)"),
    inspect_sample: z.number().int().min(0).max(20).default(0).describe("URL-inspect this many no-impression URLs (uses inspection quota)"),
  },
  async ({ sitemap_url, days, limit, inspect_sample }) =>
    json(withMeta(await indexingCoverage({ sitemapUrl: sitemap_url, days, limit, inspectSample: inspect_sample }), "indexing_coverage", { sitemap_url, days, inspect_sample }))
);

tool(
  "pagespeed",
  "PageSpeed Insights / Lighthouse audit of one URL: real-user CrUX Core Web Vitals (LCP, INP, CLS, FCP, TTFB at p75, page and origin), lab metrics, scores for performance, accessibility, best practices and SEO, the biggest speed savings, and every failed check (SEO: indexability, title/meta, links, hreflang, canonical, robots.txt; plus accessibility and best-practice errors). No Search Console access needed. Takes 10-40 s.",
  {
    url: z.string().describe("Public page URL"),
    strategy: z.enum(["mobile", "desktop"]).default("mobile").describe("Google indexes mobile-first, so mobile is the default"),
  },
  async ({ url, strategy }) => json(await pageSpeed(url, strategy))
);

tool(
  "site_audit",
  `Lighthouse audit of up to ${MAX_AUDIT_PAGES} pages at once: the given urls, or the property's top pages by clicks. Returns scores per page and failed checks (SEO, accessibility, best practices) grouped by check with the pages each affects, so template-wide problems stand out. Takes about 20 s per 2 pages.` + GUARDRAIL_SUFFIX,
  {
    urls: z.array(z.string()).max(MAX_AUDIT_PAGES).optional().describe("Pages to audit; omit to use the top pages by clicks"),
    pages: z.number().int().min(1).max(MAX_AUDIT_PAGES).default(5).describe("How many top pages when urls is omitted"),
    strategy: z.enum(["mobile", "desktop"]).default("mobile"),
  },
  async ({ urls, pages, strategy }) => json(withMeta(await siteAudit({ urls, pages, strategy }), "site_audit", { pages, strategy }, "PageSpeed Insights API + Google Search Console API (live data)",
    "Scores and checks come directly from Lighthouse via the PageSpeed Insights API; a lab run varies between runs. Base your analysis only on this data."))
);

tool(
  "export_csv",
  "Export a full Search Analytics report (all rows, past the 25k API page limit, up to 1M) to a new CSV file on this machine, and return the path, row count and a 5-row preview. Use for large datasets or spreadsheets instead of pulling rows into the chat. Never overwrites an existing file.",
  {
    dimensions: z.array(z.string()).min(1).default(["query", "page"]).describe("query, page, country, device, date, searchAppearance"),
    days: z.number().default(28).describe("Number of days"),
    filters: filtersSchema,
    search_type: searchTypeSchema,
    max_rows: z.number().int().min(1).max(1_000_000).default(1_000_000).describe("Stop after this many rows"),
    output_path: z.string().optional().describe("Where to write the .csv (default: the system temp folder)"),
  },
  async ({ dimensions, days, filters, search_type, max_rows, output_path }) =>
    json(withMeta(await exportCsv({ dimensions, days, filters, searchType: search_type, maxRows: max_rows, outputPath: output_path }), "export_csv", { dimensions, days }))
);

// ---------------------------------------------------------------------------
// Bing Webmaster (BING_API_KEY) and Yandex Webmaster (YANDEX_WEBMASTER_TOKEN)
// Registered only when their credentials are set.
// ---------------------------------------------------------------------------
const bingSiteParam = z.string().optional().describe("Bing site exactly as verified, e.g. https://www.example.com/ (default BING_SITE_URL, else derived from GSC_SITE_URL)");
const yandexSiteParam = z.string().optional().describe("Yandex host, e.g. https://example.com or a host_id like https:example.com:443 (default YANDEX_HOST, else derived from GSC_SITE_URL)");

if (bingConfigured()) {
  tool(
    "bing_query_stats",
    "Bing search queries for the site: clicks, impressions, CTR and average position, summed over the window. Bing updates this weekly." + GUARDRAIL_SUFFIX,
    { site: bingSiteParam, days: z.number().default(28), limit: z.number().int().min(1).max(1000).default(50) },
    async (a) => json(await bingQueryStats(a))
  );
  tool(
    "bing_traffic",
    "Bing daily clicks and impressions with totals, plus the latest crawl stats (pages crawled, in index, crawl errors, robots.txt blocks, HTTP status counts, malware)." + GUARDRAIL_SUFFIX,
    { site: bingSiteParam, days: z.number().default(90) },
    async (a) => json(await bingTraffic(a))
  );
  tool(
    "bing_url_info",
    "What Bing knows about one URL: HTTP status, discovery and last crawl date, size, anchors.",
    { url: z.string(), site: bingSiteParam },
    async ({ url, site }) => json(await bingUrlInfo(url, site))
  );
  tool(
    "bing_site_issues",
    "Bing errors for the site: crawl issues per URL (HTTP errors, blocked by robots.txt, DNS, timeouts, malware), URLs blocked from Bing, and submitted sitemaps / feeds with status and URL count." + GUARDRAIL_SUFFIX,
    { site: bingSiteParam },
    async ({ site }) => json(await bingSiteIssues(site))
  );
  tool(
    "bing_submit_urls",
    "Submit up to 500 URLs to Bing for crawling (SubmitUrlBatch). Checks the daily quota first." + GUARDRAIL_SUFFIX,
    { urls: z.array(z.string()).min(1).max(500), site: bingSiteParam },
    async ({ urls, site }) => json(await bingSubmitUrls(urls, site))
  );
}

if (yandexConfigured()) {
  tool(
    "yandex_popular_queries",
    "Yandex search queries for the site: clicks, impressions, CTR and average position. Yandex lists only its popular queries for the site." + GUARDRAIL_SUFFIX,
    {
      site: yandexSiteParam,
      days: z.number().default(28),
      limit: z.number().int().min(1).max(500).default(50),
      order_by: z.enum(["TOTAL_CLICKS", "TOTAL_SHOWS"]).default("TOTAL_CLICKS"),
      device: z.enum(["ALL", "DESKTOP", "MOBILE_AND_TABLET", "MOBILE", "TABLET"]).default("ALL"),
    },
    async ({ site, days, limit, order_by, device }) => json(await yandexPopularQueries({ site, days, limit, orderBy: order_by, device }))
  );
  tool(
    "yandex_site_health",
    "Yandex Webmaster health: SQI (site quality index), pages in search and excluded, active diagnostics problems by severity, pages-in-search trend, crawl results by HTTP status, pages added to / removed from search, broken internal links, and recently removed pages with the reason." + GUARDRAIL_SUFFIX,
    { site: yandexSiteParam, days: z.number().default(90) },
    async (a) => json(await yandexSiteHealth(a))
  );
  tool(
    "yandex_recrawl",
    "Queue URLs for Yandex recrawl. The daily quota is per site and often small; URLs past it are returned as skipped." + GUARDRAIL_SUFFIX,
    { urls: z.array(z.string()).min(1).max(100), site: yandexSiteParam },
    async ({ urls, site }) => json(await yandexRecrawl(urls, site))
  );
}

tool(
  "compare_engines",
  "Google vs Bing vs Yandex for the same window: clicks, impressions, CTR, click share and top queries per engine. Engines without credentials (BING_API_KEY, YANDEX_WEBMASTER_TOKEN) are listed as not configured; one engine failing does not stop the others." + GUARDRAIL_SUFFIX,
  {
    days: z.number().default(28),
    limit: z.number().int().min(1).max(50).default(10).describe("Top queries per engine"),
    bing_site: bingSiteParam,
    yandex_site: yandexSiteParam,
  },
  async ({ days, limit, bing_site, yandex_site }) =>
    json(withMeta(await compareEngines({ days, limit, bingSite: bing_site, yandexSite: yandex_site }), "compare_engines", { days },
      "Google Search Console, Bing Webmaster and Yandex Webmaster APIs (live data)",
      "Numbers come directly from each engine's API. Base your analysis only on this data. Do not invent or assume additional context."))
);

// ---------------------------------------------------------------------------
// Prompts: guided workflows that chain the tools above
// ---------------------------------------------------------------------------
const siteArg = { name: "site_url", description: "GSC property (defaults to GSC_SITE_URL)" };
const onSite = (a: Record<string, string>) => (a.site_url ? ` Use site_url "${a.site_url}" on every call.` : "");

server.prompt(
  "weekly_seo_report",
  "Weekly SEO report: what changed, why, and what to do next",
  [siteArg],
  (a) => `Write a weekly SEO report for this Search Console property.${onSite(a)}
1. site_snapshot (days 7) for the headline numbers.
2. compare_periods (days 7, dimension query) and compare_periods (days 7, dimension page) for movers.
3. check_alerts (days 7) for anything urgent.
4. quick_wins and ctr_opportunities for next actions.
Report: headline change, top 5 gainers and losers with likely causes, alerts by severity, and 3-5 prioritised actions. Quote only numbers the tools returned.`
);

server.prompt(
  "diagnose_traffic_drop",
  "Find the cause of a traffic drop, for the whole site or one page",
  [siteArg, { name: "page", description: "Page URL that dropped (optional)" }],
  (a) => `Diagnose a traffic drop${a.page ? ` on ${a.page}` : ""}.${onSite(a)}
1. compare_periods (days 28${a.page ? `, filters page equals ${a.page}` : ""}) and again with year_over_year true, to separate a real drop from seasonality.
2. ${a.page ? `page_queries with page ${a.page} to see which queries fell.` : "traffic_drops to find the pages that lost most."}
3. For the top affected pages: inspect_url (indexing, canonical, robots) and pagespeed (Core Web Vitals).
4. compare_periods with dimension device and country to see if the drop is segment-specific.
Classify the cause (ranking loss, CTR loss, demand drop, de-indexing, technical) with the evidence for each, then recommend fixes.`
);

server.prompt(
  "indexing_audit",
  "Audit indexing: sitemap coverage, non-indexed pages and their reasons",
  [siteArg],
  (a) => `Audit indexing for this property.${onSite(a)}
1. list_sitemaps for errors, warnings and submitted vs indexed counts.
2. indexing_coverage with inspect_sample 10.
3. batch_inspect_urls on up to 20 important URLs from impressionsNotInSitemap and inSitemapNoImpressions.
Group non-indexed URLs by reason (noindex, robots.txt, canonical to another URL, crawled not indexed, discovered not crawled, fetch error), estimate how many URLs each reason covers, and give a fix for each group.`
);

async function main() {
  const cmd = process.argv[2];
  if (cmd === "setup") {
    const { runSetup } = await import("./setup.js");
    const code = await runSetup(process.argv.slice(3));
    process.exit(code);
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log("2.5.1");
    process.exit(0);
  }

  console.error("mcp-gsc-tool v2.5.1 running on stdio");
  await server.serveStdio();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
