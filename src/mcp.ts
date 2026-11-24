/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping,
 * tools/list, tools/call. Replaces @modelcontextprotocol/sdk, whose 17 runtime
 * dependencies (express, hono, cors, ajv, jose, ...) serve HTTP transports this
 * server never uses. test/server.test.ts checks it against the official SDK client.
 */
import { z } from "zod";

// Same list the official SDK negotiates; newest first.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

type Content = { type: "text"; text: string };
export type ToolResult = { content: Content[]; isError?: boolean };
type Handler = (args: any) => ToolResult | Promise<ToolResult>;
type Tool = { description: string; schema: z.ZodObject; handler: Handler };
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class McpServer {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly info: { name: string; version: string }) {}

  /** Same signature as the SDK's server.tool(name, description, zodShape, handler). */
  tool(name: string, description: string, shape: z.ZodRawShape, handler: Handler): void {
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.tools.set(name, { description, schema: z.object(shape), handler });
  }

  /** Handles one JSON-RPC message; returns the response, or null for notifications. */
  async handle(msg: Message): Promise<object | null> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") throw new RpcError(-32600, "Invalid Request");
      const result = await this.dispatch(msg.method, msg.params ?? {});
      return isRequest ? { jsonrpc: "2.0", id: msg.id, result } : null;
    } catch (err) {
      if (!isRequest) return null; // notifications never get a reply, even on error
      const e = err instanceof RpcError ? err : new RpcError(-32603, (err as Error).message);
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message } };
    }
  }

  private async dispatch(method: string, params: any): Promise<object> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools].map(([name, t]) => ({
            name,
            description: t.description,
            inputSchema: z.toJSONSchema(t.schema, { target: "draft-7", io: "input" }),
          })),
        };
      case "tools/call":
        return this.callTool(params.name, params.arguments ?? {});
      default:
        if (method.startsWith("notifications/")) return {}; // initialized, cancelled, ...: nothing to do
        throw new RpcError(-32601, "Method not found");
    }
  }

  private async callTool(name: string, args: unknown): Promise<ToolResult> {
    const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
    const tool = this.tools.get(name);
    if (!tool) return error(`MCP error -32602: Tool ${name} not found`);
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return error(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${parsed.error.issues.map((i) => (i.path.length ? `${i.message} at ${i.path.join(".")}` : i.message)).join("; ")}`);
    }
    try {
      return await tool.handler(parsed.data);
    } catch (err) {
      return error((err as Error).message ?? String(err));
    }
  }

  /** Serves newline-delimited JSON-RPC on stdin/stdout until stdin closes. Logs go to stderr. */
  async serveStdio(): Promise<void> {
    const write = (obj: object) => process.stdout.write(`${JSON.stringify(obj)}\n`);
    const pending = new Set<Promise<void>>();
    let buffer = "";
    process.stdin.setEncoding("utf8"); // decoder keeps multi-byte characters split across chunks intact
    for await (const chunk of process.stdin) {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        let msg: Message;
        try {
          msg = JSON.parse(line);
        } catch {
          write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          continue;
        }
        // Requests run concurrently, like the SDK; replies are written as each one finishes.
        const p: Promise<void> = this.handle(msg).then((res) => {
          if (res) write(res);
        });
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
    }
    await Promise.all(pending); // stdin closed: finish in-flight calls before exiting
  }
}
