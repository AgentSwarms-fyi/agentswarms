// A fetch that got no answer, said in words (R368).
//
// FOUND FROM THE UI (R368). Data Catalog → Add → Iceberg REST catalog at an
// address that does not resolve → Connect & crawl: the toast read "fetch
// failed", and the wizard went back to where it was. Node's fetch says that
// for every failure below HTTP and keeps the reason in `cause`: a name that
// does not resolve, a refused connection, a certificate it would not accept.
// "fetch failed" names neither the address nor what to fix.

/** Where it tried, without a path, query or credentials. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "the address";
  }
}

type Coded = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  cause?: unknown;
  errors?: unknown;
};

/**
 * The error's own code, or its cause's (Node's fetch puts it on the cause).
 * A name with both an IPv4 and an IPv6 address, `localhost` among them, fails
 * as one AggregateError whose attempts carry the codes.
 */
function codeOf(err: unknown): string | undefined {
  const e = (err ?? {}) as Coded;
  if (typeof e.code === "string") return e.code;
  const cause = (e.cause ?? {}) as Coded;
  if (typeof cause.code === "string") return cause.code;
  const attempts = Array.isArray(cause.errors) ? (cause.errors as Coded[]) : [];
  const coded = attempts.find((a) => typeof a?.code === "string");
  return coded ? (coded.code as string) : undefined;
}

export function describeFetchFailure(
  err: unknown,
  url: string,
  opts: { timeoutMs?: number } = {},
): string {
  const where = originOf(url);
  const e = (err ?? {}) as Coded;
  if (e.name === "TimeoutError") {
    return opts.timeoutMs
      ? `${where} did not answer within ${Math.round(opts.timeoutMs / 1000)} s`
      : `${where} did not answer in time`;
  }
  const code = codeOf(err);
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${where} could not be reached: its host name does not resolve`;
    case "ECONNREFUSED":
      return `${where} could not be reached: nothing is listening there (connection refused)`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `${where} could not be reached: the connection timed out`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return `${where} could not be reached: there is no route to it`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return `${where} closed the connection before answering`;
  }
  if (code && /CERT|SSL|TLS|SELF_SIGNED/i.test(code)) {
    return `${where} could not be reached: its TLS certificate was not accepted (${code})`;
  }
  const cause = (e.cause ?? {}) as Coded;
  const detail =
    typeof cause.message === "string" && cause.message
      ? cause.message
      : typeof e.message === "string" && e.message
        ? e.message
        : String(err);
  return `${where} could not be reached: ${detail}`;
}
