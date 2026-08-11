#!/usr/bin/env node
/**
 * Administrative CLI for the knowledge-graph MCP server.
 *
 * Connects as the project owner, so it must never run anywhere but an
 * operator's machine. Requires ADMIN_DB_URL, the Supabase Postgres connection
 * string (Dashboard -> Project Settings -> Database -> Connection string).
 *
 *   node scripts/admin.mjs init-role                     # set the mcp_client password
 *   node scripts/admin.mjs create-project <name>
 *   node scripts/admin.mjs list-projects
 *   node scripts/admin.mjs issue-token <project> <employee-label>
 *   node scripts/admin.mjs grant <token-id> <project>    # add a second project
 *   node scripts/admin.mjs ungrant <token-id> <project>
 *   node scripts/admin.mjs revoke-token <token-id>
 *   node scripts/admin.mjs list-tokens
 */

import crypto from "node:crypto";
import pg from "pg";

const DB_URL = process.env.ADMIN_DB_URL;
if (!DB_URL) {
  console.error("ADMIN_DB_URL is not set. See the header of this file.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: DB_URL,
  ssl: { rejectUnauthorized: false },
});

/** Tokens are 32 bytes from the OS CSPRNG. Only the sha256 is ever stored. */
function generateToken() {
  return "kgt_" + crypto.randomBytes(32).toString("base64url");
}

async function projectId(ref) {
  const { rows } = await client.query(
    `select id, name from public.projects
     where name = $1 or id::text = $1`,
    [ref],
  );
  if (rows.length === 0) throw new Error(`No such project: ${ref}`);
  return rows[0];
}

