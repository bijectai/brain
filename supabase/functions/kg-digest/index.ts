/**
 * Posts a per-project summary of knowledge-graph activity to Discord.
 *
 * Invoked on a schedule by pg_cron (see the migration's comment block) with a
 * bearer token checked against app.system_secrets. It reads the registered
 * webhooks through SECURITY DEFINER helpers -- the discord_webhooks table
 * itself is unreachable under RLS -- and does the Discord POST here with
 * fetch, so webhook URLs never pass through pg_net's request log.
 *
 * Delivery is at-least-once by design: the watermark advances only after
 * Discord accepts the post, so a failed tick is retried rather than dropped.
 * A webhook that fails 10 times running is disabled, because a deleted channel
 * would otherwise fail forever.
 */

import postgres from "npm:postgres@3.4.5";

const DB_URL = Deno.env.get("MCP_DB_URL") ?? Deno.env.get("SUPABASE_DB_URL");
if (!DB_URL) throw new Error("Neither MCP_DB_URL nor SUPABASE_DB_URL is set.");

const sql = postgres(DB_URL, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});

/** Same tenant pinning as the MCP function: drop to mcp_client so RLS applies
 *  even when the connection role is BYPASSRLS-capable `postgres`. */
async function withTenant<T>(projectId: string, fn: (tx: typeof sql) => Promise<T>) {
  return await sql.begin(async (tx) => {
    await tx`set local role mcp_client`;
    await tx`set local search_path = public, extensions`;
    await tx`select set_config('app.project_ids', ${projectId}, true)`;
    return await fn(tx as unknown as typeof sql);
  });
}

