import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("MCP_DB_URL");
if (!DB_URL) {
  throw new Error(
    "MCP_DB_URL is not set. It must point at the pooler as the mcp_client " +
      "role, e.g. postgresql://mcp_client:<pw>@<host>:6543/postgres",
  );
}

/**
 * One pool for the whole isolate. `prepare: false` is required because we go
 * through Supabase's transaction-mode pooler, which does not keep a session
 * around for named prepared statements.
 */
export const sql = postgres(DB_URL, {
  prepare: false,
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  // The connection carries no ambient tenant. Every statement that touches
  // graph data runs inside withTenant() below.
  onnotice: () => {},
});

export type Sql = typeof sql;

/**
 * Runs `fn` in a transaction whose `app.project_ids` GUC is set to the
 * projects this request is allowed to touch. Every RLS policy filters on that
 * GUC, so anything `fn` does is confined to those projects by the database
 * itself -- a missing WHERE clause cannot leak across tenants.
 *
 * The setting is transaction-local (`set_config(..., true)`), so it is gone
 * when the connection returns to the pool.
 */
export function withTenant<T>(
  projectIds: string[],
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (projectIds.length === 0) {
    return Promise.reject(new Error("Token is not granted access to any project."));
  }
  return sql.begin(async (tx) => {
    await tx`select set_config('app.project_ids', ${projectIds.join(",")}, true)`;
    return await fn(tx as unknown as Sql);
  }) as Promise<T>;
}
