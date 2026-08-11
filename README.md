# Biject Brain

A hosted, multi-tenant knowledge graph that AI coding agents read and write over
the network. One Supabase Postgres database holds many **projects** (tenants);
every employee gets a personal token scoped to the projects they're allowed to
touch. No local files, no per-laptop state — everyone on the team sees the same
graph for a given project.

Agents speak [MCP](https://modelcontextprotocol.io) over Streamable HTTP to a
Supabase Edge Function.

```
Claude Code / Cursor  ──HTTP+MCP──►  Edge Function  ──as mcp_client──►  Postgres
   Bearer kgt_…                      hashes token,                     RLS pins
                                     resolves projects                 every row
                                                                       to a project
```

---

## Deployed endpoint

```
https://litdbmyvvqrbpocohlpw.supabase.co/functions/v1/mcp
```

Live on Supabase project `brain` (`litdbmyvvqrbpocohlpw`, us-east-2, Postgres 17).

| Piece | State |
|---|---|
| Schema + RLS migrations | Applied to production |
| Edge Function (9 MCP tools) | Deployed, `verify_jwt = false`, responding |
| Tenants | `brain`, `biject`, `isolation-test` |
| Tokens | `devrashie` on `brain`, `devrashie` on `biject`, `test-employee` on `isolation-test` |
| Isolation verified | **Yes** — over HTTPS against this endpoint, and at the database level. See [Verification](#verification) |

One hardening step is outstanding: see [Hardening](#hardening).

---

## Layout

```
supabase/migrations/    schema, RLS + roles, auth/admin functions, role membership
supabase/functions/mcp/ the MCP server (index.ts, auth.ts, db.ts, tools.ts)
scripts/admin.mjs       operator CLI: projects, tokens, grants, revocation
scripts/rls-test.sql    database-level isolation proof
scripts/isolation-test.mjs  over-the-wire isolation proof
scripts/local-test.sh   runs all of the above against a throwaway Postgres
.mcp.json.example       Claude Code client config
.cursor/mcp.json.example  Cursor client config
```

---

## How isolation works

Project scoping is enforced by **Postgres**, not by application code.

The Edge Function never connects as the database owner. It connects as
`mcp_client` — a `NOSUPERUSER`, `NOBYPASSRLS` role — and wraps every request in
a transaction that pins the tenant:

```sql
begin;
select set_config('app.project_ids', '<uuid>', true);  -- transaction-local
-- ... the tool's queries ...
commit;
```

Every RLS policy filters on that setting. A missing `where project_id = …` in a
query is therefore *not* a data leak: the database returns nothing. With the
setting unset, the role can read nothing at all — the failure mode is a closed
door, not an open one. Mutating tools narrow the setting further, to the single
project being written, so a token holding several projects can't have a bug
write into the wrong one.

`access_tokens` has RLS on and **no policy**, so `mcp_client` cannot read it at
all; tokens are checked through a `SECURITY DEFINER` function that takes a hash
and returns only an identity. Tokens are stored as SHA-256 and shown exactly
once at issue time. The `anon` and `authenticated` roles — the ones reachable
from the public PostgREST API — are granted nothing on any of these tables.

**Service role keys never leave the server.** Clients authenticate with
`kgt_…` tokens only. Nothing in `.mcp.json` or `.cursor/mcp.json` grants
database access on its own.

### Hardening

The function reads `MCP_DB_URL` if set and falls back to `SUPABASE_DB_URL`,
which Supabase injects automatically. **It is currently running on the
fallback**, because setting a function secret needs `supabase login` — a
credential that only you have.

That matters, because `SUPABASE_DB_URL` connects as `postgres`, and on Supabase
`postgres` carries `BYPASSRLS`. A request running as `postgres` would ignore
every policy above. `withTenant()` therefore drops to `mcp_client` with
`set local role` before touching anything, which puts the policies back in
force for the whole transaction — verified directly against this database, not
assumed. So isolation holds today.

It is still one line of defence rather than two: the *connection* remains
capable of bypassing RLS, and only the wrapper keeps it from doing so. With
`MCP_DB_URL` the credential itself cannot bypass RLS, so no wrapper has to be
correct. To close that gap:

```bash
export ADMIN_DB_URL='postgresql://postgres:…@db.litdbmyvvqrbpocohlpw.supabase.co:5432/postgres'
node scripts/admin.mjs init-role         # prints a generated password once

supabase login
supabase link --project-ref litdbmyvvqrbpocohlpw
supabase secrets set MCP_DB_URL='postgresql://mcp_client:<PASSWORD>@<POOLER_HOST>:6543/postgres'
supabase functions deploy mcp --no-verify-jwt
```

`<POOLER_HOST>` is the **transaction pooler** host from Project Settings →
Database. No code changes are needed — the function picks up `MCP_DB_URL` on
its own, and `set local role mcp_client` becomes a harmless no-op.

---

## Deploying

Already done for `litdbmyvvqrbpocohlpw`; these are the steps for a second
deployment, or to rebuild this one from scratch.

### 1. Link the project

```bash
supabase login                       # interactive, needs your credentials
supabase link --project-ref <REF>    # writes project_id into supabase/config.toml
```

Free-tier Supabase is enough for this; nothing here requires a paid plan.

### 2. Run the migrations

```bash
supabase db push
```

### 3. Create the Edge Function's database role password

`ADMIN_DB_URL` is the Postgres connection string from
**Project Settings → Database → Connection string** (the direct one, as
`postgres`). It's an admin credential — keep it on your machine.

```bash
npm install
export ADMIN_DB_URL='postgresql://postgres:…@db.<REF>.supabase.co:5432/postgres'
node scripts/admin.mjs init-role     # prints a freshly generated password once
```

### 4. Give the function its secret and deploy

Use the **transaction pooler** host (port 6543) from the same settings page —
Edge Functions are short-lived, so pooled connections matter.

```bash
supabase secrets set MCP_DB_URL='postgresql://mcp_client:<PASSWORD>@<POOLER_HOST>:6543/postgres'
supabase functions deploy mcp --no-verify-jwt
```

`--no-verify-jwt` is required: the endpoint authenticates with *our* tokens in
the `Authorization` header, and Supabase's gateway check would reject those as
malformed Supabase JWTs before the function ran. The function itself rejects
every unauthenticated request, and `config.toml` already sets `verify_jwt =
false` so the flag is belt-and-braces.

Your endpoint is then:

```
https://<REF>.supabase.co/functions/v1/mcp
```

### 5. Create tenants and tokens

```bash
node scripts/admin.mjs create-project acme-web
node scripts/admin.mjs create-project acme-billing

node scripts/admin.mjs issue-token acme-web      you
node scripts/admin.mjs issue-token acme-billing  test-employee
```

### 6. Verify isolation against the deployed endpoint

```bash
MCP_URL=https://<REF>.supabase.co/functions/v1/mcp \
TOKEN_A=kgt_… TOKEN_B=kgt_… \
PROJECT_A=acme-web PROJECT_B=acme-billing \
node scripts/isolation-test.mjs
```

---

## Operating

### Add a project (tenant)

```bash
node scripts/admin.mjs create-project <name>
```

Idempotent — re-running with an existing name is a no-op. New projects start
empty and invisible to every existing token until explicitly granted.

### Issue an employee token

```bash
node scripts/admin.mjs issue-token <project> <employee-label>
```

Prints the token **once**; only its SHA-256 is stored. The label is stamped onto
every observation that token writes, so `created_by` tells you who recorded
what. Send it over something private — it is a bearer credential.

### Grant a token a second project

```bash
node scripts/admin.mjs grant   <token-id> <project>
node scripts/admin.mjs ungrant <token-id> <project>
```

When a token holds more than one project, tools require an explicit `project`
argument rather than guessing.

### Revoke a token

```bash
node scripts/admin.mjs revoke-token <token-id>
node scripts/admin.mjs list-tokens
```

Revocation takes effect on the next request — there's no cached session. It's a
tombstone rather than a delete, so `created_by` on past observations stays
meaningful.

### Rotate the database password

Re-run `init-role`, then `supabase secrets set MCP_DB_URL=…` with the new value
and redeploy. Employee tokens are unaffected.

---

## Client configuration

### Claude Code — `.mcp.json`

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "type": "http",
      "url": "https://<PROJECT_REF>.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer ${KNOWLEDGE_GRAPH_TOKEN}"
      }
    }
  }
}
```

Then `export KNOWLEDGE_GRAPH_TOKEN=kgt_…` in your shell profile. Claude Code
expands `${…}` here, so this file is safe to commit; the token isn't in it.

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "url": "https://<PROJECT_REF>.supabase.co/functions/v1/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```

