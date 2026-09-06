// Reverse ETL into a CRM: push rows back into the tool they came from.
//
// One defect motivates this whole target, and most of these tests are about
// it: HubSpot and Salesforce answer 200 and report per-record failures INSIDE
// the body. The generic HTTP target calls raise_for_status(), sees 200, and
// records every row as loaded — so a run that pushed 5,000 contacts and had
// 4,000 rejected shows in the run history as a complete success. Silent, no
// error, invisible from outside. Everything below exists to make that case
// loud.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { compileGraph, requirementsFor, type EtlGraph } from "@/utils/etl/codegen";
import {
  SAAS_TARGETS,
  batchSizeFor,
  endpointPath,
  isWritableVendor,
  methodFor,
  readFailures,
  validateSaasTarget,
  type SaasTargetConfig,
} from "@/lib/saasTargets";
import { explainEtlError } from "@/utils/etl/explainError";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

const cfg = (over: Partial<SaasTargetConfig> = {}): SaasTargetConfig => ({
  type: "saas",
  connection_id: "conn-1",
  vendor: "hubspot",
  object: "contacts",
  id_column: "email",
  ...over,
});

describe("reading what the vendor actually said", () => {
  it("counts HubSpot's per-record errors inside a 200", () => {
    const { failed, messages } = readFailures(
      "hubspot",
      {
        status: "COMPLETE",
        numErrors: 2,
        errors: [{ message: "Property 'plan' does not exist" }, { message: "Invalid email" }],
        results: [{ id: "1" }],
      },
      3,
    );
    expect(failed).toBe(2);
    expect(messages[0]).toMatch(/does not exist/);
  });

  it("infers HubSpot failures from missing results when numErrors is absent", () => {
    // A partial success with no count still lost rows, and reporting zero
    // failures is the exact bug this target exists to prevent.
    expect(readFailures("hubspot", { results: [{ id: "1" }] }, 4).failed).toBe(3);
    // Mutation check: a full set of results is not a failure.
    expect(readFailures("hubspot", { results: [1, 2, 3, 4] }, 4).failed).toBe(0);
  });

  it("counts Salesforce records whose own success flag is false", () => {
    const { failed, messages } = readFailures(
      "salesforce",
      [
        { id: "001", success: true, errors: [] },
        { success: false, errors: [{ message: "Required fields missing", fields: ["Name"] }] },
      ],
      2,
    );
    expect(failed).toBe(1);
    expect(messages[0]).toBe("Required fields missing (Name)");
  });

  it("treats a Salesforce answer that is not a per-record list as a total failure", () => {
    // Not an array means the request was rejected wholesale. Reporting zero
    // failures there would be the silent success in its purest form.
    const r = readFailures("salesforce", { error: "INVALID_SESSION_ID" }, 50);
    expect(r.failed).toBe(50);
    expect(r.messages[0]).toMatch(/did not return a per-record result/);
  });

  it("says nothing failed when nothing failed", () => {
    expect(readFailures("hubspot", { status: "COMPLETE", results: [1, 2] }, 2).failed).toBe(0);
    expect(readFailures("salesforce", [{ success: true }, { success: true }], 2).failed).toBe(0);
  });
});

describe("the vendor's own rules", () => {
  it("never sends a bigger batch than the API accepts", () => {
    // Exceeding the cap rejects the whole batch, not one record — so the cap
    // belongs here rather than in a number a user has to look up.
    expect(batchSizeFor(cfg({ batch_size: 5000 }))).toBe(100);
    expect(batchSizeFor(cfg({ vendor: "salesforce", batch_size: 5000 }))).toBe(200);
    expect(batchSizeFor(cfg({ batch_size: 25 }))).toBe(25);
    expect(batchSizeFor(cfg({ batch_size: 0 }))).toBe(100);
  });

  it("upserts the way each vendor spells it", () => {
    expect(methodFor(cfg())).toBe("POST");
    expect(endpointPath(cfg())).toBe("/crm/v3/objects/contacts/batch/upsert");
    // Salesforce upserts by external id with PATCH, and the field is in the URL.
    const sf = cfg({ vendor: "salesforce", object: "Account", id_column: "ExtId__c" });
    expect(methodFor(sf)).toBe("PATCH");
    expect(endpointPath(sf)).toBe("/services/data/v61.0/composite/sobjects/Account/ExtId__c");
  });

  it("knows which connections can be written to at all", () => {
    expect(isWritableVendor("hubspot")).toBe(true);
    expect(isWritableVendor("salesforce")).toBe(true);
    // Read-only by design: creating a Stripe charge from a nightly pipeline is
    // a different kind of decision, and this is not the door for it.
    for (const p of ["stripe", "shopify", "jira", "zendesk", "google_sheets"]) {
      expect(isWritableVendor(p), p).toBe(false);
    }
  });
});

describe("what a target must say before it may run", () => {
  it("accepts a complete target", () => {
    expect(validateSaasTarget(cfg())).toBeNull();
  });

  it("refuses one that names nothing to write through or into", () => {
    expect(validateSaasTarget(cfg({ connection_id: undefined }))).toMatch(/connection/);
    expect(validateSaasTarget(cfg({ object: undefined }))).toMatch(/which HubSpot object/);
    expect(validateSaasTarget(cfg({ object: "invoices" }))).toMatch(/cannot be written as/);
    expect(validateSaasTarget(cfg({ id_column: "" }))).toMatch(/unique property/);
  });

  it("refuses a column name that is not one", () => {
    expect(validateSaasTarget(cfg({ id_column: "a'; DROP TABLE" }))).toMatch(/not a column name/);
  });

  it("refuses sending the identity as a field as well", () => {
    // An upsert key overwritten by a stale copy of itself is how records get
    // orphaned from the rows that were meant to update them.
    expect(validateSaasTarget(cfg({ columns: ["email", "firstname"] }))).toMatch(
      /cannot also be sent as a field/,
    );
    expect(validateSaasTarget(cfg({ columns: ["firstname"] }))).toBeNull();
  });
});

