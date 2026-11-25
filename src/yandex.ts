/**
 * Yandex Webmaster API v4. Auth: YANDEX_WEBMASTER_TOKEN, an OAuth token with webmaster:hostinfo
 * (+ webmaster:verify for recrawl), from https://oauth.yandex.ru/authorize?response_type=token&client_id=<app id>.
 */
import { request } from "./google.js";

const BASE = "https://api.webmaster.yandex.net/v4";

export const yandexConfigured = () => Boolean(process.env.YANDEX_WEBMASTER_TOKEN);

export function yandexCall<T = any>(path: string, init: { method?: string; query?: Record<string, string | string[]>; body?: unknown } = {}): Promise<T> {
  const token = process.env.YANDEX_WEBMASTER_TOKEN;
  if (!token) throw new Error("YANDEX_WEBMASTER_TOKEN is not set.");
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) for (const x of [v].flat()) q.append(k, x);
  return request<T>(`${BASE}${path}${q.size ? `?${q}` : ""}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { Authorization: `OAuth ${token}`, ...(init.body !== undefined && { "Content-Type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

let userId: { token: string; id: Promise<number> } | null = null;
const getUserId = () => {
  const token = process.env.YANDEX_WEBMASTER_TOKEN ?? "";
  if (userId?.token !== token) {
    const entry = { token, id: yandexCall<{ user_id: number }>("/user").then((r) => r.user_id) };
    entry.id.catch(() => {
      if (userId === entry) userId = null; // don't cache a failure
    });
    userId = entry;
  }
  return userId.id;
};

/** Bare hostname of a URL, sc-domain: property, or host. */
const hostOf = (s: string) => s.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/[:/].*$/, "").toLowerCase();

/** Every host in the Yandex Webmaster account. */
export const yandexHosts = async () => listHosts(await getUserId());

/**
 * "/user/{uid}/hosts/{host_id}" for the site: `site` arg, YANDEX_HOST or the GSC property, matched by
 * hostname against the account's hosts (prefers https, then the www-less form). Yandex host ids look like https:example.com:443.
 */
// Host list per token, cached for the process (hosts change rarely; a failure is not cached).
let hostList: { token: string; hosts: Promise<{ host_id: string; ascii_host_url: string }[]> } | null = null;
function listHosts(uid: number) {
  const token = process.env.YANDEX_WEBMASTER_TOKEN ?? "";
  if (hostList?.token !== token) {
    const entry = {
      token,
      hosts: yandexCall<{ hosts?: { host_id: string; ascii_host_url: string }[] }>(`/user/${uid}/hosts`).then((r) => r.hosts ?? []),
    };
    entry.hosts.catch(() => {
      if (hostList === entry) hostList = null;
    });
    hostList = entry;
  }
  return hostList.hosts;
}

/** Yandex takes ISO date-times; whole days from YYYY-MM-DD. */
export const yandexRange = (startDate: string, endDate: string) => ({ date_from: `${startDate}T00:00:00.000Z`, date_to: `${endDate}T23:59:59.999Z` });

export async function yandexHostPath(site?: string): Promise<{ path: string; hostId: string; userId: number }> {
  const want = site?.trim() || process.env.YANDEX_HOST || process.env.GSC_SITE_URL;
  if (!want) throw new Error("No Yandex host: pass site or set YANDEX_HOST (e.g. https://example.com).");
  const uid = await getUserId();
  const hosts = await listHosts(uid);
  const target = hostOf(want);
  const bare = (h: string) => h.replace(/^www\./, "");
  const match =
    hosts.find((h) => h.host_id === want) ??
    hosts.filter((h) => hostOf(h.ascii_host_url) === target).sort((a, b) => Number(b.ascii_host_url.startsWith("https")) - Number(a.ascii_host_url.startsWith("https")))[0] ??
    hosts.find((h) => bare(hostOf(h.ascii_host_url)) === bare(target));
  if (!match) throw new Error(`${want} is not in this Yandex Webmaster account. Hosts: ${hosts.map((h) => h.ascii_host_url).join(", ") || "none"}`);
  return { path: `/user/${uid}/hosts/${encodeURIComponent(match.host_id)}`, hostId: match.host_id, userId: uid };
}
