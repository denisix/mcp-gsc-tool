import { getDateRange } from "../analytics.js";
import { bingCall, bingDate, bingSite } from "../bing.js";

type QueryStat = { Query: string; Impressions: number; Clicks: number; AvgImpressionPosition: number; AvgClickPosition: number; Date: string };

/** Sums Bing's weekly per-query rows inside [startDate, endDate]. Pure, for tests. */
export function aggregateBingQueries(rows: QueryStat[], startDate: string, endDate: string) {
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number; posWeight: number; posImpressions: number }>();
  for (const r of rows) {
    const d = bingDate(r.Date);
    if (!d || d < startDate || d > endDate) continue;
    const q = byQuery.get(r.Query) ?? { query: r.Query, clicks: 0, impressions: 0, posWeight: 0, posImpressions: 0 };
    q.clicks += r.Clicks;
    q.impressions += r.Impressions;
    // Bing reports -1 when there is no position: leave those rows out of the average entirely.
    if (r.AvgImpressionPosition > 0) {
      q.posWeight += r.AvgImpressionPosition * r.Impressions;
      q.posImpressions += r.Impressions;
    }
    byQuery.set(r.Query, q);
  }
  return [...byQuery.values()]
    .map(({ posWeight, posImpressions, ...q }) => ({
      ...q,
      ctr: q.impressions ? Math.round((q.clicks / q.impressions) * 10000) / 100 : 0,
      position: posImpressions ? Math.round((posWeight / posImpressions) * 10) / 10 : null,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

export async function bingQueryStats(opts: { site?: string; days?: number; limit?: number } = {}) {
  const { days = 28, limit = 50 } = opts;
  const siteUrl = await bingSite(opts.site);
  // Bing query stats are weekly buckets; a short window may hold only one or two of them.
  const { startDate, endDate } = getDateRange(days);
  const queries = aggregateBingQueries(await bingCall<QueryStat[]>("GetQueryStats", { siteUrl }), startDate, endDate);
  return {
    siteUrl,
    period: { startDate, endDate },
    totalQueries: queries.length,
    queries: queries.slice(0, limit),
    note: "Bing updates query stats weekly; each row is a weekly bucket. Position is Bing's average impression position.",
  };
}

export async function bingTraffic(opts: { site?: string; days?: number } = {}) {
  const { days = 90 } = opts;
  const siteUrl = await bingSite(opts.site);
  const { startDate, endDate } = getDateRange(days);
  const [traffic, crawl] = await Promise.all([
    bingCall<{ Date: string; Clicks: number; Impressions: number }[]>("GetRankAndTrafficStats", { siteUrl }),
    bingCall<any[]>("GetCrawlStats", { siteUrl }),
  ]);
  const daily = traffic
    .map((t) => ({ date: bingDate(t.Date) ?? "", clicks: t.Clicks, impressions: t.Impressions }))
    .filter((t) => t.date >= startDate && t.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const clicks = daily.reduce((n, t) => n + t.clicks, 0);
  const impressions = daily.reduce((n, t) => n + t.impressions, 0);
  const latest = crawl.map((c) => ({ ...c, Date: bingDate(c.Date) })).sort((a, b) => String(b.Date).localeCompare(String(a.Date)))[0];
  return {
    siteUrl,
    period: { startDate, endDate },
    totals: { clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0 },
    daily,
    latestCrawl: latest
      ? {
          date: latest.Date,
          crawledPages: latest.CrawledPages,
          inIndex: latest.InIndex,
          crawlErrors: latest.CrawlErrors,
          blockedByRobotsTxt: latest.BlockedByRobotsTxt,
          code2xx: latest.Code2xx, code301: latest.Code301, code302: latest.Code302, code4xx: latest.Code4xx, code5xx: latest.Code5xx,
          containsMalware: latest.ContainsMalware,
        }
      : null,
  };
}

export async function bingUrlInfo(url: string, site?: string) {
  const siteUrl = await bingSite(site);
  const info = await bingCall<any>("GetUrlInfo", { siteUrl, url });
  return {
    url: info?.Url ?? url,
    httpStatus: info?.HttpStatus ?? null,
    lastCrawled: bingDate(info?.LastCrawledDate),
    discovered: bingDate(info?.DiscoveryDate),
    documentSize: info?.DocumentSize ?? null,
    anchorCount: info?.AnchorCount ?? null,
    childUrls: info?.TotalChildUrlCount ?? null,
  };
}

export async function bingSubmitUrls(urls: string[], site?: string) {
  const siteUrl = await bingSite(site);
  const quota = await bingCall<{ DailyQuota: number; MonthlyQuota: number }>("GetUrlSubmissionQuota", { siteUrl });
  if (urls.length > quota.DailyQuota) {
    throw new Error(`Bing allows ${quota.DailyQuota} more URL submissions today for ${siteUrl}; got ${urls.length}.`);
  }
  await bingCall("SubmitUrlBatch", {}, { siteUrl, urlList: urls });
  return { siteUrl, submitted: urls.length, remainingToday: quota.DailyQuota - urls.length, monthlyQuota: quota.MonthlyQuota };
}

/** Bing crawl issues per URL, URLs blocked from Bing, and submitted sitemaps / feeds with their status. */
export async function bingSiteIssues(site?: string) {
  const siteUrl = await bingSite(site);
  const [issues, blocked, feeds] = await Promise.all([
    bingCall<any[] | null>("GetCrawlIssues", { siteUrl }),
    bingCall<any[] | null>("GetBlockedUrls", { siteUrl }),
    bingCall<any[] | null>("GetFeeds", { siteUrl }),
  ]);
  const dated = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "__type").map(([k, v]) => [k, bingDate(v) ?? v]));
  return {
    siteUrl,
    crawlIssues: (issues ?? []).map(dated),
    blockedUrls: (blocked ?? []).map(dated),
    sitemaps: (feeds ?? []).map((f) => ({ url: f.Url, type: f.Type, status: f.Status, urls: f.UrlCount, submitted: bingDate(f.Submitted), lastCrawled: bingDate(f.LastCrawled) })),
  };
}
