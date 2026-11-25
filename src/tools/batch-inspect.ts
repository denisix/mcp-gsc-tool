import { mapLimit } from "../analytics.js";
import { GoogleApiError } from "../google.js";
import { inspectUrlTool } from "./inspect-url.js";

export const MAX_BATCH_INSPECT = 50;

/**
 * Inspects many URLs, 3 at a time. Once Google reports the quota exhausted (429 after retries),
 * the remaining URLs are skipped and the partial results are returned.
 */
export async function batchInspectUrls(urls: string[]) {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (unique.length > MAX_BATCH_INSPECT) {
    throw new Error(`At most ${MAX_BATCH_INSPECT} URLs per call (got ${unique.length}). The URL Inspection quota is 2,000 per property per day.`);
  }
  let quotaHit = false;
  const results = await mapLimit(unique, 3, async (url) => {
    if (quotaHit) return { url, skipped: true as const, reason: "quota exhausted" };
    try {
      const r = await inspectUrlTool(url);
      return {
        url,
        indexed: r.indexed,
        indexingState: r.indexingState,
        lastCrawlTime: r.lastCrawlTime,
        canonicalMatch: r.canonicalMatch,
        googleCanonical: r.googleCanonical,
        issues: r.issues,
      };
    } catch (err: any) {
      if (err instanceof GoogleApiError && err.status === 429) quotaHit = true;
      return { url, error: String(err.message ?? err) };
    }
  });
  const count = (f: (r: any) => boolean) => results.filter(f).length;
  return {
    summary: {
      total: unique.length,
      indexed: count((r) => r.indexed === true),
      notIndexed: count((r) => r.indexed === false),
      withIssues: count((r) => r.issues?.length > 0),
      errors: count((r) => "error" in r),
      skipped: count((r) => "skipped" in r),
    },
    quotaExhausted: quotaHit,
    results,
  };
}
