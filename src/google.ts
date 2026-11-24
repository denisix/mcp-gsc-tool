/**
 * Minimal Google API client: the 6 REST endpoints this server uses, plus
 * access tokens for OAuth (refresh) and service accounts (RS256 JWT bearer).
 * Replaces googleapis/google-auth-library and their ~30 transitive packages.
 * fetch honours HTTPS_PROXY / NO_PROXY under bun.
 */
import { createSign } from "node:crypto";
import * as fs from "node:fs";

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

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // non-JSON error page; keep the raw text for the message
  }
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error_description ?? body?.error ?? (text.slice(0, 200) || res.statusText);
    throw new GoogleApiError(`${typeof msg === "string" ? msg : JSON.stringify(msg)} (HTTP ${res.status})`, res.status);
  }
  return body as T;
}

/** POST a form to Google's token endpoint. */
export function tokenRequest(params: Record<string, string>): Promise<any> {
  return request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
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
export function signServiceAccountJwt(key: { client_email: string; private_key: string; token_uri?: string }, scopes: string[], now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: key.token_uri || TOKEN_URL,
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
    const t = await request<any>(key.token_uri || TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(key, scopes),
      }),
    });
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
  const call = async <T = any>(url: string, method = "GET", body?: unknown) => ({
    data: await request<T>(url, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  });
  return {
    searchanalytics: {
      query: ({ siteUrl, requestBody }: Params) => call(`${site(siteUrl)}/searchAnalytics/query`, "POST", requestBody),
    },
    urlInspection: {
      index: { inspect: ({ requestBody }: Params) => call(`${SC}/v1/urlInspection/index:inspect`, "POST", requestBody) },
    },
    sites: { list: (_?: Params) => call<{ siteEntry?: SiteEntry[] }>(`${SC}/webmasters/v3/sites`) },
    sitemaps: {
      submit: ({ siteUrl, feedpath }: Params) => call(`${site(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`, "PUT"),
      list: ({ siteUrl }: Params) => call<{ sitemap?: Sitemap[] }>(`${site(siteUrl)}/sitemaps`),
    },
  };
}
export type SearchConsoleClient = ReturnType<typeof searchConsoleClient>;

/** Indexing API client (urlNotifications.publish only). */
export function indexingClient(token: TokenSource) {
  return {
    urlNotifications: {
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
