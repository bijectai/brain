#!/usr/bin/env bash
# Runs the whole stack locally -- throwaway Postgres, migrations, the Edge
# Function under plain Deno, then both test suites. No Supabase account needed.
#
#   ./scripts/local-test.sh
#
# Requires: postgresql-16 + postgresql-contrib, deno, node.
set -euo pipefail

PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA_DIR=${PGDATA_DIR:-/var/tmp/kg-localtest}
SOCK_DIR=/var/tmp/kg-localtest-sock
PORT=${PORT:-55432}
MCP_PORT=${MCP_PORT:-8000}
DIGEST_PORT=${DIGEST_PORT:-8001}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres

cleanup() {
  [[ -n "${MCP_PID:-}" ]] && kill "$MCP_PID" 2>/dev/null || true
  [[ -n "${DIGEST_PID:-}" ]] && kill "$DIGEST_PID" 2>/dev/null || true
  su postgres -c "$PGBIN/pg_ctl -D $PGDATA_DIR -m fast stop" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if curl -s -o /dev/null --max-time 2 "telnet://127.0.0.1:$PORT" 2>/dev/null; then
  echo "Port $PORT is already in use. Stop that server or re-run with PORT=<free>." >&2
  exit 1
fi

echo "== fresh cluster"
rm -rf "$PGDATA_DIR" "$SOCK_DIR"
mkdir -p "$PGDATA_DIR" "$SOCK_DIR"
chown postgres:postgres "$PGDATA_DIR" "$SOCK_DIR"
su postgres -c "$PGBIN/initdb -D $PGDATA_DIR -U postgres --auth=trust" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $PGDATA_DIR \
  -o '-p $PORT -k $SOCK_DIR -c listen_addresses=127.0.0.1' \
  -l $PGDATA_DIR/log start" >/dev/null
sleep 3

echo "== migrations"
# Roles Supabase provides for us; created here so the migrations run unmodified.
psql -q -c "create role anon; create role authenticated; create role service_role;"
for f in supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -f "$f"
done

echo "== RLS suite (database level)"
psql -v ON_ERROR_STOP=1 -f scripts/rls-test.sql 2>&1 | grep -E "NOTICE|PASSED|ERROR|FAIL"

echo "== backfill / multi-repo schema suite"
psql -v ON_ERROR_STOP=1 -f scripts/backfill-test.sql 2>&1 | grep -E "NOTICE|PASSED|ERROR|FAIL"

echo "== negative control -- the suite must FAIL when a policy is removed"
psql -q -c "alter table public.entities disable row level security;"
psql -q -c "delete from public.projects where name like 'rlstest-%';"
if psql -v ON_ERROR_STOP=1 -f scripts/rls-test.sql >/dev/null 2>&1; then
  echo "NEGATIVE CONTROL FAILED: suite passed with RLS disabled" >&2
  exit 1
fi
echo "   negative control ok (suite correctly failed)"
psql -q -c "alter table public.entities enable row level security;"
psql -q -c "delete from public.projects where name like 'rlstest-%';"

echo "== fixtures: two tenants, two tokens"
psql -q -c "alter role mcp_client with login password 'testpw';"
psql -q -v ON_ERROR_STOP=1 <<'SQL'
select app.create_project('acme-web');
select app.create_project('acme-billing');
select app.issue_token((select id from public.projects where name='acme-web'),
                       'local-owner', 'kgt_TESTA');
select app.issue_token((select id from public.projects where name='acme-billing'),
                       'test-employee', 'kgt_TESTB');
SQL

echo "== serving the Edge Function"
MCP_DB_URL="postgresql://mcp_client:testpw@127.0.0.1:$PORT/postgres" \
  deno run --allow-net --allow-env --allow-read --allow-sys \
  supabase/functions/mcp/index.ts >/var/tmp/kg-edge.log 2>&1 &
MCP_PID=$!
for _ in $(seq 1 30); do
  curl -sf -o /dev/null -X POST "http://127.0.0.1:$MCP_PORT" \
    -H 'authorization: Bearer kgt_TESTA' \
    -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' && break
  sleep 1
done

echo "== isolation suite (over HTTP, against the real server)"
MCP_URL="http://127.0.0.1:$MCP_PORT" TOKEN_A=kgt_TESTA TOKEN_B=kgt_TESTB \
  PROJECT_A=acme-web PROJECT_B=acme-billing \
  node scripts/isolation-test.mjs

echo "== serving kg-digest"
KG_LOCAL_PORT="$DIGEST_PORT" \
  MCP_DB_URL="postgresql://mcp_client:testpw@127.0.0.1:$PORT/postgres" \
  deno run --allow-net --allow-env --allow-read --allow-sys \
  supabase/functions/kg-digest/index.ts >/var/tmp/kg-digest.log 2>&1 &
DIGEST_PID=$!
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$DIGEST_PORT" && break
  sleep 1
done

echo "== multi-repo suite"
psql -q -c "select app.add_repo((select id from public.projects where name='acme-web'), 'acmeco/acme-api');" \
  -c "select app.add_repo((select id from public.projects where name='acme-web'), 'acmeco/acme-web');"
MCP_URL="http://127.0.0.1:$MCP_PORT" TOKEN_A=kgt_TESTA PROJECT=acme-web \
  node scripts/repo-test.mjs

echo "== Discord digest suite"
MCP_URL="http://127.0.0.1:$MCP_PORT" \
  DIGEST_URL="http://127.0.0.1:$DIGEST_PORT" \
  ADMIN_DB_URL="postgresql://postgres@127.0.0.1:$PORT/postgres" \
  TOKEN_A=kgt_TESTA TOKEN_B=kgt_TESTB \
  node scripts/digest-test.mjs
