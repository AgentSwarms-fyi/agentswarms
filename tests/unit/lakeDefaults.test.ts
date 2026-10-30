// The lake's published default credentials (VA-2026-10-25-44, R414).
//
// A Compose install copies .env.example, which ships LAKEHOUSE_S3_SECRET =
// agentswarms-lake-dev (on the bundled MinIO, the ROOT password) and the
// catalog password change-me. Only setup-k8s.sh generated a lake secret. Both
// services sit on the Compose network with spark-connect, where pipelines'
// Python UDFs run, so on a fresh Compose install any pipeline author could read
// and rewrite every table. The installers now replace the S3 secret, and
// Monitoring calls out either default from the app's own configuration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import {
  PUBLISHED_LAKE_DEFAULTS,
  publishedDefaultWarnings,
  withPublishedDefaultWarnings,
  type ServiceProbe,
} from "@/lib/serviceHealth";

const envExample = Object.fromEntries(
  readFileSync(resolve(".env.example"), "utf-8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)="?([^"]*)"?\s*$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);

const probe = (id: ServiceProbe["id"], status: ServiceProbe["status"] = "up"): ServiceProbe => ({
  id,
  label: id,
  purpose: "",
  status,
  latencyMs: 1,
  endpoint: null,
});

describe("what counts as a published default", () => {
  it("is exactly what .env.example and the Compose fallbacks ship", () => {
    expect(envExample.LAKEHOUSE_S3_SECRET).toBe(PUBLISHED_LAKE_DEFAULTS.s3Secret);
    expect(envExample.LAKEHOUSE_CATALOG_PASSWORD).toBe(PUBLISHED_LAKE_DEFAULTS.catalogPassword);
    const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(compose.services.minio.environment?.MINIO_ROOT_PASSWORD).toBe(
      `\${LAKEHOUSE_S3_SECRET:-${PUBLISHED_LAKE_DEFAULTS.s3Secret}}`,
    );
    expect(compose.services["lakehouse-catalog"].environment?.POSTGRES_PASSWORD).toBe(
      `\${LAKEHOUSE_CATALOG_PASSWORD:-${PUBLISHED_LAKE_DEFAULTS.catalogPassword}}`,
    );
  });

  it("flags both on an install configured straight from .env.example", () => {
    const w = publishedDefaultWarnings(envExample);
    expect(w.minio).toMatch(/LAKEHOUSE_S3_SECRET=agentswarms-lake-dev/);
    expect(w.minio).toMatch(/docker compose up -d minio agentswarms/);
    expect(w["lakehouse-catalog"]).toMatch(/change-me/);
    expect(w["lakehouse-catalog"]).toMatch(/ALTER USER/);
  });

  it("flags nothing once both are replaced, and reads an encoded password correctly", () => {
    expect(
      publishedDefaultWarnings({
        LAKEHOUSE_S3_SECRET: "9f8e7d",
        LAKEHOUSE_CATALOG_URL:
          "postgres://lakehouse:s3cr%40t@lakehouse-catalog:5432/lakehouse_catalog",
      }),
    ).toEqual({});
    expect(
      publishedDefaultWarnings({
        LAKEHOUSE_CATALOG_URL: "postgres://lakehouse:change%2Dme@lakehouse-catalog:5432/x",
      })["lakehouse-catalog"],
    ).toBeDefined();
    expect(publishedDefaultWarnings({ LAKEHOUSE_CATALOG_URL: "not a url" })).toEqual({});
  });
});

describe("how Monitoring shows it", () => {
  it("degrades a service that answers, with the reason, and leaves the rest alone", () => {
    const out = withPublishedDefaultWarnings(
      [probe("minio"), probe("lakehouse-catalog", "down"), probe("valkey")],
      { minio: "default!", "lakehouse-catalog": "default too" },
    );
    expect(out[0]).toMatchObject({ id: "minio", status: "degraded", message: "default!" });
    // Down says more than "on a default"; it stays down.
    expect(out[1].status).toBe("down");
    expect(out[2]).toEqual(probe("valkey"));
  });

  it("is applied to every answer the health handler gives", () => {
    const fn = readFileSync(resolve("src/utils/monitoring.functions.ts"), "utf-8");
    expect(fn).toMatch(
      /const services = withPublishedDefaultWarnings\(\s*\[app, db, \.\.\.rest\],\s*publishedDefaultWarnings\(process\.env\),\s*\);\s*return \{ services,/,
    );
  });
});

describe("the installers replace the S3 secret", () => {
  it("when it is empty or the published default, on fresh and existing installs alike", () => {
    const sh = readFileSync(resolve("scripts/setup.sh"), "utf-8");
    const ps = readFileSync(resolve("scripts/setup.ps1"), "utf-8").replace(/\r\n/g, "\n");
    expect(sh).toContain(
      'if [ -z "$S3_SECRET" ] || [ "$S3_SECRET" = "agentswarms-lake-dev" ]; then',
    );
    expect(sh).toMatch(/setenv LAKEHOUSE_S3_SECRET "\$\(gen_secret\)"/);
    expect(ps).toContain(
      'if ([string]::IsNullOrEmpty($s3Secret) -or $s3Secret -eq "agentswarms-lake-dev") {',
    );
    expect(ps).toMatch(/Set-EnvVar "LAKEHOUSE_S3_SECRET" \(New-Secret\)/);
  });
});
