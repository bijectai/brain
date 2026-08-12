#!/usr/bin/env node
/**
 * Multi-repo behaviour, over HTTP against a running server.
 *
 * The cases that matter are the ones that could corrupt data quietly: two
 * repos legitimately owning the same entity name, a bare name that now matches
 * in more than one place, and the backfill that stamps a pre-multi-repo graph.
 */

const {
  MCP_URL = "http://127.0.0.1:8000",
  TOKEN_A = "kgt_TESTA",
  PROJECT = "acme-web",
} = process.env;

let failures = 0;
const checks = [];
function check(name, passed, detail = "") {
  checks.push({ check: name, result: passed ? "PASS" : "FAIL", detail });
  if (!passed) failures++;
}

async function call(name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_A}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: { project: PROJECT, ...args } },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC: ${body.error.message}`);
  return {
    isError: body.result.isError === true,
    text: body.result.content?.[0]?.text ?? "",
    data: body.result.structuredContent ?? null,
  };
}

const API = "acmeco/acme-api";
const WEB = "acmeco/acme-web";

// --- repos are visible and agents cannot invent them ------------------------

{
  const repos = await call("list_repos");
  const names = (repos.data?.repos ?? []).map((r) => r.name);
  check("list_repos shows the registered repos",
    names.includes(API) && names.includes(WEB), names.join(", "));

  const bad = await call("create_entities", {
    entities: [{ name: "Ghost", entity_type: "service", repo: "acme-api" }],
  });
  check("an unregistered repo name is refused, not created", bad.isError,
    bad.text.slice(0, 100));
  check("the refusal lists the valid repo names", bad.text.includes(API));
}

// --- the collision this whole change exists to allow ------------------------

{
  await call("create_entities", {
    entities: [
      { name: "Config", entity_type: "module", repo: API, observations: ["API-side config."] },
      { name: "Config", entity_type: "module", repo: WEB, observations: ["Web-side config."] },
    ],
  });
  const found = await call("search_nodes", { query: "Config" });
  const hits = (found.data?.entities ?? []).filter((e) => e.name === "Config");
  check("the same name can exist in two repos", hits.length === 2,
    `${hits.length} found`);
  check("each carries its own repo",
    hits.some((h) => h.repo === API) && hits.some((h) => h.repo === WEB),
    hits.map((h) => h.repo).join(", "));
  check("their observations did not merge",
    hits.every((h) => h.observations.length === 1),
    hits.map((h) => h.observations.length).join(","));
}

// --- an ambiguous bare name must error, never guess -------------------------

{
  const amb = await call("add_observations", {
    observations: [{ entity: "Config", contents: ["Which one?"] }],
  });
  check("a bare ambiguous name is refused", amb.isError, amb.text.slice(0, 110));
  check("the error names both candidates",
    amb.text.includes(API) && amb.text.includes(WEB));

  const ok = await call("add_observations", {
    observations: [{ entity: "Config", repo: API, contents: ["Disambiguated."] }],
  });
  check("qualifying by repo resolves it", !ok.isError && ok.data?.observations_added === 1);

  const check2 = await call("search_nodes", { query: "Config", repo: WEB });
  const web = (check2.data?.entities ?? []).find((e) => e.name === "Config");
  check("the observation landed on the right one",
    web?.observations.every((o) => o.content !== "Disambiguated."),
    JSON.stringify(web?.observations.map((o) => o.content)));
}

// --- cross-repo relations, the point of the exercise ------------------------

{
  await call("create_entities", {
    entities: [
      { name: "SessionClient", entity_type: "module", repo: WEB },
      { name: "AuthService", entity_type: "service", repo: API },
    ],
  });
  const made = await call("create_relations", {
    relations: [{
      from: "SessionClient", from_repo: WEB,
      to: "AuthService", to_repo: API,
      relation_type: "calls",
    }],
  });
  check("a relation can cross repos", !made.isError && made.data?.created === 1,
    made.text.slice(0, 100));

  const found = await call("search_nodes", { query: "SessionClient" });
  const edge = (found.data?.relations ?? []).find((r) => r.relation_type === "calls");
  check("the edge reports both repos",
    edge?.from_repo === WEB && edge?.to_repo === API,
    JSON.stringify(edge));
}

// --- project-wide entities ---------------------------------------------------

{
  await call("create_entities", {
    entities: [{
      name: "TrunkBasedDevelopment", entity_type: "convention",
      observations: ["No long-lived branches; feature-flag instead."],
    }],
  });
  const all = await call("search_nodes", { query: "TrunkBasedDevelopment" });
  const conv = (all.data?.entities ?? [])[0];
  check("omitting repo stores an entity project-wide", conv?.repo === null,
    String(conv?.repo));

  // A convention applies everywhere, so filtering to one repo must still surface it.
  const scoped = await call("search_nodes", { query: "TrunkBasedDevelopment", repo: WEB });
  check("project-wide entities surface when filtering by repo",
    (scoped.data?.entities ?? []).some((e) => e.name === "TrunkBasedDevelopment"));

  const scopedOut = await call("search_nodes", { query: "SessionClient", repo: API });
  check("filtering by repo excludes another repo's entities",
    !(scopedOut.data?.entities ?? []).some((e) => e.name === "SessionClient"),
    JSON.stringify((scopedOut.data?.entities ?? []).map((e) => e.name)));
}

// --- deletes stay idempotent and repo-aware ---------------------------------

{
  const gone = await call("delete_entities", {
    entities: [{ name: "NeverExisted" }],
  });
  check("deleting something absent is not an error", !gone.isError,
    gone.text.slice(0, 80));
  check("it is reported as not_found",
    (gone.data?.not_found ?? []).includes("NeverExisted"));

  const ambDel = await call("delete_entities", { entities: [{ name: "Config" }] });
  check("an ambiguous delete is refused", ambDel.isError, ambDel.text.slice(0, 90));

  const stillThere = await call("search_nodes", { query: "Config" });
  check("neither Config was deleted by the refused call",
    (stillThere.data?.entities ?? []).filter((e) => e.name === "Config").length === 2);

  const oneDel = await call("delete_entities", {
    entities: [{ name: "Config", repo: WEB }],
  });
  check("a qualified delete removes exactly one", !oneDel.isError &&
    (oneDel.data?.deleted ?? []).length === 1, JSON.stringify(oneDel.data));

  const after = await call("search_nodes", { query: "Config" });
  const left = (after.data?.entities ?? []).filter((e) => e.name === "Config");
  check("the other repo's Config survived",
    left.length === 1 && left[0].repo === API, JSON.stringify(left.map((e) => e.repo)));
}

// --- cleanup ----------------------------------------------------------------

await call("delete_entities", {
  entities: [
    { name: "Config", repo: API },
    { name: "SessionClient", repo: WEB },
    { name: "AuthService", repo: API },
    { name: "TrunkBasedDevelopment" },
  ],
});

console.table(checks);
if (failures > 0) {
  console.error(`\n${failures} repo check(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} multi-repo checks passed.`);