describe("the generated pipeline", () => {
  const graph = (over: Partial<SaasTargetConfig> = {}): EtlGraph =>
    ({
      nodes: [
        {
          id: "s1",
          kind: "source",
          label: "rows",
          config: { type: "http_api", url: "https://api.example.com/rows", records_path: "" },
        },
        { id: "t1", kind: "target", label: "CRM", config: cfg(over) },
      ],
      edges: [{ from: "s1", to: "t1" }],
    }) as unknown as EtlGraph;

  it("fails the run when the response reports rejected records", () => {
    // The single most important line in the generated program.
    const code = compileGraph(graph());
    expect(code).toContain("if _failed:");
    expect(code).toContain("HubSpot rejected ");
    expect(code).toContain("_payload.get('numErrors')");
  });

  it("reads Salesforce's per-record success flags", () => {
    const code = compileGraph(
      graph({ vendor: "salesforce", object: "Account", id_column: "Ext__c" }),
    );
    expect(code).toContain("_r.get('success')");
    expect(code).toContain("Salesforce did not return a per-record result");
    expect(code).toContain("'allOrNone': False");
  });

  it("refuses before the first request when the id column is not in the frame", () => {
    // Otherwise every record is rejected one batch at a time, which is a slow
    // and expensive way to learn a column is missing.
    const code = compileGraph(graph());
    expect(code).toContain("if 'email' not in _df.columns:");
    expect(code).toContain("column to identify records");
  });

  it("batches at the vendor's cap even when asked for more", () => {
    expect(compileGraph(graph({ batch_size: 5000 }))).toContain("range(0, len(_records), 100)");
  });

  it("takes the host and token from the environment, never from the graph", () => {
    // A graph is shared, exported and imported; a credential inside one would
    // travel with it.
    const code = compileGraph(graph());
    expect(code).toMatch(/_base = os\.environ\['ETL_[A-Z0-9_]+_BASE'\]/);
    expect(code).toMatch(/os\.environ\['ETL_[A-Z0-9_]+_TOKEN'\]/);
    expect(code).not.toContain("hubapi.com");
  });

  it("refuses to compile a target that is not fully configured", () => {
    expect(() => compileGraph(graph({ id_column: undefined }))).toThrow(/unique property/);
    expect(() => compileGraph(graph({ object: undefined }))).toThrow(/which HubSpot object/);
  });

  it("installs requests and never dlt", () => {
    // A CRM push does not touch a warehouse loader; paying for a large install
    // it never imports is a slower cold start for nothing.
    const reqs = requirementsFor(graph());
    expect(reqs).toContain("requests");
    expect(reqs).not.toContain("dlt[");
  });
});

describe("the wiring", () => {
  const service = rd("src/utils/etl/service.server.ts");
  const write = rd("src/utils/saas/write.server.ts");

  it("writes through a connection that already exists, not a second token", () => {
    expect(service).toContain("loadWritableConnection");
    expect(rd("src/routes/_authenticated/etl.tsx")).toContain("Pick a connected tool…");
  });

  it("decrypts the stored credential only server-side, and scrubs it", () => {
    expect(write).toContain("decryptJson");
    expect(service).toContain("secretValues.push(auth.token)");
  });

  it("lets a shared connection be read from but not written to", () => {
    // Pushing records into somebody else's CRM is a bigger step than reading
    // rows out of it, and the share was granted for the latter.
    expect(write).toContain('.eq("user_id", userId)');
    expect(write).toContain("OWNER-ONLY");
  });

  it("blames the proxy for a 403 that is not JSON, in the code itself", () => {
    // Found live: with the host missing from the allow-list the run failed
    // with `Salesforce 403: <!DOCTYPE html…` — squid's deny page, attributed
    // to Salesforce. The generated code knows which host it called and that a
    // 403 with a non-JSON body did not come from a JSON API.
    const code = rd("src/utils/etl/codegen.ts");
    expect(code).toContain("looks like the egress proxy");
    expect(code).toContain("'json' not in (_resp.headers.get('content-type') or '')");
  });

  it("recognises that hint in a traceback too", () => {
    const e = explainEtlError(
      "RuntimeError: Salesforce 403 (this looks like the egress proxy, not Salesforce: " +
        "add acme.my.salesforce.com to the allow-list under Admin -> Developer runtime): <!DOCTYPE html>",
    );
    expect(e?.kind).toBe("egress_blocked_saas");
    expect(e?.summary).toContain("acme.my.salesforce.com");
  });

  it("names the blocked host when the egress proxy refuses the CRM", () => {
    const e = explainEtlError(
      "requests.exceptions.ProxyError: Tunnel connection failed for api.hubapi.com: 403 Forbidden",
    );
    expect(e?.kind).toBe("egress_blocked_saas");
    expect(e?.summary).toContain("api.hubapi.com");
    expect(e?.summary).toMatch(/allow-list/);
  });

  it("offers the target where the other targets are", () => {
    expect(rd("src/utils/etl/nodeDefaults.ts")).toContain('{ type: "saas", label:');
  });

  it("documents the two implementations of one contract", () => {
    // The TypeScript reader cannot run in the sandbox and the Python one
    // cannot run in a unit test, so both exist — and both branch on the same
    // fields, which is what makes the tested one a specification.
    const code = rd("src/utils/etl/codegen.ts");
    for (const field of ["numErrors", "results", "success", "errors"]) {
      expect(code, field).toContain(field);
    }
    expect(code).toContain("Mirrors `readFailures`");
  });
});
