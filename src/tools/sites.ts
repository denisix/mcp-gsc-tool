import { getAuthMode, getSearchConsoleClient } from "../auth.js";
import { bingConfigured, bingSites } from "../bing.js";
import { getScopeTier } from "../oauth.js";
import { yandexConfigured, yandexHosts } from "../yandex.js";

function requireFullAccess(action: string) {
  if (getAuthMode() === "oauth" && getScopeTier() === "readonly") {
    throw new Error(`${action} needs full access, but this install is in read only mode (GSC_SCOPES=readonly).`);
  }
}

export async function listSites() {
  const client = await getSearchConsoleClient();
  const { data } = await client.sites.list();
  return (data.siteEntry ?? []).map((s) => ({ siteUrl: s.siteUrl ?? "", permissionLevel: s.permissionLevel ?? "unknown" }));
}

/** Sites in every configured engine; one engine failing doesn't hide the others. */
export async function listAllSites() {
  const settle = <T>(on: boolean, fn: () => Promise<T>) => (on ? fn().catch((e: any) => ({ error: String(e.message ?? e) })) : undefined);
  const [google, bing, yandex] = await Promise.all([
    settle(true, listSites),
    settle(bingConfigured(), bingSites),
    settle(yandexConfigured(), async () => (await yandexHosts()).map((h) => h.ascii_host_url)),
  ]);
  return { google, ...(bing && { bing }), ...(yandex && { yandex }) };
}

export async function addSite(siteUrl: string) {
  requireFullAccess("Adding a property");
  await (await getSearchConsoleClient()).sites.add({ siteUrl });
  return { siteUrl, added: true, note: "The property still has to be verified in Search Console before it returns data." };
}

export async function deleteSite(siteUrl: string) {
  requireFullAccess("Removing a property");
  await (await getSearchConsoleClient()).sites.delete({ siteUrl });
  return { siteUrl, deleted: true };
}
