/**
 * Minimal Google API client: the REST endpoints this server uses, plus
 * access tokens for OAuth (refresh) and service accounts (RS256 JWT bearer).
 * Replaces googleapis/google-auth-library and their ~30 transitive packages.
 * fetch honours HTTPS_PROXY / NO_PROXY under bun.
 */
import { createSign } from "node:crypto";
import * as fs from "node:fs";
import { requestSignal } from "./mcp.js";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SC = "https://searchconsole.googleapis.com";
const TIMEOUT_MS = 60_000;

/** Error carrying the HTTP status, so callers can tell a 403 from a 429 (see isPermissionError). */
export class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleApiError";
  }
}

// Retried statuses: rate limit and transient backend errors. Mutable so tests can shorten the wait.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
export const retryPolicy = { attempts: 4, baseMs: 500, maxWaitMs: 30_000 };

/** Sleeps, but wakes early (rejecting) if the MCP call is cancelled. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * JSON fetch (also used for Bing/Yandex) with timeout, MCP cancellation, and exponential backoff on 429/5xx.
 * `retry` defaults to off for POST: a POST that spends quota (Indexing publish, Bing submit, Yandex recrawl)
 * must not be resent after a 5xx that may have gone through, or hammered once a daily quota is gone.
 * Read-only POSTs (Search Analytics, URL Inspection, token exchange) opt in.
 */
export async function request<T>(url: string, init: RequestInit = {}, retry = init.method !== "POST"): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce<T>(url, init);
    } catch (err) {
      const signal = requestSignal();
      // A dropped connection (ECONNRESET etc.) is retried like a 503; a timeout or cancellation is not.
      const name = (err as Error)?.name;
      const transient = err instanceof GoogleApiError ? RETRY_STATUSES.has(err.status) : name !== "AbortError" && name !== "TimeoutError";
      if (!retry || !transient || attempt >= retryPolicy.attempts || signal?.aborted) throw err;
      const retryAfter = (err as GoogleApiError & { retryAfter?: number }).retryAfter;
      if (retryAfter !== undefined && retryAfter > retryPolicy.maxWaitMs) throw err; // e.g. a daily quota: waiting won't help
      const wait = retryAfter ?? retryPolicy.baseMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await sleep(Math.min(wait, retryPolicy.maxWaitMs), signal);
    }
  }
}

async function requestOnce<T>(url: string, init: RequestInit): Promise<T> {
  const cancel = requestSignal();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, { ...init, signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON error page; keep the raw text for the message
  }
  if (!res.ok) {
    // Google: error.message / error_description; Bing: Message; Yandex: error_message.
    const msg = body?.error?.message ?? body?.error_description ?? body?.Message ?? body?.error_message ?? body?.error ?? (text.slice(0, 200) || res.statusText);
    const err = new GoogleApiError(`${typeof msg === "string" ? msg : JSON.stringify(msg)} (HTTP ${res.status})`, res.status);
    // Retry-After is seconds or an HTTP date.
    const raw = res.headers.get("retry-after");
    const ra = raw === null ? NaN : /^\d+$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(ra)) Object.assign(err, { retryAfter: Math.max(0, ra) });
    throw err;
  }
  return body as T;
}

/** POST a form to Google's token endpoint. */
export function tokenRequest(params: Record<string, string>): Promise<any> {
  return request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  }, true);
}

/** Returns a valid bearer token, fetching a new one shortly before expiry. */
export type TokenSource = () => Promise<string>;

