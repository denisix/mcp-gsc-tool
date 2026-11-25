import { getDateRange } from "../analytics.js";
import { yandexCall, yandexHostPath, yandexRange } from "../yandex.js";

type Device = "ALL" | "DESKTOP" | "MOBILE_AND_TABLET" | "MOBILE" | "TABLET";
const INDICATORS = ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"];
type Point = { date: string; value: number };
const sum = (pts: Point[] = []) => pts.reduce((n, p) => n + (p.value ?? 0), 0);
const day = (d: string) => d.slice(0, 10);

export async function yandexPopularQueries(opts: { site?: string; days?: number; limit?: number; orderBy?: "TOTAL_CLICKS" | "TOTAL_SHOWS"; device?: Device } = {}) {
  const { days = 28, limit = 50, orderBy = "TOTAL_CLICKS", device = "ALL" } = opts;
  const host = await yandexHostPath(opts.site);
  const { startDate, endDate } = getDateRange(days);
  const r = await yandexCall<{ queries?: { query_text: string; indicators: Record<string, number | null> }[]; count?: number }>(
    `${host.path}/search-queries/popular`,
    { query: { order_by: orderBy, query_indicator: INDICATORS, device_type_indicator: device, ...yandexRange(startDate, endDate), limit: String(Math.min(limit, 500)) } }
  );
  return {
    hostId: host.hostId,
    period: { startDate, endDate },
    totalQueries: r.count ?? null,
    queries: (r.queries ?? []).map((q) => {
      const shows = q.indicators.TOTAL_SHOWS ?? 0, clicks = q.indicators.TOTAL_CLICKS ?? 0;
      return {
        query: q.query_text,
        clicks,
        impressions: shows,
        ctr: shows ? Math.round((clicks / shows) * 10000) / 100 : 0,
        position: q.indicators.AVG_SHOW_POSITION != null ? Math.round(q.indicators.AVG_SHOW_POSITION * 10) / 10 : null,
      };
    }),
    note: "Yandex only reports queries it counts as popular for the site (the top ~3,000), not the full long tail.",
  };
}

/** Clicks/impressions totals and daily series from search-queries/all/history. */
export async function yandexTotals(site: string | undefined, days: number) {
  const host = await yandexHostPath(site);
  const { startDate, endDate } = getDateRange(days);
  const r = await yandexCall<{ indicators?: Record<string, Point[]> }>(`${host.path}/search-queries/all/history`, {
    query: { query_indicator: ["TOTAL_SHOWS", "TOTAL_CLICKS"], device_type_indicator: "ALL", ...yandexRange(startDate, endDate) },
  });
  const shows = r.indicators?.TOTAL_SHOWS ?? [], clicks = r.indicators?.TOTAL_CLICKS ?? [];
  const impressions = sum(shows), c = sum(clicks);
  return { host, period: { startDate, endDate }, clicks: c, impressions, ctr: impressions ? Math.round((c / impressions) * 10000) / 100 : 0, clicksDaily: clicks.map((p) => ({ date: day(p.date), value: p.value })) };
}

export async function yandexSiteHealth(opts: { site?: string; days?: number } = {}) {
  const { days = 90 } = opts;
  const host = await yandexHostPath(opts.site);
  const { startDate, endDate } = getDateRange(days);
  const range = yandexRange(startDate, endDate);
  // Samples are extras: one failing must not hide the health summary.
  const optional = <T>(p: Promise<T>) => p.catch((e: any) => ({ error: String(e.message ?? e) }) as const);
  const [summary, diagnostics, inSearch, indexing, events, broken, eventSamples] = await Promise.all([
    yandexCall<any>(`${host.path}/summary`),
    yandexCall<{ problems?: Record<string, { severity: string; state: string; last_state_update?: string }> }>(`${host.path}/diagnostics`),
    yandexCall<{ history?: Point[] }>(`${host.path}/search-urls/in-search/history`, { query: range }),
    yandexCall<{ indicators?: Record<string, Point[]> }>(`${host.path}/indexing/history`, { query: range }),
    yandexCall<{ indicators?: Record<string, Point[]> }>(`${host.path}/search-urls/events/history`, { query: range }),
    optional(yandexCall<{ count?: number; links?: any[] }>(`${host.path}/links/internal/broken/samples`, { query: { limit: "20" } })),
    optional(yandexCall<{ samples?: any[] }>(`${host.path}/search-urls/events/samples`, { query: { limit: "100" } })),
  ]);
  const series = (pts: Point[] = []) => pts.map((p) => ({ date: day(p.date), value: p.value }));
  const active = Object.entries(diagnostics.problems ?? {})
    .filter(([, p]) => p.state === "PRESENT")
    .map(([type, p]) => ({ type, severity: p.severity, since: p.last_state_update ?? null }));
  return {
    hostId: host.hostId,
    period: { startDate, endDate },
    summary: {
      sqi: summary.sqi ?? null,
      pagesInSearch: summary.searchable_pages_count ?? null,
      excludedPages: summary.excluded_pages_count ?? null,
      problems: summary.site_problems ?? null,
    },
    activeProblems: active,
    pagesInSearch: series(inSearch.history),
    // Pages Yandex downloaded, per HTTP status group (HTTP_2XX, HTTP_3XX, HTTP_4XX, HTTP_5XX, OTHER).
    crawledByStatus: Object.fromEntries(Object.entries(indexing.indicators ?? {}).map(([k, v]) => [k, sum(v)])),
    // Pages added to / removed from search over the period.
    searchEvents: Object.fromEntries(Object.entries(events.indicators ?? {}).map(([k, v]) => [k, sum(v)])),
    brokenInternalLinks: "error" in broken ? broken : { count: broken.count ?? 0, samples: (broken.links ?? []).slice(0, 20) },
    // Recently removed pages with Yandex's reason (excluded_url_status, e.g. NOT_CANONICAL, HTTP_ERROR, NOINDEX).
    removedFromSearch: "error" in eventSamples ? eventSamples : (eventSamples.samples ?? [])
      .filter((s) => s.event === "REMOVED_FROM_SEARCH")
      .slice(0, 20)
      .map((s) => ({ url: s.url, date: day(s.event_date ?? ""), reason: s.excluded_url_status, httpStatus: s.bad_http_status, target: s.target_url })),
  };
}

/** Queues URLs for Yandex recrawl until the daily quota runs out; the rest are reported as skipped. */
export async function yandexRecrawl(urls: string[], site?: string) {
  const host = await yandexHostPath(site);
  const quota = await yandexCall<{ daily_quota: number; quota_remainder: number }>(`${host.path}/recrawl/quota`);
  let remaining = quota.quota_remainder;
  const results: { url: string; taskId?: string; error?: string; skipped?: true }[] = [];
  for (const url of urls) {
    if (remaining <= 0) {
      results.push({ url, skipped: true });
      continue;
    }
    try {
      const r = await yandexCall<{ task_id: string; quota_remainder: number }>(`${host.path}/recrawl/queue`, { body: { url } });
      remaining = r.quota_remainder;
      results.push({ url, taskId: r.task_id });
    } catch (err: any) {
      results.push({ url, error: String(err.message ?? err) });
    }
  }
  return { hostId: host.hostId, dailyQuota: quota.daily_quota, remainingToday: remaining, results };
}
