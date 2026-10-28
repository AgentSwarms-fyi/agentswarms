// Shared PySpark fragment: open a Spark Connect session, authenticating with a
// pre-shared token whenever the deployment set one.
//
// Spark 4.2's Connect server enforces `SPARK_CONNECT_AUTHENTICATE_TOKEN` with a
// pre-shared-key gRPC interceptor that checks an `authorization: Bearer <token>`
// header on every call. The stock PySpark client will only attach that token
// over TLS, or over a plaintext channel when the host is literally `localhost`,
// because gRPC refuses CallCredentials on an insecure channel. Our endpoint is
// reached by service name over plaintext gRPC on an internal-only network (gRPC
// cannot traverse the HTTP egress proxy), so the stock client would try to
// negotiate TLS against a plaintext server and hang. This fragment instead adds
// the token as request metadata through a custom ChannelBuilder on an insecure
// channel, which the server's interceptor accepts. Measured against Spark 4.2:
// right token connects, wrong token / none is refused UNAUTHENTICATED.
//
// A token reaches the run two ways: `ETL_SPARK_CONNECT_TOKEN` (what Compose
// wires from `SPARK_CONNECT_TOKEN`), or `;token=…` embedded in the connection
// URL (an operator's managed cluster). When the URL asks for TLS
// (`use_ssl=true`) or targets localhost, the stock client handles the token
// itself and this fragment stays out of the way — so a managed TLS cluster and
// the local plaintext one both work from the same generated code.

/** The Python function the fragment defines: `_connect_spark(url) -> session`. */
export const SPARK_CONNECT_FN = "_connect_spark";

/**
 * The pre-shared token a Spark run should carry as its own `ETL_SPARK_CONNECT_TOKEN`,
 * or null when it should carry none. Three cases say no: a `k8s` run (its driver
 * is per-run and unauthenticated), no configured token, and a token already
 * embedded in the connection URL as `;token=…` (left to ride there, and scrubbed
 * from logs separately). Pure so both env builders and the log scrubber decide
 * identically.
 */
export function sparkRunToken(
  provider: string,
  token: string | null | undefined,
  url: string,
): string | null {
  if (provider !== "static") return null;
  if (!token) return null;
  if (/[;?&]token=/i.test(url)) return null;
  return token;
}

/**
 * Python source (top-level, no indentation) defining {@link SPARK_CONNECT_FN}.
 * Both the ETL-graph prelude and the lakehouse-query program prepend it and
 * call it instead of `SparkSession.builder.remote(url)`.
 */
export function sparkConnectClientFragment(): string {
  return [
    `def ${SPARK_CONNECT_FN}(_url):`,
    `    # Token auth over a plaintext, service-name endpoint needs a custom`,
    `    # channel; see sparkConnectClient.ts for the full reasoning.`,
    `    import os as _os, re as _re`,
    `    from urllib.parse import urlparse as _urlparse`,
    `    _tok = _os.environ.get('ETL_SPARK_CONNECT_TOKEN') or None`,
    `    if _tok is None:`,
    `        _m = _re.search(r'[;?&]token=([^;?&\\s]+)', _url)`,
    `        if _m:`,
    `            _tok = _m.group(1)`,
    `    _ssl = bool(_re.search(r'[;?&]use_ssl=true', _url, _re.I))`,
    `    _bare = _url.split(';')[0].split('?')[0]`,
    `    _p = _urlparse(_bare.replace('sc://', 'http://', 1))`,
    `    _host = _p.hostname or 'localhost'`,
    `    _port = _p.port or 15002`,
    `    if _tok and not _ssl and _host not in ('localhost', '127.0.0.1', '::1'):`,
    `        import grpc`,
    `        from pyspark.sql.connect.session import SparkSession as _CS`,
    `        from pyspark.sql.connect.client.core import ChannelBuilder as _CB`,
    ``,
    `        class _Bearer(grpc.UnaryUnaryClientInterceptor, grpc.UnaryStreamClientInterceptor):`,
    `            def __init__(self, _t):`,
    `                self._md = ('authorization', 'Bearer ' + _t)`,
    ``,
    `            def _w(self, _cont, _d, _r):`,
    `                _meta = list(_d.metadata or [])`,
    `                _meta.append(self._md)`,
    `                return _cont(_d._replace(metadata=_meta), _r)`,
    ``,
    `            def intercept_unary_unary(self, _cont, _d, _r):`,
    `                return self._w(_cont, _d, _r)`,
    ``,
    `            def intercept_unary_stream(self, _cont, _d, _r):`,
    `                return self._w(_cont, _d, _r)`,
    ``,
    `        class _TokenChannel(_CB):`,
    `            def __init__(self, _h, _pt, _t):`,
    `                super().__init__()`,
    `                self._h, self._pt, self._t = _h, _pt, _t`,
    ``,
    `            @property`,
    `            def host(self):`,
    `                return self._h`,
    ``,
    `            @property`,
    `            def endpoint(self):`,
    `                return self._h + ':' + str(self._pt)`,
    ``,
    `            def toChannel(self):`,
    `                self.add_interceptor(_Bearer(self._t))`,
    `                return self._insecure_channel(self.endpoint)`,
    ``,
    `        return _CS.builder.channelBuilder(_TokenChannel(_host, _port, _tok)).getOrCreate()`,
    `    # No token, or TLS (the client attaches the token itself), or localhost`,
    `    # (gRPC's local credentials): the plain remote path handles it.`,
    `    from pyspark.sql import SparkSession as _SS`,
    `    return _SS.builder.remote(_url).getOrCreate()`,
    ``,
  ].join("\n");
}
