import {
  fetchAllRows,
  getDateRange,
  buildFilterGroups,
  type DimensionFilterList,
  type SearchAnalyticsRow,
  type SearchType,
} from "../analytics.js";

interface Filter {
  dimension: string;
  operator: string;
  expression: string;
}

interface AdvancedSearchResult {
  rows: Array<{
    keys: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>;
  totalRows: number;
  dimensions: string[];
  period: { startDate: string; endDate: string };
  filtersApplied: Filter[];
}

export async function advancedSearchAnalytics(
  days: number = 28,
  dimensions: string[] = ["query"],
  filters: Filter[] = [],
  rowLimit: number = 100,
  orderBy: string = "clicks",
  orderDirection: string = "descending",
  searchType?: SearchType,
  filterLists: DimensionFilterList[] = [],
  hourly = false
): Promise<AdvancedSearchResult & { searchType: string; filterListsApplied: DimensionFilterList[]; totalRowsIsLowerBound: boolean }> {
  // Hourly data exists only for the last ~10 days, and includes today.
  const { startDate, endDate } = hourly ? getDateRange(Math.min(days, 10), new Date(), 0) : getDateRange(days);
  if (hourly && !dimensions.includes("hour")) dimensions = ["hour", ...dimensions];
  const limit = Math.min(rowLimit, 500);
  // The API returns rows by clicks descending (by time ascending when grouped by date or hour), so only
  // a clicks-descending sort without a time dimension can stop paging early.
  const timeGrouped = dimensions.includes("date") || dimensions.includes("hour");
  const maxRows = orderBy === "clicks" && orderDirection !== "ascending" && !timeGrouped ? limit : undefined;

  const dimensionFilterGroups = buildFilterGroups(filters, filterLists);

  const rows = await fetchAllRows(
    {
      startDate,
      endDate,
      dimensions,
      dimensionFilterGroups,
      type: searchType,
      maxRows,
      ...(hourly && { dataState: "hourly_all" as const }),
    }
  );

  // Sort
  const sortKey = orderBy as keyof SearchAnalyticsRow;
  const multiplier = orderDirection === "ascending" ? 1 : -1;
  rows.sort((a, b) => {
    const aVal = typeof a[sortKey] === "number" ? (a[sortKey] as number) : 0;
    const bVal = typeof b[sortKey] === "number" ? (b[sortKey] as number) : 0;
    return (aVal - bVal) * multiplier;
  });

  const limited = rows.slice(0, limit);

  return {
    rows: limited.map((r) => ({
      keys: r.keys,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: Math.round(r.ctr * 10000) / 100,
      position: Math.round(r.position * 10) / 10,
    })),
    totalRows: rows.length,
    totalRowsIsLowerBound: maxRows !== undefined && rows.length >= maxRows,
    dimensions,
    period: { startDate, endDate },
    filtersApplied: filters,
    filterListsApplied: filterLists,
    searchType: searchType || "web",
  };
}
