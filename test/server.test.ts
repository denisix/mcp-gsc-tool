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

async function rpc(messages: object[], entry: string): Promise<Map<number, any>> {
  const proc = Bun.spawn(["bun", "--no-env-file", entry], {
    cwd: entry === entries.bundle ? outdir : undefined,
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

for (const [kind, entry] of Object.entries(entries)) {
test(`${kind}: registers the CLI tool set with site_url where it belongs`, async () => {
  const res = await rpc([...init, { jsonrpc: "2.0", id: 2, method: "tools/list" }], entry);
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
    expect(client.getServerVersion()).toEqual({ name: "search-console-mcp", version: "2.5.1" });
    const { tools } = await client.listTools(); // the SDK validates the response against its own schemas
    expect(tools).toHaveLength(22);
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
