/**
 * Browser-facing HTTP wrapper around the same knowledge-graph tools the MCP
 * server exposes.
 *
 * Why this exists rather than pointing the frontend at `mcp/index.ts`
 * directly: that endpoint speaks MCP's JSON-RPC-over-Streamable-HTTP
 * protocol, which is built for AI agent clients, not `fetch()` from a
 * browser. Auth (kgt_… bearer tokens), tenant scoping, and every tool's
 * validation logic live in ../mcp/auth.ts and ../mcp/tools.ts and are
 * imported here unchanged -- this file only adds a plain REST-ish shape:
 * `POST /tools/:name` with a JSON body of arguments, `GET /tools` to list
 * what's available.
 */

import { authenticate, extractToken } from "../mcp/auth.ts";
import { Ctx, TOOL_DESCRIPTORS, TOOLS_BY_NAME, ToolError } from "../mcp/tools.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  // Supabase mounts the function at /web-api; strip that prefix if present
  // so routing works the same whether called via the gateway or locally.
  const path = url.pathname.replace(/^\/web-api/, "") || "/";

  if (path === "/tools" && request.method === "GET") {
    return json({ tools: TOOL_DESCRIPTORS });
  }

  const match = path.match(/^\/tools\/([^/]+)$/);
  if (!match || request.method !== "POST") {
    return json({ error: "Not found. Use GET /tools or POST /tools/:name." }, 404);
  }

  const toolName = match[1];
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    return json({ error: `Unknown tool: ${toolName}` }, 404);
  }

  const raw = extractToken(request);
  if (!raw) {
    return json({ error: "Missing bearer token." }, 401);
  }

  let caller;
  try {
    caller = await authenticate(raw);
  } catch (err) {
    console.error("authentication backend error", err);
    return json({ error: "Authentication backend error." }, 503);
  }
  if (!caller) {
    return json({ error: "Invalid or revoked token." }, 401);
  }

  let args: Record<string, unknown> = {};
  const bodyText = await request.text();
  if (bodyText) {
    try {
      args = JSON.parse(bodyText);
    } catch {
      return json({ error: "Body is not valid JSON." }, 400);
    }
  }

  const ctx = new Ctx(caller);
  try {
    const result = await tool.handler(args, ctx);
    return json(result);
  } catch (err) {
    if (err instanceof ToolError) {
      return json({ error: err.message }, 400);
    }
    console.error(`tool ${toolName} failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Tool failed: ${message}` }, 500);
  }
});
