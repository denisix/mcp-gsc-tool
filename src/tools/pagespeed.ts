import { fetchAllRows, getDateRange, mapLimit } from "../analytics.js";
import { getAuthMode } from "../auth.js";
import { GoogleApiError, PSI_CATEGORIES, runPageSpeed } from "../google.js";
import { authenticateWithOAuth, cachedTokenHasScope } from "../oauth.js";

/** Your OAuth token when it carries openid (quota billed to your project), else none: PSI_API_KEY or the shared keyless quota. */
async function psiBearer(): Promise<string | undefined> {
  if (process.env.PSI_API_KEY || getAuthMode() !== "oauth" || !cachedTokenHasScope("openid")) return undefined;
  return (await authenticateWithOAuth())();
}

const LAB_AUDITS = {
  lcp: "largest-contentful-paint",
  fcp: "first-contentful-paint",
  cls: "cumulative-layout-shift",
  tbt: "total-blocking-time",
  speedIndex: "speed-index",
} as const;

// CrUX metric keys as PSI names them.
const FIELD_METRICS = {
  lcp: "LARGEST_CONTENTFUL_PAINT_MS",
  inp: "INTERACTION_TO_NEXT_PAINT",
  cls: "CUMULATIVE_LAYOUT_SHIFT_SCORE",
  fcp: "FIRST_CONTENTFUL_PAINT_MS",
  ttfb: "EXPERIMENTAL_TIME_TO_FIRST_BYTE",
} as const;

function field(exp: any) {
  if (!exp?.metrics) return null;
  const metrics = Object.fromEntries(
    Object.entries(FIELD_METRICS)
      .filter(([, k]) => exp.metrics[k])
      // CLS percentile is reported x100.
      .map(([name, k]) => [name, { p75: name === "cls" ? exp.metrics[k].percentile / 100 : exp.metrics[k].percentile, rating: exp.metrics[k].category }])
  );
  return { overall: exp.overall_category ?? null, metrics };
}

/** Core Web Vitals for a URL: CrUX field data (real users, 28 days) and Lighthouse lab data. Pure mapping, exported for tests. */
export function summarisePageSpeed(data: any) {
  const lh = data.lighthouseResult ?? {};
  const audits = lh.audits ?? {};
  // Older Lighthouse: details.overallSavingsMs on "opportunity" audits. Newer (insights): metricSavings per metric.
  const savings = (a: any) =>
    a.details?.overallSavingsMs ?? Math.max(0, ...Object.entries(a.metricSavings ?? {}).filter(([k]) => k !== "CLS").map(([, v]) => Number(v) || 0));
  const opportunities = Object.values(audits)
    .filter((a: any) => (a.score == null || a.score < 0.9) && savings(a) >= 100)
    .sort((a: any, b: any) => savings(b) - savings(a))
    .slice(0, 8)
    .map((a: any) => ({ id: a.id, title: a.title, savingsMs: Math.round(savings(a)) }));
  const pct = (s: unknown) => (typeof s === "number" ? Math.round(s * 100) : null);
  // Failed checks in the non-performance categories: SEO (indexability, meta, links, hreflang...), accessibility, best practices.
  const issues = PSI_CATEGORIES.filter((c) => c !== "performance").flatMap((c) =>
    (lh.categories?.[c]?.auditRefs ?? [])
      .map((ref: any) => audits[ref.id])
      .filter((a: any) => a && typeof a.score === "number" && a.score < 1 && !["manual", "notApplicable", "informative"].includes(a.scoreDisplayMode))
      .map((a: any) => ({ category: c, id: a.id, title: a.title, ...(a.displayValue && { detail: a.displayValue }), ...(a.details?.items?.length && { items: a.details.items.length }) }))
  );
  return {
    url: data.id ?? lh.finalUrl,
    finalUrl: lh.finalUrl ?? null,
    // Lighthouse could not test the page properly (redirects, blocked, non-200, timeouts).
    ...(lh.runtimeError && { runtimeError: `${lh.runtimeError.code}: ${lh.runtimeError.message}` }),
    ...(lh.runWarnings?.length && { warnings: lh.runWarnings }),
    scores: Object.fromEntries(PSI_CATEGORIES.map((c) => [c, pct(lh.categories?.[c]?.score)])),
    fieldData: { page: field(data.loadingExperience), origin: field(data.originLoadingExperience) },
    labData: Object.fromEntries(Object.entries(LAB_AUDITS).map(([name, id]) => [name, audits[id]?.displayValue ?? null])),
    // A metric Lighthouse could not measure (e.g. NO_LCP: no largest-contentful-paint element, often one that
    // fades in from opacity 0) leaves the performance score null; say why instead of returning a bare null.
    ...(() => {
      const errs = Object.entries(LAB_AUDITS).filter(([, id]) => audits[id]?.scoreDisplayMode === "error").map(([name, id]) => [name, audits[id].errorMessage ?? "error"]);
      return errs.length ? { labErrors: Object.fromEntries(errs) } : {};
    })(),
    opportunities,
    issues,
  };
}

