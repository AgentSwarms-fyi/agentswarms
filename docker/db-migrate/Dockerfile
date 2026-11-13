# AgentSwarms — db-migrate: the schema as an image (R469).
#
# psql, the migrations of this release, the bootstrap for a database whose
# admin is not a superuser (Amazon RDS and others), and the runner that applies
# them. An ECS or Kubernetes deploy runs it as a one-off task before the new
# app starts; anyone can run it against any PostgreSQL:
#
#   docker run --rm -e DATABASE_URL=postgres://admin:...@host:5432/postgres \
#     ghcr.io/agentswarms-fyi/db-migrate:<version>                 # migrate
#   ... db-migrate:<version> status                                 # applied / pending
#   ... -e AUTHENTICATOR_PASSWORD -e AUTH_ADMIN_PASSWORD -e STORAGE_ADMIN_PASSWORD \
#       db-migrate:<version> bootstrap                              # plain PostgreSQL, once
#
# Built from the repository root (the migrations live there), with its own
# ignore file next to this one, so only the four paths below reach the build.
#
# Alpine with PostgreSQL 17's client only. The postgres image would bring the
# whole server for a task that needs psql: 443 MB measured, which a deploy
# pulls for every rollout. Pinned by digest, as every base here is (R406);
# Alpine 3.24.3, released 2026-10-23.
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

# psql 17 reads PostgreSQL 15, 16 and 17 servers. ca-certificates, so
# sslrootcert=system can verify a database whose certificate a public CA
# signed; Amazon RDS has its own CA, given as PGSSLROOTCERT. curl, for
# create-admin's one call to GoTrue (R479). Alpine's security fixes since the
# base was published, as the socket proxy takes them (R406).
RUN apk upgrade --no-cache \
 && apk add --no-cache bash postgresql17-client ca-certificates curl \
 && adduser -D -H -u 10001 -s /sbin/nologin migrate

WORKDIR /db-migrate
COPY docker/db-migrate/apply-migrations.sh docker/db-migrate/db-migrate.sh ./
COPY deploy/aws/spec/bootstrap/rds-bootstrap.sql deploy/aws/spec/bootstrap/lakehouse-catalog.sql ./bootstrap/
COPY supabase/migrations ./migrations

# Its own unprivileged user. Nothing here is written: the work is done in the
# database.
USER migrate

ARG AGENTSWARMS_VERSION=dev
ARG AGENTSWARMS_REVISION=
ENV AGENTSWARMS_VERSION=$AGENTSWARMS_VERSION \
    AGENTSWARMS_REVISION=$AGENTSWARMS_REVISION

ENTRYPOINT ["bash", "/db-migrate/db-migrate.sh"]
CMD ["migrate"]
