// Offline tests: googleapis is replaced by a fake, so real code paths run without network or credentials.
import { test, expect, mock, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gsc-test-")), "key.json");
fs.writeFileSync(keyFile, "{}");
process.env.GSC_AUTH_MODE = "service_account";
process.env.GSC_KEY_FILE = keyFile;
process.env.GSC_SITE_URL = "sc-domain:default.com";

type Call = { siteUrl?: string; startRow?: number; body?: any };
const state = {
  queries: [] as Call[],
  inspects: [] as string[],
  pages: [] as any[][], // rows returned per searchanalytics page
  inspectErrors: {} as Record<string, any>, // property -> error to throw
  indexingAuth: [] as any[],
  globalOptions: 0,
};

class FakeAuth { constructor(public opts: any) {} }
mock.module("googleapis", () => ({
  google: {
    auth: { GoogleAuth: FakeAuth, OAuth2: FakeAuth },
    options: () => { state.globalOptions++; },
    searchconsole: (cfg: any) => ({
      auth: cfg.auth,
      searchanalytics: {
        query: async ({ siteUrl, requestBody }: any) => {
          state.queries.push({ siteUrl, startRow: requestBody.startRow, body: requestBody });
          return { data: { rows: state.pages.shift() ?? [] } };
        },
      },
      urlInspection: {
        index: {
          inspect: async ({ requestBody }: any) => {
            state.inspects.push(requestBody.siteUrl);
            const err = state.inspectErrors[requestBody.siteUrl];
            if (err) throw err;
            return { data: { inspectionResult: { indexStatusResult: { verdict: "PASS" } } } };
          },
        },
      },
    }),
    indexing: (cfg: any) => {
      state.indexingAuth.push(cfg.auth);
      return { urlNotifications: { publish: async () => ({ data: { urlNotificationMetadata: {} } }) } };
    },
  },
}));

const { getDateRange, getPriorDateRange, buildFilterGroups, fetchAllRows } = await import("../src/analytics.ts");
const { propertyCandidates, isPermissionError, fallbackNote } = await import("../src/property-candidates.ts");
const { withSiteUrl, getConfig } = await import("../src/auth.ts");
const { withMeta } = await import("../src/guardrails.ts");
const { inspectUrl } = await import("../src/inspection.ts");
const { submitUrl } = await import("../src/tools/submit-url.ts");

beforeEach(() => {
  Object.assign(state, { queries: [], inspects: [], pages: [], inspectErrors: {}, indexingAuth: [], globalOptions: 0 });
});

const row = (k: string) => ({ keys: [k], clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

// --- dates ---
test("date ranges don't drift a day across a DST change", () => {
  // Sydney DST starts 2026-10-04. Old code stepped back in local days, so the window shifted an hour across UTC midnight.
  const tz = process.env.TZ;
  process.env.TZ = "Australia/Sydney";
  try {
    expect(getDateRange(2, new Date("2026-10-04T23:30:00Z"))).toEqual({ startDate: "2026-10-02", endDate: "2026-10-03" });
  } finally {
    process.env.TZ = tz;
  }
});

test("prior range is the same length and ends the day before the current one starts", () => {
  const now = new Date("2026-03-02T12:00:00Z"); // crosses a month end
  const cur = getDateRange(28, now);
  const prior = getPriorDateRange(28, now);
  const day = 86_400_000;
  expect(Date.parse(cur.startDate) - Date.parse(prior.endDate)).toBe(day);
  expect((Date.parse(prior.endDate) - Date.parse(prior.startDate)) / day + 1).toBe(28);
  expect((Date.parse(cur.endDate) - Date.parse(cur.startDate)) / day + 1).toBe(28);
});

// --- filters ---
test("buildFilterGroups: empty -> undefined; filter lists normalise case", () => {
  expect(buildFilterGroups()).toBeUndefined();
  const g = buildFilterGroups(
    [{ dimension: "query", operator: "contains", expression: "Shoes" }] as any,
    [{ dimension: "device", expressions: ["mobile"] }, { dimension: "country", expressions: ["USA", "Gbr"] }] as any
  )!;
  expect(g).toHaveLength(1); // the API supports one AND group
  expect(g[0].filters![0].expression).toBe("Shoes"); // single filters untouched
  expect(g[0].filterLists).toEqual([
    { dimension: "device", expressions: ["MOBILE"] },
    { dimension: "country", expressions: ["usa", "gbr"] },
  ]);
});

// --- property fallback ---
test("propertyCandidates and isPermissionError", () => {
  expect(propertyCandidates("sc-domain:a.com")).toEqual(["sc-domain:a.com", "https://a.com/", "https://www.a.com/"]);
  expect(propertyCandidates("https://a.com/")).toEqual(["https://a.com/"]);
  expect(isPermissionError(httpErr(403))).toBe(true);
  expect(isPermissionError({ code: 403 })).toBe(true);
  expect(isPermissionError({ response: { status: 403 } })).toBe(true);
  for (const e of [httpErr(429), httpErr(500), new Error("ECONNRESET"), null]) expect(isPermissionError(e)).toBe(false);
  expect(fallbackNote("x", "x")).toBeUndefined();
});

test("inspect_url falls back to URL-prefix property on 403", async () => {
  state.inspectErrors["sc-domain:default.com"] = httpErr(403);
  const r: any = await inspectUrl("https://default.com/p");
  expect(state.inspects).toEqual(["sc-domain:default.com", "https://default.com/"]);
  expect(r.note).toContain("https://default.com/");
});

test("inspect_url does NOT retry other properties on quota/network errors", async () => {
  state.inspectErrors["sc-domain:default.com"] = httpErr(429);
  await expect(inspectUrl("https://default.com/p")).rejects.toThrow("HTTP 429");
  expect(state.inspects).toEqual(["sc-domain:default.com"]); // one call, no quota burn
});

// --- per-call site_url ---
test("withSiteUrl routes queries to the override and resets afterwards", async () => {
  await withSiteUrl("sc-domain:other.com", () => fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] }));
  await fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] });
  expect(state.queries.map((q) => q.siteUrl)).toEqual(["sc-domain:other.com", "sc-domain:default.com"]);
  expect(withSiteUrl("  ", () => getConfig().siteUrl)).toBe("sc-domain:default.com"); // blank = default
});

