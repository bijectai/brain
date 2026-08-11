-- Discord digest: per-project webhook registration plus the plumbing the
-- kg-digest Edge Function uses to find due channels and record progress.
--
-- Why the webhook URL never leaves the database except through the function:
-- a Discord webhook URL *is* the credential -- anyone holding it can post to
-- the channel. So `discord_webhooks` gets RLS with no policy (unreachable for
-- mcp_client, exactly like access_tokens), and the function reaches it only
-- through the SECURITY DEFINER helpers below.
--
-- Scheduling calls the Edge Function rather than posting to Discord straight
-- from pg_net. pg_net records the target URL and headers of every request in
-- net.http_request_queue, so posting to Discord from SQL would leave webhook
-- URLs sitting in a table. This way pg_net only ever sees our own function URL
-- and a rotatable trigger secret.

create table public.discord_webhooks (
  id             uuid        primary key default gen_random_uuid(),
  project_id     uuid        not null references public.projects (id) on delete cascade,
  webhook_url    text        not null,
  channel_label  text,
  enabled        boolean     not null default true,
  -- Watermark: only activity strictly after this is reported. Seeded to now()
  -- so registering a webhook does not immediately dump the whole backlog.
  last_digest_at timestamptz not null default now(),
  failure_count  int         not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),

  constraint discord_webhooks_url_is_discord
    check (webhook_url ~ '^https://(canary\.|ptb\.)?discord(app)?\.com/api/webhooks/'),
  constraint discord_webhooks_one_per_project unique (project_id)
);

comment on table public.discord_webhooks is
  'One digest channel per project. webhook_url is a credential: RLS is on and '
  'there are deliberately no policies, so only SECURITY DEFINER helpers reach it.';

alter table public.discord_webhooks enable row level security;
revoke all on public.discord_webhooks from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Trigger secret for the kg-digest endpoint.
--
-- Kept in the database rather than a function secret so the whole feature can
-- be set up without `supabase login`. Same shape as access tokens: only the
-- hash is stored.
-- ---------------------------------------------------------------------------

create table app.system_secrets (
  name        text        primary key,
  secret_hash text        not null,
  created_at  timestamptz not null default now()
);

create or replace function app.verify_system_secret(p_name text, p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.system_secrets
    where name = p_name and secret_hash = app.hash_token(p_secret)
  );
$$;

revoke all on function app.verify_system_secret(text, text) from public;
grant execute on function app.verify_system_secret(text, text) to mcp_client;

create or replace function app.set_system_secret(p_name text, p_secret text)
returns void
language sql
set search_path = ''
as $$
  insert into app.system_secrets (name, secret_hash)
  values (p_name, app.hash_token(p_secret))
  on conflict (name) do update set secret_hash = excluded.secret_hash;
$$;

-- ---------------------------------------------------------------------------
-- What the digest function is allowed to see about webhooks.
-- ---------------------------------------------------------------------------

create or replace function app.due_digests()
returns table (
  id            uuid,
  project_id    uuid,
  project_name  text,
  webhook_url   text,
  since         timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.project_id, p.name, w.webhook_url, w.last_digest_at
  from public.discord_webhooks w
  join public.projects p on p.id = w.project_id
  where w.enabled
  order by p.name;
$$;

revoke all on function app.due_digests() from public;
grant execute on function app.due_digests() to mcp_client;

-- Advances the watermark only on a successful post, so a failed delivery is
-- retried next tick rather than silently skipped.
create or replace function app.mark_digest_sent(p_id uuid, p_through timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.discord_webhooks
  set last_digest_at = p_through, failure_count = 0, last_error = null
  where id = p_id;
$$;

revoke all on function app.mark_digest_sent(uuid, timestamptz) from public;
grant execute on function app.mark_digest_sent(uuid, timestamptz) to mcp_client;

-- A webhook that keeps failing is disabled rather than retried forever: a
-- deleted Discord channel would otherwise fail on every tick indefinitely.
create or replace function app.mark_digest_failed(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.discord_webhooks
  set failure_count = failure_count + 1,
      last_error    = left(p_error, 500),
      enabled       = case when failure_count + 1 >= 10 then false else enabled end
  where id = p_id;
$$;

revoke all on function app.mark_digest_failed(uuid, text) from public;
grant execute on function app.mark_digest_failed(uuid, text) to mcp_client;

-- ---------------------------------------------------------------------------
-- Indexes for the digest's "what changed since" queries.
-- ---------------------------------------------------------------------------

create index observations_project_created_idx
  on public.observations (project_id, created_at desc);
create index entities_project_created_idx
  on public.entities (project_id, created_at desc);
create index relations_project_created_idx
  on public.relations (project_id, created_at desc);
