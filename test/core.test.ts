// Offline tests: global fetch is replaced by a fake Google, so the real HTTP client, JWT signing
// and token handling run without network or credentials.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-test-"));
process.env.GSC_TOKEN_DIR = path.join(tmp, "tokens"); // never the real home (bun ignores runtime HOME changes)
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyFile = path.join(tmp, "key.json");
fs.writeFileSync(keyFile, JSON.stringify({
  client_email: "bot@proj.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
}));
process.env.GSC_AUTH_MODE = "service_account";
process.env.GSC_KEY_FILE = keyFile;
process.env.GSC_SITE_URL = "sc-domain:default.com";

type Req = { method: string; url: URL; auth: string | null; body: any };
const state = {
  requests: [] as Req[],
  pages: [] as any[][], // rows returned per searchanalytics page
  inspectStatus: {} as Record<string, number>, // property -> HTTP status to fail with
  tokens: 0,
  failNextQuery: false,
  queryStatuses: [] as number[], // statuses to fail the next queries with, in order
  indexingStatuses: [] as number[],
  retryAfter: "0",
  queryDelayMs: 0,
  sitesDown: false,
};
const scopeOfToken = new Map<string, string>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
// Bing / Yandex fakes, keyed by API method or path suffix.
const engineCalls: { url: URL; init: RequestInit }[] = [];
const yandexQuota = { remainder: 2 };
const msDate = (d: string) => `/Date(${Date.parse(d)}-0700)/`;
const recent = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
function fakeOtherEngines(url: URL, init: RequestInit): Response {
  engineCalls.push({ url, init });
  if (url.hostname === "ssl.bing.com") {
    if (url.searchParams.get("apikey") !== "bing-key") return json(400, { ErrorCode: 3, Message: "InvalidApiKey" });
    const method = url.pathname.split("/").pop();
    const d = {
      GetQueryStats: [
        { Query: "shoes", Clicks: 5, Impressions: 50, AvgImpressionPosition: 2, AvgClickPosition: 2, Date: msDate(recent(3)) },
        { Query: "shoes", Clicks: 3, Impressions: 50, AvgImpressionPosition: 4, AvgClickPosition: 3, Date: msDate(recent(10)) },
        { Query: "old", Clicks: 99, Impressions: 999, AvgImpressionPosition: 1, AvgClickPosition: 1, Date: msDate(recent(400)) },
      ],
      GetRankAndTrafficStats: [{ Date: msDate(recent(2)), Clicks: 8, Impressions: 100 }, { Date: msDate(recent(400)), Clicks: 500, Impressions: 9000 }],
      GetCrawlStats: [{ Date: msDate(recent(2)), CrawledPages: 40, InIndex: 30, CrawlErrors: 1 }],
      GetCrawlIssues: [{ Url: "https://default.com/x", HttpCode: 404, Issues: 2, InLinks: 3, __type: "UrlWithCrawlIssues" }],
      GetBlockedUrls: null,
      GetFeeds: [{ __type: "Feed", Url: "https://default.com/sitemap.xml", Type: "Sitemap", Status: "Success", UrlCount: 1397, Submitted: msDate("2026-11-01"), LastCrawled: msDate("2026-11-20") }],
      GetUserSites: [{ Url: "http://default.com/" }, { Url: "https://default.com/" }, { Url: "https://www.other.com/" }],
      GetUrlSubmissionQuota: { DailyQuota: 10, MonthlyQuota: 300 },
      SubmitUrlBatch: null,
    }[method!];
    return json(200, { d });
  }
  const p = url.pathname;
  if (new Headers(init.headers).get("authorization") !== "OAuth ya-token") return json(403, { error_code: "INVALID_OAUTH_TOKEN", error_message: "bad token" });
  if (p === "/v4/user") return json(200, { user_id: 7 });
  if (p === "/v4/user/7/hosts") return json(200, { hosts: [{ host_id: "http:default.com:80", ascii_host_url: "http://default.com/" }, { host_id: "https:default.com:443", ascii_host_url: "https://default.com/" }] });
  if (p.endsWith("/search-queries/popular")) return json(200, { count: 1, queries: [{ query_text: "обувь", indicators: { TOTAL_SHOWS: 40, TOTAL_CLICKS: 4, AVG_SHOW_POSITION: 3.14 } }] });
  if (p.endsWith("/search-queries/all/history")) return json(200, { indicators: { TOTAL_SHOWS: [{ date: "2026-01-01T00:00:00,000+0300", value: 60 }], TOTAL_CLICKS: [{ date: "2026-01-01T00:00:00,000+0300", value: 4 }] } });
  // Shapes as returned live for a real host (Nov 2026).
  if (p.endsWith("/summary")) return json(200, { sqi: 10, searchable_pages_count: 691, excluded_pages_count: 3, site_problems: { CRITICAL: 0, POSSIBLE_PROBLEM: 1 } });
  if (p.endsWith("/diagnostics")) return json(200, { problems: { DNS_ERROR: { severity: "FATAL", state: "ABSENT", last_state_update: null }, NO_SITEMAP_MODIFICATIONS: { severity: "POSSIBLE_PROBLEM", state: "PRESENT", last_state_update: "2026-11-01T00:00:00.000+03:00" } } });
  if (p.endsWith("/search-urls/in-search/history")) return json(200, { history: [{ date: "2026-11-22T00:00:00.000+03:00", value: 691 }] });
  if (p.endsWith("/indexing/history")) return json(200, { indicators: {} });
  if (p.endsWith("/search-urls/events/history")) return json(200, { indicators: { APPEARED_IN_SEARCH: [{ date: "2026-11-22T00:00:00.000+03:00", value: 691 }], REMOVED_FROM_SEARCH: [{ date: "2026-11-23T00:00:00.000+03:00", value: 1 }] } });
  if (p.endsWith("/links/internal/broken/samples")) return json(500, { error_message: "backend down" });
  if (p.endsWith("/search-urls/events/samples")) return json(200, { count: 2, samples: [
    { url: "https://default.com/", event_date: "2026-11-22T00:00:00.000+03:00", event: "APPEARED_IN_SEARCH", excluded_url_status: null, bad_http_status: null, target_url: null },
    { url: "https://default.com/old", event_date: "2026-11-23T00:00:00.000+03:00", event: "REMOVED_FROM_SEARCH", excluded_url_status: "HTTP_ERROR", bad_http_status: 404, target_url: null },
  ] });
  if (p.endsWith("/recrawl/quota")) return json(200, { daily_quota: 2, quota_remainder: yandexQuota.remainder });
  if (p.endsWith("/recrawl/queue")) return json(202, { task_id: `t${yandexQuota.remainder}`, quota_remainder: --yandexQuota.remainder });
  return json(404, { error_message: `unexpected ${p}` });
}
afterAll(() => {
  globalThis.fetch = realFetch; // test files share one process
  delete process.env.BING_API_KEY;
  delete process.env.YANDEX_WEBMASTER_TOKEN;
});
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.hostname === "ssl.bing.com" || url.hostname === "api.webmaster.yandex.net") return fakeOtherEngines(url, init);
  if (!url.hostname.endsWith("googleapis.com")) return realFetch(input, init);
  const raw = typeof init.body === "string" ? init.body : init.body?.toString() ?? "";
  const body = url.hostname === "oauth2.googleapis.com" ? Object.fromEntries(new URLSearchParams(raw)) : raw ? JSON.parse(raw) : undefined;
  const auth = new Headers(init.headers).get("authorization");
  state.requests.push({ method: init.method ?? "GET", url, auth, body });

  if (url.hostname === "oauth2.googleapis.com") {
    const token = `tok-${++state.tokens}`;
    if (body.grant_type === "refresh_token") return json(200, { access_token: token, expires_in: 3600, scope: "s" });
    const claims = JSON.parse(Buffer.from(body.assertion.split(".")[1], "base64url").toString());
    scopeOfToken.set(token, claims.scope);
    return json(200, { access_token: token, expires_in: 3600 });
  }
  if (url.pathname.endsWith("/searchAnalytics/query")) {
    if (state.failNextQuery) {
      state.failNextQuery = false;
      return json(400, { error: { message: "bad request" } });
    }
    if (init.signal?.aborted) throw init.signal.reason;
    if (state.queryDelayMs) {
      await Promise.race([
        Bun.sleep(state.queryDelayMs),
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
      ]);
    }
    if (state.queryStatuses.length) {
      const status = state.queryStatuses.shift()!;
      if (status === -1) throw Object.assign(new TypeError("The socket connection was closed unexpectedly"), { code: "ECONNRESET" });
      return new Response(JSON.stringify({ error: { message: `busy ${status}` } }), { status, headers: { "retry-after": state.retryAfter } });
    }
    return json(200, { rows: state.pages.shift() ?? [] });
  }
  if (url.pathname === "/v1/urlInspection/index:inspect") {
    const status = state.inspectStatus[body.siteUrl];
    if (status) return json(status, { error: { code: status, message: `denied ${status}` } });
    return json(200, { inspectionResult: { indexStatusResult: { verdict: "PASS" } } });
  }
  if (url.hostname === "indexing.googleapis.com") {
    const status = state.indexingStatuses.shift();
    if (status) return json(status, { error: { message: `indexing ${status}` } });
    return json(200, { urlNotificationMetadata: { url: body.url } });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/pagespeedonline/")) return url.searchParams.get("url")?.includes("quota") ? json(429, { error: { message: "Quota exceeded" } }) : json(500, { error: { message: "FAILED_DOCUMENT_REQUEST" } });
  if (url.pathname === "/webmasters/v3/sites") {
    if (state.sitesDown) return json(503, { error: { message: "sites.list down" } });
    return json(200, { siteEntry: ["sc-domain:default.com", "sc-domain:other.com", "https://www.prefix.com/", "http://legacy.org/"].map((siteUrl) => ({ siteUrl, permissionLevel: "siteOwner" })) });
  }
  if (url.pathname.includes("/sitemaps")) return init.method === "PUT" ? new Response(null, { status: 204 }) : json(200, { sitemap: [] });
  return json(404, { error: { message: `unexpected ${url}` } });
}) as typeof fetch;

