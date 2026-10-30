# The Docker socket proxy the notebook gateway starts kernels through: HAProxy
# in front of /var/run/docker.sock, letting through only the API sections
# docker-compose.yml switches on.
#
# Built here rather than pulled (R407, VA-39). The upstream image is rebuilt
# only when Tecnativa cuts a release, so its Alpine packages fall behind in
# between: grype found 12 fixable criticals in v0.4.2, and 4 still in v0.5.0
# (OpenSSL 3.5.7, fixed in 3.5.8), with pcre2 and zlib behind as well. This
# image is that release with Alpine's security updates applied.
#
# The base is pinned by digest. Dependabot proposes the next one, and the
# image-scan workflow builds this file fresh every week, which picks up
# whatever Alpine has fixed since.
FROM tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459

RUN apk upgrade --no-cache
