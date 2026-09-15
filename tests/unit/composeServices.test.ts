// Every service starts with every install.
//
// This file replaced composeProfiles.test.ts, which guarded the opposite
// arrangement: seven services behind compose profiles, and a check that each
// profiled service also carried `all` so `--profile all` could not silently
// skip one. That arrangement is gone. A product whose features depend on which
// flag the installer was given is a product most installs never see, and the
// support question "is X installed?" now has one answer.
//
// What must stay true: nothing in the compose file is profiled, the installers
// still accept the flags people have in their notes, and those flags change
// nothing about what runs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

type ComposeFile = { services: Record<string, { profiles?: string[] }> };
const compose = yaml.load(readFileSync(resolve("docker-compose.yml"), "utf-8")) as ComposeFile;
const services = Object.entries(compose.services);
const setupSh = readFileSync(resolve("scripts/setup.sh"), "utf-8");
const setupPs = readFileSync(resolve("scripts/setup.ps1"), "utf-8");

const LEGACY_FLAGS = [
  "all",
  "docgen",
  "notebooks",
  "sandbox",
  "lakehouse",
  "spark",
  "vectors",
  "featurestore",
];

describe("docker compose starts the whole product", () => {
  it("declares no profiles at all, so `docker compose up -d` is the whole install", () => {
    const profiled = services
      .filter(([, s]) => Array.isArray(s.profiles) && s.profiles.length > 0)
      .map(([name]) => name);
    expect(
      profiled,
      `these services would not start on a plain up: ${profiled.join(", ")}`,
    ).toEqual([]);
  });

  it("ships the services the product needs, the object store included", () => {
    const names = services.map(([n]) => n);
    for (const required of [
      "agentswarms",
      "notebook-gateway",
      "notebook-egress",
      "notebook-docker-proxy",
      "lakehouse-catalog",
      "minio",
      "minio-init",
      "qdrant",
      "valkey",
      "spark-connect",
      "docgen",
      "js-sandbox",
    ]) {
      expect(names, `${required} is not in docker-compose.yml`).toContain(required);
    }
  });

  it("publishes every service a host-run app has to reach on loopback only", () => {
    // `scripts/setup.sh --dev` runs the app on the host and points .env at
    // 127.0.0.1, so development gets the same product rather than a subset.
    // Loopback, not 0.0.0.0: a vector store on a laptop's public interface is
    // a vector store the network can read.
    for (const name of ["qdrant", "valkey", "lakehouse-catalog", "spark-connect", "minio"]) {
      const ports = (compose.services[name] as { ports?: string[] }).ports ?? [];
      expect(ports.length, `${name} publishes no port for --dev`).toBeGreaterThan(0);
      for (const p of ports)
        expect(p, `${name} publishes ${p} beyond loopback`).toMatch(/^127\.0\.0\.1:/);
    }
  });
});

describe("the installers", () => {
  it.each(LEGACY_FLAGS)("still accept --%s and do nothing with it", (flag) => {
    expect(setupSh, `setup.sh rejects --${flag}`).toMatch(
      new RegExp(
        `--all\\|--docgen\\|--notebooks\\|--sandbox\\|--lakehouse\\|--spark\\|--vectors\\|--featurestore\\) ;;`,
      ),
    );
    const sw = flag[0].toUpperCase() + flag.slice(1);
    expect(setupPs, `setup.ps1 has no -${sw}`).toContain(`[switch]$${sw}`);
  });

  it("start everything with one plain compose command, in both modes", () => {
    expect(setupSh).toContain("docker compose up -d --build");
    expect(setupSh).not.toMatch(/docker compose \$PROFILE_FLAGS/);
    expect(setupPs).toContain("docker compose up -d --build");
    expect(setupPs).not.toContain("@profiles");
  });

  it("point .env at every service, and at loopback when the app runs on the host", () => {
    for (const key of [
      "QDRANT_URL",
      "FEATURE_STORE_URL",
      "SPARK_CONNECT_URL",
      "LAKEHOUSE_S3_ENDPOINT",
    ]) {
      expect(setupSh, `setup.sh does not set ${key} for --dev`).toContain(`setenv ${key} `);
      expect(setupPs, `setup.ps1 does not set ${key} for -Dev`).toContain(`Set-EnvVar "${key}"`);
    }
    // The catalog password exists in two places that must carry the same value.
    expect(setupSh).toContain("setenv LAKEHOUSE_CATALOG_PASSWORD");
    expect(setupSh).toContain("setenv LAKEHOUSE_CATALOG_URL");
    expect(setupPs).toContain('Set-EnvVar "LAKEHOUSE_CATALOG_PASSWORD"');
    expect(setupPs).toContain('Set-EnvVar "LAKEHOUSE_CATALOG_URL"');
  });

  it(".env.example arrives wired, for the operator who never runs an installer", () => {
    // compose's own header tells people to `cp .env.example .env` and run
    // `docker compose up -d --build`. That path has to produce the same
    // product the installer does.
    const env = readFileSync(resolve(".env.example"), "utf-8");
    for (const line of [
      'VECTOR_STORE="qdrant"',
      'QDRANT_URL="http://qdrant:6333"',
      'FEATURE_STORE_URL="redis://valkey:6379"',
      'SPARK_CONNECT_URL="sc://spark-connect:15002"',
      'LAKEHOUSE_DATA_URL="s3://lakehouse/main"',
      'LAKEHOUSE_S3_ENDPOINT="minio:9000"',
      "LAKEHOUSE_CATALOG_URL=",
    ]) {
      expect(env, `.env.example does not set ${line}`).toContain(line);
    }
  });
});

describe("the Kubernetes installer deploys the same set", () => {
  const k8s = readFileSync(resolve("scripts/setup-k8s.sh"), "utf-8");

  it("applies the notebook and Spark manifests, not only the app ones", () => {
    expect(k8s).toContain("deploy/k8s/notebooks/notebook-runtime.yaml");
    expect(k8s).toContain("deploy/k8s/spark/spark-runtime.yaml");
  });

  it("substitutes every image, including the two the notebook manifest names", () => {
    for (const image of [
      "agentswarms/docgen:latest",
      "agentswarms/js-sandbox:latest",
      "agentswarms/notebook-gateway:latest",
      "agentswarms/notebook-runtime:latest",
    ]) {
      expect(k8s, `${image} is not rewritten for a remote registry`).toContain(`image: ${image}`);
    }
  });

  it("wires the app at every service it just deployed", () => {
    for (const key of [
      "VECTOR_STORE",
      "QDRANT_URL",
      "FEATURE_STORE_URL",
      "LAKEHOUSE_DATA_URL",
      "LAKEHOUSE_S3_ENDPOINT",
      "NOTEBOOK_RUNTIME_BACKEND",
      "SPARK_PROVIDER",
    ]) {
      expect(k8s, `the agentswarms-env secret has no ${key}`).toContain(`--from-literal=${key}=`);
    }
  });
});
