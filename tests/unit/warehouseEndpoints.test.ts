// Private endpoints for BigQuery, Redshift and Athena (private connectivity,
// Phase 3, R426).
//
// These engines are called at a host the app builds. A deployment without
// private DNS calls the private endpoint by its own name: a Private Service
// Connect name for BigQuery (the token through the same endpoint), an
// interface endpoint's `vpce-…` name for Redshift's Data API and Athena. The
// override must be exactly that engine's name for the connection's region:
// these requests are signed, so it can never aim them elsewhere, not even at
// a customer-controlled name under amazonaws.com. Each driver is run here with
// the fetch layer replaced, and what it actually sent is read back: the host,
// and for AWS a SigV4 signature recomputed from the request as sent.
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Sent = { url: string; headers: Record<string, string>; body: string };
const sent: Sent[] = [];
let reply: (url: string, body: string) => unknown = () => ({});
vi.mock("@/utils/http/connectorFetch.server", () => ({
  connectorFetch: async (
    url: string,
    init: { headers?: Record<string, string>; body?: string },
  ) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v;
    sent.push({ url, headers, body: init?.body ?? "" });
    return new Response(JSON.stringify(reply(url, init?.body ?? "")), { status: 200 });
  },
  proxyForUrl: () => null,
}));

const answers: Record<string, string[]> = {};
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    const a = answers[host];
    if (!a) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return a.map((address) => ({ address, family: 4 }));
  },
}));

const { warehouseApiOrigin, warehouseEndpointProblem, bigqueryTokenUrl } =
  await import("@/utils/warehouse/endpoints");
const { warehouseHosts } = await import("@/utils/warehouse/destinations");
const { executeWarehouseQuery } = await import("@/utils/warehouse/drivers.server");
const { assertWarehouseNetwork } = await import("@/utils/warehouse/network.server");
type Cfg = Parameters<typeof executeWarehouseQuery>[0];

