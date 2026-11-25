import { fetchAllRows, getDateRange, type SearchType } from "../analytics.js";

/** Queries that bring traffic to one page, or the pages that rank for one query. */
export async function drilldown(opts: { page?: string; query?: string; days?: number; limit?: number; searchType?: SearchType }) {
  const { page, query, days = 28, limit = 50, searchType } = opts;
  if (!page === !query) throw new Error("Pass exactly one of `page` or `query`.");
  const { startDate, endDate } = getDateRange(days);
  const [filterDim, groupDim, value] = page ? ["page", "query", page] : ["query", "page", query!];
  const rows = await fetchAllRows({
    startDate,
    endDate,
    dimensions: [groupDim],
    dimensionFilterGroups: [{ filters: [{ dimension: filterDim, operator: "equals", expression: value }] }],
    type: searchType,
  });
  rows.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  return {
    [filterDim]: value,
    period: { startDate, endDate },
    total: rows.length,
    // Several pages for one query is the cannibalization signal.
    ...(query && { multiplePagesRank: rows.length > 1 }),
    rows: rows.slice(0, limit).map((r) => ({
      [groupDim]: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    })),
  };
}
