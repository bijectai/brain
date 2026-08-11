-- Row-level security and the least-privilege database role the Edge Function
-- connects as.
--
-- Threat model
-- ------------
-- The Edge Function never connects as the table owner. It connects as
-- `mcp_client`, a NOSUPERUSER / NOBYPASSRLS role, and opens every request in a
-- transaction that does:
--
--     select set_config('app.project_ids', '<uuid,uuid>', true);
--
-- Every policy below filters on that GUC. So even if the query layer has a bug
-- and forgets a `where project_id = ...`, Postgres still refuses to return or
-- write another tenant's rows. Isolation does not depend on application code
-- being correct.
--
-- `anon` and `authenticated` -- the roles PostgREST exposes to the public
-- internet with the publishable API key -- are granted nothing at all here, so
-- none of these tables are reachable over the auto-generated REST API.

-- ---------------------------------------------------------------------------
-- The role the Edge Function uses. Password is set at deploy time by
-- scripts/setup.mjs; the role is unusable until then.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_client') then
    create role mcp_client nologin noinherit nosuperuser nocreatedb nocreaterole;
  end if;
end;
$$;

grant usage on schema public     to mcp_client;
grant usage on schema app        to mcp_client;
grant usage on schema extensions to mcp_client;

-- pg_trgm's operators and functions live in `extensions`; they must be on the
-- search_path for the trigram index on entities.name to be used.
alter role mcp_client set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Tenant context
-- ---------------------------------------------------------------------------

create or replace function app.current_project_ids()
returns uuid[]
language sql
stable
set search_path = ''
as $$
  select coalesce(
    string_to_array(nullif(current_setting('app.project_ids', true), ''), ',')::uuid[],
    array[]::uuid[]
  );
$$;

comment on function app.current_project_ids() is
  'Projects the current request is allowed to touch. Empty unless the request '
  'transaction set app.project_ids, so an unset context grants nothing.';

grant execute on function app.current_project_ids() to mcp_client;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.projects              enable row level security;
alter table public.entities              enable row level security;
alter table public.observations          enable row level security;
alter table public.relations             enable row level security;
alter table public.access_tokens         enable row level security;
alter table public.access_token_projects enable row level security;

-- Nothing on the public REST surface may see these tables.
revoke all on public.projects, public.entities, public.observations,
              public.relations, public.access_tokens, public.access_token_projects
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policies -- all scoped to app.current_project_ids(), all for mcp_client only.
--
-- access_tokens and access_token_projects deliberately get NO policy: with RLS
-- enabled and no policy, mcp_client cannot read or write a single row. It
-- reaches them only through the SECURITY DEFINER authenticate() function.
-- ---------------------------------------------------------------------------

create policy projects_scoped on public.projects
  for select to mcp_client
  using (id = any (app.current_project_ids()));

create policy entities_scoped on public.entities
  for all to mcp_client
  using      (project_id = any (app.current_project_ids()))
  with check (project_id = any (app.current_project_ids()));

create policy observations_scoped on public.observations
  for all to mcp_client
  using      (project_id = any (app.current_project_ids()))
  with check (project_id = any (app.current_project_ids()));

create policy relations_scoped on public.relations
  for all to mcp_client
  using      (project_id = any (app.current_project_ids()))
  with check (project_id = any (app.current_project_ids()));

-- ---------------------------------------------------------------------------
-- Table privileges for mcp_client. Note there is no privilege on projects
-- beyond SELECT: tenants are created by an administrator, not by agents.
-- ---------------------------------------------------------------------------

grant select                         on public.projects     to mcp_client;
grant select, insert, update, delete on public.entities     to mcp_client;
grant select, insert,         delete on public.observations to mcp_client;
grant select, insert,         delete on public.relations    to mcp_client;
