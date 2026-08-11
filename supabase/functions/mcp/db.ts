import postgres from "npm:postgres@3.4.5";

/**
 * Two ways to connect, in order of preference:
 *
 *  1. MCP_DB_URL -- a connection string for the dedicated `mcp_client` role.
 *     This is the stronger configuration: the credential itself cannot bypass
 *     RLS, so nothing the function does, correct or buggy, can escape tenant
 *     scoping.
 *
 *  2. SUPABASE_DB_URL -- injected into every Edge Function automatically, but
 *     it connects as `postgres`, which on Supabase carries BYPASSRLS. Used as
 *     a fallback so the server runs without an operator having to set a secret
 *     first. Safe only because withTenant() drops to mcp_client for the whole
 *     of every request; see the note there.
 *
 * Set MCP_DB_URL in production. See the README's "Hardening" section.
 */
const DB_URL = Deno.env.get("MCP_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!DB_URL) {
  throw new Error(
    "Neither MCP_DB_URL nor SUPABASE_DB_URL is set; cannot reach the database.",
  );
}

export const usingDedicatedRole = Boolean(Deno.env.get("MCP_DB_URL"));

export const sql = postgres(DB_URL, {
  // Required when going through Supabase's transaction-mode pooler, which does
  // not keep a session around for named prepared statements.
  prepare: false,
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

export type Sql = typeof sql;

/**
 * Runs `fn` in a transaction that is (a) executing as `mcp_client` and (b)
 * pinned to the given projects.
 *
 * The role switch matters as much as the tenant pin. `postgres` has BYPASSRLS
 * on Supabase, so a transaction running as `postgres` would ignore every
 * policy. `mcp_client` is NOBYPASSRLS and owns nothing, so once we drop to it
 * the policies are live and a missing `where project_id = ...` returns nothing
 * instead of leaking. Both settings are transaction-local, so they unwind when
 * the connection goes back to the pool.
 *
 * search_path is set explicitly because SET ROLE does not apply the target
 * role's configured search_path, and pg_trgm's `similarity`/`%` live in the
 * `extensions` schema.
 */
export function withTenant<T>(
  projectIds: string[],
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  if (projectIds.length === 0) {
    return Promise.reject(new Error("Token is not granted access to any project."));
  }
  return sql.begin(async (tx) => {
    await tx`set local role mcp_client`;
    await tx`set local search_path = public, extensions`;
    await tx`select set_config('app.project_ids', ${projectIds.join(",")}, true)`;
    return await fn(tx as unknown as Sql);
  }) as Promise<T>;
}
