import { fetchAllRows, getDateRange } from "../analytics.js";
import { siteUrlOverride } from "../auth.js";
import { bingConfigured } from "../bing.js";
import { yandexConfigured } from "../yandex.js";
import { bingQueryStats, bingTraffic } from "./bing.js";
import { totals } from "./compare-periods.js";
import { yandexPopularQueries, yandexTotals } from "./yandex.js";

type EngineResult = { clicks: number; impressions: number; ctr: number; topQueries: { query: string; clicks: number; impressions: number }[] };

async function engine(enabled: boolean, fn: () => Promise<EngineResult>) {
  if (!enabled) return { status: "not configured" as const };
  try {
    return { status: "ok" as const, ...(await fn()) };
  } catch (err: any) {
    return { status: "error" as const, error: String(err.message ?? err) };
  }
}

/** Google vs Bing vs Yandex over one window: totals, click share and top queries per engine. */
export async function compareEngines(opts: { days?: number; limit?: number; bingSite?: string; yandexSite?: string } = {}) {
  const { days = 28, limit = 10 } = opts;
  // A per-call site_url names the site for every engine, ahead of BING_SITE_URL / YANDEX_HOST.
  const bingSite = opts.bingSite ?? siteUrlOverride();
  const yandexSite = opts.yandexSite ?? siteUrlOverride();
  const { startDate, endDate } = getDateRange(days);
  const top = (qs: { query: string; clicks: number; impressions: number }[]) => qs.slice(0, limit).map(({ query, clicks, impressions }) => ({ query, clicks, impressions }));

  const [google, bing, yandex] = await Promise.all([
    engine(true, async () => {
      const [daily, queries] = await Promise.all([
        fetchAllRows({ startDate, endDate, dimensions: ["date"] }),
        fetchAllRows({ startDate, endDate, dimensions: ["query"], maxRows: limit }),
      ]);
      const t = totals(daily);
      return { ...t, topQueries: queries.map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions })) };
    }),
    engine(bingConfigured(), async () => {
      const [t, q] = await Promise.all([bingTraffic({ site: bingSite, days }), bingQueryStats({ site: bingSite, days, limit })]);
      return { ...t.totals, topQueries: top(q.queries) };
    }),
    engine(yandexConfigured(), async () => {
      const [t, q] = await Promise.all([yandexTotals(yandexSite, days), yandexPopularQueries({ site: yandexSite, days, limit })]);
      return { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, topQueries: top(q.queries) };
    }),
  ]);

  const engines = { google, bing, yandex };
  const allClicks = Object.values(engines).reduce((n, e) => n + ("clicks" in e ? e.clicks : 0), 0);
  const clickShare = Object.fromEntries(
    Object.entries(engines).filter(([, e]) => "clicks" in e).map(([k, e]) => [k, allClicks ? Math.round(((e as EngineResult).clicks / allClicks) * 1000) / 10 : 0])
  );
  return {
    period: { startDate, endDate },
    clickSharePercent: clickShare,
    engines,
    note: "Numbers are each engine's own and only roughly comparable: Bing query stats are weekly buckets, Yandex lists only its popular queries, and each engine counts impressions differently." +
      (bingConfigured() && yandexConfigured() ? "" : " Set BING_API_KEY / YANDEX_WEBMASTER_TOKEN to include the missing engines."),
  };
}
