/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0): initialize, ping,
 * tools/list, tools/call. Replaces @modelcontextprotocol/sdk, whose 17 runtime
 * dependencies (express, hono, cors, ajv, jose, ...) serve HTTP transports this
 * server never uses. test/server.test.ts checks it against the official SDK client.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

// Abort signal of the tools/call being served; fetches read it so notifications/cancelled stops the work.
const signalContext = new AsyncLocalStorage<AbortSignal>();
export const requestSignal = (): AbortSignal | undefined => signalContext.getStore();
export const runWithSignal = <T>(signal: AbortSignal, fn: () => T): T => signalContext.run(signal, fn);

// Same list the official SDK negotiates; newest first.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

type Content = { type: "text"; text: string };
export type ToolResult = { content: Content[]; isError?: boolean };
type Handler = (args: any) => ToolResult | Promise<ToolResult>;
type Tool = { description: string; schema: z.ZodObject; handler: Handler };
type PromptArg = { name: string; description: string; required?: boolean };
type Prompt = { description: string; arguments: PromptArg[]; render: (args: Record<string, string>) => string };
type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const CANCELLED = Object.freeze({});

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export class McpServer {
  private readonly tools = new Map<string, Tool>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly running = new Map<string | number, AbortController>();

  constructor(private readonly info: { name: string; version: string }, private readonly instructions?: string) {}

  /** Same signature as the SDK's server.tool(name, description, zodShape, handler). */
  tool(name: string, description: string, shape: z.ZodRawShape, handler: Handler): void {
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.tools.set(name, { description, schema: z.object(shape), handler });
  }

  /** Registers a prompt template (prompts/list, prompts/get). */
  prompt(name: string, description: string, args: PromptArg[], render: Prompt["render"]): void {
    if (this.prompts.has(name)) throw new Error(`Prompt ${name} is already registered`);
    this.prompts.set(name, { description, arguments: args, render });
  }

  /** Handles one JSON-RPC message; returns the response, or null for notifications. */
  async handle(msg: Message): Promise<object | null> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") throw new RpcError(-32600, "Invalid Request");
      const result = await this.dispatch(msg.method, msg.params ?? {}, msg.id);
      if (result === CANCELLED) return null; // the spec: no response to a cancelled request
      return isRequest ? { jsonrpc: "2.0", id: msg.id, result } : null;
    } catch (err) {
      if (!isRequest) return null; // notifications never get a reply, even on error
      const e = err instanceof RpcError ? err : new RpcError(-32603, (err as Error).message);
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.code, message: e.message } };
    }
  }

  private async dispatch(method: string, params: any, id?: string | number | null): Promise<object> {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: this.info,
          // Sent once per session (Claude Code puts it in the system prompt) instead of repeated in every tool description.
          ...(this.instructions && { instructions: this.instructions }),
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
      case "tools/call": {
        const ctrl = new AbortController();
        const tracked = id !== undefined && id !== null && !this.running.has(id); // a reused id keeps the first call's entry
        if (tracked) this.running.set(id, ctrl);
        try {
          const result = await runWithSignal(ctrl.signal, () => this.callTool(params.name, params.arguments ?? {}));
          return ctrl.signal.aborted ? CANCELLED : result;
        } finally {
          if (tracked) this.running.delete(id);
        }
      }
      case "prompts/list":
        return { prompts: [...this.prompts].map(([name, p]) => ({ name, description: p.description, arguments: p.arguments })) };
      case "prompts/get": {
        const p = this.prompts.get(params.name);
        if (!p) throw new RpcError(-32602, `Prompt ${params.name} not found`);
        const args = params.arguments ?? {};
        const missing = p.arguments.filter((a) => a.required && !args[a.name]).map((a) => a.name);
        if (missing.length) throw new RpcError(-32602, `Missing required arguments: ${missing.join(", ")}`);
        return { description: p.description, messages: [{ role: "user", content: { type: "text", text: p.render(args) } }] };
      }
      case "notifications/cancelled":
        this.running.get(params.requestId)?.abort();
        return {};
      default:
        if (method.startsWith("notifications/")) return {}; // initialized, progress, ...: nothing to do
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
