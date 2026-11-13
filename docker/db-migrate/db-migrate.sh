#!/usr/bin/env bash
# The db-migrate image's entrypoint (R469).
#
#   migrate       apply every migration not yet recorded (the default)
#   status        how many are applied, and which are pending
#   bootstrap     set a plain PostgreSQL up for Supabase's services, once, as
#                 its admin (deploy/aws/spec/bootstrap/rds-bootstrap.sql). Needs
#                 AUTHENTICATOR_PASSWORD, AUTH_ADMIN_PASSWORD and
#                 STORAGE_ADMIN_PASSWORD; with LAKEHOUSE_CATALOG_PASSWORD, also
#                 the lakehouse catalog's role and database
#   create-admin  the first admin, with a confirmed address, through GoTrue:
#                 ADMIN_EMAIL, ADMIN_PASSWORD, GOTRUE_URL, SERVICE_ROLE_KEY.
#                 One that already exists is left as it is
#   deploy        migrate, then create-admin when ADMIN_EMAIL is set: what a
#                 deploy runs once, before the app starts (deploy/aws, Helm)
#   version       the release this image belongs to, and its newest migration
#
# Every command but version and create-admin reads DATABASE_URL: the admin's
# connection string, with sslmode=verify-full and PGSSLROOTCERT on a managed
# database (or the password in PGPASSWORD, kept out of the URL).
set -uo pipefail
HERE=/db-migrate
MIGRATIONS="$HERE/migrations"

usage() {
  sed -n '4,20p' "$0" | sed 's/^# \{0,1\}//'
}

# The first admin, created through GoTrue's admin API with the address
# already confirmed. A deploy cannot leave this to a sign-up: the address in
# ADMIN_EMAIL becomes a permanent superadmin (src/utils/iam.server.ts), and
# until someone registers it, whoever does first gets that.
create_admin() {
  local v missing="" body out code
  for v in ADMIN_EMAIL ADMIN_PASSWORD GOTRUE_URL SERVICE_ROLE_KEY; do
    [ -n "${!v:-}" ] || missing="$missing $v"
  done
  if [ -n "$missing" ]; then
    echo "create-admin needs:$missing" >&2
    return 2
  fi
  # Written into JSON as is, so only what an address and a generated
  # password are made of: no quote, backslash or control character.
  if ! [[ "$ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
    echo "create-admin: ADMIN_EMAIL is not an e-mail address: $ADMIN_EMAIL" >&2
    return 2
  fi
  if ! [[ "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9._~!@#%^*+=-]{8,128}$ ]]; then
    echo "create-admin: ADMIN_PASSWORD must be 8-128 characters of letters, digits and ._~!@#%^*+=-" >&2
    return 2
  fi
  body=$(printf '{"email":"%s","password":"%s","email_confirm":true}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
  out=$(curl -sS --max-time 30 -w '\n%{http_code}' -X POST "${GOTRUE_URL%/}/admin/users" \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" --data-binary @- <<<"$body") || {
    echo "create-admin: GoTrue at $GOTRUE_URL did not answer" >&2
    return 1
  }
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  case "$code" in
    200 | 201) echo "created the admin $ADMIN_EMAIL, address confirmed" ;;
    422)
      if grep -qiE 'email_exists|already (been )?registered' <<<"$out"; then
        echo "the admin $ADMIN_EMAIL already exists; left as it is"
      else
        echo "create-admin: GoTrue refused it (422): $out" >&2
        return 1
      fi
      ;;
    *)
      echo "create-admin: GoTrue answered $code: $out" >&2
      return 1
      ;;
  esac
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
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
      -v authenticator_password="$AUTHENTICATOR_PASSWORD" \
      -v auth_admin_password="$AUTH_ADMIN_PASSWORD" \
      -v storage_admin_password="$STORAGE_ADMIN_PASSWORD" \
      -f "$HERE/bootstrap/rds-bootstrap.sql" || exit 1
    # The lakehouse catalog beside Supabase's database, when the deploy has
    # one (R479); Compose runs it as a container of its own instead.
    if [ -n "${LAKEHOUSE_CATALOG_PASSWORD:-}" ]; then
      psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
        -v lakehouse_password="$LAKEHOUSE_CATALOG_PASSWORD" \
        -f "$HERE/bootstrap/lakehouse-catalog.sql" || exit 1
      echo "the lakehouse catalog's role and database are ready"
    fi
    ;;
  create-admin)
    create_admin
    exit $?
    ;;
  deploy)
    need_url
    bash "$HERE/apply-migrations.sh" "$MIGRATIONS" || exit 1
    if [ -n "${ADMIN_EMAIL:-}" ]; then
      create_admin || exit 1
    fi
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
