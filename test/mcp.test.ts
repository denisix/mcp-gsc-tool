// Unit tests for the in-house MCP server (src/mcp.ts).
import { test, expect } from "bun:test";
import { z } from "zod";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";

const server = new McpServer({ name: "t", version: "1" });
server.tool("echo", "Echo", { n: z.number().default(1), s: z.string().optional() }, async ({ n, s }) => ({
  content: [{ type: "text", text: `${n}:${s ?? ""}` }],
}));
server.tool("boom", "Throws", {}, () => {
  throw new Error("kaput");
});
const req = (method: string, params?: object, id: number | string = 1) => server.handle({ jsonrpc: "2.0", id, method, params });

test("initialize negotiates the protocol version like the SDK", async () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(((await req("initialize", { protocolVersion: v })) as any).result.protocolVersion).toBe(v);
  const r: any = await req("initialize", { protocolVersion: "1999-01-01" });
  expect(r.result).toEqual({ protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "t", version: "1" } });
});

test("notifications never get a reply, even unknown or failing ones", async () => {
  expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  expect(await server.handle({ jsonrpc: "2.0", method: "no/such" })).toBeNull();
});

test("JSON-RPC errors: unknown method, invalid request; ids echoed (string ids too)", async () => {
  expect(await req("nope", {}, "abc")).toEqual({ jsonrpc: "2.0", id: "abc", error: { code: -32601, message: "Method not found" } });
  expect(await server.handle({ id: 2, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Invalid Request" } });
  expect(await req("ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
});

test("tools/list emits draft-7 input schemas where defaulted fields are optional", async () => {
  const { result }: any = await req("tools/list");
  const echo = result.tools.find((t: any) => t.name === "echo");
  expect(echo.inputSchema).toMatchObject({ type: "object", properties: { n: { type: "number", default: 1 }, s: { type: "string" } } });
  expect(echo.inputSchema.required ?? []).toEqual([]);
});

test("tools/call validates, applies defaults, and reports failures as isError results", async () => {
  const call = async (name: string, args: object) => ((await req("tools/call", { name, arguments: args })) as any).result;
  expect(await call("echo", {})).toEqual({ content: [{ type: "text", text: "1:" }] });
  expect(await call("echo", { n: 5, s: "x" })).toEqual({ content: [{ type: "text", text: "5:x" }] });
  const bad = await call("echo", { n: "five" });
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toBe("MCP error -32602: Input validation error: Invalid arguments for tool echo: Invalid input: expected number, received string at n");
  expect(await call("boom", {})).toEqual({ content: [{ type: "text", text: "kaput" }], isError: true });
  expect((await call("ghost", {})).content[0].text).toBe("MCP error -32602: Tool ghost not found");
});

test("duplicate tool names are rejected at registration", () => {
  expect(() => server.tool("echo", "again", {}, () => ({ content: [] }))).toThrow("already registered");
});
