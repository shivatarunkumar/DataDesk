#!/usr/bin/env bash
# Source this to load .env for commands running on the host:
#   source scripts/localenv.sh
# The Make targets do it for you. Container hostnames (host.docker.internal, @postgres:)
# are rewritten to localhost, so a .env written for docker still works here.
if [ -z "${BASH_VERSION:-}" ]; then
  echo "localenv.sh needs bash: run 'bash -c \"source scripts/localenv.sh && ...\"' or use the make targets" >&2
  return 1 2>/dev/null || exit 1
fi

_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$_root/.env" ]; then
  cat >&2 <<'EOF'
No .env file yet. On a new machine:

  cp .env.example .env

then open .env and set:
  DATABASE_URL / POSTGRES_ADMIN_URL  your local Postgres user, password and port
  TARGET_DATABASE_URL                the Postgres server that holds the upload targets
  JWT_SECRET                         openssl rand -hex 32
  GCP_PROJECT_ID / GCS_BUCKET        the project and bucket behind the workspace

See the "Run it locally" section of the README.
EOF
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1091
. "$_root/.env"
set +a

for _var in DATABASE_URL POSTGRES_ADMIN_URL TARGET_DATABASE_URL GCS_ENDPOINT_URL; do
  _value="${!_var:-}"
  [[ -z "$_value" ]] && continue
  _value="${_value//host.docker.internal/localhost}"
  _value="${_value//"@postgres:"/"@localhost:"}"
  _value="${_value//"//gcs:"/"//localhost:"}"
  export "$_var=$_value"
done
unset _var _value _root

# psql and other libpq tools don't understand SQLAlchemy driver prefixes
# (postgresql+asyncpg://); PSQL_URL is the same connection without them.
export PSQL_URL="${DATABASE_URL/+asyncpg/}"
export PSQL_URL="${PSQL_URL/+psycopg/}"
