# Connecting a repo to the knowledge graph

Paste the prompt below into a Claude Code session at the root of the repo you
want to connect. It writes the client config, the gitignore entries and the
`CLAUDE.md` convention, then checks the credential works.

You need a token for that repo's project first:

```bash
node scripts/admin.mjs create-project <project-name>
node scripts/admin.mjs issue-token <project-name> <your-label>
```

Prefer a token scoped to a **single** project — then agents never have to pass
a `project` argument.

> **The server won't be usable in the session that sets it up.** Claude Code
> loads MCP servers at startup, so the config only takes effect after a
> restart. The prompt verifies over `curl` instead, and the ingestion pass runs
> in a fresh session.

---

## The prompt

Replace `<ENDPOINT>` and `<PROJECT>` before pasting.

---

Set this repo up to use our team's shared knowledge graph, which is an MCP
server at `<ENDPOINT>`. Do not try to call its tools in this session — MCP
servers are only loaded at startup, so it won't be connected until Claude Code
restarts. Everything below is file edits plus one `curl` check.

**1.** Create `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "type": "http",
      "url": "<ENDPOINT>",
      "headers": {
        "Authorization": "Bearer ${KNOWLEDGE_GRAPH_TOKEN}"
      }
    }
  }
}
```

The token is read from the environment rather than written here, so this file
contains no secret — commit it. That is how teammates get connected: they pull
it and export their own token.

**2.** Make sure `.gitignore` covers files that *would* hold a literal token —
add them if missing, and don't disturb the rest of the file:

```
.cursor/mcp.json
.mcp.local.json
```

**3.** Create `.cursor/mcp.json.example` for teammates using Cursor. Cursor does
not reliably expand `${ENV_VARS}` in this file, so their token goes in
literally — which is why the real `.cursor/mcp.json` is gitignored above:

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "url": "<ENDPOINT>",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```

**4.** Add this section to `CLAUDE.md` (create the file if it doesn't exist;
otherwise append without reformatting what's already there):

```markdown
## Knowledge graph

This repo has a shared, persistent knowledge graph via the `knowledge-graph`
MCP server. It holds what isn't recoverable from reading the code: why things
are the way they are, constraints that will bite you, and who owns what.

- At the start of a task, `search_nodes` for the components you're about to
  touch. Read what the graph knows before reading the code.
- At the end, record what changed and why: `create_entities` for new
  components, `add_observations` for decisions and gotchas you hit,
  `create_relations` for dependencies you discovered (active voice, e.g.
  `ApiGateway depends_on AuthService`).
- Retract facts that have become wrong with `delete_observations`. Stale
  knowledge is worse than none.
- Record **why**, not **what** — the diff already says what changed.
- Use `search_nodes`, not `read_graph`. The full dump is for audits only.
```

**5.** Verify the credential works, without needing the MCP server connected:

```bash
curl -s -X POST '<ENDPOINT>' \
  -H "Authorization: Bearer $KNOWLEDGE_GRAPH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_projects","arguments":{}}}'
```

Expect a result naming project `<PROJECT>`. Interpret the outcome for me rather
than just printing it:

- `401` → the token is wrong, revoked, or `KNOWLEDGE_GRAPH_TOKEN` isn't
  exported in this shell. Check `echo ${KNOWLEDGE_GRAPH_TOKEN:+set}` first.
- A project list that doesn't include `<PROJECT>` → the token is scoped to a
  different tenant; I need a different one.
- More than one project listed → tools will require an explicit `project`
  argument on every call. Tell me, because I'd rather issue a
  single-project token.

**6.** Commit the config files and the `CLAUDE.md` change. Then tell me exactly
what to do next: which environment variable to export and where, that I need to
restart Claude Code, and that I'll be asked to approve the new MCP server on
first launch.

---

## After it finishes

1. Export the token where new shells will see it — `~/.zshrc`, `~/.bashrc`, or
   your secret manager:

   ```bash
   export KNOWLEDGE_GRAPH_TOKEN=kgt_…
   ```

2. Restart Claude Code and approve the `knowledge-graph` server when prompted.

3. Confirm with `/mcp` — it should list `knowledge-graph` with nine tools.

4. If the graph is empty, seed it with the pass in
   [ingest-codebase.md](ingest-codebase.md).
