// Spawns the real server over stdio and talks MCP to it.
import { test, expect, beforeAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The bundle is built into an empty temp dir, so it must run without node_modules.
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "scm-build-"));
const entries = { source: "src/index.ts", bundle: path.join(outdir, "index.js") };
beforeAll(async () => {
  const r = await Bun.build({ entrypoints: ["src/index.ts"], target: "bun", minify: true, outdir });
  if (!r.success) throw new AggregateError(r.logs, "bun build failed");
});

async function rpc(messages: object[], entry: string, extraEnv: Record<string, string> = {}): Promise<Map<number, any>> {
  const proc = Bun.spawn(["bun", "--no-env-file", entry], {
    cwd: entry === entries.bundle ? outdir : undefined,
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, GSC_SITE_URL: "sc-domain:x.com", GSC_KEY_FILE: "/nonexistent", GSC_AUTH_MODE: "service_account", BING_API_KEY: "", YANDEX_WEBMASTER_TOKEN: "", ...extraEnv },
  });
  proc.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  return new Map(out.trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.id).map((m) => [m.id, m]));
}

const init = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

const NO_SITE = ["submit_url", "submit_batch", "multi_site_dashboard", "indexing_status", "pagespeed", "list_sites", "add_site", "delete_site",
  "bing_query_stats", "bing_traffic", "bing_url_info", "bing_site_issues", "bing_submit_urls", "yandex_popular_queries", "yandex_site_health", "yandex_recrawl"];

for (const [kind, entry] of Object.entries(entries)) {
test(`${kind}: Bing / Yandex tools appear only with their credentials; their write tools obey GSC_READ_ONLY`, async () => {
  const list = [...init, { jsonrpc: "2.0", id: 2, method: "tools/list" }];
  const keys = { BING_API_KEY: "k", YANDEX_WEBMASTER_TOKEN: "t" };
  const names: string[] = (await rpc(list, entry, keys)).get(2).result.tools.map((t: any) => t.name);
  expect(names).toHaveLength(44);
  for (const n of ["bing_query_stats", "bing_submit_urls", "yandex_site_health", "yandex_recrawl"]) expect(names).toContain(n);
  const ro: string[] = (await rpc(list, entry, { ...keys, GSC_READ_ONLY: "1" })).get(2).result.tools.map((t: any) => t.name);
  expect(ro).toHaveLength(36);
  expect(ro).not.toContain("bing_submit_urls");
  expect(ro).not.toContain("yandex_recrawl");
}, 20_000);
test(`${kind}: GSC_READ_ONLY=1 drops every write tool; prompts are listed`, async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "prompts/list" }], entry, { GSC_READ_ONLY: "1" });
  const names: string[] = res.get(2).result.tools.map((t: any) => t.name);
  expect(names).toHaveLength(30);
  for (const w of ["submit_url", "submit_batch", "submit_sitemap", "delete_sitemap", "add_site", "delete_site"]) expect(names).not.toContain(w);
  expect(res.get(3).result.prompts.map((p: any) => p.name)).toEqual(["weekly_seo_report", "diagnose_traffic_drop", "indexing_audit"]);
}, 20_000);

test(`${kind}: registers the CLI tool set with site_url where it belongs`, async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 2, method: "tools/list" }], entry);
  const tools: any[] = res.get(2).result.tools;
  const names = tools.map((t) => t.name);
  expect(names).toHaveLength(36);
  for (const gone of ["generate_report", "image_page_audit", "image_keyword_overview", "compare_web_vs_image"]) expect(names).not.toContain(gone);
  for (const t of tools) {
    const hasSite = "site_url" in (t.inputSchema.properties ?? {});
    expect([t.name, hasSite]).toEqual([t.name, !NO_SITE.includes(t.name)]);
    expect(t.description).not.toContain("PRESENTATION"); // no Desktop-artifact rendering instructions
  }
}, 20_000);

test(`${kind}: rejects invalid arguments before touching Google`, async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quick_wins", arguments: { days: "lots" } } }], entry);
  const r = res.get(3).result;
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("Input validation error");
}, 20_000);

test(`${kind}: the official MCP SDK client can connect, list and call tools`, async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["--no-env-file", entry],
    cwd: entry === entries.bundle ? outdir : process.cwd(),
    env: { PATH: process.env.PATH!, GSC_SITE_URL: "sc-domain:x.com", GSC_KEY_FILE: "/nonexistent" },
    stderr: "ignore",
  });
  const client = new Client({ name: "sdk-interop", version: "1" });
  await client.connect(transport);
  try {
    expect(client.getServerVersion()).toEqual({ name: "mcp-gsc-tool", version: "2.5.1" });
    const { tools } = await client.listTools(); // the SDK validates the response against its own schemas
    expect(tools).toHaveLength(36);
    const { prompts } = await client.listPrompts();
    expect(prompts).toHaveLength(3);
    const p = await client.getPrompt({ name: "diagnose_traffic_drop", arguments: { page: "https://x.com/a" } });
    expect((p.messages[0].content as any).text).toContain("https://x.com/a");
    await client.ping();
    const r: any = await client.callTool({ name: "quick_wins", arguments: { days: "x" } });
    expect(r.isError).toBe(true);
    // A real call with a missing key file fails cleanly as a tool error, not a protocol error.
    const real: any = await client.callTool({ name: "site_snapshot", arguments: {} });
    expect(real.isError).toBe(true);
    expect(real.content[0].text).toContain("/nonexistent");
  } finally {
    await client.close();
  }
}, 20_000);
}

test("stdio: parse errors are reported, split multi-byte characters survive, stdin close waits for replies", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, GSC_SITE_URL: "sc-domain:x.com", GSC_KEY_FILE: "/nonexistent" },
  });
  const msg = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "gh\u00e9st", arguments: {} } })}\n`);
  const cut = msg.indexOf(0xc3) + 1; // inside the two-byte é
  proc.stdin.write("not json\n");
  proc.stdin.write(msg.subarray(0, cut));
  await proc.stdin.flush();
  await Bun.sleep(50);
  proc.stdin.write(msg.subarray(cut));
  proc.stdin.end();
  const lines = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  expect(lines[1].result.content[0].text).toBe("MCP error -32602: Tool gh\u00e9st not found");
  expect(await proc.exited).toBe(0);
}, 20_000);