export async function pageSpeed(url: string, strategy: "mobile" | "desktop" = "mobile") {
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  return {
    strategy,
    ...summarisePageSpeed(await runPageSpeed(url, strategy, await psiBearer()).catch((e: unknown) => {
      // The keyless quota is shared by every anonymous caller and is often exhausted.
      if (e instanceof GoogleApiError && e.status === 429 && !process.env.PSI_API_KEY && !cachedTokenHasScope("openid")) {
        throw new GoogleApiError(
          `${e.message}. Use your own quota: enable PageSpeed Insights API in your Google Cloud project, then re-run setup with --reauth (OAuth), or set PSI_API_KEY.`,
          429
        );
      }
      throw e;
    })),
    note: "Field data is what Google uses for the page experience signal; it is null when the page lacks CrUX traffic. Lab data is one Lighthouse run and varies between runs.",
  };
}

export const MAX_AUDIT_PAGES = 10;

/**
 * PageSpeed audit of several pages: explicit urls, or the property's top pages by clicks (last 28 days).
 * Issues are grouped by check, so a template-wide problem shows up once with every page it affects.
 */
export async function siteAudit(opts: { urls?: string[]; pages?: number; strategy?: "mobile" | "desktop" } = {}) {
  const { strategy = "mobile" } = opts;
  const pages = Math.min(opts.pages ?? 5, MAX_AUDIT_PAGES);
  let urls = [...new Set(opts.urls ?? [])].slice(0, MAX_AUDIT_PAGES);
  if (!urls.length) {
    const { startDate, endDate } = getDateRange(28);
    urls = (await fetchAllRows({ startDate, endDate, dimensions: ["page"], maxRows: pages })).map((r) => r.keys[0]);
    if (!urls.length) throw new Error("No pages with impressions in the last 28 days; pass urls instead.");
  }
  // Two at a time: each run takes 10-40 s and PSI rate-limits bursts.
  const results = await mapLimit(urls, 2, (u) => pageSpeed(u, strategy).catch((e: any) => ({ url: u, error: String(e.message ?? e) })));
  const byIssue = new Map<string, { category: string; id: string; title: string; pages: string[] }>();
  for (const r of results) {
    for (const i of "issues" in r ? r.issues : []) {
      const e = byIssue.get(i.id) ?? { category: i.category, id: i.id, title: i.title, pages: [] as string[] };
      e.pages.push(r.url);
      byIssue.set(i.id, e);
    }
  }
  return {
    strategy,
    pages: results.map((r) => ("error" in r ? r : { url: r.url, scores: r.scores, fieldOverall: r.fieldData.page?.overall ?? null, ...(r.runtimeError && { runtimeError: r.runtimeError }), ...(r.labErrors && { labErrors: r.labErrors }), issues: r.issues.length })),
    issues: [...byIssue.values()].sort((a, b) => b.pages.length - a.pages.length),
    note: "Issues are failed Lighthouse checks (SEO, accessibility, best practices), grouped across pages. Use pagespeed on one URL for its Core Web Vitals and savings.",
  };
}
