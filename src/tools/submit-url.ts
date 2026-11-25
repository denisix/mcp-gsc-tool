import { indexingClient, serviceAccountTokenSource } from "../google.js";
import { getAuthMode } from "../auth.js";
import { authenticateWithOAuth, getScopeTier } from "../oauth.js";
import * as fs from "node:fs";

async function getIndexingClient() {
  const mode = getAuthMode();

  if (mode === "oauth" && getScopeTier() === "readonly") {
    throw new Error(
      "URL submission needs full access, but this install is in read only mode (GSC_SCOPES=readonly). " +
      "Re-run `bun src/index.ts setup --reauth` and choose full access, then try again."
    );
  }

  if (mode === "oauth") {
    // Each client owns its token source; nothing global to clobber the Search Console client (#15).
    return indexingClient(await authenticateWithOAuth());
  }

  const keyFile = process.env.GSC_KEY_FILE;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error("GSC_KEY_FILE is required for indexing API in service_account mode.");
  }
  return indexingClient(serviceAccountTokenSource(keyFile, ["https://www.googleapis.com/auth/indexing"]));
}

interface SubmitResult {
  url: string;
  type: string;
  notifyTime: string | null;
  success: boolean;
  error: string | null;
  note: string;
}

export async function submitUrl(
  url: string,
  action: "URL_UPDATED" | "URL_DELETED" = "URL_UPDATED"
): Promise<SubmitResult> {
  try {
    const indexing = await getIndexingClient();

    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url,
        type: action,
      },
    });

    return {
      url,
      type: action,
      notifyTime: response.data.urlNotificationMetadata?.latestUpdate?.notifyTime || null,
      success: true,
      error: null,
      note:
        "Google has been notified. The Indexing API officially supports JobPosting and BroadcastEvent schema types, but processes requests for all page types. Priority is not guaranteed for non-job pages.",
    };
  } catch (err: any) {
    return {
      url,
      type: action,
      notifyTime: null,
      success: false,
      error: err.message || String(err),
      note:
        "Submission failed. Ensure the Indexing API is enabled in your Google Cloud project and the service account has owner access in Search Console.",
    };
  }
}

export async function submitBatch(
  urls: string[],
  action: "URL_UPDATED" | "URL_DELETED" = "URL_UPDATED"
): Promise<{ results: SubmitResult[]; summary: { total: number; succeeded: number; failed: number; note: string } }> {
  if (urls.length > 200) {
    throw new Error(
      `Google's Indexing API has a daily quota of 200 requests. You provided ${urls.length} URLs. Please reduce to 200 or fewer.`
    );
  }

  const results: SubmitResult[] = [];
  let quotaHit = false;

  for (const url of urls) {
    if (quotaHit) {
      results.push({ url, type: action, notifyTime: null, success: false, error: "skipped: daily quota exhausted", note: "Not sent." });
      continue;
    }
    const result = await submitUrl(url, action);
    results.push(result);
    // 429 on publish is the daily quota (publish is never retried): the rest would all fail.
    if (result.error?.includes("(HTTP 429)")) quotaHit = true;

    // Small delay to avoid rate limiting
    if (urls.length > 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    results,
    summary: {
      total: urls.length,
      succeeded,
      failed,
      note: `Daily quota is 200 URL notifications. ${succeeded} submitted successfully, ${failed} failed.`,
    },
  };
}

/** Last URL_UPDATED / URL_DELETED notification Google recorded for this URL (Indexing API getMetadata). */
export async function getIndexingStatus(url: string) {
  const indexing = await getIndexingClient();
  try {
    const { data } = await indexing.urlNotifications.getMetadata({ url });
    return { url, latestUpdate: data.latestUpdate ?? null, latestRemove: data.latestRemove ?? null };
  } catch (err: any) {
    // 404 means this URL was never submitted through the Indexing API.
    if (err.status === 404) return { url, latestUpdate: null, latestRemove: null, note: "No Indexing API notification on record for this URL." };
    throw err;
  }
}
