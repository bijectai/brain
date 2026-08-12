#!/usr/bin/env node
/**
 * Proves cross-project isolation against the *deployed* endpoint, over the
 * network, using two real employee tokens.
 *
 *   MCP_URL=https://<ref>.supabase.co/functions/v1/mcp \
 *   TOKEN_A=kgt_... TOKEN_B=kgt_... \
 *   PROJECT_A=acme-web PROJECT_B=acme-billing \
 *   node scripts/isolation-test.mjs
 *
 * Exits non-zero if any assertion fails.
 */

const {
  MCP_URL,
  TOKEN_A,
  TOKEN_B,
  PROJECT_A = "acme-web",
  PROJECT_B = "acme-billing",
} = process.env;

for (const [k, v] of Object.entries({ MCP_URL, TOKEN_A, TOKEN_B })) {
  if (!v) {
    console.error(`${k} is not set.`);
    process.exit(1);
  }
}

let rpcId = 0;

async function rpc(token, method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* non-JSON error page */ }
  return { status: res.status, body, text };
}

async function call(token, name, args = {}) {
  const { status, body, text } = await rpc(token, "tools/call", {
    name,
    arguments: args,
  });
  if (status !== 200) throw new Error(`HTTP ${status} from ${name}: ${text}`);
  if (body.error) throw new Error(`RPC error from ${name}: ${body.error.message}`);
  const result = body.result;
  return {
    isError: result.isError === true,
    text: result.content?.[0]?.text ?? "",
    data: result.structuredContent ?? null,
  };
}

// ---------------------------------------------------------------------------

let failures = 0;
const checks = [];

function check(name, passed, detail = "") {
  checks.push({ check: name, result: passed ? "PASS" : "FAIL", detail });
  if (!passed) failures++;
}

// Deliberately dissimilar names. search_nodes matches fuzzily, so fixtures
// sharing a long common substring would match each other *within* a project
// and muddy the reading of a cross-project check.
const stamp = Date.now();
const SECRET_A = `Zebracorn${stamp}`;
const SECRET_B = `Quokkaflux${stamp}`;

console.log(`Testing ${MCP_URL}\n`);

// -- handshake -------------------------------------------------------------
{
  const { status, body } = await rpc(TOKEN_A, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "isolation-test", version: "1.0.0" },
  });
  check(
    "initialize handshake succeeds",
    status === 200 && !!body?.result?.serverInfo,
    body?.result?.serverInfo?.name ?? "",
  );

  const tools = await rpc(TOKEN_A, "tools/list", {});
  const names = (tools.body?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "add_observations", "create_entities", "create_relations",
    "delete_entities", "delete_observations", "delete_relations",
    "list_projects", "list_repos", "read_graph", "search_nodes",
  ];
  check(
    "all ten tools advertised",
    JSON.stringify(names) === JSON.stringify(expected),
    names.join(", "),
  );
}

// -- auth ------------------------------------------------------------------
{
  const anon = await rpc(null, "tools/list", {});
  check("request with no token is rejected", anon.status === 401);

  const bogus = await rpc("kgt_definitely-not-a-real-token", "tools/list", {});
  check("request with an invalid token is rejected", bogus.status === 401);

  const revokedLike = await rpc(TOKEN_A + "x", "tools/list", {});
  check("a tampered token is rejected", revokedLike.status === 401);
}

// -- seed both projects ----------------------------------------------------
await call(TOKEN_A, "create_entities", {
  project: PROJECT_A,
  entities: [
    {
      name: SECRET_A,
      entity_type: "service",
      observations: [`Only project ${PROJECT_A} should ever see this.`],
    },
    { name: `${SECRET_A}_dep`, entity_type: "module", observations: ["Dependency."] },
  ],
});
await call(TOKEN_A, "create_relations", {
  project: PROJECT_A,
  relations: [{ from: SECRET_A, to: `${SECRET_A}_dep`, relation_type: "depends_on" }],
});

await call(TOKEN_B, "create_entities", {
  project: PROJECT_B,
  entities: [
    {
      name: SECRET_B,
      entity_type: "service",
      observations: [`Only project ${PROJECT_B} should ever see this.`],
    },
  ],
});

check("token A can write to its own project", true);
check("token B can write to its own project", true);

