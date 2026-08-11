# Seeding the graph from an existing codebase

A one-off pass to give a repo's knowledge graph a useful starting shape. After
this, normal sessions keep it current by following the convention in the README.

Run it in a session dedicated to the repo you're indexing, with nothing else in
flight — it will read a lot and write a lot.

## Before you start

- The MCP server must be connected in that repo (`.mcp.json`, see README).
- Use a token scoped to **one** project, so no `project` argument is needed.
- If the graph already has content, this prompt updates rather than duplicates:
  entity names are unique per project and `create_entities` upserts.

## The prompt

Paste this as the first message of the session.

---

You have an MCP server called `knowledge-graph` that stores durable, shared
knowledge about this codebase. It is empty (or nearly so) and I want you to
seed it. Other engineers' agents will read what you write, so accuracy matters
more than volume.

**Phase 1 — survey before writing.** Map the repo before recording anything:
top-level layout, build and dependency manifests, entry points, deployment and
CI config, README and any docs/ADRs. Identify the real subsystems. Do not start
writing to the graph during this phase.

**Phase 2 — pick the granularity.** Aim for roughly 30–150 entities for a
typical repo. The unit is a *thing someone would ask about* — a service, a
module, a significant table, an external integration, a convention — not one
entity per file. If you find yourself creating an entity for every file, you
are too granular; if the whole backend is one entity, too coarse. Tell me the
list you plan to create and roughly how many, then continue without waiting.

Useful `entity_type` values: `service`, `module`, `package`, `table`,
`endpoint`, `job`, `integration`, `config`, `convention`, `decision`, `gotcha`.

**Phase 3 — write entities.** Use `create_entities` in batches of 10–30, with
`observations` attached inline. Rules for observations:

- One discrete fact per observation. Short and self-contained — that is the
  unit that gets searched.
- Record **why**, not **what**. The code already says what it does; the graph
  is for the reasoning that isn't recoverable from reading it. "Retries capped
  at 3 because the upstream gateway times out at 30s" is worth storing.
  "Has a retry helper" is not.
- Prioritise: non-obvious invariants, constraints that will bite someone,
  historical decisions and their rationale, things that look wrong but are
  deliberate, ownership, and anything you had to read three files to work out.
- If you are inferring rather than reading it somewhere, say so in the text
  ("appears to…"). Do not state guesses as fact.
- Skip anything trivially visible from the file you'd open anyway.

**Phase 4 — write relations.** Only after the entities exist, since both
endpoints must. Use `create_relations` in batches, active voice, snake_case, so
each edge reads as a sentence: `ApiGateway depends_on AuthService`. Prefer a
small vocabulary — `depends_on`, `calls`, `owns`, `implements`, `reads_from`,
`writes_to`, `tested_by`, `documented_in`, `deployed_by` — and reuse it rather
than inventing a new verb per edge.

**Phase 5 — verify.** Call `search_nodes` for five or six of the most important
things you recorded and check that what comes back would actually orient
someone new. Then report: how many entities, observations and relations you
created, the entity types you used, which areas you deliberately left thin, and
anything you were unsure about.

Do not use `read_graph` at any point — it is for audits, and `search_nodes` is
the query path.

---

## After it finishes

Spot-check a few nodes yourself. The failure mode to look for is **confident
restatement of the obvious** — a graph full of "handles authentication" is
worse than a small one with ten real gotchas in it, because it costs context on
every future lookup and teaches agents the graph isn't worth reading.

If a pass came out too shallow, `delete_entities` the weak nodes and re-run
that section with sharper instructions rather than layering more on top.

## Keeping it current

Add this to the repo's `CLAUDE.md` so every future session maintains it:

```markdown
## Knowledge graph

This repo has a shared knowledge graph via the `knowledge-graph` MCP server.

- At the start of a task, `search_nodes` for the components you're about to
  touch. Read what the graph knows before reading the code.
- At the end, record what changed and why: `create_entities` for new
  components, `add_observations` for decisions and gotchas you hit,
  `create_relations` for dependencies you discovered.
- Retract facts that have become wrong with `delete_observations`. Stale
  knowledge is worse than none.
- Record why, not what. Use `search_nodes`, not `read_graph`.
```
