# Discord digest

Posts a per-project summary of knowledge-graph activity to a Discord channel on
a schedule: what entities appeared, what people recorded and why, who wrote it.

One channel per project. `biject` and `brain` can post to different channels,
and a channel only ever receives its own project's activity — the digest reads
through the same tenant pinning as everything else.

```
biject — knowledge graph
4 new entities · 17 observations · 6 relations
Since 24 hours ago

New entities
• AuthService (service)
• TokenStore (table)

Observations
• AuthService — Retries capped at 3 because the upstream gateway times
  out at 30s (devrashie)
…and 12 more

Contributors
devrashie (14), sam (3)
```

## Setup

### 1. Create the Discord webhook

In Discord: **Channel → Edit Channel → Integrations → Webhooks → New Webhook**,
then **Copy Webhook URL**. It looks like
`https://discord.com/api/webhooks/<id>/<token>`.

That URL is a credential — anyone holding it can post to the channel. It is
stored server-side only and is never returned by any MCP tool or admin listing.

### 2. Register it

```bash
export ADMIN_DB_URL='postgresql://postgres:…@db.<REF>.supabase.co:5432/postgres'
node scripts/admin.mjs set-discord biject 'https://discord.com/api/webhooks/…' '#eng-knowledge'
```

Registering seeds the watermark at `now()`, so turning this on does not replay
the project's whole history into the channel.

### 3. Deploy the function and schedule it

```bash
supabase functions deploy kg-digest --no-verify-jwt
node scripts/admin.mjs init-digest-secret      # prints the secret and the cron snippet once
```

Then run the printed `cron.schedule(...)` in the SQL editor. It enables
`pg_cron` and `pg_net` and calls the function hourly at **:07** — off the busy
minute, where every other hourly job in the world piles up.

For a daily digest instead, use `7 9 * * *` (09:07 UTC).

### 4. Check it

```bash
curl -X POST 'https://<REF>.supabase.co/functions/v1/kg-digest' \
  -H 'Authorization: Bearer <DIGEST_SECRET>'
```

Returns what it did per project: `posted (N changes)`, `skipped (no activity)`,
or the failure. A quiet period posts nothing at all — a daily "0 changes"
message trains people to ignore the channel.

## Operating

```bash
node scripts/admin.mjs list-discord            # projects, channels, health
node scripts/admin.mjs unset-discord biject    # stop posting
node scripts/admin.mjs set-discord biject <new-url>   # rotate / re-enable
node scripts/admin.mjs init-digest-secret      # rotate the trigger secret
```

`list-discord` deliberately does not print webhook URLs.

Rotating the trigger secret invalidates the scheduled job — re-run
`cron.schedule` with the new value, or the digest silently stops.

## How it behaves

**Delivery is at-least-once.** The watermark advances only after Discord
accepts the post, so a failed tick is retried on the next one rather than
dropped. If Discord is down for three hours, the next successful post covers
the whole gap. The cost is that a failure between Discord accepting the post
and the watermark write would repeat a digest — duplicated once beats silently
losing a day's activity.

**A dead channel gets disabled.** Ten consecutive failures — a deleted channel,
a revoked webhook — flip `enabled` to false, with the last error kept in
`last_error`. Re-register to resume. Without this a deleted channel would fail
on every tick forever.

**Discord's limits are enforced before sending, not discovered.** Embeds cap at
4096 characters of description, 1024 per field, 25 fields and 6000 total;
exceeding any one of them rejects the entire payload. Long observations are
clamped and overflow becomes "…and N more", so a session that writes a 3000-
character observation still produces a valid post.

## Why it is built this way

`pg_cron` calls **our Edge Function**, which then posts to Discord with `fetch`.
The more obvious wiring — `pg_net` posting to Discord directly from SQL — would
put webhook URLs into `net.http_request_queue`, which records the target URL and
headers of every request. This way `pg_net` only ever sees our own function URL
and a rotatable trigger secret, and the Discord credentials never leave the
`discord_webhooks` table except inside the function.

`discord_webhooks` has RLS enabled with **no policies**, exactly like
`access_tokens`, so `mcp_client` cannot read it at all. The function reaches it
through `SECURITY DEFINER` helpers that return only what a digest run needs.

The trigger secret lives in `app.system_secrets` rather than a function secret,
so the whole feature can be set up without `supabase login`. Only its hash is
stored.

## What gets sent to Discord

Observation text is posted verbatim (truncated). If agents record anything
sensitive in observations, it lands in the channel. Point the webhook at a
private channel, and treat the digest as having the same audience as the graph
itself.

## Tests

`scripts/digest-test.mjs`, run by `scripts/local-test.sh`, covers this against
a real local stack with a fake Discord receiver: trigger auth, the quiet-period
no-post, one post per project, **that one project's digest never contains
another's content**, every Discord size limit, watermark advance, no-advance on
failure, failure counting, and recovery delivering the activity missed during
an outage.
