// The lake's published default credentials (VA-2026-10-25-44, R414).
//
// A Compose install copies .env.example, which ships LAKEHOUSE_S3_SECRET =
// agentswarms-lake-dev (on the bundled MinIO, the ROOT password) and the
// catalog password change-me. Only setup-k8s.sh generated a lake secret. Both
// services sit on the Compose network with spark-connect, where pipelines'
// Python UDFs run, so on a fresh Compose install any pipeline author could read
// and rewrite every table. The installers now replace the S3 secret, and
// Monitoring calls out either default from the app's own configuration.
//
// R415: the catalog's password is the one the installers must NOT replace on
// an existing install. Postgres takes it when it creates its volume and never
// again, so they generate it only where Docker says there is no volume yet.
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

describe("the installers leave a catalog that already holds data on its password (R415)", () => {
  const sh = readFileSync(resolve("scripts/setup.sh"), "utf-8");
  const ps = readFileSync(resolve("scripts/setup.ps1"), "utf-8").replace(/\r\n/g, "\n");
  const between = (s: string, from: string, to: string) => {
    const i = s.indexOf(from);
    const j = s.indexOf(to, i + from.length);
    expect(i, from).toBeGreaterThan(-1);
    expect(j, to).toBeGreaterThan(i);
    return s.slice(i, j);
  };
  const shBlock = between(sh, "catalog_volume() {", "# The app runs on the HOST in --dev");
  const psBlock = between(
    ps,
    "function Get-CatalogVolumeState {",
    "# The app runs on the HOST in -Dev",
  );

  it("looks up the volume Compose actually mounts, by project", () => {
    const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as {
      services: Record<string, { volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };
    expect(compose.services["lakehouse-catalog"].volumes).toContain(
      "lakehouse-catalog-data:/var/lib/postgresql/data",
    );
    expect(Object.keys(compose.volumes)).toContain("lakehouse-catalog-data");
    for (const block of [shBlock, psBlock]) {
      expect(block).toContain("label=com.docker.compose.volume=lakehouse-catalog-data");
      expect(block).toContain("label=com.docker.compose.project=$project");
      expect(block).toMatch(/docker compose config 2>(\/dev\/|\$)null/);
    }
  });

  it("generates only when Docker says there is no volume, and otherwise leaves .env alone", () => {
    expect(shBlock).toContain("rc=0; catalog_volume || rc=$?");
    const shGen = between(shBlock, 'if [ "$rc" -eq 1 ]; then', 'elif [ "$rc" -eq 0 ]; then');
    const shRest = between(shBlock, 'elif [ "$rc" -eq 0 ]; then', "\nfi\n");
    expect(shGen).toContain('setenv LAKEHOUSE_CATALOG_PASSWORD "$LH_PW"');
    expect(shRest).not.toContain("setenv");
    expect(shRest).toContain("ALTER USER lakehouse PASSWORD");

    expect(psBlock).toContain("$catalogVolume = Get-CatalogVolumeState");
    const psGen = between(
      psBlock,
      "if ($catalogVolume -eq 1) {",
      "} elseif ($catalogVolume -eq 0) {",
    );
    const psRest = between(psBlock, "} elseif ($catalogVolume -eq 0) {", "\n}\n");
    expect(psGen).toContain('Set-EnvVar "LAKEHOUSE_CATALOG_PASSWORD" $lhPw');
    expect(psRest).not.toContain("Set-EnvVar");
    expect(psRest).toContain("ALTER USER lakehouse PASSWORD");
  });

  it("reads a Docker that cannot answer as 'can't say', never as 'no volume'", () => {
    const shFn = between(shBlock, "catalog_volume() {", "\n}\n");
    expect(shFn).toContain("command -v docker >/dev/null 2>&1 || return 2");
    expect(shFn).toContain('[ -n "$project" ] || return 2');
    expect(shFn).toMatch(/lakehouse-catalog-data 2>\/dev\/null\)" \|\| return 2/);
    expect(shFn).not.toMatch(/return 1/);

    const psFn = between(psBlock, "function Get-CatalogVolumeState {", "\n}\n");
    // Under the script's "Stop", Windows PowerShell would throw on docker's stderr.
    expect(psFn).toContain('$ErrorActionPreference = "Continue"');
    // Measured: piped into Select-Object -First 1, `docker compose config` was
    // stopped mid-output and $LASTEXITCODE read -1 on five runs of five, so a
    // catalog with no volume read as "can't say" and never got a password.
    expect(psFn).toMatch(
      /\$config = docker compose config 2>\$null\n\s*if \(\$LASTEXITCODE -ne 0\) \{ return 2 \}/,
    );
    expect(psFn).not.toMatch(/docker [^\n]*\|\s*Select-/);
    expect(psFn).toContain("if (-not $line) { return 2 }");
    expect(psFn.match(/if \(\$LASTEXITCODE -ne 0\) \{ return 2 \}/g)).toHaveLength(2);
    expect(psFn).toContain("} catch { return 2 }");
    expect(psFn.match(/return 1/g)).toHaveLength(1);
  });

  it("points a dev install at the password Compose gives an empty one", () => {
    expect(sh).toContain(
      '"postgres://lakehouse:${LH_PW:-change-me}@127.0.0.1:55432/lakehouse_catalog"',
    );
    expect(
      between(ps, 'if ([string]::IsNullOrEmpty($lhPw)) { $lhPw = "change-me" }', "if ($Dev) {"),
    ).toBeTruthy();
  });
});
