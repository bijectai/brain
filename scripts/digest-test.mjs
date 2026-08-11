#!/usr/bin/env node
/**
 * End-to-end test for the Discord digest, against a local stack.
 *
 * Stands up a fake Discord webhook receiver, registers it for two projects,
 * writes graph activity through the MCP endpoint, triggers kg-digest and
 * asserts on the captured payloads -- including that Discord's embed limits
 * are respected and that one project's activity never appears in another's
 * digest.
 *
 * Driven by scripts/local-test.sh; see there for the surrounding setup.
 */

import http from "node:http";
import pg from "pg";

const {
  MCP_URL = "http://127.0.0.1:8000",
  DIGEST_URL = "http://127.0.0.1:8001",
  ADMIN_DB_URL,
  TOKEN_A = "kgt_TESTA",
  TOKEN_B = "kgt_TESTB",
  DIGEST_SECRET = "digest-test-secret",
  HOOK_PORT = "8770",
} = process.env;

const db = new pg.Client({ connectionString: ADMIN_DB_URL });
await db.connect();

// --- fake Discord ----------------------------------------------------------

const received = [];
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ path: req.url, json: JSON.parse(body) });
    res.writeHead(204).end();
  });
});
await new Promise((r) => hook.listen(Number(HOOK_PORT), "127.0.0.1", r));

const hookUrl = (name) => `http://127.0.0.1:${HOOK_PORT}/${name}`;

let failures = 0;
const checks = [];
function check(name, passed, detail = "") {
  checks.push({ check: name, result: passed ? "PASS" : "FAIL", detail });
  if (!passed) failures++;
}