const { getDateRange, getPriorDateRange, buildFilterGroups, fetchAllRows } = await import("../src/analytics.ts");
const { propertyCandidates, isPermissionError, fallbackNote } = await import("../src/property-candidates.ts");
const { withSiteUrl, getConfig } = await import("../src/auth.ts");
const { withMeta } = await import("../src/guardrails.ts");
const { inspectUrl } = await import("../src/inspection.ts");
const { submitUrl } = await import("../src/tools/submit-url.ts");
const { submitSitemap } = await import("../src/tools/submit-sitemap.ts");
const { signServiceAccountJwt, cachedTokenSource, GoogleApiError, retryPolicy } = await import("../src/google.ts");
retryPolicy.baseMs = 1; // keep backoff waits out of the test run

beforeEach(() => {
  Object.assign(state, { requests: [], pages: [], inspectStatus: {}, failNextQuery: false, queryStatuses: [], indexingStatuses: [], queryDelayMs: 0, retryAfter: "0" });
});

const row = (k: string) => ({ keys: [k], clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const apiCalls = (part: string) => state.requests.filter((r) => r.url.pathname.includes(part));
const querySites = () => apiCalls("/searchAnalytics/query").map((r) => decodeURIComponent(r.url.pathname.split("/")[4]));

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

const inspected = () => apiCalls("index:inspect").map((r) => r.body.siteUrl);

test("inspect_url falls back to URL-prefix property on 403", async () => {
  state.inspectStatus["sc-domain:default.com"] = 403;
  const r: any = await inspectUrl("https://default.com/p");
  expect(inspected()).toEqual(["sc-domain:default.com", "https://default.com/"]);
  expect(r.note).toContain("https://default.com/");
});

test("inspect_url does NOT retry other properties on quota/network errors", async () => {
  state.inspectStatus["sc-domain:default.com"] = 429;
  await expect(inspectUrl("https://default.com/p")).rejects.toThrow("denied 429 (HTTP 429)");
  // 429 is retried on the same property (backoff), never spread to other properties.
  expect(new Set(inspected())).toEqual(new Set(["sc-domain:default.com"]));
});

// --- per-call site_url ---
test("withSiteUrl routes queries to the override and resets afterwards", async () => {
  await withSiteUrl("sc-domain:other.com", () => fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] }));
  await fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] });
  expect(querySites()).toEqual(["sc-domain:other.com", "sc-domain:default.com"]);
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
  const q = apiCalls("/searchAnalytics/query");
  expect(q.map((r) => r.body.startRow)).toEqual([0, 2]);
  expect(q[0].body.dataState).toBe("all");
  expect(q[0].method).toBe("POST");
});

// --- #15 ---
test("#15: submit_url gets its own auth client", async () => {
  await fetchAllRows({ startDate: "a", endDate: "b", dimensions: [] });
  const r = await submitUrl("https://default.com/p");
  expect(r.success).toBe(true);
  await fetchAllRows({ startDate: "c", endDate: "d", dimensions: [] });
  const tokenOf = (r: Req) => r.auth!.replace("Bearer ", "");
  const [publish] = apiCalls("urlNotifications:publish");
  expect(scopeOfToken.get(tokenOf(publish))).toBe("https://www.googleapis.com/auth/indexing");
  // The Search Console client still uses its own full-scope token after the indexing call.
  for (const q of apiCalls("/searchAnalytics/query")) expect(scopeOfToken.get(tokenOf(q))).toContain("webmasters");
});

// --- in-flight dedup ---
const P = { startDate: "a", endDate: "b", dimensions: ["query"] };

test("identical parallel queries share one download, and each caller gets its own copy", async () => {
  state.pages = [[row("b"), row("a")]];
  const [x, y] = await Promise.all([fetchAllRows(P), fetchAllRows(P)]);
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(1); // one download, not two
  x.sort((p, q) => p.keys[0].localeCompare(q.keys[0]));
  x[0].keys[0] = "mutated";
  expect(y.map((r) => r.keys[0])).toEqual(["b", "a"]); // y untouched by x's in-place sort/mutation
});

