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

**1.** Register the server in Claude Code's own user-scoped config, with the
token written literally:

```bash
claude mcp add --transport http knowledge-graph <ENDPOINT> \
  --header "Authorization: Bearer <YOUR_TOKEN>"
```

(If `--header` isn't in this version, check `claude mcp add --help`.)

Do **not** put a `${KNOWLEDGE_GRAPH_TOKEN}` placeholder in a repo `.mcp.json`
and expect it to expand. See [Why not `${VAR}`](#why-not-var) below — it
depends on how the app was launched and fails with an opaque 401.

**2.** Create `.mcp.json.example` at the repo root, so teammates can see what
they need without a token being committed:

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "type": "http",
      "url": "<ENDPOINT>",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```

Then make sure `.gitignore` covers every file that would hold a real token —
add them if missing, without disturbing the rest of the file:

```
.mcp.json
.mcp.local.json
.cursor/mcp.json
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
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_projects","arguments":{}}}'
```

Expect a result naming project `<PROJECT>`. Interpret the outcome for me rather
than just printing it:

- `401` → the token is wrong or revoked; I need a new one.
- A project list that doesn't include `<PROJECT>` → the token is scoped to a
  different tenant; I need a different one.
- More than one project listed → tools will require an explicit `project`
  argument on every call. Tell me, because I'd rather issue a
  single-project token.

**6.** Commit `.mcp.json.example`, the `.gitignore` change and the `CLAUDE.md`
change. Do not commit any file containing the literal token. Then tell me that
I need to restart Claude Code and approve the new MCP server on first launch.

---

## After it finishes

1. Restart Claude Code and approve the `knowledge-graph` server when prompted.

2. Confirm with `/mcp` — it should list `knowledge-graph` with nine tools.

3. If the graph is empty, seed it with the pass in
   [ingest-codebase.md](ingest-codebase.md).

## Why not `${VAR}`

A repo `.mcp.json` holding `"Authorization": "Bearer ${KNOWLEDGE_GRAPH_TOKEN}"`
is appealing — no secret in the file, so it can be committed and shared. It was
this guide's original recommendation and it was wrong often enough to abandon.

Expansion resolves against the environment **Claude Code was launched in**. On
macOS, launching from Spotlight, the Dock or an IDE does not source `~/.zshrc`,
so a variable that is plainly set in your terminal is invisible to the app.
Whether `${VAR}` is expanded inside `headers` at all also varies by version.

The failure is unhelpful: the app reports

```
Server rejected the configured Authorization header (HTTP 401).
```

which reads like a bad token, so you go and check the token — which is fine.
The tell is that `curl` with the same variable succeeds from your shell while
the app still 401s: that means the credential is good and the app never got it.

A literal token in user scope has none of these failure modes. The cost is that
each person runs one `claude mcp add` instead of inheriting a committed file,
which is a fair trade for an error that otherwise burns half an hour.

## Troubleshooting a 401

Find out which layer refused, and whether your shell has the token at all:

```bash
echo "${KNOWLEDGE_GRAPH_TOKEN:+set}"      # "set", or empty if unset

curl -i -s -X POST '<ENDPOINT>' \
  -H "Authorization: Bearer $KNOWLEDGE_GRAPH_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tail -3
```

| What you see | What it means |
|---|---|
| `curl` returns the tool list, app still 401s | Credential is good; the app never received it. Use a literal token in user scope. |
| `"Invalid or revoked token."` | The token string is wrong, or it was revoked. Issue a new one. |
| `"Missing bearer token."` | The header arrived empty — the variable is unset in that shell. |
| Anything mentioning `JWT` | Supabase's gateway rejected it before the function; `verify_jwt` got turned back on. Redeploy with `--no-verify-jwt`. |