Cursor does not reliably expand environment variables in this file, so the token
goes in literally — **keep `.cursor/mcp.json` out of version control**. Both
files are in `.gitignore` here, with `.example` copies checked in.

---

## The convention agents should follow

Put this in your `CLAUDE.md` / Cursor rules. The server also returns it in the
MCP `initialize` response, so compliant clients pick it up automatically.

> **At the start of a task**, call `search_nodes` for the components you're
> about to touch — the service, module, or table names from the request. Read
> what the graph already knows before reading the code; it will tell you the
> constraints, gotchas and ownership that aren't obvious from the source.
>
> **At the end of a task**, record what changed and why:
> - `create_entities` for components that didn't exist in the graph yet
> - `add_observations` for facts you learned or decisions you made — one short,
>   self-contained fact per observation, because that's the unit that gets
>   searched. "Retries are capped at 3 because the upstream gateway times out at
>   30s" is useful; "updated the retry logic" is not.
> - `create_relations` for dependencies you discovered, in the active voice, so
>   the edge reads as a sentence: `AuthService depends_on TokenStore`.
> - `delete_observations` when you find a recorded fact that has become wrong.
>   Stale knowledge is worse than none.
>
> Record *why*, not *what*. The diff already says what changed; the graph is for
> the reasoning that isn't recoverable from the code.

