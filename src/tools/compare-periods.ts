import {
  COMPARE_LAG_DAYS,
  buildFilterGroups,
  fetchAllRows,
  getDateRange,
  getPriorDateRange,
  type DimensionFilter,
  type SearchAnalyticsRow,
  type SearchType,
} from "../analytics.js";

type Totals = { clicks: number; impressions: number; ctr: number; position: number };

export function totals(rows: SearchAnalyticsRow[]): Totals {
  let clicks = 0, impressions = 0, posWeight = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posWeight += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : 0,
    position: impressions ? Math.round((posWeight / impressions) * 10) / 10 : 0,
  };
}

const pct = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Per-key deltas between two periods: top movers both ways, plus keys that appeared or vanished. Pure, for tests. */
export function diffPeriods(current: SearchAnalyticsRow[], prior: SearchAnalyticsRow[], limit: number) {
  const prev = new Map(prior.map((r) => [r.keys.join(" | "), r]));
  const seen = new Set<string>();
  const changes = current.map((r) => {
    const key = r.keys.join(" | ");
    seen.add(key);
    const p = prev.get(key);
    return {
      key,
      clicks: r.clicks,
      clicksPrior: p?.clicks ?? 0,
      clicksChange: r.clicks - (p?.clicks ?? 0),
      impressionsChange: r.impressions - (p?.impressions ?? 0),
      position: Math.round(r.position * 10) / 10,
      // Positive = moved up the results page.
      positionChange: p ? Math.round((p.position - r.position) * 10) / 10 : null,
      isNew: !p,
    };
  });
  const lost = prior
    .filter((r) => !seen.has(r.keys.join(" | ")))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, limit)
    .map((r) => ({ key: r.keys.join(" | "), clicksPrior: r.clicks, impressionsPrior: r.impressions }));
  const byChange = [...changes].sort((a, b) => b.clicksChange - a.clicksChange);
  return {
    gainers: byChange.filter((c) => c.clicksChange > 0).slice(0, limit),
    losers: byChange.filter((c) => c.clicksChange < 0).reverse().slice(0, limit),
    new: changes.filter((c) => c.isNew).sort((a, b) => b.clicks - a.clicks).slice(0, limit),
    lost,
  };
}

export async function comparePeriods(
  days = 28,
  dimension: "query" | "page" | "country" | "device" | "searchAppearance" = "query",
  limit = 25,
  filters: DimensionFilter[] = [],
  searchType?: SearchType,
  yearOverYear = false
) {
  const now = new Date();
  const current = getDateRange(days, now, COMPARE_LAG_DAYS);
  // Year over year compares the same calendar window 364 days back (keeps weekdays aligned).
  const prior = yearOverYear ? getDateRange(days, now, COMPARE_LAG_DAYS + 364) : getPriorDateRange(days, now, COMPARE_LAG_DAYS);
  const base = { dimensionFilterGroups: buildFilterGroups(filters), type: searchType };
  // Totals come from a date-grouped query: summing query (or page) rows misses anonymised queries
  // and double counts across pages, so it does not match the dashboard.
  const [cur, prev, curDays, prevDays] = await Promise.all([
    fetchAllRows({ ...base, ...current, dimensions: [dimension] }),
    fetchAllRows({ ...base, ...prior, dimensions: [dimension] }),
    fetchAllRows({ ...base, ...current, dimensions: ["date"] }),
    fetchAllRows({ ...base, ...prior, dimensions: ["date"] }),
  ]);
  const c = totals(curDays), p = totals(prevDays);
  return {
    dimension,
    current: { ...current, ...c },
    prior: { ...prior, ...p },
    change: {
      clicksPercent: pct(c.clicks, p.clicks),
      impressionsPercent: pct(c.impressions, p.impressions),
      ctrPoints: Math.round((c.ctr - p.ctr) * 100) / 100,
      position: Math.round((p.position - c.position) * 10) / 10,
    },
    ...diffPeriods(cur, prev, limit),
    note: `Both windows end ${COMPARE_LAG_DAYS} days back, so partial recent data does not show up as a drop. Positive position change = ranking improved.`,
  };
}
