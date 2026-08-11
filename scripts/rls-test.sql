-- Database-level proof that project scoping is enforced by Postgres, not by
-- application code. Run against a database with the migrations applied:
--
--   psql -v ON_ERROR_STOP=1 -f scripts/rls-test.sql
--
-- Every check raises an exception on failure, so a clean run means a pass.

\set QUIET on
set client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- Fixtures, created as the owner.
-- ---------------------------------------------------------------------------

select app.create_project('rlstest-alpha') \gset alpha_
select app.create_project('rlstest-beta')  \gset beta_

select app.issue_token(
  (select id from public.projects where name = 'rlstest-alpha'),
  'rls-owner', 'raw-token-alpha') as tok \gset alphatok_
select app.issue_token(
  (select id from public.projects where name = 'rlstest-beta'),
  'rls-test-employee', 'raw-token-beta') as tok \gset betatok_

insert into public.entities (project_id, name, entity_type)
select id, 'AlphaService', 'service' from public.projects where name = 'rlstest-alpha';
insert into public.entities (project_id, name, entity_type)
select id, 'BetaService', 'service' from public.projects where name = 'rlstest-beta';

insert into public.observations (entity_id, project_id, content)
select e.id, e.project_id, 'alpha secret' from public.entities e where e.name = 'AlphaService';
insert into public.observations (entity_id, project_id, content)
select e.id, e.project_id, 'beta secret' from public.entities e where e.name = 'BetaService';

-- ---------------------------------------------------------------------------
do $$
declare
  alpha uuid := (select id from public.projects where name = 'rlstest-alpha');
  beta  uuid := (select id from public.projects where name = 'rlstest-beta');
  n     int;
  ok    boolean;
begin
  -- 1. authenticate() resolves a live token to exactly its own project.
  select count(*) into n
  from app.authenticate(app.hash_token('raw-token-alpha')) a
  where a.project_ids = array[alpha];
  if n <> 1 then raise exception 'FAIL 1: authenticate did not scope to alpha'; end if;

  -- 2. A revoked token authenticates to nothing.
  perform app.revoke_token(
    (select id from public.access_tokens where employee_label = 'rls-owner'));
  select count(*) into n from app.authenticate(app.hash_token('raw-token-alpha'));
  if n <> 0 then raise exception 'FAIL 2: revoked token still authenticates'; end if;
  update public.access_tokens set revoked_at = null where employee_label = 'rls-owner';

  -- 3. An unknown token authenticates to nothing.
  select count(*) into n from app.authenticate(app.hash_token('not-a-token'));
  if n <> 0 then raise exception 'FAIL 3: unknown token authenticated'; end if;

  -- 4. The raw token is nowhere in the table.
  select count(*) into n from public.access_tokens
  where token_hash in ('raw-token-alpha', 'raw-token-beta');
  if n <> 0 then raise exception 'FAIL 4: raw token stored in plaintext'; end if;

  raise notice 'checks 1-4 (token handling) passed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Everything below runs as mcp_client, the role the Edge Function uses.
-- ---------------------------------------------------------------------------

set role mcp_client;
set search_path = public, extensions;

do $$
declare
  alpha uuid;
  beta  uuid;
  n     int;
begin
  -- With no tenant context set, the role can see nothing at all.
  select count(*) into n from public.entities;
  if n <> 0 then raise exception 'FAIL 5: entities visible without tenant context'; end if;
  select count(*) into n from public.projects;
  if n <> 0 then raise exception 'FAIL 6: projects visible without tenant context'; end if;
  raise notice 'checks 5-6 (empty context grants nothing) passed';
end;
$$;

reset role;
select id as alpha_id from public.projects where name = 'rlstest-alpha' \gset
select id as beta_id  from public.projects where name = 'rlstest-beta'  \gset

-- Pin the session to alpha only, exactly as withTenant() does per request.
-- beta's id is stashed in a side GUC so the checks below can attempt to reach
-- it: knowing the id must not be enough to use it.
select set_config('app.project_ids', :'alpha_id', false),
       set_config('rlstest.beta',    :'beta_id',  false);

set role mcp_client;
set search_path = public, extensions;

do $$
declare
  n      int;
  beta   uuid := current_setting('rlstest.beta')::uuid;
  denied boolean;
begin
  -- 7. Reads are confined to alpha.
  select count(*) into n from public.entities;
  if n <> 1 then raise exception 'FAIL 7: expected 1 entity, saw %', n; end if;
  select count(*) into n from public.entities where name = 'BetaService';
  if n <> 0 then raise exception 'FAIL 7b: beta entity visible from alpha context'; end if;

  -- 8. Observations are confined too, even though the filter is on a
  --    denormalized column the query never mentions.
  select count(*) into n from public.observations;
  if n <> 1 then raise exception 'FAIL 8: expected 1 observation, saw %', n; end if;
  select count(*) into n from public.observations where content = 'beta secret';
  if n <> 0 then raise exception 'FAIL 8b: beta observation leaked'; end if;

  -- 9. Only alpha appears in projects.
  select count(*) into n from public.projects;
  if n <> 1 then raise exception 'FAIL 9: expected 1 project, saw %', n; end if;

  -- 10. Writing into beta is refused even with beta's real project_id --
  --     this is the case a buggy query layer would hit.
  denied := false;
  begin
    insert into public.entities (project_id, name, entity_type)
    values (beta, 'Trespass', 'service');
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'FAIL 10: cross-project INSERT succeeded'; end if;

  -- 11. Deleting beta's rows is a silent no-op, not a deletion.
  delete from public.entities where name = 'BetaService';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 11: cross-project DELETE affected % rows', n; end if;

  -- 12. Re-parenting an alpha row into beta is refused (WITH CHECK).
  denied := false;
  begin
    update public.entities set project_id = beta where name = 'AlphaService';
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'FAIL 12: cross-project UPDATE succeeded'; end if;

  -- 13. The token tables are unreachable for this role entirely.
  denied := false;
  begin
    perform 1 from public.access_tokens;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'FAIL 13: mcp_client can read access_tokens'; end if;

  -- 14. And it cannot mint itself a project.
  denied := false;
  begin
    insert into public.projects (name) values ('self-granted');
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'FAIL 14: mcp_client can create projects'; end if;

  raise notice 'checks 7-14 (tenant isolation) passed';
end;
$$;

-- 15. Writes inside the pinned project still work normally.
insert into public.entities (project_id, name, entity_type)
values (current_setting('app.project_ids')::uuid, 'AlphaModule', 'module');

do $$
declare n int;
begin
  select count(*) into n from public.entities;
  if n <> 2 then raise exception 'FAIL 15: in-tenant insert did not land'; end if;
  raise notice 'check 15 (in-tenant writes work) passed';
end;
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------
delete from public.projects where name in ('rlstest-alpha', 'rlstest-beta');

\echo 'RLS TEST SUITE: ALL CHECKS PASSED'