async function call(token, name, args = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function trigger(secret = DIGEST_SECRET) {
  const res = await fetch(DIGEST_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// --- setup -----------------------------------------------------------------

await db.query(`select app.set_system_secret('digest', $1)`, [DIGEST_SECRET]);
await db.query(`delete from public.discord_webhooks`);

// The schema constrains webhook_url to real Discord hosts, which is worth
// asserting before we get out of its way.
{
  let rejected = false;
  try {
    await db.query(
      `insert into public.discord_webhooks (project_id, webhook_url)
       select id, 'https://hooks.slack.com/services/nope' from public.projects limit 1`,
    );
  } catch {
    rejected = true;
  }
  check("a non-Discord webhook URL is rejected by the schema", rejected);
  await db.query(`delete from public.discord_webhooks`);
}

// The delivery tests need a local receiver, which that constraint forbids, so
// it comes off for the duration and goes back on at the end.
await db.query(
  `alter table public.discord_webhooks drop constraint discord_webhooks_url_is_discord`,
);
await db.query(
  `insert into public.discord_webhooks (project_id, webhook_url, channel_label, last_digest_at)
   select id, $2, 'fake-a', now() from public.projects where name = $1`,
  ["acme-web", hookUrl("a")],
);
await db.query(
  `insert into public.discord_webhooks (project_id, webhook_url, channel_label, last_digest_at)
   select id, $2, 'fake-b', now() from public.projects where name = $1`,
  ["acme-billing", hookUrl("b")],
);

// --- auth on the trigger endpoint -----------------------------------------

check("digest rejects a missing secret", (await trigger("")).status === 401);
check("digest rejects a wrong secret", (await trigger("nope")).status === 401);

// --- quiet period should not post -----------------------------------------

{
  received.length = 0;
  const { status } = await trigger();
  check("digest runs with no activity", status === 200);
  check("no post when nothing changed", received.length === 0,
    `${received.length} posts`);
}

// --- activity in both projects --------------------------------------------

await call(TOKEN_A, "create_entities", {
  project: "acme-web",
  entities: [
    { name: "AuthService", entity_type: "service", observations: ["Issues JWTs for the web app."] },
    { name: "TokenStore", entity_type: "table", observations: ["Rows expire after 30 days."] },
  ],
});
await call(TOKEN_A, "create_relations", {
  project: "acme-web",
  relations: [{ from: "AuthService", to: "TokenStore", relation_type: "depends_on" }],
});
await call(TOKEN_B, "create_entities", {
  project: "acme-billing",
  entities: [{ name: "Invoicer", entity_type: "service", observations: ["BILLING_ONLY_SECRET"] }],
});

// A very long observation, to exercise the Discord field-length clamping.
await call(TOKEN_A, "add_observations", {
  project: "acme-web",
  observations: [{ entity: "AuthService", contents: ["x".repeat(3000)] }],
});

{
  received.length = 0;
  const { status, body } = await trigger();
  check("digest run succeeds", status === 200, JSON.stringify(body?.results ?? []));
  check("one post per project with activity", received.length === 2,
    `${received.length} posts`);

  const a = received.find((r) => r.path === "/a");
  const b = received.find((r) => r.path === "/b");
  check("project A got a post", !!a);
  check("project B got a post", !!b);

  const aText = JSON.stringify(a?.json ?? {});
  const bText = JSON.stringify(b?.json ?? {});

  check("A's digest names project A", (a?.json.embeds?.[0]?.title ?? "").includes("acme-web"));
  check("A's digest lists its entities", aText.includes("AuthService") && aText.includes("TokenStore"));
  check("A's digest lists its relation", aText.includes("depends_on"));
  check("A's digest credits the author", aText.includes("local-owner"));

  // The isolation guarantee has to hold here too: the digest reads through
  // withTenant, so one channel must never receive another project's content.
  check("A's digest contains nothing from project B", !aText.includes("BILLING_ONLY_SECRET"));
  check("B's digest contains nothing from project A", !bText.includes("AuthService"));

  // Discord rejects the whole payload if any limit is exceeded.
  const embed = a?.json.embeds?.[0] ?? {};
  const fields = embed.fields ?? [];
  check("embed title within 256", (embed.title ?? "").length <= 256, `${(embed.title ?? "").length}`);
  check("embed description within 4096", (embed.description ?? "").length <= 4096);
  check("all field values within 1024",
    fields.every((f) => f.value.length <= 1024),
    `max ${Math.max(0, ...fields.map((f) => f.value.length))}`);
  check("at most 25 fields", fields.length <= 25);
  check("total embed within 6000",
    JSON.stringify(embed).length <= 6000, `${JSON.stringify(embed).length}`);
  check("the 3000-char observation was truncated", !aText.includes("x".repeat(200)));
}

// --- watermark: the same activity must not be reported twice ---------------

{
  received.length = 0;
  await trigger();
  check("second run reports nothing (watermark advanced)", received.length === 0,
    `${received.length} posts`);
}

// --- a failing webhook must not advance the watermark ----------------------

{
  await db.query(
    `update public.discord_webhooks set webhook_url = $1
     where project_id = (select id from public.projects where name = 'acme-web')`,
    [`http://127.0.0.1:${HOOK_PORT}/../nope`],
  );
  const before = await db.query(
    `select last_digest_at, failure_count from public.discord_webhooks w
     join public.projects p on p.id = w.project_id where p.name = 'acme-web'`,
  );
  await call(TOKEN_A, "add_observations", {
    project: "acme-web",
    observations: [{ entity: "AuthService", contents: ["Written while the webhook was broken."] }],
  });

  // Point at a port with nothing on it so the POST genuinely fails.
  await db.query(
    `update public.discord_webhooks set webhook_url = 'http://127.0.0.1:1/dead'
     where project_id = (select id from public.projects where name = 'acme-web')`,
  );
  await trigger();
  const after = await db.query(
    `select last_digest_at, failure_count from public.discord_webhooks w
     join public.projects p on p.id = w.project_id where p.name = 'acme-web'`,
  );
  check("failed delivery does not advance the watermark",
    after.rows[0].last_digest_at.getTime() === before.rows[0].last_digest_at.getTime());
  check("failed delivery increments failure_count",
    after.rows[0].failure_count > before.rows[0].failure_count,
    `${before.rows[0].failure_count} -> ${after.rows[0].failure_count}`);

  // Recovery: point back at the fake receiver, the missed activity arrives.
  received.length = 0;
  await db.query(
    `update public.discord_webhooks set webhook_url = $1
     where project_id = (select id from public.projects where name = 'acme-web')`,
    [hookUrl("a")],
  );
  await trigger();
  const recovered = JSON.stringify(received.find((r) => r.path === "/a")?.json ?? {});
  check("activity missed during the outage is delivered on recovery",
    recovered.includes("Written while the webhook was broken."));
  const healed = await db.query(
    `select failure_count from public.discord_webhooks w
     join public.projects p on p.id = w.project_id where p.name = 'acme-web'`,
  );
  check("failure_count resets after a success", healed.rows[0].failure_count === 0);
}

// --- cleanup ---------------------------------------------------------------

await db.query(`delete from public.discord_webhooks`);
await db.query(
  `alter table public.discord_webhooks add constraint discord_webhooks_url_is_discord
   check (webhook_url ~ '^https://(canary\\.|ptb\\.)?discord(app)?\\.com/api/webhooks/')`,
);
await call(TOKEN_A, "delete_entities", { project: "acme-web", names: ["AuthService", "TokenStore"] });
await call(TOKEN_B, "delete_entities", { project: "acme-billing", names: ["Invoicer"] });
await db.end();
hook.close();

console.table(checks);
if (failures > 0) {
  console.error(`\n${failures} digest check(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} digest checks passed.`);
