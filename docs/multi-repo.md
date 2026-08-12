# Multi-repo

A project (tenant) holds several repositories. Tenancy is unchanged: isolation
belongs between customers and teams, not between one team's own repos. Repos are
a dimension *inside* a project — which is what makes the most valuable knowledge
in a multi-repo setup expressible at all:

```
SessionClient (bijectai/biject-web) --calls--> AuthService (bijectai/biject-api)
```

Split those repos into separate projects and that edge cannot exist.

## The model

- **`repos`** — registered per project. An operator adds them; agents cannot.
- **`entities.repo_id`** — nullable. `NULL` means **project-wide**: a
  convention, a person, an architectural decision spanning services. Forcing
  those into one repo would be a lie.
- **Uniqueness is `(project, repo, name)`** — two repos may each have a
  `Config`. Project-wide names are unique too, via `NULLS NOT DISTINCT`;
  without it Postgres treats every `NULL` as distinct and you could create
  unlimited project-wide entities sharing a name.

### Why repos are registered, not free text

If `repo` were a string on each entity, one agent writing `biject-api` and
another writing `bijectai/biject-api` would fragment the graph into two repos
that look like one, and nothing would report it. That is the same quiet
corruption the `create_relations` existence check exists to prevent, so repos
get the same treatment: unknown names are refused, with the valid list in the
error. `list_repos` lets an agent discover the names.

It also makes a rename one row update instead of a sweep, because entities
reference the repo by id.

## Referencing entities

Names are no longer unique within a project, so any tool that takes an entity
name accepts an optional repo alongside it — `repo` on `add_observations` and
`delete_*`, `from_repo`/`to_repo` on relations.

Omitting it means "find this name in any repo", which keeps ordinary calls
short. That is only safe because a name matching in more than one repo is an
**error listing the candidates**, never a silent pick:

```
"Config" exists in more than one repo: Config (bijectai/biject-api),
Config (bijectai/biject-web). Say which one with the repo field.
```

Note the asymmetry with *creating*: there, an omitted repo means project-wide.
When creating there is nothing to match against and the caller has to decide;
when referencing, there is.

## Operating

```bash
node scripts/admin.mjs add-repo    biject bijectai/biject-api
node scripts/admin.mjs list-repos  biject
node scripts/admin.mjs rename-repo biject bijectai/biject old-name new-name
```

A rename updates one row; every entity follows automatically, and nothing needs
re-ingesting.

Deleting a repo that still holds entities fails with a foreign-key error rather
than orphaning or silently deleting a chunk of the graph. Move or delete its
entities first.

## Migrating a graph that predates this

For a project whose entities were all written before multi-repo existed:

```bash
supabase db push
node scripts/admin.mjs stamp-repo biject bijectai/biject-api
```

`stamp-repo` registers the repo and claims every entity in the project that has
no repo yet. It prints counts before and after so you can see it landed. It only
ever touches rows where `repo_id is null`, so re-running is a no-op rather than
a reassignment, and entities already assigned to another repo are never moved.

> **Do the backfill before creating any project-wide entities.** `stamp-repo`
> cannot tell "not yet assigned" from "belongs to no repo on purpose" — both are
> `NULL`. Anything you intended as project-wide before the stamp gets absorbed
> into the stamped repo. After backfilling, new entities created without a repo
> stay project-wide as intended.

If a project's entities span several repos already, stamp the bulk first, then
move the exceptions:

```sql
update public.entities
set repo_id = (select id from public.repos where name = 'bijectai/biject-web')
where project_id = (select id from public.projects where name = 'biject')
  and name in ('SessionClient', 'WebConfig');
```

## Tests

`scripts/backfill-test.sql` covers the schema and migration path: the stamp
claims everything unassigned, re-running changes nothing, already-assigned
entities are never reassigned, two repos can each hold a `Config` but one repo
cannot hold it twice, project-wide names collide as they should, a rename
carries every entity, and deleting a populated repo is refused.

`scripts/repo-test.mjs` covers the tool surface over HTTP: unregistered repo
names are refused with the valid list, the same name lives in two repos without
their observations merging, an ambiguous bare name errors and names both
candidates, qualifying resolves to the right one, relations cross repos and
report both sides, project-wide entities surface when filtering by repo while
another repo's entities do not, and an ambiguous delete removes nothing.
