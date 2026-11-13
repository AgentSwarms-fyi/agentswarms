#!/usr/bin/env bash
# The db-migrate image's entrypoint (R469).
#
#   migrate     apply every migration not yet recorded (the default)
#   status      how many are applied, and which are pending
#   bootstrap   set a plain PostgreSQL up for Supabase's services, once, as
#               its admin (deploy/aws/spec/bootstrap/rds-bootstrap.sql). Needs
#               AUTHENTICATOR_PASSWORD, AUTH_ADMIN_PASSWORD and
#               STORAGE_ADMIN_PASSWORD
#   version     the release this image belongs to, and its newest migration
#
# Every command but version reads DATABASE_URL: the admin's connection string,
# with sslmode=verify-full and PGSSLROOTCERT on a managed database.
set -uo pipefail
HERE=/db-migrate
MIGRATIONS="$HERE/migrations"

usage() {
  sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'
}

need_url() {
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is not set: give the database admin's connection string" >&2
    exit 2
  fi
}

versions_in_image() {
  for f in "$MIGRATIONS"/*.sql; do
    v=${f##*/}
    echo "${v%%_*}"
  done | sort
}

case "${1:-migrate}" in
  migrate)
    need_url
    exec bash "$HERE/apply-migrations.sh" "$MIGRATIONS"
    ;;
  status)
    need_url
    applied=$(psql "$DATABASE_URL" -X -q -tA -v ON_ERROR_STOP=1 -c \
      "select version from supabase_migrations.schema_migrations order by version" 2>/dev/null) || applied=""
    pending=$(comm -23 <(versions_in_image) <(echo "$applied" | sed '/^$/d' | sort))
    total=$(versions_in_image | wc -l | tr -d ' ')
    n_pending=$(echo "$pending" | sed '/^$/d' | wc -l | tr -d ' ')
    echo "image ${AGENTSWARMS_VERSION:-dev}: $total migrations, $((total - n_pending)) applied, $n_pending pending"
    if [ "$n_pending" -gt 0 ]; then
      for v in $pending; do
        for f in "$MIGRATIONS/${v}"_*.sql; do echo "  pending ${f##*/}"; done
      done
    fi
    # Newer than this image: the database was migrated by a later release.
    ahead=$(comm -13 <(versions_in_image) <(echo "$applied" | sed '/^$/d' | sort) | sed '/^$/d' | wc -l | tr -d ' ')
    [ "$ahead" -gt 0 ] && echo "  $ahead applied migration(s) are newer than this image: a later release migrated this database"
    exit 0
    ;;
  bootstrap)
    need_url
    missing=""
    for v in AUTHENTICATOR_PASSWORD AUTH_ADMIN_PASSWORD STORAGE_ADMIN_PASSWORD; do
      [ -n "${!v:-}" ] || missing="$missing $v"
    done
    if [ -n "$missing" ]; then
      echo "bootstrap needs:$missing" >&2
      exit 2
    fi
    exec psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
      -v authenticator_password="$AUTHENTICATOR_PASSWORD" \
      -v auth_admin_password="$AUTH_ADMIN_PASSWORD" \
      -v storage_admin_password="$STORAGE_ADMIN_PASSWORD" \
      -f "$HERE/bootstrap/rds-bootstrap.sql"
    ;;
  version)
    newest=$(versions_in_image | tail -1)
    echo "agentswarms db-migrate ${AGENTSWARMS_VERSION:-dev}${AGENTSWARMS_REVISION:+ ($AGENTSWARMS_REVISION)}"
    echo "$(versions_in_image | wc -l | tr -d ' ') migrations, newest $newest"
    psql --version
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "unknown command: $1" >&2
    usage >&2
    exit 2
    ;;
esac
