// The online feature store, checked in the source.
//
// The rules are in featureStore.test.ts and the protocol is in resp.test.ts.
// These are the promises neither can keep, and nearly all of them are about
// one property: THE STORE IS NEVER AUTHORITATIVE. A lookup it cannot answer
// must read the lakehouse and return the same rows it always did. Every way of
// breaking that is silent — the wrong numbers still score, and a slower path
// still answers — so each is pinned here.
import { readFileSync } from "node:fs";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const LOOKUP = rd("src/utils/featureViews/lookup.server.ts");
const ONLINE = rd("src/utils/featureStore/online.server.ts");
const CLIENT = rd("src/utils/featureStore/client.server.ts");
const FNS = rd("src/utils/featureViews.functions.ts");
const VIEWS = rd("src/lib/featureViews.ts");
const COMPOSE = rd("docker-compose.yml");

/** Source with line comments stripped, for anything the prose also mentions. */
const codeOnly = (src: string) => src.replace(/^\s*\/\/.*$/gm, "");

/**
 * scanSql's body, to its closing brace.
 *
 * Read to the end of the FUNCTION rather than a fixed number of characters: a
 * first version sliced 1,600 and failed the moment the explanation above the
 * code grew, which is a guard reporting on its own window size instead of on
 * the thing it guards.
 */
function scanSqlBody(): string {
  const from = VIEWS.slice(VIEWS.indexOf("export function scanSql"));
  return from.slice(0, from.indexOf("\n}"));
}

describe("a lookup the store cannot answer still answers", () => {
  it("the store is tried first, and its misses become the lakehouse's keys", () => {
    const fn = LOOKUP.slice(LOOKUP.indexOf("export async function lookupFeatures"));
    expect(fn).toContain("const online = await readOnline(");
    expect(fn).toContain("const wanted = online ? online.misses : args.keys;");
    expect(fn).toContain("lookupSql(args.view, wanted)");
  });

  it("and the lakehouse query is still the one that ran before", () => {
    // The fallback is not a reimplementation. It is the same governed
    // statement, through the same chokepoint, with the same audit trail.
    const fn = LOOKUP.slice(LOOKUP.indexOf("export async function lookupFeatures"));
    expect(fn).toContain("await runLakehouseStatement(");
    expect(fn).toContain('auditVia: args.via ?? "feature-lookup"');
  });

  it("rows from both halves are matched to keys together", () => {
    // resolveRows pairs by fingerprint rather than by order, so a half-warm
    // lookup cannot attribute a stored row to the wrong key.
    const fn = LOOKUP.slice(LOOKUP.indexOf("export async function lookupFeatures"));
    expect(fn).toContain("resolveRows(args.view, args.keys, [...fromStore, ...rows])");
  });

  it("and the row cap counts the keys actually being read", () => {
    // `args.keys.length + 1` with a warm store asks the engine for room the
    // query does not need — harmless today, and wrong in the direction that
    // stops being harmless when the cap is what bounds a runaway query.
    const fn = LOOKUP.slice(LOOKUP.indexOf("export async function lookupFeatures"));
    expect(fn).toContain("rowCap: wanted.length + 1");
    expect(fn).not.toContain("rowCap: args.keys.length + 1");
  });

  it("nothing in the store's own path can throw a lookup out", () => {
    // readOnline returns null for every refusal rather than raising, so the
    // caller has one shape to handle and no way to forget a catch.
    expect(ONLINE).toContain("): Promise<{");
    expect(codeOnly(ONLINE)).not.toMatch(/throw new Error/);
  });
});

