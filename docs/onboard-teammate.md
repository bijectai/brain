# Onboarding a teammate

## What you do

Issue them their own token — never share yours. Per-person tokens are what make
`created_by` on observations meaningful, and let you revoke one person without
disturbing anyone else.

```bash
export ADMIN_DB_URL='postgresql://postgres:…@db.<REF>.supabase.co:5432/postgres'
node scripts/admin.mjs issue-token <project> <their-name>
```

It prints the token once — only the SHA-256 is stored, so it cannot be
recovered later, only reissued. Send it over something private.

If they ever leave or the token leaks:

```bash
node scripts/admin.mjs list-tokens
node scripts/admin.mjs revoke-token <token-id>
```

Revocation takes effect on their next request; there is no cached session.

## What you send them

Everything below the line, with `<ENDPOINT>`, `<PROJECT>` and `<THEIR_TOKEN>`
filled in.

---

**Connecting to our shared knowledge graph**

We keep a shared knowledge graph about the codebase that Claude Code and Cursor
read and write over the network. It stores the things that aren't recoverable
from reading the code — why something is built the way it is, constraints that
will bite you, who owns what. Everyone on the team sees the same graph.

**Claude Code — one command:**

```bash
claude mcp add --scope user --transport http knowledge-graph \
  <ENDPOINT> \
  --header "Authorization: Bearer <THEIR_TOKEN>"
```

Restart Claude Code, approve `knowledge-graph` when prompted, then run `/mcp` —
you should see it listed with nine tools. That's it.

**Cursor** — create `.cursor/mcp.json` in the repo (or `~/.cursor/mcp.json` for
all repos):

```json
{
  "mcpServers": {
    "knowledge-graph": {
      "url": "<ENDPOINT>",
      "headers": { "Authorization": "Bearer <THEIR_TOKEN>" }
    }
  }
}
```

Add `.cursor/mcp.json` to your `.gitignore` — that file has your token in it.

**Your token is yours.** Don't commit it and don't paste it in a shared
channel. It's scoped to the `<PROJECT>` project only; it can't see anything
else. If it leaks, say so and we'll revoke it — that takes one command and
breaks nothing else.

**How to use it.** Mostly you don't have to think about it — the repo's
`CLAUDE.md` tells the agent what to do. The convention is:

- **Start of a task:** the agent calls `search_nodes` for whatever you're about
  to touch, and reads what the graph already knows before reading the code.
- **End of a task:** it records what changed and *why* — decisions, gotchas,
  dependencies it discovered.

Two things worth knowing if you nudge it manually:

- Ask for `search_nodes`, not `read_graph`. `read_graph` dumps everything and
  is for audits.
- Record **why**, not **what**. "Retries capped at 3 because the upstream
  gateway times out at 30s" is worth storing. "Updated the retry logic" isn't —
  the diff already says that.

**If it doesn't connect** and you get a 401, check the token reached the server:

```bash
curl -s -X POST '<ENDPOINT>' \
  -H "Authorization: Bearer <THEIR_TOKEN>" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_projects","arguments":{}}}'
```

If that returns `<PROJECT>` but Claude Code still fails, the app didn't get the
token — make sure you used the command above with the token written literally,
and that no `.mcp.json` in the repo is shadowing it with a different config.
If the curl itself 401s, the token is wrong or revoked — ping me for a new one.

---

## Why the token goes in literally

Not via a `${KNOWLEDGE_GRAPH_TOKEN}` placeholder in a committed `.mcp.json`,
which is the tidier-looking option. Expansion resolves against the environment
Claude Code was *launched* in, so on macOS a token plainly set in the user's
terminal is invisible to an app started from Spotlight or the Dock, and it
fails as an opaque 401 that looks like a bad credential. See
[repo-setup.md](repo-setup.md#why-not-var).