test("dedup never crosses properties or outlives the request", async () => {
  await Promise.all([fetchAllRows(P), withSiteUrl("sc-domain:other.com", () => fetchAllRows(P))]);
  expect(new Set(querySites())).toEqual(new Set(["sc-domain:default.com", "sc-domain:other.com"]));
  const before = querySites().length;
  await fetchAllRows(P); // sequential: fresh data, not a cache hit
  expect(querySites().length).toBe(before + 1);
});

test("a failed download is not cached", async () => {
  const q = { ...P, dimensions: ["page"] };
  state.failNextQuery = true;
  await expect(fetchAllRows(q)).rejects.toThrow("bad request (HTTP 400)");
  expect(await fetchAllRows(q)).toEqual([]);
});

// --- Google client (src/google.ts) ---
test("service account JWT is RS256-signed with the right claims", () => {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const jwt = signServiceAccountJwt(key, ["a", "b"], 1_700_000_000_000);
  const [h, c, sig] = jwt.split(".");
  expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
    iss: "bot@proj.iam.gserviceaccount.com", scope: "a b", aud: "https://oauth2.googleapis.com/token", iat: 1_700_000_000, exp: 1_700_003_600,
  });
  expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
});

test("tokens are cached until near expiry, and concurrent callers share one fetch", async () => {
  let fetches = 0;
  let now = 0;
  const src = cachedTokenSource(async () => ({ token: `t${++fetches}`, expiresAt: Date.now() + now }));
  now = 3_600_000;
  expect(await Promise.all([src(), src(), src()])).toEqual(["t1", "t1", "t1"]);
  expect(fetches).toBe(1);
  expect(await src()).toBe("t1"); // later call: served from cache
  expect(fetches).toBe(1);
  const expiring = cachedTokenSource(async () => ({ token: `e${++fetches}`, expiresAt: Date.now() + 30_000 })); // < 60 s left
  await expiring();
  await expiring();
  expect(fetches).toBe(3); // refetched, never handed out a token about to expire
});

test("API errors carry Google's message and the HTTP status", async () => {
  state.inspectStatus["sc-domain:default.com"] = 404;
  const err = await inspectUrl("https://default.com/p").catch((e) => e);
  expect(err.message).toStartWith("denied 404 (HTTP 404)");
  expect(apiCalls("index:inspect")).toHaveLength(1); // 404 is not a permission error: no fallback
  const direct = new GoogleApiError("x", 403);
  expect(isPermissionError(direct)).toBe(true);
});

test("property and sitemap URLs are percent-encoded into the path", async () => {
  const r = await submitSitemap("https://default.com/sitemap.xml?x=1");
  expect(r.success).toBe(true);
  const [put] = apiCalls("/sitemaps/");
  expect(put.method).toBe("PUT");
  expect(put.url.pathname).toBe("/webmasters/v3/sites/sc-domain%3Adefault.com/sitemaps/https%3A%2F%2Fdefault.com%2Fsitemap.xml%3Fx%3D1");
});

test("OAuth: expired cached token is refreshed, refresh_token kept, cache stays owner-only", async () => {
  const { authenticateWithOAuth, saveCachedToken, tokenPath } = await import("../src/oauth.ts");
  process.env.GSC_OAUTH_CLIENT_ID = "cid";
  process.env.GSC_OAUTH_CLIENT_SECRET = "csecret";
  process.env.GSC_SCOPES = "readonly";
  try {
    saveCachedToken({ access_token: "old", refresh_token: "r1", scope: "https://www.googleapis.com/auth/webmasters.readonly", expiry_date: Date.now() - 1000 });
    const token = await authenticateWithOAuth();
    const t = await token();
    expect(t).toStartWith("tok-");
    const [refresh] = apiCalls("/token");
    expect(refresh.body).toEqual({ grant_type: "refresh_token", refresh_token: "r1", client_id: "cid", client_secret: "csecret" });
    const cached = JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
    expect(cached.access_token).toBe(t);
    expect(cached.refresh_token).toBe("r1"); // Google doesn't resend it on refresh
    expect(cached.expiry_date).toBeGreaterThan(Date.now());
    expect(fs.statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(await token()).toBe(t); // cached in memory: no second refresh
    expect(apiCalls("/token")).toHaveLength(1);
  } finally {
    delete process.env.GSC_SCOPES;
  }
});

test("tokens from the older ~/.gsc-mcp / ~/.mcp-gsc-tool are still picked up; new ones go to ~/.claude/mcp-gsc-tool", async () => {
    // Legacy lookup needs the default location, so run in a child with a fake HOME set at process start.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scm-home-"));
  fs.mkdirSync(path.join(home, ".gsc-mcp"));
  fs.writeFileSync(path.join(home, ".gsc-mcp", "oauth-token.json"), JSON.stringify({ access_token: "legacy" }));
  const mod = new URL("../src/oauth.ts", import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(mod)});
    const a = m.loadCachedToken().access_token; m.saveCachedToken({ access_token: "new" });
    console.log(JSON.stringify([a, m.loadCachedToken().access_token, m.tokenPath()]));`;
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.GSC_TOKEN_DIR;
  delete env.CLAUDE_CONFIG_DIR;
  const run = () => JSON.parse(Bun.spawnSync(["bun", "-e", script], { env }).stdout.toString());
  expect(run()).toEqual(["legacy", "new", path.join(home, ".claude", "mcp-gsc-tool", "oauth-token.json")]);
  expect(fs.statSync(path.join(home, ".claude", "mcp-gsc-tool")).mode & 0o777).toBe(0o700);
  // ~/.mcp-gsc-tool (the previous default) wins over ~/.gsc-mcp when no new token exists yet.
  fs.rmSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".mcp-gsc-tool"));
  fs.writeFileSync(path.join(home, ".mcp-gsc-tool", "oauth-token.json"), JSON.stringify({ access_token: "prev" }));
  expect(run()[0]).toBe("prev");
  fs.rmSync(home, { recursive: true });
});

// --- retry, caps, dates (audit fixes) ---
test("429 and 5xx are retried with backoff; 4xx is not", async () => {
  state.queryStatuses = [429, 503];
  state.pages = [[row("a")]];
  expect((await fetchAllRows({ ...P, dimensions: ["country"] })).map((r) => r.keys[0])).toEqual(["a"]);
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(3);
  state.queryStatuses = [429, 429, 429, 429];
  await expect(fetchAllRows({ ...P, dimensions: ["device"] })).rejects.toThrow("busy 429 (HTTP 429)");
});

test("a dropped connection (ECONNRESET) is retried; a POST that spends quota is not", async () => {
  state.queryStatuses = [-1];
  state.pages = [[row("a")]];
  expect((await fetchAllRows({ ...P, dimensions: ["searchAppearance"] })).map((r) => r.keys[0])).toEqual(["a"]);
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(2);
  const { request } = await import("../src/google.ts");
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    throw new TypeError("ECONNRESET");
  }) as unknown as typeof fetch;
  try {
    await expect(request("https://x.test/submit", { method: "POST" })).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = saved;
  }
});

test("maxRows stops paging and trims to the cap", async () => {
  state.pages = [[row("a"), row("b")], [row("c"), row("d")], [row("e")]];
  const rows = await fetchAllRows({ ...P, dimensions: ["date"], rowLimit: 2, maxRows: 3 });
  expect(rows.map((r) => r.keys[0])).toEqual(["a", "b", "c"]);
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(2);
});

test("date ranges follow Pacific Time, and lag shifts the window back", () => {
  // 05:00 UTC on the 10th is still the 9th in California: yesterday there is the 8th.
  expect(getDateRange(1, new Date("2026-06-10T05:00:00Z"))).toEqual({ startDate: "2026-06-08", endDate: "2026-06-08" });
  expect(getDateRange(7, new Date("2026-06-10T12:00:00Z"), 3)).toEqual({ startDate: "2026-06-01", endDate: "2026-06-07" });
  expect(getPriorDateRange(7, new Date("2026-06-10T12:00:00Z"), 3)).toEqual({ startDate: "2026-05-25", endDate: "2026-05-31" });
});

// --- new tools ---
test("compare_periods diff: gainers, losers, new and lost", async () => {
  const { diffPeriods } = await import("../src/tools/compare-periods.ts");
  const r = (k: string, clicks: number, position = 5) => ({ keys: [k], clicks, impressions: clicks * 10, ctr: 0.1, position });
  const d = diffPeriods([r("up", 50, 3), r("down", 5), r("fresh", 9)], [r("up", 10, 6), r("down", 20), r("gone", 30)], 10);
  expect(d.gainers.map((g) => g.key)).toEqual(["up", "fresh"]);
  expect(d.gainers[0].positionChange).toBe(3); // moved up 3 spots
  expect(d.losers.map((l) => [l.key, l.clicksChange])).toEqual([["down", -15]]);
  expect(d.new.map((n) => n.key)).toEqual(["fresh"]);
  expect(d.lost).toEqual([{ key: "gone", clicksPrior: 30, impressionsPrior: 300 }]);
});

test("parseSitemap reads urlsets and sitemap indexes, decoding entities", async () => {
  const { parseSitemap } = await import("../src/tools/indexing-coverage.ts");
  expect(parseSitemap(`<urlset><url><loc> https://a.com/?x=1&amp;y=2 </loc><lastmod>2026</lastmod></url><url><loc>https://a.com/b</loc></url></urlset>`))
    .toEqual({ urls: ["https://a.com/?x=1&y=2", "https://a.com/b"], sitemaps: [] });
  expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>`))
    .toEqual({ urls: [], sitemaps: ["https://a.com/s1.xml"] });
});

test("batch_inspect_urls stops after the quota runs out and returns partial results", async () => {
  const { batchInspectUrls } = await import("../src/tools/batch-inspect.ts");
  const ok = await batchInspectUrls(["https://default.com/a", "https://default.com/a", "https://default.com/b"]);
  expect(ok.summary).toMatchObject({ total: 2, indexed: 2, errors: 0 }); // deduplicated
  state.inspectStatus["sc-domain:default.com"] = 429;
  const urls = Array.from({ length: 8 }, (_, i) => `https://default.com/${i}`);
  const r = await batchInspectUrls(urls);
  expect(r.quotaExhausted).toBe(true);
  expect(r.summary.errors).toBeGreaterThan(0);
  expect(r.summary.skipped).toBe(8 - r.summary.errors);
  await expect(batchInspectUrls(Array.from({ length: 51 }, (_, i) => `https://x/${i}`))).rejects.toThrow("At most 50");
});

