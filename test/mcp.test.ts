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
  expect(r.result).toEqual({ protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: "t", version: "1" } });
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

test("prompts/list and prompts/get render templates and check required arguments", async () => {
  server.prompt("p", "A prompt", [{ name: "who", description: "x", required: true }], (a) => `hi ${a.who}`);
  const list: any = await req("prompts/list");
  expect(list.result.prompts).toEqual([{ name: "p", description: "A prompt", arguments: [{ name: "who", description: "x", required: true }] }]);
  const got: any = await req("prompts/get", { name: "p", arguments: { who: "bob" } });
  expect(got.result.messages).toEqual([{ role: "user", content: { type: "text", text: "hi bob" } }]);
  expect(((await req("prompts/get", { name: "p" })) as any).error.code).toBe(-32602);
  expect(((await req("prompts/get", { name: "nope" })) as any).error.code).toBe(-32602);
});

test("a reused request id cannot cancel or untrack the first call", async () => {
  const { requestSignal } = await import("../src/mcp.ts");
  const signals: AbortSignal[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  server.tool("hold", "Holds", {}, async () => {
    signals.push(requestSignal()!);
    await gate;
    return { content: [{ type: "text", text: "done" }] };
  });
  const first = req("tools/call", { name: "hold", arguments: {} }, 5);
  const second = req("tools/call", { name: "hold", arguments: {} }, 5);
  await Bun.sleep(5);
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
  release();
  expect(((await first) as any)).toBeNull(); // the tracked (first) call was cancelled
  expect(((await second) as any).result.content[0].text).toBe("done");
  expect(signals[1].aborted).toBe(false);
});

test("notifications/cancelled aborts the signal of the matching tools/call", async () => {
  const { requestSignal } = await import("../src/mcp.ts");
  let seen: AbortSignal | undefined;
  server.tool("wait", "Waits until cancelled", {}, () =>
    new Promise((resolve) => {
      seen = requestSignal();
      seen!.addEventListener("abort", () => resolve({ content: [{ type: "text", text: "aborted" }] }));
    })
  );
  const call = req("tools/call", { name: "wait", arguments: {} }, 77);
  await Bun.sleep(5);
  await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 77 } });
  expect(await call).toBeNull(); // a cancelled request gets no response
  expect(seen?.aborted).toBe(true);
});
