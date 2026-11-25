import { gunzipSync } from "node:zlib";
import { fetchAllRows, getDateRange, mapLimit } from "../analytics.js";
import { getConfig } from "../auth.js";
import { requestSignal } from "../mcp.js";
import { batchInspectUrls } from "./batch-inspect.js";
import { listSitemaps } from "./submit-sitemap.js";

const MAX_SITEMAP_BYTES = 50 * 1024 * 1024; // the sitemap protocol limit (uncompressed)
const MAX_CHILD_SITEMAPS = 50;

const unescapeXml = (v: string) =>
  v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** <loc> values from a sitemap or sitemap index (CDATA and namespace prefixes allowed). Pure, for tests. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = (tag: string) =>
    [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>[\\s\\S]*?<(?:\\w+:)?loc>\\s*(?:<!\\[CDATA\\[)?\\s*([^<\\s\\]]+)`, "g"))].map((m) => unescapeXml(m[1]));
  return { urls: locs("url"), sitemaps: locs("sitemap") };
}

/** Compare URLs the way GSC reports them: no fragment, normalised escaping and host case. */
export function normaliseUrl(u: string): string {
  try {
    const url = new URL(u.trim());
    url.hash = "";
    return url.href;
  } catch {
    return u.trim();
  }
}

/** Reads a response body, aborting once it passes `limit` bytes (content-length can be absent or wrong). */
async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) throw new Error(`${res.url}: larger than 50 MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchSitemap(url: string, onSite: (host: string) => boolean): Promise<string> {
  const signal = requestSignal();
  const timeout = AbortSignal.timeout(30_000);
  let current = url;
  let res: Response;
  // Redirects are followed by hand so every hop is host-checked before it is requested: child sitemap
  // URLs come from remote XML, and must not reach other hosts (internal services, metadata endpoints).
  for (let hop = 0; ; hop++) {
    if (!/^https?:\/\//i.test(current)) throw new Error(`Not an http(s) sitemap URL: ${current}`);
    if (!onSite(new URL(current).hostname)) throw new Error(`${url}: redirected off-site to ${current}`);
    res = await fetch(current, {
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "User-Agent": "mcp-gsc-tool sitemap check" },
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) break;
    if (hop >= 5) throw new Error(`${url}: too many redirects`);
    current = new URL(location, current).href;
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await readCapped(res, MAX_SITEMAP_BYTES);
  // Gzipped sitemaps (.xml.gz) are common; fetch only decodes Content-Encoding, not the file format.
  const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
  try {
    return new TextDecoder().decode(isGzip ? gunzipSync(buf, { maxOutputLength: MAX_SITEMAP_BYTES }) : buf);
  } catch (err: any) {
    throw new Error(`${url}: ${err.code === "ERR_BUFFER_TOO_LARGE" ? "larger than 50 MB uncompressed" : err.message}`);
  }
}

/** All page URLs (normalised) in the given sitemaps, following one level of sitemap index, 4 files at a time. */
/**
 * Hosts the property covers: sc-domain:x is x and its subdomains; a URL prefix is its host, www or bare.
 * Every sitemap fetch, sitemap_url included, must stay on them: the URL can come from prompt-injected text,
 * and an unchecked one would make this machine request LAN / loopback / cloud-metadata addresses.
 */
export function propertyHostCheck(property: string): (host: string) => boolean {
  if (property.startsWith("sc-domain:")) {
    const d = property.slice(10).toLowerCase();
    return (h) => h === d || h.endsWith(`.${d}`);
  }
  const h0 = new URL(property).hostname.toLowerCase();
  const bare = h0.replace(/^www\./, "");
  return (h) => h === bare || h === `www.${bare}`;
}

async function collectSitemapUrls(roots: string[]) {
  const urls = new Set<string>();
  const errors: string[] = [];
  const onSite = propertyHostCheck(getConfig().siteUrl!);
  const allowed = (u: string) => {
    try {
      const url = new URL(u);
      return /^https?:$/.test(url.protocol) && onSite(url.hostname);
    } catch {
      return false;
    }
  };
  for (const r of roots) if (!allowed(r)) errors.push(`${r}: not on property ${getConfig().siteUrl}, not fetched`);
  roots = roots.filter(allowed);
  const read = async (sm: string) => {
    try {
      return parseSitemap(await fetchSitemap(sm, onSite));
    } catch (err: any) {
      errors.push(String(err.message ?? err));
      return { urls: [], sitemaps: [] };
    }
  };
  const rootList = [...new Set(roots)];
  const top = await mapLimit(rootList, 4, read);
  const children = [...new Set(top.flatMap((t) => t.sitemaps))]
    .filter((c) => !rootList.includes(c))
    .filter(allowed);
  const room = Math.max(0, MAX_CHILD_SITEMAPS - rootList.length);
  const nested = await mapLimit(children.slice(0, room), 4, read);
  for (const r of [...top, ...nested]) for (const u of r.urls) urls.add(normaliseUrl(u));
  return { urls, errors, truncated: children.length > room };
}

/**
 * Sitemap vs search visibility: sitemap URLs with no impressions (likely not indexed or not ranking),
 * pages with impressions missing from the sitemap, and optionally a URL Inspection sample of the first group.
 */
export async function indexingCoverage(opts: { sitemapUrl?: string; days?: number; limit?: number; inspectSample?: number }) {
  const { sitemapUrl, days = 90, limit = 50, inspectSample = 0 } = opts;
  if (sitemapUrl) {
    let host = "";
    try {
      host = /^https?:$/.test(new URL(sitemapUrl).protocol) ? new URL(sitemapUrl).hostname : "";
    } catch {}
    if (!host || !propertyHostCheck(getConfig().siteUrl!)(host)) throw new Error(`sitemap_url must be an http(s) URL on the property ${getConfig().siteUrl}.`);
  }
  const roots = sitemapUrl ? [sitemapUrl] : (await listSitemaps()).sitemaps.map((s) => s.path).filter(Boolean);
  if (roots.length === 0) throw new Error("No sitemaps submitted for this property. Pass sitemap_url.");

  const { startDate, endDate } = getDateRange(days);
  const [sitemap, rows] = await Promise.all([
    collectSitemapUrls(roots),
    fetchAllRows({ startDate, endDate, dimensions: ["page"] }),
  ]);
  // GSC reports jump links (#fragment) as separate pages: merge them into their page.
  const visible = new Map<string, { page: string; clicks: number; impressions: number }>();
  for (const r of rows) {
    const page = normaliseUrl(r.keys[0]);
    const v = visible.get(page) ?? { page, clicks: 0, impressions: 0 };
    v.clicks += r.clicks;
    v.impressions += r.impressions;
    visible.set(page, v);
  }
  const noImpressions = [...sitemap.urls].filter((u) => !visible.has(u));
  const notInSitemap = [...visible.values()].filter((v) => !sitemap.urls.has(v.page)).sort((a, b) => b.clicks - a.clicks);

  const sample = Math.min(inspectSample, 20, noImpressions.length);
  return {
    period: { startDate, endDate },
    sitemaps: roots,
    sitemapUrlCount: sitemap.urls.size,
    pagesWithImpressions: visible.size,
    sitemapCoveragePercent: sitemap.urls.size ? Math.round(((sitemap.urls.size - noImpressions.length) / sitemap.urls.size) * 1000) / 10 : null,
    inSitemapNoImpressions: { total: noImpressions.length, urls: noImpressions.slice(0, limit) },
    impressionsNotInSitemap: { total: notInSitemap.length, pages: notInSitemap.slice(0, limit) },
    ...(sample > 0 && { inspection: await batchInspectUrls(noImpressions.slice(0, sample)) }),
    ...(sitemap.errors.length && { sitemapErrors: sitemap.errors }),
    ...(sitemap.truncated && { note: `Read only the first ${MAX_CHILD_SITEMAPS} sitemap files.` }),
    hint: "Sitemap URLs with no impressions in the period are usually not indexed, or indexed but never shown. Pages with traffic missing from the sitemap often point to stale sitemaps, parameter URLs or canonical problems. Use inspect_sample or batch_inspect_urls to confirm.",
  };
}
