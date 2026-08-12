# Web GUI

A browser GUI for browsing and editing the knowledge graph by hand — the
same graph AI agents read and write over MCP, now with a shared URL any
biject member can open, paste their token into, and use without installing
anything.

```
Browser  ──HTTPS──►  web-api Edge Function  ──as mcp_client──►  Postgres
kgt_… in                same auth + tool handlers                RLS pins
localStorage             as the MCP server                       every row
```

It's two pieces:

- **`supabase/functions/web-api/`** — a small Edge Function that exposes the
  same 10 tools the MCP server uses (`search_nodes`, `create_entities`, …)
  over plain `POST /tools/:name` + CORS, so a browser can call them directly.
  It reuses `mcp/auth.ts` and `mcp/tools.ts` unchanged — same tokens, same
  per-project RLS scoping, same validation.
- **`web/`** — a static React SPA (Vite) that calls `web-api` and renders an
  interactive force-directed graph, with a side panel for viewing and
  editing an entity's observations and relations.

Hosted online rather than run locally by each person: the data already lives
in one shared Postgres instance, so a "local" copy of the GUI would just be a
dev server on someone's laptop pointed at the same remote database — more
setup, no benefit. A deployed static site gives everyone one link.

---

## Deploying

### 1. Deploy `web-api`

Same steps as deploying `mcp` (see the root [README](../README.md#deploying)) —
it shares the project's database role and secrets, nothing new to configure:

```bash
supabase functions deploy web-api --no-verify-jwt
```

`--no-verify-jwt` is required for the same reason as `mcp`: this endpoint
authenticates with our own `kgt_…` tokens, and Supabase's gateway JWT check
would reject those before the function runs.

Your endpoint is then:

```
https://<REF>.supabase.co/functions/v1/web-api
```

Sanity-check it:

```bash
curl -s -X POST 'https://<REF>.supabase.co/functions/v1/web-api/tools/list_projects' \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H 'content-type: application/json' -d '{}'
```

### 2. Deploy `web/` to Vercel

1. In Vercel, "Add New Project" → import this repo.
2. Set **Root Directory** to `web`.
3. Framework preset: Vite (build command `npm run build`, output `dist`,
   auto-detected).
4. Add an environment variable `VITE_WEB_API_URL` pointing at the `web-api`
   URL from step 1 (see `web/.env.example`).
5. Deploy. Every push to the connected branch redeploys automatically.

No server, no database credentials touch the frontend at all — it only ever
holds the *user's own* personal token, in their browser.

---

## Using it

Send members the deployed URL plus their own token (same one used for
`claude mcp add` — see [onboard-teammate.md](onboard-teammate.md)). On first
visit they paste the token in; it's stored in `localStorage` and sent as
`Authorization: Bearer …` on every request, same as any MCP client.

From there:

- Pick a project and, optionally, a repo.
- Search, or clear the search box to see the whole graph (capped the same
  way `read_graph` is).
- Click a node to see its observations and relations, add or remove an
  observation, or delete the entity.
- **+ Entity** / **+ Relation** create new nodes and edges.

Everything writes through the same tool handlers the MCP server uses, so
anything typed here is immediately visible to Claude Code / Cursor sessions
using the graph, and vice versa.

## Running it locally (development only)

```bash
cd web
npm install
cp .env.example .env   # points at the already-deployed web-api by default
npm run dev
```

This is for developing the GUI itself, not day-to-day use — it still talks
to the same shared, deployed backend, it just runs the frontend on your
machine instead of Vercel's.
