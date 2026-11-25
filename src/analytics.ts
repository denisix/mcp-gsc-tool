import { getSearchConsoleClient, getConfig } from "./auth.js";
import { requestSignal } from "./mcp.js";

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
  // Stop paging once this many rows are collected (default: everything).
  maxRows?: number;
  // "all" (default, matches the dashboard), "final" (complete days only) or "hourly_all" (with the HOUR dimension).
  dataState?: "all" | "final" | "hourly_all";
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

// GSC days are Pacific Time; "today" in PT, as a UTC-midnight Date.
function todayPT(now: Date): Date {
  return new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now)}T00:00:00Z`);
}

// Period comparisons end this many days back: the last ~2 days are still partial ("fresh") data,
// and comparing them against a complete prior window reads as a fake drop.
export const COMPARE_LAG_DAYS = 3;

/** `days`-long window ending `lag` days before today (PT). lag=1 is yesterday, the latest available. */
export function getDateRange(days: number, now: Date = new Date(), lag = 1): { startDate: string; endDate: string } {
  const end = daysAgo(lag, todayPT(now));
  return { startDate: formatDate(daysAgo(days - 1, end)), endDate: formatDate(end) };
}

/** The equal-length window immediately before getDateRange(days, now, lag). */
export function getPriorDateRange(days: number, now: Date = new Date(), lag = 1): { startDate: string; endDate: string } {
  return getDateRange(days, now, lag + days);
}

/**
 * All rows of a Search Analytics query. Identical queries already in flight share one paginated
 * download (e.g. content_recommendations runs quick_wins and content_gaps in parallel over the same report).
 */
// Shared only within the same MCP call (same abort signal): a download started by a call that is
// later cancelled must not fail an unrelated call waiting on it.
const inflight = new Map<string, { signal: AbortSignal | undefined; rows: Promise<SearchAnalyticsRow[]> }>();

export async function fetchAllRows(params: QueryParams): Promise<SearchAnalyticsRow[]> {
  const { siteUrl } = getConfig();
  const signal = requestSignal();
  const key = JSON.stringify([siteUrl, params]);
  let entry = inflight.get(key);
  if (!entry || entry.signal !== signal) {
    const rows: SearchAnalyticsRow[] = [];
    const mine = {
      signal,
      rows: (async () => {
        for await (const page of queryPages(params, siteUrl!)) rows.push(...page);
        return rows;
      })().finally(() => {
        if (inflight.get(key) === mine) inflight.delete(key);
      }),
    };
    entry = mine;
    inflight.set(key, entry);
  }
  // Copies: callers sort and mutate their rows in place.
  return (await entry.rows).map((r) => ({ ...r, keys: [...r.keys] }));
}

/**
 * Yields Search Analytics rows page by page (pagination via startRow, capped at maxRows), so a
 * large export can be written out without holding every row. Uses dataState "all" by default,
 * which matches the GSC dashboard.
 */
export async function* queryPages(params: QueryParams, siteUrl: string = getConfig().siteUrl!): AsyncGenerator<SearchAnalyticsRow[]> {
  const client = await getSearchConsoleClient();
  const maxRows = params.maxRows ?? Infinity;
  const pageSize = Math.min(params.rowLimit || 25000, maxRows);
  let startRow = 0;
  let total = 0;

  while (total < maxRows) {
    const response = await client.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: params.dimensions,
        dimensionFilterGroups: params.dimensionFilterGroups,
        rowLimit: pageSize,
        startRow,
        dataState: params.dataState ?? "all",
        // Defaults server-side to `web` when omitted.
        ...(params.type ? { type: params.type } : {}),
      },
    });

    const rows = response.data.rows;
    if (!rows || rows.length === 0) return;
    const page = rows.slice(0, maxRows - total).map((row: any) => ({
      keys: row.keys || [],
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
    }));
    total += page.length;
    yield page;
    if (rows.length < pageSize) return;
    startRow += pageSize;
  }
}

/** Maps items with at most `limit` calls in flight, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
