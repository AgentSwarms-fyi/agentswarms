# AgentSwarms — egress-proxy: the sandboxes' only way out, on AWS (R478).
#
# squid with an allow-list it PULLS from the app (egress-pull in
# egress-proxy.sh), for ECS and EKS, where the app can neither write a file
# into the proxy nor restart it. Compose keeps its own: the ubuntu/squid
# service, whose files the app writes (deploy/notebooks/egress).
#
#   docker run -p 3128:3128 \
#     -e EGRESS_PULL_URL=http://app.internal/api/notebook/runtime/egress \
#     -e EGRESS_PULL_TOKEN=... ghcr.io/agentswarms-fyi/egress-proxy:<version>
#
# Alpine, pinned by digest, as db-migrate is; Alpine 3.24.3, released
# 2026-10-23. squid from Alpine's own packages, with Alpine's security fixes
# since the base was published (R406).
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

RUN apk upgrade --no-cache \
 && apk add --no-cache squid curl ca-certificates \
 && mkdir -p /var/lib/egress /run/squid \
 && chown -R squid:squid /var/lib/egress /run/squid

COPY squid.conf /etc/squid/squid.conf
COPY egress-proxy.sh /usr/local/bin/egress-proxy.sh

# squid's own user from the start: it never needs root, binding 3128.
USER squid
EXPOSE 3128

ARG AGENTSWARMS_VERSION=dev
ARG AGENTSWARMS_REVISION=
ENV AGENTSWARMS_VERSION=$AGENTSWARMS_VERSION \
    AGENTSWARMS_REVISION=$AGENTSWARMS_REVISION

ENTRYPOINT ["/bin/sh", "/usr/local/bin/egress-proxy.sh"]