test("pagespeed summary maps CrUX field data and lab metrics", async () => {
  const { summarisePageSpeed } = await import("../src/tools/pagespeed.ts");
  const s = summarisePageSpeed({
    id: "https://a.com/",
    loadingExperience: { overall_category: "FAST", metrics: { CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" }, INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" } } },
    lighthouseResult: {
      categories: { performance: { score: 0.873 } },
      audits: {
        "largest-contentful-paint": { displayValue: "2.1 s" },
        "render-blocking-resources": { id: "render-blocking-resources", title: "Eliminate", details: { type: "opportunity", overallSavingsMs: 640 } },
        tiny: { id: "tiny", title: "t", details: { type: "opportunity", overallSavingsMs: 20 } },
      },
    },
  });
  expect(s.scores.performance).toBe(87);
  expect(s.fieldData.page).toEqual({ overall: "FAST", metrics: { inp: { p75: 180, rating: "FAST" }, cls: { p75: 0.05, rating: "FAST" } } });
  expect(s.fieldData.origin).toBeNull();
  expect(s.labData.lcp).toBe("2.1 s");
  expect(s.opportunities).toEqual([{ id: "render-blocking-resources", title: "Eliminate", savingsMs: 640 }]);
});

test("export_csv writes all rows, escapes cells, neutralises formulas, never overwrites", async () => {
  const { exportCsv } = await import("../src/tools/export-csv.ts");
  state.pages = [[{ keys: ['=HYPERLINK("x")', "a,b"], clicks: 1, impressions: 2, ctr: 0.5, position: 1 }]];
  const out = path.join(tmp, "e.csv");
  const r = await exportCsv({ dimensions: ["query", "page"], outputPath: out });
  expect(r.rows).toBe(1);
  expect(fs.readFileSync(out, "utf8")).toBe(`query,page,clicks,impressions,ctr,position\n"'=HYPERLINK(""x"")","a,b",1,2,0.5,1\n`);
  await expect(exportCsv({ dimensions: ["query"], outputPath: out })).rejects.toThrow();
  await expect(exportCsv({ dimensions: ["query"], outputPath: path.join(tmp, "e.txt") })).rejects.toThrow(".csv");
});

// --- Bing / Yandex ---
process.env.BING_API_KEY = "bing-key";
process.env.YANDEX_WEBMASTER_TOKEN = "ya-token";

test("bing: /Date()/ parsing, weekly rows summed inside the window only", async () => {
  const { bingDate } = await import("../src/bing.ts");
  const { bingQueryStats } = await import("../src/tools/bing.ts");
  expect(bingDate("/Date(1316156400000-0700)/")).toBe("2011-09-16");
  expect(bingDate("nope")).toBeNull();
  const r = await bingQueryStats({ days: 28 });
  expect(r.siteUrl).toBe("https://default.com/"); // derived from sc-domain:default.com
  expect(r.queries).toEqual([{ query: "shoes", clicks: 8, impressions: 100, ctr: 8, position: 3 }]);
});

test("bing: submit checks the quota; API key never leaks into errors", async () => {
  const { bingSubmitUrls } = await import("../src/tools/bing.ts");
  expect(await bingSubmitUrls(["https://default.com/a"])).toMatchObject({ submitted: 1, remainingToday: 9 });
  const post = engineCalls.find((c) => c.url.pathname.endsWith("SubmitUrlBatch"))!;
  expect(JSON.parse(String(post.init.body))).toEqual({ siteUrl: "https://default.com/", urlList: ["https://default.com/a"] });
  await expect(bingSubmitUrls(Array.from({ length: 11 }, (_, i) => `https://default.com/${i}`))).rejects.toThrow("10 more");
  process.env.BING_API_KEY = "wrong-key";
  try {
    const err = await bingSubmitUrls(["x"]).catch((e) => e);
    expect(err.message).toBe("InvalidApiKey (HTTP 400)");
    expect(err.message).not.toContain("wrong-key");
  } finally {
    process.env.BING_API_KEY = "bing-key";
  }
});

