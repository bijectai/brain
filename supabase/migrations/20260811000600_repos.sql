-- Multi-repo support.
--
-- A project (tenant) now holds several repositories. Tenancy is unchanged --
-- isolation still belongs between customers/teams, not between one team's own
-- repos -- so this adds a dimension *inside* a project rather than splitting it.
-- That is what makes cross-repo relations expressible at all:
--
--   SessionClient (bijectai/biject-web) --calls--> AuthService (bijectai/biject-api)
--
-- Repos are registered rather than free text. Free text would let one agent
-- write 'biject-api' and another 'bijectai/biject-api', silently fragmenting
-- the graph into two repos that look like one -- the same class of quiet
-- corruption the create_relations existence check exists to prevent. It also
-- makes a rename a single row update instead of a sweep over every entity.

create table public.repos (
  id         uuid        primary key default gen_random_uuid(),
  project_id uuid        not null references public.projects (id) on delete cascade,
  name       text        not null,
  created_at timestamptz not null default now(),

  constraint repos_name_not_blank check (length(btrim(name)) > 0),
  constraint repos_project_name_key unique (project_id, name)
);

comment on table public.repos is
  'Repositories within a project. Registered by an operator, not by agents, so '
  'a typo cannot fragment the graph. Renaming one is an update to name here.';

-- Target for the composite FK below, so an entity can never point at a repo
-- belonging to a different project.
alter table public.repos
  add constraint repos_id_project_key unique (id, project_id);

-- ---------------------------------------------------------------------------
-- entities.repo_id
--
-- Nullable on purpose: NULL means project-wide. Cross-cutting knowledge -- a
-- convention, a person, an architectural decision spanning services -- does not
-- belong to any one repo, and forcing it into one would be a lie.
--
-- restrict, not cascade: deleting a repo that still has entities should fail
-- loudly rather than quietly orphan or delete a chunk of the graph.
-- ---------------------------------------------------------------------------

alter table public.entities add column repo_id uuid;

alter table public.entities
  add constraint entities_repo_fkey
  foreign key (repo_id, project_id)
  references public.repos (id, project_id) on delete restrict;

-- Uniqueness moves from (project, name) to (project, repo, name), so two repos
-- may each have a `Config` or a `Client`.
--
-- NULLS NOT DISTINCT matters: by default Postgres treats NULLs as distinct in a
-- unique constraint, which would let unlimited project-wide entities share one
-- name. Requires PG15+; this project is on 17.
alter table public.entities drop constraint entities_project_name_key;

alter table public.entities
  add constraint entities_project_repo_name_key
  unique nulls not distinct (project_id, repo_id, name);

create index entities_repo_idx on public.entities (project_id, repo_id, name);

-- ---------------------------------------------------------------------------
-- RLS: repos are tenant data, same scoping as everything else.
--
-- No insert/update/delete for mcp_client -- registering a repo is an operator
-- action, like creating a project.
-- ---------------------------------------------------------------------------

alter table public.repos enable row level security;
revoke all on public.repos from anon, authenticated;

create policy repos_scoped on public.repos
  for select to mcp_client
  using (project_id = any (app.current_project_ids()));

grant select on public.repos to mcp_client;

-- ---------------------------------------------------------------------------
-- Operator helpers.
-- ---------------------------------------------------------------------------

create or replace function app.add_repo(p_project_id uuid, p_name text)
returns public.repos
language sql
set search_path = ''
as $$
  insert into public.repos (project_id, name) values (p_project_id, btrim(p_name))
  on conflict (project_id, name) do update set name = excluded.name
  returning *;
$$;

comment on function app.add_repo(uuid, text) is
  'Idempotent: re-adding an existing repo name returns the existing row.';

-- A rename is one update here; every entity follows because they reference the
-- repo by id, not by name.
create or replace function app.rename_repo(p_project_id uuid, p_old text, p_new text)
returns public.repos
language sql
set search_path = ''
as $$
  update public.repos
  set name = btrim(p_new)
  where project_id = p_project_id and name = btrim(p_old)
  returning *;
$$;

-- Backfill helper: registers a repo and claims every entity in the project that
-- has not yet been assigned one. Explicit and re-runnable -- it only ever
-- touches rows where repo_id is null, so running it twice is a no-op rather
-- than a reassignment.
-- The output column is named stamped_repo_id, not repo_id: a plpgsql OUT
-- parameter shares a namespace with column references, so `repo_id` here would
-- be ambiguous against entities.repo_id and the UPDATE would refuse to run.
-- The table alias below guards the same hazard for the WHERE clause.
create or replace function app.stamp_unassigned_entities(p_project_id uuid, p_repo text)
returns table (stamped_repo_id uuid, entities_stamped bigint)
language plpgsql
set search_path = ''
as $$
declare
  v_repo uuid;
  n      bigint;
begin
  select id into v_repo from app.add_repo(p_project_id, p_repo);

  update public.entities e
  set repo_id = v_repo
  where e.project_id = p_project_id and e.repo_id is null;
  get diagnostics n = row_count;

  return query select v_repo, n;
end;
$$;