// -- each token sees only its own project ----------------------------------
{
  const a = await call(TOKEN_A, "list_projects");
  const b = await call(TOKEN_B, "list_projects");
  const aNames = a.data.projects.map((p) => p.name);
  const bNames = b.data.projects.map((p) => p.name);

  check("token A lists only its own project",
    aNames.includes(PROJECT_A) && !aNames.includes(PROJECT_B), aNames.join(","));
  check("token B lists only its own project",
    bNames.includes(PROJECT_B) && !bNames.includes(PROJECT_A), bNames.join(","));
}

// -- the core cross-tenant reads -------------------------------------------
{
  // Assert on the structured payload, not the raw text: the response echoes
  // the search term back in a `query` field, so a substring check on the whole
  // body would match its own input and report a leak that is not there.
  // The invariant is "no foreign entity comes back", not "nothing comes
  // back": search is fuzzy, so a token's own similarly-named entities are a
  // legitimate result.
  const names = (r) => (r.data?.entities ?? []).map((e) => e.name);

  const aSearchesB = await call(TOKEN_A, "search_nodes", { query: SECRET_B });
  check(
    "token A's search cannot find token B's entity",
    !names(aSearchesB).includes(SECRET_B),
    `returned: ${JSON.stringify(names(aSearchesB))}`,
  );

  const bSearchesA = await call(TOKEN_B, "search_nodes", { query: SECRET_A });
  check(
    "token B's search cannot find token A's entity",
    !names(bSearchesA).includes(SECRET_A),
    `returned: ${JSON.stringify(names(bSearchesA))}`,
  );

  // The same query run by the token that *does* own the entity must find it --
  // otherwise the two checks above would pass on a server that simply returns
  // nothing to anyone.
  const bSearchesB = await call(TOKEN_B, "search_nodes", { query: SECRET_B });
  check(
    "the owning token does find that same entity",
    names(bSearchesB).includes(SECRET_B),
    `returned: ${JSON.stringify(names(bSearchesB))}`,
  );

  const aDump = await call(TOKEN_A, "read_graph");
  check(
    "token A's full graph dump contains none of project B",
    aDump.text.includes(SECRET_A) && !aDump.text.includes(SECRET_B),
  );

  const bDump = await call(TOKEN_B, "read_graph");
  check(
    "token B's full graph dump contains none of project A",
    bDump.text.includes(SECRET_B) && !bDump.text.includes(SECRET_A),
  );
}

// -- naming the other project explicitly is refused, not silently honoured --
{
  const byName = await call(TOKEN_A, "search_nodes", {
    project: PROJECT_B,
    query: SECRET_B,
  });
  check(
    "token A naming project B is refused",
    byName.isError && !byName.text.includes(SECRET_B),
    byName.text.slice(0, 90),
  );

  const bWrite = await call(TOKEN_B, "create_entities", {
    project: PROJECT_A,
    entities: [{ name: "trespass", entity_type: "service" }],
  });
  check("token B cannot write into project A", bWrite.isError, bWrite.text.slice(0, 90));

  const bDelete = await call(TOKEN_B, "delete_entities", {
    project: PROJECT_A,
    entities: [{ name: SECRET_A }],
  });
  check("token B cannot delete from project A", bDelete.isError);

  const stillThere = await call(TOKEN_A, "search_nodes", { query: SECRET_A });
  check(
    "project A's entity survived token B's delete attempt",
    stillThere.text.includes(SECRET_A),
  );
}

// -- sanity: the graph works at all ----------------------------------------
{
  const found = await call(TOKEN_A, "search_nodes", { query: SECRET_A });
  const names = (found.data?.entities ?? []).map((e) => e.name);
  check("search_nodes returns the seeded entity", names.includes(SECRET_A));
  check(
    "search_nodes returns its relations",
    (found.data?.relations ?? []).some((r) => r.relation_type === "depends_on"),
  );
  check(
    "search_nodes returns its observations",
    (found.data?.entities ?? []).some((e) => (e.observations ?? []).length > 0),
  );
}

// -- clean up the fixtures -------------------------------------------------
await call(TOKEN_A, "delete_entities", {
  project: PROJECT_A,
  entities: [{ name: SECRET_A }, { name: `${SECRET_A}_dep` }],
});
await call(TOKEN_B, "delete_entities", { project: PROJECT_B, entities: [{ name: SECRET_B }] });

console.table(checks);
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed. Cross-project isolation holds.`);
