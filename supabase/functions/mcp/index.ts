/**
 * Multi-tenant knowledge-graph MCP server, spoken over Streamable HTTP.
 *
 * Why this implements the transport directly instead of using
 * @modelcontextprotocol/sdk's StreamableHTTPServerTransport: that class is
 * written against Node's `http.IncomingMessage`/`ServerResponse`, while Edge
 * Functions hand you a Fetch `Request` and expect a `Response`. Bridging the
 * two needs a node:http compatibility shim in the hot path. A *stateless*
 * Streamable HTTP server -- which is what this is, since every request carries
 * its own bearer token and nothing is kept between calls -- is simply
 * "POST JSON-RPC, get JSON back", so it is implemented here in ~100 lines with
 * no shim and no transport dependency. The wire protocol is unchanged, so
 * standard MCP clients connect without knowing the difference.
 */

import { authenticate, extractToken } from "./auth.ts";
import { Ctx, TOOL_DESCRIPTORS, TOOLS_BY_NAME, ToolError } from "./tools.ts";

const SERVER_INFO = { name: "supabase-knowledge-graph", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, "2025-03-26", "2024-11-05"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-mcp-token, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...CORS,
      ...extra,
    },
  });
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Tool failures are reported in-band with isError so the model can react to
 *  them, rather than as protocol-level errors. */
function toolFailure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handleRpc(req: RpcRequest, ctx: Ctx): Promise<unknown | null> {
  const id = req.id ?? null;
  const isNotification = req.id === undefined || req.id === null;

  switch (req.method) {
    case "initialize": {
      const asked = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "Persistent knowledge graph shared across this team. At the start " +
            "of a task, call search_nodes for the components you are about to " +
            "touch. At the end, record what changed and why with " +
            "create_entities / add_observations / create_relations. Prefer " +
            "search_nodes over read_graph.",
        },
      };
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOL_DESCRIPTORS } };

    case "tools/call": {
      const name = req.params?.name as string;
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        return rpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const result = await tool.handler(args, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          },
        };
      } catch (err) {
        if (err instanceof ToolError) {
          return { jsonrpc: "2.0", id, result: toolFailure(err.message) };
        }
        console.error(`tool ${name} failed`, err);
        const message = err instanceof Error ? err.message : String(err);
        return { jsonrpc: "2.0", id, result: toolFailure(`Tool failed: ${message}`) };
      }
    }

    // Declared unsupported rather than silently 404'd, so clients stop asking.
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };

    default:
      if (isNotification) return null;
      return rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  // Stateless server: there is no session to resume or tear down, and no
  // server-initiated stream to open.
  if (request.method === "DELETE") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method === "GET") {
    return json(
      rpcError(null, INVALID_REQUEST, "This server is stateless; use POST."),
      405,
      { allow: "POST, DELETE, OPTIONS" },
    );
  }
  if (request.method !== "POST") {
    return json(rpcError(null, INVALID_REQUEST, "Method not allowed"), 405);
  }

  const raw = extractToken(request);
  if (!raw) {
    return json(
      rpcError(null, INVALID_REQUEST, "Missing bearer token."),
      401,
      { "www-authenticate": 'Bearer realm="mcp"' },
    );
  }

  let caller;
  try {
    caller = await authenticate(raw);
  } catch (err) {
    console.error("authentication backend error", err);
    return json(rpcError(null, INTERNAL_ERROR, "Authentication backend error."), 503);
  }
  if (!caller) {
    return json(
      rpcError(null, INVALID_REQUEST, "Invalid or revoked token."),
      401,
      { "www-authenticate": 'Bearer realm="mcp", error="invalid_token"' },
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, PARSE_ERROR, "Body is not valid JSON."), 400);
  }

  const ctx = new Ctx(caller);
  const batch = Array.isArray(payload) ? payload : [payload];
  if (batch.length === 0) {
    return json(rpcError(null, INVALID_REQUEST, "Empty batch."), 400);
  }

  const responses = [];
  for (const item of batch as RpcRequest[]) {
    const result = await handleRpc(item ?? {}, ctx);
    if (result !== null) responses.push(result);
  }

  // Every message was a notification -- nothing to send back.
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS });
  }
  return json(Array.isArray(payload) ? responses : responses[0]);
});