test("concurrent calls with different site_url don't leak into each other", async () => {
  const sites = ["sc-domain:a.com", "sc-domain:b.com", "sc-domain:c.com"];
  const seen = await Promise.all(
    sites.map((s) => withSiteUrl(s, async () => { await Bun.sleep(Math.random() * 10); return getConfig().siteUrl; }))
  );
  expect(seen).toEqual(sites);
});

test("withMeta records the property the call actually ran against", () => {
  expect(withSiteUrl("sc-domain:x.com", () => withMeta({}, "t", {}))._meta.site_url).toBe("sc-domain:x.com");
});

// --- pagination ---
test("fetchAllRows paginates with dataState=all and stops on a short page", async () => {
  state.pages = [[row("a"), row("b")], [row("c")]];
  const rows = await fetchAllRows({ startDate: "a", endDate: "b", dimensions: ["query"], rowLimit: 2 });
  expect(rows.map((r) => r.keys[0])).toEqual(["a", "b", "c"]);
  expect(state.queries.map((q) => q.startRow)).toEqual([0, 2]);
  expect(state.queries[0].body.dataState).toBe("all");
});

// --- #15 ---
test("#15: submit_url never sets global googleapis auth", async () => {
  await fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] });
  const r = await submitUrl("https://default.com/p");
  expect(r.success).toBe(true);
  expect(state.globalOptions).toBe(0);
  expect(state.indexingAuth[0].opts.scopes).toEqual(["https://www.googleapis.com/auth/indexing"]);
});
