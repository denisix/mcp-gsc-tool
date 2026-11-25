import { getSearchConsoleClient, getConfig, getAuthMode } from "../auth.js";
import { getScopeTier } from "../oauth.js";
import { propertyCandidates as sitemapPropertyCandidates, fallbackNote, permissionHint, isPermissionError } from "../property-candidates.js";

interface SitemapSubmitResult {
  siteUrl: string;
  sitemapUrl: string;
  success: boolean;
  error: string | null;
  note?: string;
}

interface SitemapListResult {
  siteUrl: string;
  sitemaps: Array<{
    path: string;
    lastSubmitted: string | null;
    isPending: boolean;
    lastDownloaded: string | null;
    warnings: number;
    errors: number;
    contents: Array<{ type: string; submitted: number; indexed: number }>;
  }>;
  note?: string;
}

function defaultSitemapUrl(property: string): string {
  if (property.startsWith("sc-domain:")) {
    return `https://${property.replace("sc-domain:", "")}/sitemap.xml`;
  }
  return `${property}sitemap.xml`;
}

export async function submitSitemap(sitemapUrl?: string): Promise<SitemapSubmitResult> {
  if (getAuthMode() === "oauth" && getScopeTier() === "readonly") {
    return {
      siteUrl: "",
      sitemapUrl: sitemapUrl || "",
      success: false,
      error:
        "Sitemap submission needs full access, but this install is in read only mode (GSC_SCOPES=readonly). " +
        "Re-run `bun src/index.ts setup --reauth` and choose full access, then try again.",
    };
  }

  const client = await getSearchConsoleClient();
  const { siteUrl: configSiteUrl } = getConfig();
  const candidates = sitemapPropertyCandidates(configSiteUrl);

  let firstError: any = null;
  for (const property of candidates) {
    const feedpath = sitemapUrl || defaultSitemapUrl(property);
    try {
      await client.sitemaps.submit({ siteUrl: property, feedpath });
      const note = fallbackNote(property, configSiteUrl);
      return {
        siteUrl: property,
        sitemapUrl: feedpath,
        success: true,
        error: null,
        ...(note && { note }),
      };
    } catch (err: any) {
      if (!firstError) firstError = err;
      if (!isPermissionError(err)) break;
    }
  }

  return {
    siteUrl: configSiteUrl,
    sitemapUrl: sitemapUrl || defaultSitemapUrl(configSiteUrl),
    success: false,
    error: (firstError?.message || String(firstError)) + permissionHint(candidates),
  };
}

export async function listSitemaps(): Promise<SitemapListResult> {
  const client = await getSearchConsoleClient();
  const { siteUrl: configSiteUrl } = getConfig();
  const candidates = sitemapPropertyCandidates(configSiteUrl);

  let firstError: any = null;
  for (const property of candidates) {
    try {
      const response = await client.sitemaps.list({ siteUrl: property });

      const sitemaps = (response.data.sitemap || []).map((s) => ({
        path: s.path || "",
        lastSubmitted: s.lastSubmitted || null,
        isPending: s.isPending || false,
        lastDownloaded: s.lastDownloaded || null,
        warnings: Number(s.warnings) || 0,
        errors: Number(s.errors) || 0,
        contents: (s.contents || []).map((c) => ({
          type: c.type || "unknown",
          submitted: Number(c.submitted) || 0,
          indexed: Number(c.indexed) || 0,
        })),
      }));

      const note = fallbackNote(property, configSiteUrl);
      return {
        siteUrl: property,
        sitemaps,
        ...(note && { note }),
      };
    } catch (err: any) {
      if (!firstError) firstError = err;
      if (!isPermissionError(err)) break;
    }
  }

  throw new Error((firstError?.message || String(firstError)) + permissionHint(candidates));
}

/** Runs `fn` against the configured property, falling back to its URL-prefix variants on 403. */
async function onProperty<T>(fn: (property: string) => Promise<T>): Promise<T & { siteUrl: string; note?: string }> {
  const { siteUrl: configSiteUrl } = getConfig();
  const candidates = sitemapPropertyCandidates(configSiteUrl);
  let firstError: any = null;
  for (const property of candidates) {
    try {
      const result = await fn(property);
      const note = fallbackNote(property, configSiteUrl);
      return { ...result, siteUrl: property, ...(note && { note }) };
    } catch (err: any) {
      if (!firstError) firstError = err;
      if (!isPermissionError(err)) break;
    }
  }
  throw new Error((firstError?.message || String(firstError)) + permissionHint(candidates));
}

export async function getSitemap(sitemapUrl?: string) {
  const client = await getSearchConsoleClient();
  return onProperty(async (property) => {
    const feedpath = sitemapUrl || defaultSitemapUrl(property);
    const { data } = await client.sitemaps.get({ siteUrl: property, feedpath });
    return { sitemapUrl: feedpath, sitemap: data };
  });
}

export async function deleteSitemap(sitemapUrl: string) {
  if (getAuthMode() === "oauth" && getScopeTier() === "readonly") {
    throw new Error("Deleting a sitemap needs full access, but this install is in read only mode (GSC_SCOPES=readonly).");
  }
  const client = await getSearchConsoleClient();
  return onProperty(async (property) => {
    await client.sitemaps.delete({ siteUrl: property, feedpath: sitemapUrl });
    return { sitemapUrl, deleted: true };
  });
}
