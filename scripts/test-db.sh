#!/usr/bin/env bash
# Applies supabase/migrations/003_line_tracking.sql to a throwaway local Postgres and runs tests/db/*.sql.
# Never touches a remote database. Requires initdb/pg_ctl/psql (Postgres 15+) on PATH.
set -euo pipefail
shopt -s nullglob
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(mktemp -d)"
port="${TEST_DB_PORT:-54329}"
cleanup() { pg_ctl -D "$dir/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$dir"; }
trap cleanup EXIT

initdb -D "$dir/data" -U postgres -A trust >/dev/null
pg_ctl -D "$dir/data" -o "-p $port -k $dir -c listen_addresses=''" -l "$dir/log" -w start >/dev/null
psql_run() { psql -h "$dir" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Supabase provides these roles; create them so the migration's grants apply
psql_run -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;"
psql_run -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
             ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
             ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"
psql_run -f "$root/supabase/migrations/003_line_tracking.sql"
psql_run -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;"
for f in "$root"/tests/db/*.sql; do
  echo "# $f"
  psql_run -o /dev/null -f "$f" 2>&1 | sed "s/^psql:[^ ]* //"
done
for f in "$root"/tests/db/*.sh; do
  echo "# $f"
  # shellcheck source=/dev/null
  source "$f"
done
echo "db tests passed"
