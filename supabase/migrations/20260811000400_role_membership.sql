-- Lets the Edge Function's connection role drop down to mcp_client for the
-- duration of each request (see withTenant() in functions/mcp/db.ts).
--
-- This is needed when the function connects with the auto-injected
-- SUPABASE_DB_URL, which authenticates as `postgres`. On Supabase `postgres`
-- has BYPASSRLS, so a request running as `postgres` would ignore every policy;
-- `set local role mcp_client` puts the policies back in force, and that
-- requires role membership.
--
-- Membership only permits SET ROLE. It confers no privilege that `postgres`
-- does not already hold, and it does not weaken mcp_client: the role is still
-- NOBYPASSRLS and still owns nothing.
--
-- When MCP_DB_URL is configured with a dedicated mcp_client credential (the
-- recommended production setup), this grant is unused but harmless.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    execute 'grant mcp_client to postgres';
  end if;
end;
$$;