### Seeding a repo that has no graph yet

A new tenant starts empty, and the convention above only accumulates knowledge
as people work. To give a repo a useful starting shape in one pass, see
[docs/ingest-codebase.md](docs/ingest-codebase.md) — a ready-to-paste prompt
that surveys the repo, picks a sensible granularity, and writes entities,
observations and relations in batches.

### Use `search_nodes`, not `read_graph`

`search_nodes` is the query path. It matches on entity names (exact, prefix and
fuzzy), on entity type, and on the full text of observations, and returns the
matched entities with their observations plus the relations touching them —
including edges out to neighbours, so one call gives you a usable neighbourhood
rather than isolated nodes.

`read_graph` dumps everything. It's for small graphs and explicit audits. It
caps at `limit` entities (250 by default) and, once the graph is bigger than
that, says so in the response and tells the agent to use `search_nodes`
instead — so the wrong habit degrades loudly rather than quietly burning
context.

### Tools

| Tool | Purpose |
|---|---|
| `search_nodes` | Targeted query. **Start here.** |
| `read_graph` | Full dump, truncated and capped. Audits only. |
| `create_entities` | Batch create/update nodes. Idempotent by name. |
| `create_relations` | Batch create edges. Both endpoints must exist. |
| `add_observations` | Batch attach facts to existing entities. |
| `delete_entities` | Remove nodes; cascades to observations and edges. |
| `delete_relations` | Remove specific edges. |
| `delete_observations` | Retract facts, by id or exact content. |
| `list_projects` | Projects this token can reach, with counts. |

Every tool takes an optional `project` (name or id), required only when the
token holds more than one.

---

## Verification

### Against the deployed endpoint

Both tenants were seeded through the live HTTPS endpoint with the two real
employee tokens, and every cross-tenant access was attempted. Results:

| Check | Result |
|---|---|
| `tools/list` returns all nine tools | pass |
| Request with no token | `401 Missing bearer token.` |
| Request with an invalid token | `401 Invalid or revoked token.` |
| Each token writes to its own project | pass |
| `devrashie` searches for the `isolation-test` entity | 0 entities |
| `test-employee` searches for the `brain` entity | 0 entities |
| Each token finds its *own* entity with the same query | pass (positive control) |
| Full-text search over observation bodies | pass, within tenant only |
| `read_graph` as `devrashie` | 2 entities, all `brain` |
| `read_graph` as `test-employee` | 1 entity, all `isolation-test` |
| `list_projects` per token | exactly one project each |
| `test-employee` naming `project: "brain"` to **read** | refused |
| `test-employee` naming `project: "brain"` to **write** | refused |
| `test-employee` naming `project: "brain"` to **delete** | refused |

The refusals come back as `Unknown or inaccessible project "brain". This token
can access: isolation-test` — the server does not confirm that a project it
cannot reach exists.

This sandbox's egress is firewalled off from `*.supabase.co`, so these requests
were driven from inside Postgres via `pg_net` rather than from a laptop. They
were still ordinary HTTPS requests to the public endpoint with a bearer token.
`pg_net` and its request log were dropped afterwards — that log records
`Authorization` headers, i.e. the raw tokens.