test("yandex: host resolved from the GSC property (https preferred), queries mapped", async () => {
  const { yandexPopularQueries } = await import("../src/tools/yandex.ts");
  const r = await yandexPopularQueries({ days: 7 });
  expect(r.hostId).toBe("https:default.com:443");
  expect(r.queries).toEqual([{ query: "обувь", clicks: 4, impressions: 40, ctr: 10, position: 3.1 }]);
  const call = engineCalls.findLast((c) => c.url.pathname.endsWith("/popular"))!;
  expect(call.url.pathname).toBe("/v4/user/7/hosts/https%3Adefault.com%3A443/search-queries/popular");
  expect(call.url.searchParams.getAll("query_indicator")).toHaveLength(4);
  const { yandexHostPath } = await import("../src/yandex.ts");
  await expect(yandexHostPath("https://other.com")).rejects.toThrow("not in this Yandex Webmaster account");
});

test("yandex: recrawl stops at the daily quota and reports the rest as skipped", async () => {
  const { yandexRecrawl } = await import("../src/tools/yandex.ts");
  yandexQuota.remainder = 2;
  const r = await yandexRecrawl(["https://default.com/1", "https://default.com/2", "https://default.com/3"]);
  expect(r.results.map((x) => (x.taskId ? "queued" : x.skipped ? "skipped" : "error"))).toEqual(["queued", "queued", "skipped"]);
  expect(r.remainingToday).toBe(0);
});

test("compare_engines combines all three and survives one engine failing", async () => {
  const { compareEngines } = await import("../src/tools/compare-engines.ts");
  state.pages = [[{ keys: ["2026-01-01"], clicks: 88, impressions: 1000, ctr: 0.088, position: 4 }], [row("g")]];
  const r: any = await compareEngines({ days: 28 });
  expect(r.engines.google).toMatchObject({ status: "ok", clicks: 88 });
  expect(r.engines.bing).toMatchObject({ status: "ok", clicks: 8, impressions: 100 });
  expect(r.engines.yandex).toMatchObject({ status: "ok", clicks: 4, impressions: 60 });
  expect(r.clickSharePercent).toEqual({ google: 88, bing: 8, yandex: 4 });
  process.env.YANDEX_WEBMASTER_TOKEN = "bad";
  try {
    const r2: any = await compareEngines({ days: 28 });
    expect(r2.engines.yandex).toMatchObject({ status: "error" });
    expect(r2.engines.bing.status).toBe("ok");
  } finally {
    process.env.YANDEX_WEBMASTER_TOKEN = "ya-token";
  }
  delete process.env.BING_API_KEY;
  try {
    expect(((await compareEngines({ days: 28 })) as any).engines.bing).toEqual({ status: "not configured" });
  } finally {
    process.env.BING_API_KEY = "bing-key";
  }
});

// --- critic pass: retry policy, cancellation, sharing ---
const { runWithSignal } = await import("../src/mcp.ts");
const { submitBatch } = await import("../src/tools/submit-url.ts");

test("quota-spending POSTs are never retried; submit_batch stops at the daily quota", async () => {
  state.indexingStatuses = [503];
  const r = await submitUrl("https://default.com/a");
  expect(r.success).toBe(false);
  expect(apiCalls("urlNotifications")).toHaveLength(1); // no resend of a publish that may have gone through
  state.requests = [];
  state.indexingStatuses = [200, 429];
  const b = await submitBatch(["https://default.com/1", "https://default.com/2", "https://default.com/3", "https://default.com/4"]);
  expect(b.results.map((x) => x.success)).toEqual([true, false, false, false]);
  expect(b.results[3].error).toContain("skipped");
  expect(apiCalls("urlNotifications")).toHaveLength(2);
});

test("PageSpeed 500s (page could not be loaded) are not retried", async () => {
  const { pageSpeed } = await import("../src/tools/pagespeed.ts");
  await expect(pageSpeed("https://default.com/")).rejects.toThrow("FAILED_DOCUMENT_REQUEST");
  expect(state.requests.filter((r) => r.url.pathname.startsWith("/pagespeedonline/"))).toHaveLength(1);
  await expect(pageSpeed("file:///etc/passwd")).rejects.toThrow("http");
  await expect(pageSpeed("https://default.com/quota")).rejects.toThrow("re-run setup with --reauth");
});

test("a Retry-After beyond the cap gives up instead of waiting; HTTP-date form is parsed", async () => {
  state.queryStatuses = [429];
  state.retryAfter = "3600";
  await expect(fetchAllRows({ ...P, dimensions: ["hour"] })).rejects.toThrow("(HTTP 429)");
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(1);
  state.requests = [];
  state.queryStatuses = [429];
  state.retryAfter = new Date(Date.now() + 3_600_000).toUTCString();
  await expect(fetchAllRows({ ...P, dimensions: ["page", "query"] })).rejects.toThrow("(HTTP 429)");
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(1);
});

test("cancelling during backoff stops right away", async () => {
  const { retryPolicy: rp } = await import("../src/google.ts");
  rp.baseMs = 10_000;
  try {
    state.retryAfter = ""; // no Retry-After: use the (long) exponential backoff
    state.queryStatuses = [503, 503];
    const ctrl = new AbortController();
    const started = Date.now();
    const p = runWithSignal(ctrl.signal, () => fetchAllRows({ ...P, dimensions: ["country", "device"] }));
    await Bun.sleep(20);
    ctrl.abort();
    await expect(p).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  } finally {
    rp.baseMs = 1;
  }
});

test("a cancelled caller does not fail another caller's identical query", async () => {
  state.queryDelayMs = 50;
  state.pages = [[row("x")], [row("x")]];
  const a = new AbortController();
  const b = new AbortController();
  const q = { ...P, dimensions: ["query", "country"] };
  const pa = runWithSignal(a.signal, () => fetchAllRows(q));
  const pb = runWithSignal(b.signal, () => fetchAllRows(q));
  a.abort();
  await expect(pa).rejects.toThrow();
  expect((await pb).map((r) => r.keys[0])).toEqual(["x"]);
  // Same call (same signal): still one shared download.
  state.requests = [];
  state.pages = [[row("y")]];
  const c = new AbortController();
  await runWithSignal(c.signal, () => Promise.all([fetchAllRows(q), fetchAllRows(q)]));
  expect(apiCalls("/searchAnalytics/query")).toHaveLength(1);
});

// --- critic pass: tools ---
test("advanced_search_analytics never stops early when grouped by date (API sorts those by date)", async () => {
  const { advancedSearchAnalytics } = await import("../src/tools/advanced-search-analytics.ts");
  state.pages = [[row("d1"), row("d2"), row("d3")]];
  await advancedSearchAnalytics(7, ["date"], [], 2);
  expect(apiCalls("/searchAnalytics/query")[0].body.rowLimit).toBe(25000);
  state.requests = [];
  state.pages = [[row("q1"), row("q2")]];
  const r = await advancedSearchAnalytics(7, ["query"], [], 2);
  expect(apiCalls("/searchAnalytics/query")[0].body.rowLimit).toBe(2); // clicks order: capped download
  expect(r.totalRowsIsLowerBound).toBe(true);
});

