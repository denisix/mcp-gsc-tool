/**
 * Bing Webmaster Tools API (JSON). Auth: BING_API_KEY (Bing Webmaster > Settings > API access),
 * one key for every site the account has verified. Results come wrapped as {"d": ...}.
 */
import { request } from "./google.js";
import { hostOf } from "./property-candidates.js";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

export const bingConfigured = () => Boolean(process.env.BING_API_KEY);

// Verified sites per key, cached for the process (a failure is not cached).
let siteList: { key: string; sites: Promise<string[]> } | null = null;
export function bingSites(): Promise<string[]> {
  const key = process.env.BING_API_KEY ?? "";
  if (siteList?.key !== key) {
    const entry = { key, sites: bingCall<{ Url: string }[] | null>("GetUserSites").then((r) => (r ?? []).map((s) => s.Url)) };
    entry.sites.catch(() => {
      if (siteList === entry) siteList = null;
    });
    siteList = entry;
  }
  return siteList.sites;
}


/**
 * Bing site as verified in the account: explicit arg, BING_SITE_URL, or the GSC property, matched by
 * hostname (then www-less) against GetUserSites, so "example.com" or "sc-domain:example.com" finds https://www.example.com/.
 */
export async function bingSite(site?: string): Promise<string> {
  const want = site?.trim() || process.env.BING_SITE_URL || process.env.GSC_SITE_URL;
  if (!want) throw new Error("No Bing site: pass site or set BING_SITE_URL (e.g. https://www.example.com/).");
  const sites = await bingSites();
  const bare = (h: string) => h.replace(/^www\./, "");
  const https = (a: string, b: string) => Number(b.startsWith("https")) - Number(a.startsWith("https"));
  const match =
    sites.find((u) => u === want) ??
    sites.filter((u) => hostOf(u) === hostOf(want)).sort(https)[0] ??
    sites.filter((u) => bare(hostOf(u)) === bare(hostOf(want))).sort(https)[0];
  // Don't list the account's other sites unasked; list_sites does that on request.
  if (!match) throw new Error(`${want} is not in this Bing Webmaster account (list_sites shows which sites are).`);
  return match;
}

/** "/Date(1316156400000-0700)/" -> "2011-09-16". */
export function bingDate(v: unknown): string | null {
  const m = typeof v === "string" ? /\/Date\((-?\d+)/.exec(v) : null;
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
}

export async function bingCall<T = any>(method: string, params: Record<string, string> = {}, body?: unknown): Promise<T> {
  const key = process.env.BING_API_KEY;
  if (!key) throw new Error("BING_API_KEY is not set.");
  const q = new URLSearchParams({ ...params, apikey: key });
  const res = await request<{ d: T }>(`${BASE}/${method}?${q}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.d;
}