beforeEach(() => {
  sent.length = 0;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(() => {
  delete process.env.HTTPS_PROXY;
});

const VPCE_RS = "https://vpce-0abc123-xyz.redshift-data.us-east-1.vpce.amazonaws.com";
const VPCE_ATHENA = "https://vpce-0abc123-xyz.athena.eu-west-1.vpce.amazonaws.com";
const PSC = "https://bigquery-myendpoint.p.googleapis.com";

const problem = (cfg: Record<string, unknown>) => warehouseEndpointProblem(cfg as never);

describe("the endpoint a connection may name", () => {
  it("none: the public host, as before", () => {
    expect(warehouseApiOrigin({ provider: "bigquery" })).toBe("https://bigquery.googleapis.com");
    expect(warehouseApiOrigin({ provider: "redshift", region: "us-east-1" })).toBe(
      "https://redshift-data.us-east-1.amazonaws.com",
    );
    expect(warehouseApiOrigin({ provider: "athena", region: "eu-west-1" })).toBe(
      "https://athena.eu-west-1.amazonaws.com",
    );
  });

  it("each engine's own private names, in the connection's region", () => {
    expect(warehouseApiOrigin({ provider: "bigquery", endpoint: `${PSC}/` })).toBe(PSC);
    expect(
      warehouseApiOrigin({ provider: "redshift", region: "us-east-1", endpoint: VPCE_RS }),
    ).toBe(VPCE_RS);
    expect(
      warehouseApiOrigin({
        provider: "athena",
        region: "eu-west-1",
        endpoint: VPCE_ATHENA.toUpperCase().replace("HTTPS", "https"),
      }),
    ).toBe(VPCE_ATHENA);
    // The FIPS name is AWS's own too.
    expect(
      problem({
        provider: "redshift",
        region: "us-east-1",
        endpoint: "https://redshift-data-fips.us-east-1.amazonaws.com",
      }),
    ).toBeNull();
  });

  it("never a name a customer controls, even under amazonaws.com or googleapis.com", () => {
    for (const endpoint of [
      "https://evil.test",
      "https://ec2-52-1-2-3.compute-1.amazonaws.com",
      "https://my-lb-1234.us-east-1.elb.amazonaws.com",
      "https://bucket.s3-website-us-east-1.amazonaws.com",
      "https://vpce-0abc.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      "https://vpce-0abc.redshift-data.us-west-2.vpce.amazonaws.com",
      "https://redshift-data.us-east-1.amazonaws.com.evil.test",
    ]) {
      expect(problem({ provider: "redshift", region: "us-east-1", endpoint }), endpoint).toMatch(
        /^Redshift endpoint must be redshift-data's own address in us-east-1 — expected something like https:\/\/vpce-/,
      );
    }
    for (const endpoint of [
      "https://storage-myendpoint.p.googleapis.com",
      "https://bigquery-thisnameiswaytoolong21.p.googleapis.com",
      "https://bigquery-1abc.p.googleapis.com",
      "https://bigquery-x.p.googleapis.com.evil.test",
      "https://attacker.googleapis.com",
    ]) {
      expect(problem({ provider: "bigquery", endpoint }), endpoint).toMatch(
        /^BigQuery endpoint must be a Private Service Connect name/,
      );
    }
  });

  it("an address only: https, no port, path, query or credentials", () => {
    const cases: [string, RegExp][] = [
      ["http://vpce-0abc.athena.eu-west-1.vpce.amazonaws.com", /must use https/],
      ["https://vpce-0abc.athena.eu-west-1.vpce.amazonaws.com:8443", /must not name a port/],
      ["https://vpce-0abc.athena.eu-west-1.vpce.amazonaws.com/x", /no path/],
      ["https://vpce-0abc.athena.eu-west-1.vpce.amazonaws.com/?a=1", /no path/],
      ["https://u:p@vpce-0abc.athena.eu-west-1.vpce.amazonaws.com", /credentials/],
      ["not a url", /not a valid URL/],
    ];
    for (const [endpoint, why] of cases) {
      expect(problem({ provider: "athena", region: "eu-west-1", endpoint }), endpoint).toMatch(why);
    }
  });

  it("a Redshift region is a region: it can no longer move the host", () => {
    expect(problem({ provider: "redshift", region: "x.attacker.test/" })).toMatch(
      /^Redshift region "x\.attacker\.test\/" is not a region name/,
    );
    expect(problem({ provider: "athena", region: "eu-west-1#" })).toMatch(/Athena region/);
    expect(problem({ provider: "postgres", host: "anything" })).toBeNull();
  });

  it("BigQuery's token comes through the same Private Service Connect endpoint", () => {
    expect(bigqueryTokenUrl(PSC)).toBe("https://oauth2-myendpoint.p.googleapis.com/token");
    expect(bigqueryTokenUrl(undefined)).toBeUndefined();
  });
});

describe("the hosts the network and shared-secret checks see", () => {
  it("follow the override", () => {
    expect(warehouseHosts({ provider: "bigquery", endpoint: PSC } as unknown as Cfg)).toEqual([
      PSC,
      "https://oauth2-myendpoint.p.googleapis.com",
    ]);
    expect(warehouseHosts({ provider: "bigquery" } as unknown as Cfg)).toEqual([
      "https://bigquery.googleapis.com",
      "https://oauth2.googleapis.com",
    ]);
    expect(
      warehouseHosts({
        provider: "redshift",
        region: "us-east-1",
        endpoint: VPCE_RS,
      } as unknown as Cfg),
    ).toEqual([VPCE_RS]);
    expect(warehouseHosts({ provider: "athena", region: "eu-west-1" } as unknown as Cfg)).toEqual([
      "https://athena.eu-west-1.amazonaws.com",
    ]);
  });

  it("require a private path: the endpoint's private name passes where the public one is refused", async () => {
    answers["vpce-0abc123-xyz.athena.eu-west-1.vpce.amazonaws.com"] = ["10.0.7.9"];
    answers["athena.eu-west-1.amazonaws.com"] = ["52.95.110.1"];
    const athena = (endpoint?: string) =>
      ({
        provider: "athena",
        region: "eu-west-1",
        access_key_id: "AKIA",
        secret_access_key: "s",
        require_private: true,
        ...(endpoint ? { endpoint } : {}),
      }) as unknown as Cfg;
    await expect(assertWarehouseNetwork(athena(VPCE_ATHENA))).resolves.toBeUndefined();
    await expect(assertWarehouseNetwork(athena())).rejects.toThrow(/private network path/);
  });
});

// ── The drivers send to the endpoint, signed for it ──────────────────────────

const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const sha = (d: string) => createHash("sha256").update(d).digest("hex");

/** Recompute the SigV4 signature for a request as it was sent. */
function expectedSignature(req: Sent, secret: string, service: string): string {
  const host = new URL(req.url).host;
  const auth = req.headers.authorization;
  const scope = /Credential=[^/]+\/([^,]+),/.exec(auth)![1];
  const [date, region] = scope.split("/");
  const signed = /SignedHeaders=([^,]+),/.exec(auth)![1].split(";");
  const value = (h: string) => (h === "host" ? host : req.headers[h]);
  const canonical = `POST\n/\n\n${signed.map((h) => `${h}:${value(h)}\n`).join("")}\n${signed.join(";")}\n${sha(req.body)}`;
  const toSign = `AWS4-HMAC-SHA256\n${req.headers["x-amz-date"]}\n${scope}\n${sha(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
  return hmac(key, toSign).toString("hex");
}

describe("each driver calls the endpoint it was given", () => {
  it("Redshift: every Data API call goes to the interface endpoint, signed for that host", async () => {
    reply = (_url, body) => {
      const p = JSON.parse(body) as Record<string, unknown>;
      if ("Sql" in p) return { Id: "st-1" };
      if (sent.length === 2) return { Status: "FINISHED" };
      return { ColumnMetadata: [{ name: "one", typeName: "int4" }], Records: [[{ longValue: 1 }]] };
    };
    const res = await executeWarehouseQuery(
      {
        provider: "redshift",
        region: "us-east-1",
        access_key_id: "AKIATEST",
        secret_access_key: "secret-r426",
        database: "dev",
        workgroup_name: "wg",
        endpoint: VPCE_RS,
      } as unknown as Cfg,
      "select 1",
    );
    expect(res.rows ?? res).toBeTruthy();
    expect(sent.map((r) => new URL(r.url).origin)).toEqual([VPCE_RS, VPCE_RS, VPCE_RS]);
    for (const r of sent) {
      expect(r.headers.authorization).toContain("/us-east-1/redshift-data/aws4_request");
      expect(r.headers.authorization).toContain(
        `Signature=${expectedSignature(r, "secret-r426", "redshift-data")}`,
      );
    }
  });

  it("Athena: the same, session token included", async () => {
    reply = (_url, body) => {
      const p = JSON.parse(body) as Record<string, unknown>;
      if ("QueryString" in p) return { QueryExecutionId: "q-1" };
      if (!("MaxResults" in p)) return { QueryExecution: { Status: { State: "SUCCEEDED" } } };
      return {
        ResultSet: {
          Rows: [{ Data: [{ VarCharValue: "one" }] }, { Data: [{ VarCharValue: "1" }] }],
          ResultSetMetadata: { ColumnInfo: [{ Name: "one", Type: "integer" }] },
        },
      };
    };
    await executeWarehouseQuery(
      {
        provider: "athena",
        region: "eu-west-1",
        access_key_id: "AKIATEST",
        secret_access_key: "secret-a426",
        session_token: "tok-a426",
        output_location: "s3://b/r/",
        endpoint: VPCE_ATHENA,
      } as unknown as Cfg,
      "select 1",
    );
    expect(sent.map((r) => new URL(r.url).origin)).toEqual([VPCE_ATHENA, VPCE_ATHENA, VPCE_ATHENA]);
    for (const r of sent) {
      expect(r.headers["x-amz-security-token"]).toBe("tok-a426");
      expect(r.headers.authorization).toContain(
        `Signature=${expectedSignature(r, "secret-a426", "athena")}`,
      );
    }
  });

  it("without an endpoint, both still call their regional names", async () => {
    reply = (_url, body) => {
      const p = JSON.parse(body) as Record<string, unknown>;
      if ("Sql" in p) return { Id: "st-2" };
      if (sent.length === 2) return { Status: "FINISHED" };
      return { ColumnMetadata: [], Records: [] };
    };
    await executeWarehouseQuery(
      {
        provider: "redshift",
        region: "us-east-1",
        access_key_id: "AKIATEST",
        secret_access_key: "s",
        database: "dev",
        workgroup_name: "wg",
      } as unknown as Cfg,
      "select 1",
    );
    expect(new Set(sent.map((r) => new URL(r.url).origin))).toEqual(
      new Set(["https://redshift-data.us-east-1.amazonaws.com"]),
    );
  });

  it("BigQuery: the token and the queries through the PSC endpoint; the JWT's audience stays Google's", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const sa = JSON.stringify({
      client_email: "r426@test.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    });
    reply = (url) =>
      url.includes("/token")
        ? { access_token: "at-r426" }
        : { jobComplete: true, schema: { fields: [{ name: "one", type: "INTEGER" }] }, rows: [] };
    const run = (endpoint?: string) =>
      executeWarehouseQuery(
        {
          provider: "bigquery",
          project_id: "p",
          service_account_json: sa,
          ...(endpoint ? { endpoint } : {}),
        } as unknown as Cfg,
        "select 1",
      );

    await run(PSC);
    expect(sent.map((r) => r.url.split("?")[0])).toEqual([
      "https://oauth2-myendpoint.p.googleapis.com/token",
      `${PSC}/bigquery/v2/projects/p/queries`,
    ]);
    const assertion = decodeURIComponent(/assertion=([^&]+)/.exec(sent[0].body)![1]);
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(sent[1].headers.authorization).toBe("Bearer at-r426");

    sent.length = 0;
    await run();
    expect(sent.map((r) => new URL(r.url).origin)).toEqual([
      "https://oauth2.googleapis.com",
      "https://bigquery.googleapis.com",
    ]);
  });
});

describe("where it is wired", () => {
  it("a save refuses a bad endpoint or region in words, before anything is stored", () => {
    const f = readFileSync("src/utils/warehouse.functions.ts", "utf8");
    const save = f.slice(f.indexOf("export const saveWarehouseConnection"));
    const check = save.indexOf("const endpointProblem = warehouseEndpointProblem(config);");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(save.indexOf("await encryptJson(config, { owner: userId })"));
    expect(save).toContain("if (endpointProblem) return { ok: false, error: endpointProblem };");
  });

  it("the form offers the field to these three engines", () => {
    const ui = readFileSync("src/components/integrations/WarehousesTab.tsx", "utf8");
    for (const engine of ["redshift", "bigquery", "athena"]) {
      expect(ui).toContain(`placeholder: WAREHOUSE_ENDPOINT_EXAMPLE.${engine},`);
    }
  });
});
