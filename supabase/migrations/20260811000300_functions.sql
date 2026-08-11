-- Authentication entry point and the administrative helpers used by
-- scripts/admin.mjs.

-- ---------------------------------------------------------------------------
-- authenticate() -- the only way mcp_client can learn anything about tokens.
--
-- SECURITY DEFINER because access_tokens is unreachable under RLS for
-- mcp_client. It takes a hash, never a raw token, and returns only the token's
-- identity plus the projects it may touch. A revoked token returns no rows.
-- ---------------------------------------------------------------------------

create or replace function app.authenticate(p_token_hash text)
returns table (
  token_id       uuid,
  employee_label text,
  project_ids    uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    t.employee_label,
    coalesce(
      array_agg(atp.project_id order by atp.project_id)
        filter (where atp.project_id is not null),
      array[]::uuid[]
    )
  from public.access_tokens t
  left join public.access_token_projects atp on atp.token_id = t.id
  where t.token_hash = p_token_hash
    and t.revoked_at is null
  group by t.id, t.employee_label;
$$;

revoke all on function app.authenticate(text) from public;
grant execute on function app.authenticate(text) to mcp_client;

-- ---------------------------------------------------------------------------
-- Administrative helpers. Not granted to mcp_client -- these run as the
-- project owner from an operator's machine.
-- ---------------------------------------------------------------------------

create or replace function app.hash_token(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

create or replace function app.create_project(p_name text)
returns public.projects
language sql
set search_path = ''
as $$
  insert into public.projects (name) values (btrim(p_name))
  on conflict (name) do update set name = excluded.name
  returning *;
$$;

comment on function app.create_project(text) is
  'Idempotent: re-running with an existing name returns that project.';

-- Stores only the hash. The caller is responsible for generating the raw token
-- with a CSPRNG and for showing it to the employee exactly once.
create or replace function app.issue_token(
  p_project_id     uuid,
  p_employee_label text,
  p_token          text
)
returns uuid
language sql
set search_path = ''
as $$
  insert into public.access_tokens (project_id, employee_label, token_hash)
  values (p_project_id, btrim(p_employee_label), app.hash_token(p_token))
  returning id;
$$;

create or replace function app.grant_project(p_token_id uuid, p_project_id uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.access_token_projects (token_id, project_id)
  values (p_token_id, p_project_id)
  on conflict do nothing;
$$;

create or replace function app.revoke_project(p_token_id uuid, p_project_id uuid)
returns void
language sql
set search_path = ''
as $$
  delete from public.access_token_projects
  where token_id = p_token_id and project_id = p_project_id;
$$;

-- Revocation is a tombstone, not a delete: it keeps the audit trail in
-- observations.created_by meaningful.
create or replace function app.revoke_token(p_token_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.access_tokens
  set revoked_at = now()
  where id = p_token_id and revoked_at is null;
$$;
