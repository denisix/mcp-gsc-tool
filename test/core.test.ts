// Offline tests: global fetch is replaced by a fake Google, so the real HTTP client, JWT signing
// and token handling run without network or credentials.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gsc-test-"));
process.env.HOME = tmp; // token cache lives here, never in the real ~/.gsc-mcp
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
};
const scopeOfToken = new Map<string, string>();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch; // test files share one process
});
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
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
      return json(500, { error: { message: "backend error" } });
    }
    return json(200, { rows: state.pages.shift() ?? [] });
  }
  if (url.pathname === "/v1/urlInspection/index:inspect") {
    const status = state.inspectStatus[body.siteUrl];
    if (status) return json(status, { error: { code: status, message: `denied ${status}` } });
    return json(200, { inspectionResult: { indexStatusResult: { verdict: "PASS" } } });
  }
  if (url.hostname === "indexing.googleapis.com") return json(200, { urlNotificationMetadata: { url: body.url } });
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
const { signServiceAccountJwt, cachedTokenSource, GoogleApiError } = await import("../src/google.ts");

beforeEach(() => {
  Object.assign(state, { requests: [], pages: [], inspectStatus: {}, failNextQuery: false });
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
  expect(inspected()).toEqual(["sc-domain:default.com"]); // one call, no quota burn
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
  await expect(fetchAllRows(q)).rejects.toThrow("backend error (HTTP 500)");
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
