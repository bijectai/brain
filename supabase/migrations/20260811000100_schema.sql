-- Multi-tenant knowledge graph: core schema.
--
-- Tenancy model: every row that holds graph data carries a project_id. Child
-- tables (observations, relations) carry a *denormalized* project_id so that
-- RLS can be enforced with a plain column predicate instead of a subquery on
-- every row. Composite foreign keys make the denormalized value impossible to
-- desynchronize from the parent entity.

-- `extensions` already exists on Supabase; created here so the migration also
-- runs against a bare Postgres (which is how the test suite exercises it).
create schema if not exists extensions;
create schema if not exists app;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------

create table public.projects (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null unique,
  created_at timestamptz not null default now()
);

comment on table public.projects is 'Tenants. One knowledge graph namespace each.';

-- ---------------------------------------------------------------------------
-- entities
-- ---------------------------------------------------------------------------

create table public.entities (
  id          uuid        primary key default gen_random_uuid(),
  project_id  uuid        not null references public.projects (id) on delete cascade,
  name        text        not null,
  entity_type text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint entities_name_not_blank check (length(btrim(name)) > 0),
  constraint entities_type_not_blank check (length(btrim(entity_type)) > 0),
  constraint entities_project_name_key unique (project_id, name)
);

-- Target for the composite foreign keys used by observations and relations.
alter table public.entities
  add constraint entities_id_project_key unique (id, project_id);

comment on table public.entities is
  'Graph nodes. Unique by (project_id, name) so agents can address them by name.';

-- ---------------------------------------------------------------------------
-- observations
-- ---------------------------------------------------------------------------

create table public.observations (
  id         uuid        primary key default gen_random_uuid(),
  entity_id  uuid        not null,
  project_id uuid        not null,
  content    text        not null,
  created_at timestamptz not null default now(),
  created_by text,  -- employee_label of the token that wrote it

  constraint observations_content_not_blank check (length(btrim(content)) > 0),
  constraint observations_entity_fkey
    foreign key (entity_id, project_id)
    references public.entities (id, project_id) on delete cascade
);

comment on column public.observations.project_id is
  'Denormalized from entities for RLS. Composite FK keeps it consistent.';

-- ---------------------------------------------------------------------------
-- relations (active voice: from --relation_type--> to)
-- ---------------------------------------------------------------------------

create table public.relations (
  id             uuid        primary key default gen_random_uuid(),
  project_id     uuid        not null,
  from_entity_id uuid        not null,
  to_entity_id   uuid        not null,
  relation_type  text        not null,
  created_at     timestamptz not null default now(),

  constraint relations_type_not_blank check (length(btrim(relation_type)) > 0),
  constraint relations_from_fkey
    foreign key (from_entity_id, project_id)
    references public.entities (id, project_id) on delete cascade,
  constraint relations_to_fkey
    foreign key (to_entity_id, project_id)
    references public.entities (id, project_id) on delete cascade,
  constraint relations_unique_edge
    unique (project_id, from_entity_id, to_entity_id, relation_type)
);

-- ---------------------------------------------------------------------------
-- access tokens
-- ---------------------------------------------------------------------------

create table public.access_tokens (
  id             uuid        primary key default gen_random_uuid(),
  project_id     uuid        not null references public.projects (id) on delete cascade,
  employee_label text        not null,
  token_hash     text        not null unique,
  created_at     timestamptz not null default now(),
  revoked_at     timestamptz,

  constraint access_tokens_label_not_blank check (length(btrim(employee_label)) > 0)
);

comment on table public.access_tokens is
  'Personal access tokens. token_hash is sha256(raw token) hex; the raw token '
  'is shown exactly once at issue time and never stored.';
comment on column public.access_tokens.project_id is
  'The token''s home project. Additional grants live in access_token_projects; '
  'the home project is mirrored there automatically by a trigger.';

-- A token may be granted more than one project.
create table public.access_token_projects (
  token_id   uuid        not null references public.access_tokens (id) on delete cascade,
  project_id uuid        not null references public.projects (id) on delete cascade,
  granted_at timestamptz not null default now(),

  primary key (token_id, project_id)
);

-- search_path is pinned on every function here: without it, unqualified names
-- resolve against the caller's search_path, which lets anyone able to create
-- objects shadow what the function meant to reference.
create or replace function app.mirror_home_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into public.access_token_projects (token_id, project_id)
  values (new.id, new.project_id)
  on conflict do nothing;
  return new;
end;
$$;

create trigger access_tokens_mirror_home_project
  after insert on public.access_tokens
  for each row execute function app.mirror_home_project();

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger entities_touch_updated_at
  before update on public.entities
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes sized for real traffic
-- ---------------------------------------------------------------------------

-- Exact / prefix entity lookup within a tenant is the primary access pattern.
-- (project_id, name) is already covered by entities_project_name_key.
create index entities_project_type_idx
  on public.entities (project_id, entity_type);

-- Fuzzy + substring name search for search_nodes.
create index entities_name_trgm_idx
  on public.entities using gin (name extensions.gin_trgm_ops);

-- Relation traversal in both directions, tenant-scoped.
create index relations_from_idx
  on public.relations (project_id, from_entity_id, relation_type);
create index relations_to_idx
  on public.relations (project_id, to_entity_id, relation_type);

-- Fetching an entity's observations newest-first.
create index observations_entity_idx
  on public.observations (entity_id, created_at desc);
create index observations_project_idx
  on public.observations (project_id);

-- Full-text search over observation bodies.
create index observations_content_fts_idx
  on public.observations using gin (to_tsvector('english', content));

create index access_tokens_project_idx
  on public.access_tokens (project_id);
create index access_token_projects_project_idx
  on public.access_token_projects (project_id);