const commands = {
  async "init-role"() {
    // The Edge Function's database role gets a fresh random password, printed
    // once so it can be pasted into the function's MCP_DB_URL secret.
    const password = crypto.randomBytes(24).toString("base64url");
    await client.query(
      `alter role mcp_client with login password ${quoteLiteral(password)}`,
    );
    console.log("mcp_client password rotated. Put this in MCP_DB_URL:\n");
    console.log(`  ${password}\n`);
    console.log(
      "Full value, using the *transaction pooler* host from the dashboard:\n" +
        `  postgresql://mcp_client:${encodeURIComponent(password)}` +
        `@<pooler-host>:6543/postgres\n`,
    );
  },

  async "create-project"(name) {
    if (!name) throw new Error("usage: create-project <name>");
    const { rows } = await client.query(`select * from app.create_project($1)`, [name]);
    console.log(`project ${rows[0].name}  ${rows[0].id}`);
  },

  async "list-projects"() {
    const { rows } = await client.query(
      `select p.id, p.name, p.created_at,
              (select count(*) from public.entities e where e.project_id = p.id) as entities
       from public.projects p order by p.name`,
    );
    console.table(rows);
  },

  async "issue-token"(project, label) {
    if (!project || !label) throw new Error("usage: issue-token <project> <employee-label>");
    const p = await projectId(project);
    const token = generateToken();
    const { rows } = await client.query(
      `select app.issue_token($1, $2, $3) as id`,
      [p.id, label, token],
    );
    console.log(`\nToken for "${label}" on project "${p.name}"`);
    console.log(`  token id: ${rows[0].id}`);
    console.log(`  token:    ${token}`);
    console.log(
      `\nThis is the only time the token is shown -- only its hash is stored.\n`,
    );
  },

  async grant(tokenId, project) {
    if (!tokenId || !project) throw new Error("usage: grant <token-id> <project>");
    const p = await projectId(project);
    await client.query(`select app.grant_project($1, $2)`, [tokenId, p.id]);
    console.log(`granted ${p.name} to token ${tokenId}`);
  },

  async ungrant(tokenId, project) {
    if (!tokenId || !project) throw new Error("usage: ungrant <token-id> <project>");
    const p = await projectId(project);
    await client.query(`select app.revoke_project($1, $2)`, [tokenId, p.id]);
    console.log(`revoked ${p.name} from token ${tokenId}`);
  },

  async "revoke-token"(tokenId) {
    if (!tokenId) throw new Error("usage: revoke-token <token-id>");
    const { rowCount } = await client.query(
      `update public.access_tokens set revoked_at = now()
       where id = $1 and revoked_at is null`,
      [tokenId],
    );
    console.log(rowCount ? `revoked ${tokenId}` : `no active token ${tokenId}`);
  },

  async "list-tokens"() {
    const { rows } = await client.query(
      `select t.id, t.employee_label, t.created_at, t.revoked_at,
              (select string_agg(p.name, ', ' order by p.name)
               from public.access_token_projects atp
               join public.projects p on p.id = atp.project_id
               where atp.token_id = t.id) as projects
       from public.access_tokens t order by t.created_at`,
    );
    console.table(rows);
  },

  // --- Discord digest ------------------------------------------------------

  async "set-discord"(project, url, label) {
    if (!project || !url) {
      throw new Error("usage: set-discord <project> <webhook-url> [channel-label]");
    }
    const p = await projectId(project);
    // Registering seeds the watermark at now(), so enabling a webhook does not
    // immediately replay the project's entire history into the channel.
    await client.query(
      `insert into public.discord_webhooks (project_id, webhook_url, channel_label)
       values ($1, $2, $3)
       on conflict (project_id) do update
         set webhook_url = excluded.webhook_url,
             channel_label = excluded.channel_label,
             enabled = true, failure_count = 0, last_error = null`,
      [p.id, url, label ?? null],
    );
    console.log(`digest for "${p.name}" -> ${label ?? "Discord"}`);
    console.log("Only activity from now on is reported; history is not replayed.");
  },

  async "unset-discord"(project) {
    if (!project) throw new Error("usage: unset-discord <project>");
    const p = await projectId(project);
    const { rowCount } = await client.query(
      `delete from public.discord_webhooks where project_id = $1`,
      [p.id],
    );
    console.log(rowCount ? `removed digest for ${p.name}` : `no digest for ${p.name}`);
  },

  async "list-discord"() {
    const { rows } = await client.query(
      `select p.name as project, w.channel_label, w.enabled,
              w.last_digest_at, w.failure_count, w.last_error
       from public.discord_webhooks w
       join public.projects p on p.id = w.project_id
       order by p.name`,
    );
    // webhook_url is deliberately not selected -- it is a credential.
    console.table(rows);
  },

  async "init-digest-secret"() {
    const secret = crypto.randomBytes(32).toString("base64url");
    await client.query(`select app.set_system_secret('digest', $1)`, [secret]);

    const { rows } = await client.query(`select current_database() as db`);
    console.log(`\nDigest trigger secret (shown once): ${secret}\n`);
    console.log("Schedule it with pg_cron, hourly at :07 to stay off the busy minute:\n");
    console.log(`  create extension if not exists pg_net  with schema extensions;`);
    console.log(`  create extension if not exists pg_cron;`);
    console.log(`  select cron.schedule('kg-digest', '7 * * * *', $$`);
    console.log(`    select net.http_post(`);
    console.log(`      url     := 'https://<REF>.supabase.co/functions/v1/kg-digest',`);
    console.log(`      headers := jsonb_build_object(`);
    console.log(`        'Content-Type', 'application/json',`);
    console.log(`        'Authorization', 'Bearer ${secret}'),`);
    console.log(`      body    := '{}'::jsonb);`);
    console.log(`  $$);\n`);
    console.log(`(database: ${rows[0].db})`);
  },
};

function quoteLiteral(s) {
  return `'${s.replaceAll("'", "''")}'`;
}

const [command, ...args] = process.argv.slice(2);
const run = commands[command];
if (!run) {
  console.error(
    `Unknown command "${command ?? ""}".\nAvailable: ${Object.keys(commands).join(", ")}`,
  );
  process.exit(1);
}

await client.connect();
try {
  await run(...args);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
