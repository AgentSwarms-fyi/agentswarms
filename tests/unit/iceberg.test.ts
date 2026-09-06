// Iceberg interop: what a catalog must say, the statements the engine is
// given, and (below) the wiring that attaches catalogs, mounts a namespace
// as a governed schema and publishes a table.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  defaultIcebergCatalog,
  describeIcebergEndpoint,
  icebergAlias,
  icebergAttachSql,
  icebergImportSql,
  icebergListNamespacesSql,
  icebergListTablesSql,
  icebergPublishSql,
  icebergSecretNames,
  icebergSecretSql,
  icebergViewName,
  icebergViewSql,
  validateIcebergCatalog,
  type IcebergCatalogConfig,
} from "@/utils/lakehouse/iceberg";

const cat = (over: Partial<IcebergCatalogConfig> = {}): IcebergCatalogConfig => ({
  ...defaultIcebergCatalog(),
  name: "lakekeeper",
  endpoint: "http://192.168.1.85:8181/",
  warehouse: "s3://iceberg/",
  ...over,
});

describe("what a catalog must say", () => {
  it("needs a name, an http endpoint and a warehouse, and the secrets its auth needs", () => {
    expect(validateIcebergCatalog(cat({ name: "Bad Name" }))).toContain("lowercase letters");
    expect(validateIcebergCatalog(cat({ endpoint: "catalog.example.com" }))).toContain(
      "http(s) URL",
    );
    expect(validateIcebergCatalog(cat({ warehouse: " " }))).toContain("warehouse is required");
    expect(validateIcebergCatalog(cat({ auth_type: "bearer" }))).toContain(
      "secret holding the token",
    );
    expect(
      validateIcebergCatalog(cat({ auth_type: "bearer", token_secret: "ICE_TOKEN" })),
    ).toBeNull();
    expect(validateIcebergCatalog(cat({ auth_type: "oauth2", client_id_secret: "A" }))).toContain(
      "client id and the client secret",
    );
    expect(
      validateIcebergCatalog(
        cat({
          auth_type: "oauth2",
          client_id_secret: "A",
          client_secret_secret: "B",
          oauth2_server_uri: "nope",
        }),
      ),
    ).toContain("OAuth2 server URI");
    expect(validateIcebergCatalog(cat())).toBeNull();
  });

  it("names the secrets per auth type, and none for an open catalog", () => {
    expect(icebergSecretNames(cat())).toEqual([]);
    expect(icebergSecretNames(cat({ auth_type: "bearer", token_secret: "T" }))).toEqual([
      { key: "token", secret: "T" },
    ]);
    expect(
      icebergSecretNames(
        cat({ auth_type: "oauth2", client_id_secret: "A", client_secret_secret: "B" }),
      ),
    ).toEqual([
      { key: "client_id", secret: "A" },
      { key: "client_secret", secret: "B" },
    ]);
  });
});

describe("what the engine is told", () => {
  const alias = icebergAlias("3f2b1c9e-0000-4000-8000-0000000000ab");

  it("the alias is an identifier; the endpoint rides ATTACH; the auth is a secret, or none", () => {
    expect(alias).toBe("ice_3f2b1c9e0000400080000000000000ab");
    expect(icebergSecretSql(alias, cat(), {})).toBeNull();
    expect(icebergAttachSql(alias, cat())).toBe(
      `ATTACH IF NOT EXISTS 's3://iceberg/' AS "${alias}" (TYPE iceberg, ENDPOINT 'http://192.168.1.85:8181', AUTHORIZATION_TYPE 'none', READ_ONLY false);`,
    );
    const bearer = icebergSecretSql(alias, cat({ auth_type: "bearer", token_secret: "T" }), {
      token: "it's",
    });
    expect(bearer).toBe(`CREATE OR REPLACE SECRET "${alias}" (TYPE iceberg, TOKEN 'it''s');`);
    const oauth = icebergSecretSql(
      alias,
      cat({
        auth_type: "oauth2",
        client_id_secret: "A",
        client_secret_secret: "B",
        oauth2_server_uri: "https://auth.example.com/token",
      }),
      { client_id: "id", client_secret: "sec" },
    );
    expect(oauth).toContain(
      "CLIENT_ID 'id', CLIENT_SECRET 'sec', OAUTH2_SERVER_URI 'https://auth.example.com/token'",
    );
    expect(icebergAttachSql(alias, cat({ auth_type: "bearer", token_secret: "T" }))).toContain(
      `ENDPOINT 'http://192.168.1.85:8181', SECRET "${alias}", READ_ONLY false);`,
    );
  });

  it("lists namespaces and tables through DuckDB's catalog functions (the attached catalog has no information_schema)", () => {
    expect(icebergListNamespacesSql(alias)).toContain(
      `FROM duckdb_schemas() WHERE database_name = '${alias}'`,
    );
    expect(icebergListTablesSql(alias, "sales")).toContain(
      `FROM duckdb_tables() WHERE database_name = '${alias}' AND schema_name = 'sales'`,
    );
  });

  it("a mount is a view per table under the lakehouse schema; names are made safe", () => {
    expect(icebergViewName("Orders-2026")).toBe("orders_2026");
    expect(icebergViewName("9lives")).toBeNull();
    expect(icebergViewSql("ice_sales", "orders", alias, "sales", "orders")).toBe(
      `CREATE OR REPLACE VIEW "ice_sales"."orders" AS SELECT * FROM "${alias}"."sales"."orders"`,
    );
  });

  it("publishing creates the namespace then the table from the governed lakehouse table; import is the reverse", () => {
    const [ns, ct] = icebergPublishSql({
      alias,
      namespace: "sales",
      table: "revenue_facts",
      sourceSchema: "analytics",
      sourceTable: "revenue_facts",
      mode: "create",
    });
    expect(ns).toBe(`CREATE SCHEMA IF NOT EXISTS "${alias}"."sales";`);
    expect(ct).toBe(
      `CREATE TABLE "${alias}"."sales"."revenue_facts" AS SELECT * FROM "lake"."analytics"."revenue_facts";`,
    );
    // The extension has no CREATE OR REPLACE: replace is a drop then a create.
    const replace = icebergPublishSql({
      alias,
      namespace: "sales",
      table: "t",
      sourceSchema: "a",
      sourceTable: "b",
      mode: "replace",
    });
    expect(replace[1]).toBe(`DROP TABLE IF EXISTS "${alias}"."sales"."t";`);
    expect(replace[2]).toContain(`CREATE TABLE "${alias}"."sales"."t" AS`);
    expect(
      icebergImportSql({
        alias,
        namespace: "sales",
        table: "orders",
        targetSchema: "analytics",
        targetTable: "orders_from_iceberg",
        mode: "create",
      }),
    ).toBe(
      `CREATE TABLE "lake"."analytics"."orders_from_iceberg" AS SELECT * FROM "${alias}"."sales"."orders";`,
    );
  });

  it("an endpoint is shown without credentials or a trailing slash", () => {
    expect(describeIcebergEndpoint("https://user:pw@catalog.example.com/api/")).toBe(
      "https://catalog.example.com/api",
    );
  });
});