describe("a store that is down costs nothing", () => {
  it("a failure opens a breaker rather than being caught per call", () => {
    // A try/catch still pays the timeout on every request. 500 lookups against
    // a dead socket at two seconds each is an outage caused by an optimisation.
    expect(CLIENT).toContain("breakerUntil = Date.now() + BREAKER_MS");
    expect(CLIENT).toContain("if (Date.now() < breakerUntil) return null;");
  });

  it("and the breaker is checked BEFORE anything is connected or sent", () => {
    const fn = CLIENT.slice(CLIENT.indexOf("export async function call("));
    const breaker = fn.indexOf("breakerUntil");
    const connect = fn.indexOf("connect()");
    expect(breaker).toBeGreaterThan(-1);
    expect(breaker).toBeLessThan(connect);
  });

  it("a command that never comes back drops the socket", () => {
    // The reply may still arrive, and it would be handed to whoever asked
    // next: every answer after it would belong to the wrong caller.
    const fn = CLIENT.slice(CLIENT.indexOf("export async function call("));
    expect(fn).toContain("COMMAND_TIMEOUT_MS");
    expect(fn).toContain("fail(`no reply within");
  });

  it("and the read path skips the store entirely while the breaker is open", () => {
    expect(ONLINE).toContain("if (storeStatus().breakerOpen) return null;");
  });
});

describe("what the refresh will and will not copy", () => {
  it("reads through the governed chokepoint, like every other read", () => {
    // A serving path with its own connection would be a way to read a table
    // the caller cannot read.
    const fn = ONLINE.slice(ONLINE.indexOf("export async function refreshView"));
    expect(fn).toContain("await runLakehouseStatement(userId, scanSql(view, after, want)");
    expect(fn).toContain('auditVia: "feature-store-refresh"');
  });

  it("pages by key, never by offset", () => {
    // LIMIT/OFFSET with no promised order lets two pages overlap and miss —
    // the same unsoundness that made a distributed fit read the wrong rows.
    const scan = scanSqlBody();
    expect(scan).toContain("ORDER BY ${order} LIMIT ${limit}");
    expect(codeOnly(scan)).not.toMatch(/OFFSET/);
    expect(scan).toContain("(${order}) > (");
  });

  it("refuses a view whose key is not unique instead of picking a row", () => {
    // Verified against DuckDB: 500 rows under 91 keys page out as 442 with
    // repeats, so paging alone would have made a broken table invisible.
    expect(scanSqlBody()).toContain("count(*) OVER (PARTITION BY ${order}) AS _fv_n");
    const fn = ONLINE.slice(ONLINE.indexOf("export async function refreshView"));
    expect(fn).toContain("if (!view.timestamp_column) {");
    expect(fn).toContain("Number(r._fv_n) > 1");
    expect(fn).toContain("has more than one row for");
  });

  it("stores the declared columns and nothing else", () => {
    // _fv_n is how the page reported duplicates. Stored, it would arrive at a
    // model as a feature it never trained on.
    const fn = ONLINE.slice(ONLINE.indexOf("export async function refreshView"));
    expect(fn).toContain("for (const c of [...view.key_columns, ...view.feature_columns])");
  });

  it("and writes each page in one pipelined call", () => {
    // 50,000 keys as 50,000 round trips would be slower than the lakehouse it
    // is replacing.
    const fn = ONLINE.slice(ONLINE.indexOf("export async function refreshView"));
    expect(fn).toContain("const acks = await call(writes);");
  });

  it("a refresh the store did not accept is a failure, not a silent partial", () => {
    const fn = ONLINE.slice(ONLINE.indexOf("export async function refreshView"));
    expect(fn).toContain("if (!acks) {");
    expect(fn).toContain("stopped answering after");
  });
});

describe("the store never outlives what it copied", () => {
  it("turning online serving off drops the rows", () => {
    // Left behind, a view turned back on later answers from whatever the table
    // looked like at some forgotten moment — and its meta says it is fresh,
    // because the meta records when it was written.
    const fn = FNS.slice(FNS.indexOf("export const featureViewSetOnline"));
    expect(fn).toContain("if (!data.enabled) await dropView(data.id);");
  });

  it("deleting the view drops them too", () => {
    const fn = FNS.slice(FNS.indexOf("export const featureViewDelete"));
    expect(fn.slice(0, 900)).toContain("await dropView(data.id);");
  });

  it("and a view edited since its refresh is refused, not served", () => {
    expect(ONLINE).toContain("storeRefusal(meta, viewDefinition(view), new Date()");
  });
});

