// Spawns the real server over stdio and talks MCP to it.
import { test, expect } from "bun:test";

async function rpc(messages: object[]): Promise<Map<number, any>> {
  const proc = Bun.spawn(["bun", "--no-env-file", "src/index.ts"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, GSC_SITE_URL: "sc-domain:x.com", GSC_KEY_FILE: "/nonexistent", GSC_AUTH_MODE: "service_account" },
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

test("registers the CLI tool set with site_url where it belongs", async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  const tools: any[] = res.get(2).result.tools;
  const names = tools.map((t) => t.name);
  expect(names).toHaveLength(22);
  for (const gone of ["generate_report", "image_page_audit", "image_keyword_overview", "compare_web_vs_image"]) expect(names).not.toContain(gone);
  for (const t of tools) {
    const hasSite = "site_url" in (t.inputSchema.properties ?? {});
    expect([t.name, hasSite]).toEqual([t.name, !["submit_url", "submit_batch", "multi_site_dashboard"].includes(t.name)]);
    expect(t.description).not.toContain("PRESENTATION"); // no Desktop-artifact rendering instructions
  }
}, 20_000);

test("rejects invalid arguments before touching Google", async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "quick_wins", arguments: { days: "lots" } } }]);
  const r = res.get(3).result;
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("Input validation error");
}, 20_000);