test("advanced_search_analytics hourly uses hourly_all and the hour dimension", async () => {
  const { advancedSearchAnalytics } = await import("../src/tools/advanced-search-analytics.ts");
  await advancedSearchAnalytics(30, ["page"], [], 10, "clicks", "descending", undefined, [], true);
  const [q] = apiCalls("/searchAnalytics/query");
  expect(q.body.dataState).toBe("hourly_all");
  expect(q.body.dimensions).toEqual(["hour", "page"]);
  expect((Date.parse(q.body.endDate) - Date.parse(q.body.startDate)) / 86_400_000).toBe(9); // at most 10 days
});

test("compare_periods totals come from a date query, not summed query rows", async () => {
  const { comparePeriods } = await import("../src/tools/compare-periods.ts");
  const day = (clicks: number) => ({ keys: ["2026-01-01"], clicks, impressions: clicks * 10, ctr: 0.1, position: 5 });
  // Order matches Promise.all: current by query, prior by query, current by date, prior by date.
  state.pages = [[row("a")], [row("a")], [day(100)], [day(50)]];
  const r = await comparePeriods(7);
  expect(r.current.clicks).toBe(100); // query rows only hold 1 click (anonymised queries are missing there)
  expect(r.change.clicksPercent).toBe(100);
  const dims = apiCalls("/searchAnalytics/query").map((q) => q.body.dimensions[0]).sort();
  expect(dims).toEqual(["date", "date", "query", "query"]);
});

test("content_decay uses three back-to-back 30-day windows ending 3 days ago", async () => {
  const { contentDecay } = await import("../src/tools/content-decay.ts");
  await contentDecay();
  const w = apiCalls("/searchAnalytics/query").map((q) => [q.body.startDate, q.body.endDate]);
  const day = 86_400_000;
  expect(w).toHaveLength(3);
  for (const [a, b] of w) expect((Date.parse(b) - Date.parse(a)) / day).toBe(29);
  expect(Date.parse(w[0][0]) - Date.parse(w[1][1])).toBe(day);
  expect(Date.parse(w[1][0]) - Date.parse(w[2][1])).toBe(day);
  expect(w[0][1]).toBe(getDateRange(1, new Date(), 3).endDate);
});

test("parseSitemap handles CDATA and namespace prefixes, ignores image:loc and <urlset>", async () => {
  const { parseSitemap, normaliseUrl } = await import("../src/tools/indexing-coverage.ts");
  const xml = `<?xml version="1.0"?><ns:urlset xmlns:ns="x"><ns:url><ns:loc><![CDATA[https://a.com/c]]></ns:loc><image:image><image:loc>https://a.com/i.png</image:loc></image:image></ns:url></ns:urlset>`;
  expect(parseSitemap(xml)).toEqual({ urls: ["https://a.com/c"], sitemaps: [] });
  expect(normaliseUrl("https://A.com/p#top")).toBe("https://a.com/p");
  expect(normaliseUrl(" https://a.com/caf%C3%A9 ")).toBe("https://a.com/caf%C3%A9");
  expect(normaliseUrl("not a url")).toBe("not a url");
});

test("indexing_coverage: gzip, index -> children on the same site only, fragments merged, bombs rejected", async () => {
  const { gzipSync } = await import("node:zlib");
  const { indexingCoverage } = await import("../src/tools/indexing-coverage.ts");
  const urlset = (...u: string[]) => `<urlset>${u.map((x) => `<url><loc>${x}</loc></url>`).join("")}</urlset>`;
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server): Response {
      const base = `http://127.0.0.1:${server.port}`;
      const p = new URL(req.url).pathname;
      if (p === "/index.xml") return new Response(`<sitemapindex><sitemap><loc>${base}/a.xml.gz</loc></sitemap><sitemap><loc>http://169.254.169.254/latest.xml</loc></sitemap></sitemapindex>`);
      if (p === "/a.xml.gz") return new Response(gzipSync(urlset(`${base}/seen`, `${base}/unseen`)));
      if (p === "/bomb.xml.gz") return new Response(gzipSync(Buffer.alloc(51 * 1024 * 1024)));
      if (p === "/away") return Response.redirect("http://localhost:1/x.xml", 302);
      return new Response("nope", { status: 404 });
    },
  });
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    state.pages = [[
      { keys: [`${base}/seen#section`], clicks: 2, impressions: 20, ctr: 0.1, position: 3 },
      { keys: [`${base}/seen`], clicks: 3, impressions: 30, ctr: 0.1, position: 3 },
      { keys: [`${base}/orphan`], clicks: 9, impressions: 90, ctr: 0.1, position: 2 },
    ]];
    const { withSiteUrl } = await import("../src/auth.ts");
    const { propertyHostCheck } = await import("../src/tools/indexing-coverage.ts");
    // A sitemap_url off the property (here the default sc-domain:default.com) is never fetched.
    await expect(indexingCoverage({ sitemapUrl: `${base}/index.xml` })).rejects.toThrow("on the property sc-domain:default.com");
    await expect(withSiteUrl(`${base}/`, () => indexingCoverage({ sitemapUrl: "file:///etc/passwd" }))).rejects.toThrow("http(s)");
    expect(propertyHostCheck("sc-domain:x.com")("blog.x.com")).toBe(true);
    expect(propertyHostCheck("sc-domain:x.com")("evilx.com")).toBe(false);
    expect(propertyHostCheck("https://www.x.com/")("x.com")).toBe(true);
    expect(propertyHostCheck("https://www.x.com/")("sub.x.com")).toBe(false);
    const run = (o: any) => withSiteUrl(`${base}/`, () => indexingCoverage(o));
    const r: any = await run({ sitemapUrl: `${base}/index.xml` });
    expect(r.sitemapUrlCount).toBe(2);
    expect(r.inSitemapNoImpressions.urls).toEqual([`${base}/unseen`]);
    expect(r.impressionsNotInSitemap.pages).toEqual([{ page: `${base}/orphan`, clicks: 9, impressions: 90 }]);
    expect(r.pagesWithImpressions).toBe(2); // #section merged into /seen
    expect(r.sitemapCoveragePercent).toBe(50);
    expect(r.sitemapErrors).toBeUndefined(); // the off-site child was never fetched
    state.pages = [[]];
    const bomb: any = await run({ sitemapUrl: `${base}/bomb.xml.gz` }).catch((e) => e);
    expect(bomb.sitemapErrors?.[0] ?? String(bomb)).toContain("50 MB");
    state.pages = [[]];
    const away: any = await run({ sitemapUrl: `${base}/away` });
    expect(away.sitemapErrors[0]).toContain("off-site");
  } finally {
    srv.stop(true);
  }
});

test("queryPages yields page by page and honours maxRows mid-page", async () => {
  const { queryPages } = await import("../src/analytics.ts");
  state.pages = [[row("a"), row("b")], [row("c"), row("d")], [row("e")]];
  const pages: string[][] = [];
  for await (const p of queryPages({ ...P, dimensions: ["query"], rowLimit: 2, maxRows: 3 })) pages.push(p.map((r) => r.keys[0]));
  expect(pages).toEqual([["a", "b"], ["c"]]);
});

