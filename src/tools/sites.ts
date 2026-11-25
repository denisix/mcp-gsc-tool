import { getAuthMode, getSearchConsoleClient } from "../auth.js";
import { bingConfigured, bingSites } from "../bing.js";
import { getScopeTier } from "../oauth.js";
import { hostOf } from "../property-candidates.js";
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

// Property list per process: site_url resolution would otherwise cost a sites.list call per tool call.
let propertyList: Promise<string[]> | null = null;
const properties = () => {
  propertyList ??= listSites().then((s) => s.map((e) => e.siteUrl));
  propertyList.catch(() => {
    propertyList = null;
  });
  return propertyList;
};

/**
 * The Search Console property for what the agent passed: an exact property, or a bare domain / URL such as
 * "example.com" or "https://www.example.com", matched to sc-domain:, then https, then http URL-prefix properties.
 * If the property list can't be read, the input is used as given.
 */
export async function resolveProperty(input: string): Promise<string> {
  const s = input.trim();
  let list: string[];
  try {
    list = await properties();
  } catch {
    return s;
  }
  const host = hostOf(s), bare = host.replace(/^www\./, "");
  const pick = (l: string[]) => (l.includes(s) ? s : [`sc-domain:${host}`, `sc-domain:${bare}`, `https://${host}/`, `https://www.${bare}/`, `https://${bare}/`, `http://${host}/`, `http://www.${bare}/`, `http://${bare}/`]
    .find((c) => l.includes(c)));
  let match = pick(list);
  if (!match) {
    propertyList = null; // the list is cached per process: re-read once in case the property was added since
    match = pick(await properties().catch(() => []));
  }
  if (!match) throw new Error(`${s} is not a Search Console property these credentials can access (list_sites shows which are).`);
  return match;
}

/** Sites in every configured engine; one engine failing doesn't hide the others. With domain, only that site. */
export async function listAllSites(domain?: string) {
  const want = domain ? hostOf(domain).replace(/^www\./, "") : "";
  const keep = (u: string) => !want || hostOf(u).replace(/^www\./, "") === want || hostOf(u).endsWith(`.${want}`);
  const settle = <T>(on: boolean, fn: () => Promise<T>) => (on ? fn().catch((e: any) => ({ error: String(e.message ?? e) })) : undefined);
  const [google, bing, yandex] = await Promise.all([
    settle(true, async () => (await listSites()).filter((s) => keep(s.siteUrl))),
    settle(bingConfigured(), async () => (await bingSites()).filter(keep)),
    settle(yandexConfigured(), async () => (await yandexHosts()).map((h) => h.ascii_host_url).filter(keep)),
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
