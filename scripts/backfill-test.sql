-- Proves the multi-repo backfill behaves on a graph that predates repos:
-- every existing entity gets claimed, re-running changes nothing, entities
-- already assigned to another repo are never reassigned, and a rename carries
-- every entity with it.
--
-- This is the path that runs against real data, so it is worth more than the
-- schema being merely well-formed.

\set QUIET on
set client_min_messages = notice;

select app.create_project('backfill-test') \gset bft_

do $$
declare
  p       uuid := (select id from public.projects where name = 'backfill-test');
  api     uuid;
  web     uuid;
  n       bigint;
  stamped bigint;
begin
  -- A pre-multi-repo graph: entities with no repo at all.
  insert into public.entities (project_id, name, entity_type)
  values (p, 'AuthService', 'service'),
         (p, 'TokenStore',  'table'),
         (p, 'Config',      'module');

  select count(*) into n from public.entities
  where project_id = p and repo_id is null;
  if n <> 3 then raise exception 'FAIL 1: expected 3 unassigned, saw %', n; end if;

  -- Backfill.
  select s.stamped_repo_id, s.entities_stamped into api, stamped
  from app.stamp_unassigned_entities(p, 'acmeco/acme-api') s;
  if stamped <> 3 then raise exception 'FAIL 2: stamped % entities, expected 3', stamped; end if;

  select count(*) into n from public.entities where project_id = p and repo_id is null;
  if n <> 0 then raise exception 'FAIL 3: % entities left unassigned', n; end if;

  select count(*) into n from public.entities where project_id = p and repo_id = api;
  if n <> 3 then raise exception 'FAIL 4: only % entities carry the repo', n; end if;

  -- Re-running must be a no-op, not a reassignment.
  select s.entities_stamped into stamped
  from app.stamp_unassigned_entities(p, 'acmeco/acme-api') s;
  if stamped <> 0 then raise exception 'FAIL 5: re-run stamped % rows', stamped; end if;

  -- A second repo, plus one more entity that arrives without a repo.
  select id into web from app.add_repo(p, 'acmeco/acme-web');
  insert into public.entities (project_id, name, entity_type, repo_id)
  values (p, 'SessionClient', 'module', web);
  insert into public.entities (project_id, name, entity_type)
  values (p, 'LegacyThing', 'module');

  -- Stamping again must claim only the new unassigned row, and must not drag
  -- the acme-web entity across.
  select s.entities_stamped into stamped
  from app.stamp_unassigned_entities(p, 'acmeco/acme-api') s;
  if stamped <> 1 then raise exception 'FAIL 6: stamped % rows, expected 1', stamped; end if;

  select count(*) into n from public.entities
  where project_id = p and repo_id = web and name = 'SessionClient';
  if n <> 1 then raise exception 'FAIL 7: an already-assigned entity was reassigned'; end if;

  -- Project-wide entities are created *after* backfilling, deliberately: the
  -- stamp claims everything with no repo and cannot tell "not yet assigned"
  -- from "belongs to no repo on purpose". Creating this before the stamp above
  -- would have seen it silently absorbed into acme-api.
  insert into public.entities (project_id, name, entity_type)
  values (p, 'TrunkBasedDevelopment', 'convention');

  -- The collision the whole change exists to permit.
  insert into public.entities (project_id, name, entity_type, repo_id)
  values (p, 'Config', 'module', web);
  select count(*) into n from public.entities where project_id = p and name = 'Config';
  if n <> 2 then raise exception 'FAIL 8: two repos cannot both hold Config'; end if;

  -- ...but not twice in the same repo.
  begin
    insert into public.entities (project_id, name, entity_type, repo_id)
    values (p, 'Config', 'module', web);
    raise exception 'FAIL 9: duplicate name within one repo was allowed';
  exception when unique_violation then null;
  end;

  -- NULLS NOT DISTINCT: project-wide names must be unique too. Without it,
  -- Postgres treats each NULL repo_id as distinct and this would succeed.
  begin
    insert into public.entities (project_id, name, entity_type)
    values (p, 'TrunkBasedDevelopment', 'convention');
    raise exception 'FAIL 10: duplicate project-wide name was allowed';
  exception when unique_violation then null;
  end;

  -- A rename is one row; entities follow because they reference it by id.
  perform app.rename_repo(p, 'acmeco/acme-api', 'acmeco/acme-api-renamed');
  select count(*) into n
  from public.entities e join public.repos r on r.id = e.repo_id
  where e.project_id = p and r.name = 'acmeco/acme-api-renamed';
  if n <> 4 then raise exception 'FAIL 11: only % entities followed the rename', n; end if;

  -- Deleting a repo that still holds entities must fail rather than orphan them.
  begin
    delete from public.repos where id = api;
    raise exception 'FAIL 12: deleted a repo that still had entities';
  exception when foreign_key_violation then null;
  end;

  raise notice 'BACKFILL SUITE: all 12 checks passed';
end;
$$;

delete from public.projects where name = 'backfill-test';

\echo 'BACKFILL TEST: ALL CHECKS PASSED'
