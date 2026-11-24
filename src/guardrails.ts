/**
 * Hallucination guardrails for search-console-mcp.
 *
 * These ensure Claude sticks to the data returned by the GSC API
 * and does not speculate about causes, invent numbers, or fill gaps
 * with assumptions from its training data.
 *
 * Inspired by feedback from Krinal Mehta (https://www.linkedin.com/in/krinal/)
 */

import { currentSiteUrl } from "./auth.js";

export const GUARDRAIL_SUFFIX =
  " IMPORTANT: Base your analysis ONLY on the data returned. Report exact numbers from the results. Do not speculate about causes (e.g. algorithm updates, competitor actions) unless the data explicitly supports it. If the data does not contain enough information to answer a question, say so clearly rather than guessing.";

export const POSITION_CAVEAT =
  " POSITION: position is an impression-weighted average over real impressions, blended across queries, devices and countries. It is not a rank-tracker rank. Deep positions are only recorded when a user actually reaches that part of the results, so values beyond page one rest on sparse data. Treat absolute positions as directional and prefer position deltas between periods when judging change.";

/**
 * Wraps tool results with a _meta provenance field so Claude
 * knows the data source and is anchored to the actual numbers.
 */
export function withMeta(
  data: unknown,
  toolName: string,
  params: Record<string, unknown>,
  source: string = "Google Search Console API (live data)",
  note: string = "All numbers in this response come directly from the Google Search Console API. They are exact values, not estimates. Base your analysis only on this data. Do not invent or assume additional context."
): {
  _meta: {
    source: string;
    tool: string;
    site_url: string | undefined;
    parameters: Record<string, unknown>;
    note: string;
  };
  data: unknown;
} {
  return {
    _meta: {
      source,
      tool: toolName,
      site_url: currentSiteUrl(),
      parameters: params,
      note,
    },
    data,
  };
}
