// Delta Sharing (the open protocol clients such as the delta-sharing Python
// package, Spark and Power BI speak), the part that needs no database: the
// wire shapes, the path grammar, the schema translation and the token
// format. Pure so the routes, the server module and the tests share one
// reading of the protocol.
//
// Protocol reference: https://github.com/delta-io/delta-sharing/blob/main/PROTOCOL.md
// A recipient's client does four things: list shares/schemas/tables, ask a
// table's version, read its metadata, and query it — the last two answered
// as newline-delimited JSON where each line is one action (protocol,
// metaData, file). The file lines carry URLs the client fetches directly,
// so what is behind them must already be governed.

export const SHARE_TOKEN_PREFIX = "dss_";
export const DELTA_SHARING_PREFIX = "/api/delta-sharing";
export const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return SHARE_TOKEN_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export async function hashShareToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function shareTokenPrefix(token: string): string {
  return token.slice(0, SHARE_TOKEN_PREFIX.length + 6);
}

export function looksLikeShareToken(token: string): boolean {
  return (
    typeof token === "string" &&
    token.startsWith(SHARE_TOKEN_PREFIX) &&
    token.length >= SHARE_TOKEN_PREFIX.length + 16 &&
    token.length <= 120
  );
}

/** A share name as it appears in URLs: lower case, letters, digits, `-` and `_`. */
export function shareSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export const SHARE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const SHARED_AS_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

export class DeltaSharingError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

export function deltaErrorBody(errorCode: string, message: string) {
  return { errorCode, message };
}

/**
 * The parts of a Delta Sharing path after the prefix:
 *   /shares
 *   /shares/{share}
 *   /shares/{share}/schemas
 *   /shares/{share}/all-tables
 *   /shares/{share}/schemas/{schema}/tables
 *   /shares/{share}/schemas/{schema}/tables/{table}/{version|metadata|query}
 */
export type SharePath = {
  share?: string;
  schema?: string;
  table?: string;
  op?: "version" | "metadata" | "query" | "schemas" | "tables" | "all-tables";
};

export function parseSharePath(pathname: string): SharePath {
  const rest = pathname.replace(/\/+$/, "").slice(DELTA_SHARING_PREFIX.length);
  const parts = rest.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "shares") return {};
  const out: SharePath = {};
  if (parts[1]) out.share = parts[1];
  if (parts[2] === "schemas" && !parts[3]) out.op = "schemas";
  if (parts[2] === "all-tables") out.op = "all-tables";
  if (parts[2] === "schemas" && parts[3]) {
    out.schema = parts[3];
    if (parts[4] === "tables" && !parts[5]) out.op = "tables";
    if (parts[4] === "tables" && parts[5]) {
      out.table = parts[5];
      if (parts[6] === "version" || parts[6] === "metadata" || parts[6] === "query") {
        out.op = parts[6];
      }
    }
  }
  return out;
}

// --- Schema ------------------------------------------------------------------

/**
 * A DuckDB column type as the Spark type name Delta Sharing's schemaString
 * uses. Anything without a Spark counterpart travels as a string, which is
 * what the Parquet file will carry for it as well.
 */
export function sparkTypeOf(duckType: string): string {
  const t = duckType.trim().toUpperCase();
  const decimal = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(t);
  if (decimal) return `decimal(${decimal[1]},${decimal[2]})`;
  switch (t) {
    case "BOOLEAN":
      return "boolean";
    case "TINYINT":
      return "byte";
    case "SMALLINT":
      return "short";
    case "INTEGER":
    case "INT":
    case "UINTEGER":
      return "integer";
    case "BIGINT":
    case "HUGEINT":
    case "UBIGINT":
      return "long";
    case "FLOAT":
    case "REAL":
      return "float";
    case "DOUBLE":
      return "double";
    case "DATE":
      return "date";
    case "TIMESTAMP":
    case "TIMESTAMP WITH TIME ZONE":
    case "TIMESTAMPTZ":
    case "TIMESTAMP_S":
    case "TIMESTAMP_MS":
    case "TIMESTAMP_NS":
      return "timestamp";
    case "BLOB":
      return "binary";
    default:
      return "string";
  }
}

export type ShareColumn = { name: string; type: string };

/** The `schemaString` a metaData action carries: a Spark StructType as JSON. */
export function sparkSchemaString(columns: ShareColumn[]): string {
  return JSON.stringify({
    type: "struct",
    fields: columns.map((c) => ({
      name: c.name,
      type: sparkTypeOf(c.type),
      nullable: true,
      metadata: {},
    })),
  });
}

// --- Actions -----------------------------------------------------------------

export type ShareFile = {
  url: string;
  id: string;
  size: number;
  numRecords: number;
  expirationTimestamp: number;
};

export function protocolAction() {
  return { protocol: { minReaderVersion: 1 } };
}

export function metaDataAction(args: {
  id: string;
  name: string;
  columns: ShareColumn[];
  numFiles: number;
  size: number;
}) {
  return {
    metaData: {
      id: args.id,
      name: args.name,
      format: { provider: "parquet" },
      schemaString: sparkSchemaString(args.columns),
      partitionColumns: [],
      configuration: {},
      numFiles: args.numFiles,
      size: args.size,
    },
  };
}

export function fileAction(f: ShareFile) {
  return {
    file: {
      url: f.url,
      id: f.id,
      partitionValues: {},
      size: f.size,
      stats: JSON.stringify({ numRecords: f.numRecords }),
      expirationTimestamp: f.expirationTimestamp,
    },
  };
}

/** One JSON object per line, each line terminated — what the clients parse. */
export function ndjson(actions: unknown[]): string {
  return actions.map((a) => JSON.stringify(a)).join("\n") + "\n";
}

/** The profile file a recipient loads into their client. */
export function shareProfile(endpoint: string, bearerToken: string, expiresAt?: string | null) {
  return {
    shareCredentialsVersion: 1,
    endpoint,
    bearerToken,
    ...(expiresAt ? { expirationTime: expiresAt } : {}),
  };
}

/** The query body a client sends; every field is optional and advisory. */
export function readQueryBody(body: unknown): {
  limitHint: number | null;
  predicateHints: string[];
  version: number | null;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const limit =
    typeof b.limitHint === "number" && b.limitHint >= 0 ? Math.floor(b.limitHint) : null;
  const hints = Array.isArray(b.predicateHints)
    ? b.predicateHints.filter((h): h is string => typeof h === "string")
    : [];
  const version = typeof b.version === "number" ? b.version : null;
  return { limitHint: limit, predicateHints: hints, version };
}
