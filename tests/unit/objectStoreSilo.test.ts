// The bundled object store is SILO, and stays a drop-in for what was there (R418).
//
// MinIO stopped publishing images anyone can pull (VA-2026-10-25-35): Docker
// Hub's minio/minio is gone and quay.io answers 401 to an anonymous pull, so a
// fresh install failed at the lakehouse's object store and the cached build
// could not be patched (23 fixable criticals in the server image by R418's
// scan). SILO is a maintained fork with the same S3 API, MINIO_* settings,
// health paths and on-disk format; what was measured against it is in
// docs/LAKEHOUSE.md and objectStoreLakeLive.test.ts.
//
// What this file holds still: the swap stays in place (same service, volume,
// settings, health check), both manifests pin the same builds by digest, and
// the two things the swap found broken stay fixed.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const compose = rd("docker-compose.yml");
const k8s = rd("deploy/k8s/app/services.yaml");

/** The block of one compose service, up to the next service. */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `no ${name} service`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const imageOf = (block: string) => /\n\s+image: (\S+)/.exec(block)?.[1] ?? "";
const PINNED = /^[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/;

describe("the swap is in place", () => {
  it("runs SILO and its client, pinned by digest", () => {
    expect(imageOf(service("minio"))).toMatch(
      /^pgsty\/silo:RELEASE\.[\dT-]+Z@sha256:[0-9a-f]{64}$/,
    );
    expect(imageOf(service("minio-init"))).toMatch(
      /^pgsty\/mc:RELEASE\.[\dT-]+Z@sha256:[0-9a-f]{64}$/,
    );
    expect(imageOf(service("minio"))).toMatch(PINNED);
  });

  it("names no MinIO image anywhere it installs from", () => {
    // Neither can be pulled. One left behind is an install that stops there.
    for (const [name, text] of [
      ["docker-compose.yml", compose],
      ["deploy/k8s/app/services.yaml", k8s],
    ] as const) {
      expect(text, name).not.toMatch(/image:\s*(quay\.io\/)?minio\/(minio|mc)\b/);
    }
  });

  it("keeps the service, the volume, the settings and the health check", () => {
    // What makes `docker compose up -d` a replacement in place rather than a
    // second store beside the first: the name `minio` (which an existing
    // .env reaches as minio:9000), the same volume, MINIO_* from the same
    // variables, and the same command.
    const minio = service("minio");
    expect(minio).toContain("- lake-data:/data");
    expect(minio).toContain("MINIO_ROOT_USER: ${LAKEHOUSE_S3_KEY_ID:-agentswarms}");
    expect(minio).toContain("MINIO_ROOT_PASSWORD: ${LAKEHOUSE_S3_SECRET:-agentswarms-lake-dev}");
    expect(minio).toContain('command: server /data --console-address ":9001"');
    // SILO ships its client as mcli with an `mc` alias, and `mc ready local`
    // passed inside the pinned image (measured).
    expect(minio).toContain('test: ["CMD", "mc", "ready", "local"]');
    expect(service("minio-init")).toContain("minio: { condition: service_healthy }");
    expect(rd(".env.example")).toContain('LAKEHOUSE_S3_ENDPOINT="minio:9000"');
  });

  it("pins the same builds in Compose and on Kubernetes", () => {
    expect(k8s).toContain(`image: ${imageOf(service("minio"))}`);
    expect(k8s).toContain(`image: ${imageOf(service("minio-init"))}`);
    // The StatefulSet keeps its name and its claim, so the new image is a
    // rolling restart onto the same data.
    expect(k8s).toMatch(/kind: StatefulSet\nmetadata:\n {2}name: minio\n/);
    expect(k8s).toContain("httpGet: { path: /minio/health/ready, port: s3 }");
  });
});

describe("what the swap found broken stays fixed", () => {
  it("gives the bucket Job a writable mc config directory", () => {
    // Measured as uid 1000, with MinIO's client and with SILO's: `mc alias
    // set` failed with "mkdir /.mc: permission denied" and the Job's
    // until-loop retried it for ever, so Kubernetes never got its bucket.
    const job = k8s.slice(k8s.indexOf("name: minio-bucket"));
    expect(job).toMatch(/runAsUser: 1000/);
    expect(job).toMatch(/- name: MC_CONFIG_DIR\n\s+value: \/tmp\/\.mc/);
    expect(job).toContain("readOnlyRootFilesystem: false");
  });

  it("fails the weekly scan on an image that cannot be pulled", () => {
    // A warning while the MinIO pins could not be pulled by anyone. Every
    // image pulls now, so one that does not is an install that cannot start.
    const wf = rd(".github/workflows/image-scan.yml");
    const step = wf.slice(wf.indexOf("could not pull"));
    expect(wf).toContain('echo "::error::could not pull $img to scan it"');
    expect(step.slice(0, 200)).toContain("status=1");
    expect(wf).not.toContain("::warning::could not pull");
  });
});

describe("it says so where people look", () => {
  it("credits SILO and its licence", () => {
    const ack = rd("ACKNOWLEDGEMENTS.md");
    expect(ack).toContain("[SILO](https://github.com/pgsty/silo)");
    expect(ack).toMatch(/SILO[^\n]*AGPL-3\.0-or-later/);
  });

  it("names the store SILO on Monitoring, under the id saved state already uses", async () => {
    const { SERVICE_CATALOGUE } = await import("@/lib/serviceHealth");
    const row = SERVICE_CATALOGUE.find((s) => s.id === "minio");
    expect(row?.label).toBe("Object store (SILO)");
    expect(row?.path).toBe("/minio/health/ready");
  });

  it("documents the switch, the measurements and the way back", () => {
    const lake = rd("docs/LAKEHOUSE.md");
    expect(lake).toContain("### The bundled object store is SILO");
    expect(lake).toContain("MinIO opened the volume SILO had written");
    expect(rd("docs/DEPLOYMENT.md")).toContain("**The object store moves to SILO by itself.**");
    const live = rd("tests/unit/objectStoreLakeLive.test.ts");
    expect(live).toContain("it.skipIf(!live)");
    expect(live).toContain("pgsty/silo:RELEASE.");
  });
});