To re-run the same checks from your own machine at any time:

```bash
MCP_URL=https://litdbmyvvqrbpocohlpw.supabase.co/functions/v1/mcp \
TOKEN_A=<your token> TOKEN_B=<test-employee token> \
PROJECT_A=brain PROJECT_B=isolation-test \
node scripts/isolation-test.mjs
```

### Against the production database

Twelve database-level checks, run as `mcp_client` on the live database: live
tokens resolve to exactly their own project; unknown and revoked tokens resolve
to nothing; no raw token is stored; with no tenant context the role reads
nothing; pinned to one tenant, foreign rows are invisible, cross-project
`INSERT` and re-parenting `UPDATE` are refused with `insufficient_privilege`,
and `access_tokens` is unreadable. All passing.

Supabase's own security advisors report no warnings attributable to this
schema. Two `rls_enabled_no_policy` INFO notices remain on `access_tokens` and
`access_token_projects` — that is the intended deny-all design, not an
oversight.

### Locally, from scratch

`./scripts/local-test.sh` brings up a throwaway Postgres, applies the
migrations, and runs both suites. Results from the last run:

**`scripts/rls-test.sql` — 15 database-level checks, all passing.** Live tokens
resolve to exactly their own project; revoked and unknown tokens resolve to
nothing; raw tokens appear nowhere in storage; with no tenant context the role
reads nothing; with a tenant pinned, cross-project `SELECT` returns nothing,
cross-project `INSERT` and `UPDATE` are refused with `insufficient_privilege`,
cross-project `DELETE` affects zero rows, `mcp_client` cannot read
`access_tokens` or create projects — and in-tenant writes still work.

The suite is **negative-controlled**: with RLS disabled on one table it fails at
check 5, so a pass means the policies are doing the work.

**`scripts/isolation-test.mjs` — 21 checks over HTTP against a running server,
all passing.** Two projects, two tokens. Each token writes to its own project;
neither can see the other's entities via `search_nodes` or `read_graph`; each
`list_projects` shows only its own; naming the other project explicitly is
refused rather than silently honoured; a cross-project delete attempt leaves the
target intact.

Two notes on how those checks are written, because both nearly produced a false
result:

- `search_nodes` echoes the query back in its response. Asserting on the raw
  response text matches the test's *own input* and looks like a leak. The checks
  assert on the structured `entities` array.
- Search is fuzzy, so "the search returned nothing" is the wrong invariant — a
  token's own similarly-named entities are a legitimate match. The invariant is
  "no *foreign* entity came back", plus a positive control confirming the owning
  token *does* find the same entity, so the check can't pass on a server that
  returns nothing to anyone.

---

## Design notes

**No pgvector.** The access pattern is exact and near-exact lookup by name —
agents arrive knowing the identifier they care about. That's served by a unique
`(project_id, name)` index, a GIN trigram index for fuzzy matching, and a GIN
full-text index over observations. Semantic search would add an embedding
provider, per-write API latency and cost, to improve a case that isn't the
bottleneck. The schema doesn't preclude adding it later.

**The MCP transport is implemented directly rather than via the SDK's
`StreamableHTTPServerTransport`.** That class is written against Node's
`http.IncomingMessage`/`ServerResponse`; Edge Functions deal in Fetch `Request`
and `Response`, so wiring it up needs a `node:http` shim in the request path.
This server is stateless — every request carries its own bearer token and
nothing is kept between calls — which reduces Streamable HTTP to "POST JSON-RPC,
get JSON back". That's implemented in `index.ts` with no shim and no transport
dependency. **This is still the Edge Function**, not the standalone-Node
fallback; the wire protocol is unchanged and standard MCP clients can't tell the
difference. `GET` returns 405 (no server-initiated streams), `DELETE` is a
no-op, and both single and batched JSON-RPC payloads are handled.

**`observations` and `relations` carry a denormalized `project_id`** so RLS is a
column comparison instead of a subquery on every row. Composite foreign keys
against `entities (id, project_id)` make it impossible for that column to
disagree with the parent.

**`access_tokens.project_id` is the token's home project**, per the schema spec,
and `access_token_projects` carries additional grants; a trigger mirrors the
home project into the join table so multi-project scoping has one code path.