describe("a view saved with no feature columns gets the real list", () => {
  it("resolved once, at save", () => {
    // Empty meant "every column that is not a key" on the table and meant
    // NOTHING in the code: lookupSql selects the keys plus the features, so an
    // empty list served a model the one column it was looked up BY. Seen live
    // on a view a trained model was already bound to.
    const fn = FNS.slice(FNS.indexOf("export const featureViewSave"));
    expect(fn).toContain("const resolved = effectiveFeatureColumns(");
    expect(fn).toContain("feature_columns: resolved,");
  });

  it("and a view saved before that is repaired when it is loaded", () => {
    expect(LOOKUP).toContain("async function repairFeatureColumns(");
    expect(LOOKUP).toContain("return view ? await repairFeatureColumns(view, userId) : null;");
  });

  it("a table with nothing left to serve is refused rather than saved empty", () => {
    const fn = FNS.slice(FNS.indexOf("export const featureViewSave"));
    expect(fn).toContain("has no columns left to serve as features");
  });
});

describe("the service ships the way the rest of the stack does", () => {
  const compose = yaml.load(COMPOSE) as {
    services: Record<string, Record<string, unknown>>;
    volumes?: Record<string, unknown>;
  };
  const valkey = compose.services.valkey as Record<string, unknown>;

  it("is valkey, not redis", () => {
    // Redis moved to RSALv2/SSPL, which this project cannot ship in its own
    // stack. Same protocol, so FEATURE_STORE_URL may still name a Redis.
    expect(String(valkey.image)).toMatch(/^valkey\/valkey:/);
  });

  it("keeps nothing on disk, on purpose", () => {
    // Everything in it is a copy of rows the lake holds. A restored cache the
    // lake never had is worse than an empty one.
    expect(valkey.volumes).toBeUndefined();
    const args = JSON.stringify(valkey.command ?? []);
    expect(args).toContain("--save");
    expect(args).toContain("--appendonly");
    expect(JSON.stringify(compose.volumes ?? {})).not.toContain("valkey");
  });

  it("evicts rather than refusing writes when it is full", () => {
    // A full store that refuses writes fails a refresh. One that drops its
    // coldest keys serves what it has and sends the rest to the lakehouse.
    expect(JSON.stringify(valkey.command ?? [])).toContain("allkeys-lru");
  });

  it("is not published to the host", () => {
    // A feature store on a laptop's loopback is one anybody on that laptop can
    // read, and it holds whatever the feature table holds.
    expect(valkey.ports).toBeUndefined();
  });

  it("restarts by itself and answers a health check with its own client", () => {
    expect(valkey.restart).toBe("unless-stopped");
    expect(JSON.stringify(valkey.healthcheck)).toContain("valkey-cli");
  });

  it("and carries the `all` profile like every other optional service", () => {
    expect(valkey.profiles).toContain("featurestore");
    expect(valkey.profiles).toContain("all");
  });

  it("the Kubernetes workload claims no volume either", () => {
    const text = rd("deploy/k8s/app/services.yaml");
    const block = text.slice(text.indexOf("name: agentswarms-valkey"));
    const mine = block.slice(0, block.indexOf("\n---"));
    // NO STORAGE OF ANY KIND, not merely no PVC. A mutation pass attached an
    // emptyDir-style mount to this pod and the first version of this test —
    // which looked for `persistentVolumeClaim` and `volumeClaimTemplates` —
    // did not notice, because those are only two of the ways to give a
    // container a disk. The claim being made is that the store keeps nothing,
    // so the check is that it mounts nothing.
    expect(mine).not.toContain("volumeMounts");
    expect(mine).not.toContain("volumes:");
    expect(mine).not.toContain("persistentVolumeClaim");
    expect(mine).not.toContain("volumeClaimTemplates");
    // Recreate, because two pods behind one Service would each hold half the
    // keys and a lookup's hit rate would depend on which it reached.
    expect(mine).toContain("type: Recreate");
  });
});
