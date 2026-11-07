// A Hive Metastore's address, as somebody would paste it.
//
// What an admin has is hive.metastore.uris from hive-site.xml, so that is what
// the form takes: `thrift://hms.internal:9083`. A bare host works too, on the
// default port. Shared because the wizard checks it beside the field and the
// server decides by the same rule.

export const HIVE_DEFAULT_PORT = 9083;

export type MetastoreAddress = { host: string; port: number };

export function parseMetastoreUri(
  raw: string,
): ({ ok: true } & MetastoreAddress) | { ok: false; error: string } {
  const value = raw.trim();
  if (value === "") return { ok: false, error: "Enter the metastore's address." };
  // hive.metastore.uris may list several for failover. Engines walk the list;
  // this connector reads from one, and picking for someone would hide that.
  if (value.includes(",")) {
    return { ok: false, error: "Enter one metastore: its list is for an engine's failover." };
  }
  const m = /^(?:thrift:\/\/)?(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::(\d+))?\/?$/.exec(value);
  if (!m) {
    return {
      ok: false,
      error: /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
        ? "A metastore's address starts with thrift://, for example thrift://hms.internal:9083."
        : "That is not a host name. For example: thrift://hms.internal:9083.",
    };
  }
  const port = m[2] === undefined ? HIVE_DEFAULT_PORT : Number(m[2]);
  if (port < 1 || port > 65535) return { ok: false, error: "A port is between 1 and 65535." };
  return { ok: true, host: m[1].replace(/^\[|\]$/g, ""), port };
}