/** Caches a token until 60 s before expiry; concurrent callers share one refresh. */
export function cachedTokenSource(fetchToken: () => Promise<{ token: string; expiresAt: number }>): TokenSource {
  let current: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return () => {
    if (current && current.expiresAt - 60_000 > Date.now()) return Promise.resolve(current.token);
    if (!pending) {
      pending = fetchToken()
        .then((t) => {
          current = t;
          return t.token;
        })
        .finally(() => {
          pending = null;
        });
    }
    return pending;
  };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** Signs the JWT a service account trades for an access token (RFC 7523). Exported for tests. */
export function signServiceAccountJwt(key: { client_email: string; private_key: string }, scopes: string[], now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

export function serviceAccountTokenSource(keyFile: string, scopes: string[]): TokenSource {
  return cachedTokenSource(async () => {
    const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    if (!key.client_email || !key.private_key) {
      throw new Error(`${keyFile} is not a service account key (missing client_email or private_key).`);
    }
    // Always Google's endpoint, never the key file's token_uri: a tampered key must not redirect the signed assertion.
    const t = await request<any>(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(key, scopes),
      }),
    }, true);
    return { token: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 };
  });
}

type Params = Record<string, any>;

// Response subsets this server reads (Search Console API v3 / v1 reference).
export interface SiteEntry { siteUrl?: string; permissionLevel?: string }
export interface Sitemap {
  path?: string;
  lastSubmitted?: string;
  isPending?: boolean;
  lastDownloaded?: string;
  warnings?: string;
  errors?: string;
  contents?: { type?: string; submitted?: string; indexed?: string }[];
}
const site = (siteUrl: string) => `${SC}/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`;

/** Search Console client with the same call shapes as googleapis' searchconsole_v1. */
export function searchConsoleClient(token: TokenSource) {
  const call = async <T = any>(url: string, method = "GET", body?: unknown, retry = method !== "POST") => ({
    data: await request<T>(url, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, retry),
  });
  return {
    searchanalytics: {
      query: ({ siteUrl, requestBody }: Params) => call(`${site(siteUrl)}/searchAnalytics/query`, "POST", requestBody, true),
    },
    urlInspection: {
      index: { inspect: ({ requestBody }: Params) => call(`${SC}/v1/urlInspection/index:inspect`, "POST", requestBody, true) },
    },
    sites: {
      list: (_?: Params) => call<{ siteEntry?: SiteEntry[] }>(`${SC}/webmasters/v3/sites`),
      get: ({ siteUrl }: Params) => call<SiteEntry>(site(siteUrl)),
      add: ({ siteUrl }: Params) => call(site(siteUrl), "PUT"),
      delete: ({ siteUrl }: Params) => call(site(siteUrl), "DELETE"),
    },
    sitemaps: {
      submit: ({ siteUrl, feedpath }: Params) => call(`${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, "PUT"),
      list: ({ siteUrl }: Params) => call<{ sitemap?: Sitemap[] }>(`${site(siteUrl)}/sitemaps`),
      get: ({ siteUrl, feedpath }: Params) => call<Sitemap>(`${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`),
      delete: ({ siteUrl, feedpath }: Params) => call(`${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, "DELETE"),
    },
  };
}
export type SearchConsoleClient = ReturnType<typeof searchConsoleClient>;

/** Indexing API client (urlNotifications.publish and getMetadata). */
export function indexingClient(token: TokenSource) {
  return {
    urlNotifications: {
      getMetadata: async ({ url }: Params) => ({
        data: await request<any>(`https://indexing.googleapis.com/v3/urlNotifications/metadata?url=${encodeURIComponent(url)}`, {
          headers: { Authorization: `Bearer ${await token()}` },
        }),
      }),
      publish: async ({ requestBody }: Params) => ({
        data: await request<any>("https://indexing.googleapis.com/v3/urlNotifications:publish", {
          method: "POST",
          headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }),
      }),
    },
  };
}

export const PSI_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

/** PageSpeed Insights v5 (Lighthouse lab data + CrUX field data). Works without a key; PSI_API_KEY raises the quota. */
export function runPageSpeed(url: string, strategy: "mobile" | "desktop", bearer?: string) {
  const q = new URLSearchParams({ url, strategy });
  for (const c of PSI_CATEGORIES) q.append("category", c.toUpperCase().replace("-", "_"));
  if (process.env.PSI_API_KEY) q.set("key", process.env.PSI_API_KEY);
  // No retry: PSI answers 500 for pages it cannot load (FAILED_DOCUMENT_REQUEST), and each try can take a minute.
  return request<any>(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {}, false);
}