const rd = (p: string) => readFileSync(p, "utf8");

describe("the wiring", () => {
  it("the engine loads the extension and attaches every active catalog at boot, never fatally", () => {
    const core = rd("src/utils/lakehouse/core.server.ts");
    expect(core).toContain("INSTALL iceberg;");
    expect(core).toContain("LOAD iceberg;");
    expect(core).toContain("m.ensureIcebergCatalogs(c)");
    expect(core).toContain(
      '.select("id, name, user_id, description, lake_source_id, iceberg_catalog_id, iceberg_namespace")',
    );
    // A user statement may name no catalog but the lakehouse's own.
    expect(core).toContain('if (ref.catalog && ref.catalog !== "lake") {');
    const server = rd("src/utils/lakehouse/iceberg.server.ts");
    expect(server).toContain(".update({ last_error: message })");
    // A dead endpoint is retried on a backoff, never on every sync, and a
    // forced sync (a statement that met the missing catalog) tries at once.
    expect(server).toContain("const RETRY_FAILED_MS = 5 * 60_000;");
    expect(server).toContain(
      "if (!force && now - (failedAt.get(row.id) ?? 0) < RETRY_FAILED_MS) continue;",
    );
    expect(server).toContain("failedAt.set(row.id, Date.now());");
    expect(server).toContain("failedAt.delete(row.id);");
    expect(server).toContain('action: "lakehouse.iceberg.mount"');
    expect(server).toContain('action: "lakehouse.iceberg.publish"');
    expect(server).toContain('action: "lakehouse.iceberg.import"');
  });

  it("a mount is read-only wherever a lake mount is, and the catalog's secrets resolve as the owner", () => {
    expect(rd("src/utils/lakehouse/tables.server.ts")).toContain(
      "writable: s.user_id === userId && !s.lake_source_id && !s.iceberg_catalog_id,",
    );
    expect(
      (
        rd("src/utils/lakehouse.functions.ts").match(
          /schemaRow\.lake_source_id \|\| schemaRow\.iceberg_catalog_id/g,
        ) ?? []
      ).length,
    ).toBe(2);
    expect(rd("src/utils/lakehouse/matviews.server.ts")).toContain(
      "schemaRow.lake_source_id || schemaRow.iceberg_catalog_id",
    );
    const server = rd("src/utils/lakehouse/iceberg.server.ts");
    expect(server).toContain("await resolveSecretRefs(userId, ref)");
    expect(server).toContain("is not set for this account (Settings → Secrets)");
  });

  it("the page offers the catalogs, the badge, no new-table on a mount, and publish on a table tab; the docs and migration follow", () => {
    const page = rd("src/routes/_authenticated/lakehouse.tsx");
    expect(page).toContain("<IcebergCatalogsDialog onChanged={reload} />");
    expect(page).toContain("<PublishToIcebergDialog schema={schema} table={table} />");
    expect(page).toContain("{!s.lake_source_id && !s.iceberg_catalog_id && (");
    const sql = rd("supabase/migrations/20260867000000_iceberg_catalogs.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.iceberg_catalogs");
    expect(sql).toContain("audit_row_change('iceberg_catalog')");
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS iceberg_catalog_id uuid REFERENCES public.iceberg_catalogs(id) ON DELETE CASCADE",
    );
    expect(rd("docs/LAKEHOUSE.md")).toContain("## Iceberg interop");
    expect(rd("src/routes/docs.lakehouse.tsx")).toContain('<H2 id="iceberg">Iceberg interop</H2>');
  });
});
