/**
 * Hallucination guardrails for mcp-gsc-tool.
 *
 * These ensure Claude sticks to the data returned by the GSC API
 * and does not speculate about causes, invent numbers, or fill gaps
 * with assumptions from its training data.
 *
 * Inspired by feedback from Krinal Mehta (https://www.linkedin.com/in/krinal/)
 */

import { currentSiteUrl } from "./auth.js";

/** Rules shared by every tool, sent once as MCP server instructions (not per tool description, to save context). */
export const SERVER_INSTRUCTIONS = [
  "Search data for Google Search Console, Bing and Yandex. Pass a bare domain (example.com) as site_url / site; call list_sites only when the user asks which sites exist.",
  "Base analysis ONLY on the data returned and report its exact numbers. Do not speculate about causes (algorithm updates, competitors) unless the data supports it; if the data cannot answer, say so.",
  "Position is an impression-weighted average across queries, devices and countries, not a rank-tracker rank; positions beyond page one rest on sparse data. Prefer position deltas between periods over absolute values.",
].join("\n");



/**
 * Wraps tool results with a _meta provenance field so Claude
 * knows the data source and is anchored to the actual numbers.
 */
export function withMeta(
  data: unknown,
  toolName: string,
  params: Record<string, unknown>,
  source: string = "Google Search Console API (live data)",
  // The "use only this data" rule lives in SERVER_INSTRUCTIONS; a note here is only for tool-specific caveats.
  note?: string
): {
  _meta: {
    source: string;
    tool: string;
    site_url: string | undefined;
    parameters: Record<string, unknown>;
    note?: string;
  };
  data: unknown;
} {
  return {
    _meta: {
      source,
      tool: toolName,
      site_url: currentSiteUrl(),
      parameters: params,
      ...(note && { note }),
    },
    data,
  };
}