test("export_csv writes every row and removes a half-written file on failure", async () => {
  const { exportCsv } = await import("../src/tools/export-csv.ts");
  state.pages = [[row("a"), row("b"), row("c")]];
  const out = path.join(tmp, "stream.csv");
  const r = await exportCsv({ dimensions: ["query"], outputPath: out });
  expect(r.rows).toBe(3);
  expect(r.preview).toEqual([["a", 1, 10], ["b", 1, 10], ["c", 1, 10]]);
  expect(fs.readFileSync(out, "utf8").trim().split("\n")).toEqual([
    "query,clicks,impressions,ctr,position", "a,1,10,0.1,3", "b,1,10,0.1,3", "c,1,10,0.1,3",
  ]);
  const bad = path.join(tmp, "bad.csv");
  state.failNextQuery = true;
  await expect(exportCsv({ dimensions: ["query"], outputPath: bad })).rejects.toThrow("bad request");
  expect(fs.existsSync(bad)).toBe(false);
});

test("pagespeed reads newer Lighthouse metricSavings and skips passing audits", async () => {
  const { summarisePageSpeed } = await import("../src/tools/pagespeed.ts");
  const s = summarisePageSpeed({
    lighthouseResult: {
      audits: {
        "render-blocking-insight": { id: "render-blocking-insight", title: "Render blocking", score: 0, metricSavings: { FCP: 450, LCP: 900, CLS: 2 } },
        "image-delivery-insight": { id: "image-delivery-insight", title: "Images", score: 1, metricSavings: { LCP: 5000 } },
      },
    },
  });
  expect(s.opportunities).toEqual([{ id: "render-blocking-insight", title: "Render blocking", savingsMs: 900 }]);
  expect(s.scores.performance).toBeNull();
});

test("bing: rows without a position (-1) don't drag the average down", async () => {
  const { aggregateBingQueries } = await import("../src/tools/bing.ts");
  const d = `/Date(${Date.parse("2026-05-02")})/`;
  const r = aggregateBingQueries([
    { Query: "q", Clicks: 1, Impressions: 10, AvgImpressionPosition: 4, AvgClickPosition: 4, Date: d },
    { Query: "q", Clicks: 0, Impressions: 30, AvgImpressionPosition: -1, AvgClickPosition: -1, Date: d },
  ], "2026-05-01", "2026-05-31");
  expect(r[0]).toMatchObject({ clicks: 1, impressions: 40, position: 4 });
});

test("yandex: dates sent as ISO date-times; host list fetched once per token", async () => {
  const { yandexPopularQueries, yandexTotals } = await import("../src/tools/yandex.ts");
  const before = engineCalls.filter((c) => c.url.pathname.endsWith("/hosts")).length;
  await yandexPopularQueries({ days: 7 });
  await yandexTotals(undefined, 7);
  expect(engineCalls.filter((c) => c.url.pathname.endsWith("/hosts")).length - before).toBeLessThanOrEqual(1);
  const call = engineCalls.findLast((c) => c.url.pathname.endsWith("/all/history"))!;
  expect(call.url.searchParams.get("date_from")).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  expect(call.url.searchParams.get("date_to")).toMatch(/T23:59:59\.999Z$/);
});

test("setup carries optional Bing / Yandex / PSI variables from the shell into the Claude Code entry", async () => {
  const { buildEnv } = await import("../src/setup.ts");
  const prev = process.env.BING_API_KEY;
  process.env.BING_API_KEY = "bk";
  try {
    const env = buildEnv({ scopes: "full", site: "sc-domain:x.com", secretsPath: null });
    expect(env.BING_API_KEY).toBe("bk");
    expect("YANDEX_HOST" in env).toBe(false);
  } finally {
    process.env.BING_API_KEY = prev;
  }
});

test("multi-site: Bing site matched to the verified one; compare_engines follows site_url; list_sites covers every engine", async () => {
  const { bingSite } = await import("../src/bing.ts");
  const { withSiteUrl } = await import("../src/auth.ts");
  const { compareEngines } = await import("../src/tools/compare-engines.ts");
  const { listAllSites } = await import("../src/tools/sites.ts");
  expect(await bingSite()).toBe("https://default.com/"); // sc-domain:default.com, https preferred
  expect(await bingSite("other.com")).toBe("https://www.other.com/");
  expect(await bingSite("sc-domain:www.other.com")).toBe("https://www.other.com/");
  const miss = await bingSite("nope.com").catch((e) => e.message);
  expect(miss).toContain("not in this Bing Webmaster account");
  expect(miss).not.toContain("other.com"); // the account's other sites are not listed unasked

  engineCalls.length = 0;
  await withSiteUrl("sc-domain:other.com", () => compareEngines({ days: 28 }));
  const bingSites = new Set(engineCalls.filter((c) => c.url.hostname === "ssl.bing.com" && c.url.searchParams.get("siteUrl")).map((c) => c.url.searchParams.get("siteUrl")));
  expect([...bingSites]).toEqual(["https://www.other.com/"]);

  state.sitesDown = true; // Google failing must not hide Bing / Yandex
  const all: any = await listAllSites();
  state.sitesDown = false;
  expect(all.bing).toContain("https://www.other.com/");
  expect(all.yandex).toContain("https://default.com/");
  expect(all.google.error).toContain("sites.list down");
  const one: any = await listAllSites("www.other.com");
  expect(one).toEqual({ google: [{ siteUrl: "sc-domain:other.com", permissionLevel: "siteOwner" }], bing: ["https://www.other.com/"], yandex: [] });
});

test("setup registers through claude mcp add-json, so the server name and env values survive", async () => {
  const { claudeAddArgs } = await import("../src/setup.ts");
  const args = claudeAddArgs({ GSC_SITE_URL: "http://dcxv.com/", GSC_OAUTH_SECRETS_FILE: "/a b/c.json" });
  expect(args.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "mcp-gsc-tool"]);
  const entry = JSON.parse(args[5]);
  expect(entry).toMatchObject({ type: "stdio", command: "bun", env: { GSC_SITE_URL: "http://dcxv.com/", GSC_OAUTH_SECRETS_FILE: "/a b/c.json" } });
  expect(entry.args[0]).toBe("--no-env-file");
});