async function sha256Hex(raw: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Discord payload limits. Exceeding any of these is a 400, so everything
// --- that interpolates user content is clamped before it goes in.
const EMBED_DESC_MAX = 4096;
const FIELD_VALUE_MAX = 1024;

function clamp(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Builds a field value from lines, dropping the overflow into a "+N more". */
function bulletField(lines: string[], shown: number): string | null {
  if (lines.length === 0) return null;
  const head = lines.slice(0, shown);
  const rest = lines.length - head.length;
  let text = head.map((l) => `• ${l}`).join("\n");
  if (rest > 0) text += `\n…and ${rest} more`;
  if (text.length > FIELD_VALUE_MAX) {
    // Re-trim line by line rather than cutting mid-entry.
    const kept: string[] = [];
    let used = 0;
    for (const l of head) {
      const entry = `• ${l}`;
      if (used + entry.length + 24 > FIELD_VALUE_MAX) break;
      kept.push(entry);
      used += entry.length + 1;
    }
    text = kept.join("\n") + `\n…and ${lines.length - kept.length} more`;
  }
  return text;
}

interface Digest {
  webhookId: string;
  projectName: string;
  webhookUrl: string;
  since: Date;
  entities: { name: string; entity_type: string }[];
  observations: { entity: string; content: string; created_by: string | null }[];
  relations: { from: string; to: string; relation_type: string }[];
  counts: { entities: number; observations: number; relations: number };
  contributors: { who: string; n: number }[];
}

async function collect(row: {
  id: string;
  project_id: string;
  project_name: string;
  webhook_url: string;
  since: Date;
}, through: Date): Promise<Digest> {
  return await withTenant(row.project_id, async (tx) => {
    const entities = await tx<{ name: string; entity_type: string }[]>`
      select name, entity_type from public.entities
      where created_at > ${row.since} and created_at <= ${through}
      order by created_at`;

    const observations = await tx<
      { entity: string; content: string; created_by: string | null }[]
    >`
      select e.name as entity, o.content, o.created_by
      from public.observations o
      join public.entities e on e.id = o.entity_id
      where o.created_at > ${row.since} and o.created_at <= ${through}
      order by o.created_at`;

    const relations = await tx<
      { from: string; to: string; relation_type: string }[]
    >`
      select f.name as "from", t.name as "to", r.relation_type
      from public.relations r
      join public.entities f on f.id = r.from_entity_id
      join public.entities t on t.id = r.to_entity_id
      where r.created_at > ${row.since} and r.created_at <= ${through}
      order by r.created_at`;

    const contributors = await tx<{ who: string; n: number }[]>`
      select coalesce(created_by, 'unknown') as who, count(*)::int as n
      from public.observations
      where created_at > ${row.since} and created_at <= ${through}
      group by 1 order by n desc limit 5`;

    return {
      webhookId: row.id,
      projectName: row.project_name,
      webhookUrl: row.webhook_url,
      since: row.since,
      entities,
      observations,
      relations,
      counts: {
        entities: entities.length,
        observations: observations.length,
        relations: relations.length,
      },
      contributors,
    };
  });
}

function buildPayload(d: Digest) {
  const { entities, observations, relations, counts } = d;

  const fields: { name: string; value: string; inline?: boolean }[] = [];

  const entityLines = bulletField(
    entities.map((e) => `**${clamp(e.name, 80)}** (${clamp(e.entity_type, 30)})`),
    8,
  );
  if (entityLines) fields.push({ name: "New entities", value: entityLines });

  const obsLines = bulletField(
    observations.map((o) =>
      `**${clamp(o.entity, 60)}** — ${clamp(o.content, 160)}` +
      (o.created_by ? ` _(${clamp(o.created_by, 40)})_` : "")
    ),
    6,
  );
  if (obsLines) fields.push({ name: "Observations", value: obsLines });

  const relLines = bulletField(
    relations.map((r) =>
      `${clamp(r.from, 50)} \`${clamp(r.relation_type, 30)}\` ${clamp(r.to, 50)}`
    ),
    6,
  );
  if (relLines) fields.push({ name: "Relations", value: relLines });

  if (d.contributors.length > 0) {
    fields.push({
      name: "Contributors",
      value: clamp(
        d.contributors.map((c) => `${c.who} (${c.n})`).join(", "),
        FIELD_VALUE_MAX,
      ),
    });
  }

  const summary =
    `**${counts.entities}** new ${counts.entities === 1 ? "entity" : "entities"} · ` +
    `**${counts.observations}** ${counts.observations === 1 ? "observation" : "observations"} · ` +
    `**${counts.relations}** ${counts.relations === 1 ? "relation" : "relations"}`;

  return {
    username: "Knowledge Graph",
    embeds: [{
      title: clamp(`${d.projectName} — knowledge graph`, 256),
      description: clamp(
        `${summary}\nSince <t:${Math.floor(d.since.getTime() / 1000)}:R>`,
        EMBED_DESC_MAX,
      ),
      color: 0x5865f2,
      fields: fields.slice(0, 25),
      footer: { text: "search_nodes to explore · read_graph for audits only" },
      timestamp: new Date().toISOString(),
    }],
  };
}

// Unset in production, where the platform assigns the port and the default is
// correct. Set only by scripts/local-test.sh, so this function and the MCP one
// can run side by side locally.
const LOCAL_PORT = Number(Deno.env.get("KG_LOCAL_PORT") ?? 0);

Deno.serve(LOCAL_PORT ? { port: LOCAL_PORT } : {}, async (request: Request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "POST only" }, { status: 405 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const secret = auth.replace(/^Bearer\s+/i, "").trim();
  if (!secret) {
    return Response.json({ error: "Missing bearer token." }, { status: 401 });
  }
  const [{ ok }] = await sql<{ ok: boolean }[]>`
    select app.verify_system_secret('digest', ${secret}) as ok`;
  if (!ok) {
    return Response.json({ error: "Invalid trigger secret." }, { status: 401 });
  }

  // One snapshot for the whole run, so rows written while we work are picked
  // up by the next tick instead of being skipped.
  const through = new Date();

  const due = await sql<{
    id: string;
    project_id: string;
    project_name: string;
    webhook_url: string;
    since: Date;
  }[]>`select * from app.due_digests()`;

  const results: Record<string, string>[] = [];

  for (const row of due) {
    try {
      const digest = await collect(row, through);
      const total = digest.counts.entities + digest.counts.observations +
        digest.counts.relations;

      if (total === 0) {
        // Nothing happened. Advance the watermark anyway and stay quiet --
        // a daily "0 changes" post trains people to ignore the channel.
        await sql`select app.mark_digest_sent(${row.id}, ${through})`;
        results.push({ project: row.project_name, status: "skipped (no activity)" });
        continue;
      }

      const res = await fetch(row.webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(digest)),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        await sql`select app.mark_digest_failed(${row.id}, ${`HTTP ${res.status}: ${body.slice(0, 300)}`})`;
        results.push({ project: row.project_name, status: `failed (HTTP ${res.status})` });
        continue;
      }

      await sql`select app.mark_digest_sent(${row.id}, ${through})`;
      results.push({
        project: row.project_name,
        status: `posted (${total} changes)`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`digest failed for ${row.project_name}`, err);
      await sql`select app.mark_digest_failed(${row.id}, ${message})`;
      results.push({ project: row.project_name, status: `error: ${message}` });
    }
  }

  return Response.json({ ran_at: through.toISOString(), results });
});
