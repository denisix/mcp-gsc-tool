import { getSearchConsoleClient, getConfig } from "./auth.js";

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface DimensionFilter {
  dimension: string;
  operator: string;
  expression: string;
}

// Multi-value filter (API field `filterLists`, added November 2026). A row
// matches when its value equals ANY of the expressions. Google accepts only
// `country` and `device` here, and rejects a request that filters the same
// dimension in both `filters` and `filterLists`.
export interface DimensionFilterList {
  dimension: string;
  expressions: string[];
}

export type SearchType =
  | "web"
  | "image"
  | "video"
  | "news"
  | "discover"
  | "googleNews"
  | "webMultimodal";

// First date with branded / non-branded data in the API.
export const BRANDED_DATA_START = "2026-02-21";

export interface QueryParams {
  startDate: string;
  endDate: string;
  dimensions: string[];
  dimensionFilterGroups?: Array<{
    filters?: DimensionFilter[];
    filterLists?: DimensionFilterList[];
  }>;
  rowLimit?: number;
  // GSC Search Analytics `type` filter. Defaults server-side to web.
  // `webMultimodal` (Google Lens, Circle to Search, image uploads) cannot be
  // grouped or filtered by query or brandedClassification.
  type?: SearchType;
}

/**
 * Builds the single AND filter group the API supports from single-value
 * filters and multi-value filter lists. Country codes are lower-cased and
 * device names upper-cased in filter lists, which is the form the API matches.
 */
export function buildFilterGroups(
  filters: DimensionFilter[] = [],
  filterLists: DimensionFilterList[] = []
): QueryParams["dimensionFilterGroups"] {
  if (filters.length === 0 && filterLists.length === 0) return undefined;
  return [
    {
      ...(filters.length > 0
        ? {
            filters: filters.map((f) => ({
              dimension: f.dimension,
              operator: f.operator,
              expression: f.expression,
            })),
          }
        : {}),
      ...(filterLists.length > 0
        ? {
            filterLists: filterLists.map((l) => ({
              dimension: l.dimension,
              expressions: l.expressions.map((e) =>
                l.dimension === "device" ? e.toUpperCase() : e.toLowerCase()
              ),
            })),
          }
        : {}),
    },
  ];
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

// UTC throughout: local setDate() + toISOString() shifted windows by a day across DST changes.
function daysAgo(n: number, from: Date = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

export function getDateRange(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  const end = daysAgo(1, now); // yesterday (latest available)
  return { startDate: formatDate(daysAgo(days - 1, end)), endDate: formatDate(end) };
}

/** The equal-length window immediately before getDateRange(days). */
export function getPriorDateRange(days: number, now: Date = new Date()): { startDate: string; endDate: string } {
  return getDateRange(days, daysAgo(days, now));
}

/**
 * Fetches all rows from the Search Analytics API with automatic pagination.
 * Uses dataState: 'all' so data matches the GSC dashboard exactly.
 */
// Identical queries already in flight share one paginated download (e.g. content_recommendations runs
// quick_wins and content_gaps in parallel over the same report). Entries live only while the request does.
const inflight = new Map<string, Promise<SearchAnalyticsRow[]>>();

export async function fetchAllRows(params: QueryParams): Promise<SearchAnalyticsRow[]> {
  const { siteUrl } = getConfig();
  const key = JSON.stringify([siteUrl, params]);
  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchAllRowsUncached(params, siteUrl!).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  // Copies: callers sort and mutate their rows in place.
  return (await pending).map((r) => ({ ...r, keys: [...r.keys] }));
}

async function fetchAllRowsUncached(params: QueryParams, siteUrl: string): Promise<SearchAnalyticsRow[]> {
  const client = await getSearchConsoleClient();
  const allRows: SearchAnalyticsRow[] = [];
  const pageSize = params.rowLimit || 25000;
  let startRow = 0;

  while (true) {
    const response = await client.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions,
        dimensionFilterGroups: params.dimensionFilterGroups,
        rowLimit: pageSize,
        startRow,
        dataState: "all",
        // Pass through the type filter when provided. Defaults server-side to
        // `web` when omitted, matching prior behaviour.
        ...(params.type ? { type: params.type } : {}),
      },
    });

    const rows = response.data.rows;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      allRows.push({
        keys: row.keys || [],
        clicks: row.clicks || 0,
        impressions: row.impressions || 0,
        ctr: row.ctr || 0,
        position: row.position || 0,
      });
    }

    if (rows.length < pageSize) break;
    startRow += pageSize;
  }

  return allRows;
}