test("pagespeed lists failed SEO / accessibility / best-practice checks and Lighthouse run errors", async () => {
  const { summarisePageSpeed } = await import("../src/tools/pagespeed.ts");
  const s = summarisePageSpeed({
    id: "https://a.com/",
    lighthouseResult: {
      finalUrl: "https://a.com/en",
      runWarnings: ["The page was redirected to https://a.com/en"],
      categories: {
        performance: { score: 0.5, auditRefs: [] },
        seo: { score: 0.82, auditRefs: [{ id: "meta-description" }, { id: "is-crawlable" }, { id: "structured-data" }, { id: "hreflang" }] },
        accessibility: { score: 0.9, auditRefs: [{ id: "image-alt" }] },
        "best-practices": { score: 1, auditRefs: [{ id: "errors-in-console" }] },
      },
      audits: {
        "meta-description": { id: "meta-description", title: "Document does not have a meta description", score: 0, scoreDisplayMode: "binary" },
        "is-crawlable": { id: "is-crawlable", title: "Page is crawlable", score: 1, scoreDisplayMode: "binary" },
        "structured-data": { id: "structured-data", title: "Structured data is valid", score: null, scoreDisplayMode: "manual" },
        hreflang: { id: "hreflang", title: "hreflang", score: 0, scoreDisplayMode: "notApplicable" },
        "image-alt": { id: "image-alt", title: "Images lack alt", score: 0, scoreDisplayMode: "binary", details: { items: [{}, {}, {}] } },
        "errors-in-console": { id: "errors-in-console", title: "No console errors", score: 1, scoreDisplayMode: "binary" },
      },
    },
  });
  expect(s.scores).toEqual({ performance: 50, accessibility: 90, "best-practices": 100, seo: 82 });
  expect(s.issues).toEqual([
    { category: "accessibility", id: "image-alt", title: "Images lack alt", items: 3 },
    { category: "seo", id: "meta-description", title: "Document does not have a meta description" },
  ]);
  expect(s.warnings).toEqual(["The page was redirected to https://a.com/en"]);
  expect("labErrors" in s).toBe(false);
  const noLcp = summarisePageSpeed({ lighthouseResult: { categories: { performance: { score: null } }, audits: {
    "largest-contentful-paint": { score: null, scoreDisplayMode: "error", errorMessage: "NO_LCP" },
    "speed-index": { score: 0.63, scoreDisplayMode: "numeric", displayValue: "5.0 s" },
  } } });
  expect(noLcp.labErrors).toEqual({ lcp: "NO_LCP" });
  expect(noLcp.labData.speedIndex).toBe("5.0 s");
  expect(s.finalUrl).toBe("https://a.com/en");
});

test("site_audit groups a failed check across pages and keeps going when one page fails", async () => {
  const { siteAudit } = await import("../src/tools/pagespeed.ts");
  const saved = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    const page = u.searchParams.get("url")!;
    asked.push(page);
    expect(u.searchParams.getAll("category")).toEqual(["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]);
    if (page.endsWith("/broken")) return json(400, { error: { message: "Lighthouse returned error: NOT_HTML" } });
    return json(200, { id: page, lighthouseResult: { categories: { seo: { score: 0.9, auditRefs: [{ id: "link-text" }] } }, audits: { "link-text": { id: "link-text", title: "Links do not have descriptive text", score: 0, scoreDisplayMode: "binary" } } } });
  }) as unknown as typeof fetch;
  try {
    const r = await siteAudit({ urls: ["https://a.com/1", "https://a.com/2", "https://a.com/broken", "https://a.com/1"] });
    expect(asked.sort()).toEqual(["https://a.com/1", "https://a.com/2", "https://a.com/broken"]);
    expect(r.issues).toEqual([{ category: "seo", id: "link-text", title: "Links do not have descriptive text", pages: ["https://a.com/1", "https://a.com/2"] }]);
    expect(r.pages.find((p: any) => p.url === "https://a.com/broken")).toMatchObject({ error: expect.stringContaining("NOT_HTML") });
  } finally {
    globalThis.fetch = saved;
  }
});

test("site_audit without urls audits the top pages by clicks", async () => {
  const { siteAudit } = await import("../src/tools/pagespeed.ts");
  state.pages = [[row("https://default.com/top"), row("https://default.com/second")]];
  const r = await siteAudit({ pages: 2 });
  expect(r.pages.map((p: any) => p.url)).toEqual(["https://default.com/top", "https://default.com/second"]);
});

test("yandex_site_health: active problems, removed pages with the reason; a failing sample call doesn't hide the rest", async () => {
  const { yandexSiteHealth } = await import("../src/tools/yandex.ts");
  const r: any = await yandexSiteHealth({});
  expect(r.summary).toEqual({ sqi: 10, pagesInSearch: 691, excludedPages: 3, problems: { CRITICAL: 0, POSSIBLE_PROBLEM: 1 } });
  expect(r.activeProblems).toEqual([{ type: "NO_SITEMAP_MODIFICATIONS", severity: "POSSIBLE_PROBLEM", since: "2026-11-01T00:00:00.000+03:00" }]);
  expect(r.searchEvents).toEqual({ APPEARED_IN_SEARCH: 691, REMOVED_FROM_SEARCH: 1 });
  expect(r.removedFromSearch).toEqual([{ url: "https://default.com/old", date: "2026-11-23", reason: "HTTP_ERROR", httpStatus: 404, target: null }]);
  expect(r.brokenInternalLinks.error).toContain("backend down");
});

test("bing_site_issues: crawl issues with dates mapped, empty lists from null, sitemap status", async () => {
  const { bingSiteIssues } = await import("../src/tools/bing.ts");
  const r = await bingSiteIssues();
  expect(r.siteUrl).toBe("https://default.com/");
  expect(r.crawlIssues).toEqual([{ Url: "https://default.com/x", HttpCode: 404, Issues: 2, InLinks: 3 }]);
  expect(r.blockedUrls).toEqual([]);
  expect(r.sitemaps).toEqual([{ url: "https://default.com/sitemap.xml", type: "Sitemap", status: "Success", urls: 1397, submitted: "2026-11-01", lastCrawled: "2026-11-20" }]);
});

test("PageSpeed bills your project via the OAuth token when it carries openid; otherwise no token is sent", async () => {
  const { saveCachedToken } = await import("../src/oauth.ts");
  const { pageSpeed } = await import("../src/tools/pagespeed.ts");
  const psi = () => state.requests.filter((r) => r.url.pathname.startsWith("/pagespeedonline/"));
  Object.assign(process.env, { GSC_AUTH_MODE: "oauth", GSC_OAUTH_CLIENT_ID: "cid", GSC_OAUTH_CLIENT_SECRET: "csecret", GSC_SCOPES: "readonly" });
  try {
    const ro = "https://www.googleapis.com/auth/webmasters.readonly";
    saveCachedToken({ access_token: "plain", refresh_token: "r", scope: ro, expiry_date: Date.now() + 3_600_000 });
    await pageSpeed("https://default.com/").catch(() => {});
    expect(psi().at(-1)!.auth).toBeNull(); // old token without openid: still works, keyless
    saveCachedToken({ access_token: "with-openid", refresh_token: "r", scope: `${ro} openid`, expiry_date: Date.now() + 3_600_000 });
    await pageSpeed("https://default.com/").catch(() => {});
    expect(psi().at(-1)!.auth).toBe("Bearer with-openid");
  } finally {
    process.env.GSC_AUTH_MODE = "service_account";
    delete process.env.GSC_SCOPES;
  }
});

test("site_url: a bare domain or loose URL resolves to the accessible property; unknown sites fail without listing others", async () => {
  const { resolveProperty } = await import("../src/tools/sites.ts");
  expect(await resolveProperty("default.com")).toBe("sc-domain:default.com");
  expect(await resolveProperty("https://www.default.com/page")).toBe("sc-domain:default.com");
  expect(await resolveProperty("prefix.com")).toBe("https://www.prefix.com/");
  expect(await resolveProperty("https://www.prefix.com/")).toBe("https://www.prefix.com/");
  expect(await resolveProperty("legacy.org")).toBe("http://legacy.org/");
  const miss = await resolveProperty("nope.com").catch((e) => e.message);
  expect(miss).toContain("not a Search Console property");
  expect(miss).not.toContain("other.com");
});
