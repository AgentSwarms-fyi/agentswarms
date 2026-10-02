// Every service this project ships is described everywhere an operator looks.
//
// THIS EXISTS BECAUSE THE LOOP WAS ME REMEMBERING, AND I DID NOT. Services
// were added over several milestones — the lakehouse catalog, the Spark
// cluster, the vector store — and each time, some of the places that describe
// the shipped system were updated and some were not. The result is the worst
// kind of documentation: confident, specific, and wrong. INSTALL.md said "five
// more services" while compose had six of them; the in-app self-hosting page
// listed three and had not been touched since; the sizing guide's table of
// what consumes resources never learned that a vector index wants RAM.
//
// None of that is catchable by reading the diff of the feature you are adding,
// because the stale files are not in it. So the check is mechanical and it is
// keyed on `docker-compose.yml`, which is the one file that cannot be wrong
// about what exists: if it is not in there, it does not ship.
//
// Adding a service now means this file fails until every surface knows about
// it. That is the point.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { docsFamilyFiles } from "./docsPages";

const rd = (p: string) => readFileSync(p, "utf8");

type ComposeFile = {
  services: Record<string, { profiles?: string[]; image?: string }>;
};
const compose = yaml.load(rd("docker-compose.yml")) as ComposeFile;

/**
 * Services that never actually run.
 *
 * `notebook-runtime-image` exists so `--build` produces the kernel image the
 * orchestrator launches; its entrypoint exits immediately. `minio-init`
 * creates the lakehouse bucket and exits. Nothing to document, nothing to
 * monitor, nothing to size.
 */
const ONE_SHOT = new Set(["notebook-runtime-image", "minio-init"]);

const runnable = Object.entries(compose.services)
  .filter(([name]) => !ONE_SHOT.has(name))
  .map(([name]) => ({ name }));

/** Every service compose starts — which is all of them; there are no profiles. */
const SERVICES = runnable.map((s) => s.name).sort();

const K8S_FILES = [
  "deploy/k8s/app/agentswarms.yaml",
  "deploy/k8s/app/services.yaml",
  "deploy/k8s/notebooks/notebook-runtime.yaml",
  "deploy/k8s/spark/spark-runtime.yaml",
];
const k8sText = K8S_FILES.map(rd).join("\n");

/**
 * Services with no Kubernetes workload, and why — each reason checked against
 * the code that makes it true, so an exemption cannot outlive its reason.
 *
 * Both are Compose-only by DESIGN rather than by omission: in Kubernetes the
 * same job is done by something the cluster already provides.
 */
const NO_K8S_WORKLOAD: Record<string, { because: string; provenBy: [string, RegExp] }> = {
  // The Docker socket proxy is how the `docker` runtime backend starts kernel
  // containers. In Kubernetes the backend is `k8s` and kernels are pods,
  // created through the API with the notebook-orchestrator ServiceAccount —
  // there is no Docker socket to proxy.
  "notebook-docker-proxy": {
    because: "Kubernetes uses the k8s runtime backend, which creates kernel pods through the API",
    provenBy: ["src/utils/notebookRuntime/config.server.ts", /RuntimeBackend = "docker" \| "k8s"/],
  },
  // A static Spark Connect endpoint is one provider of two. The Kubernetes
  // path is `SPARK_PROVIDER=k8s`, which creates a driver and executors PER
  // RUN — which is exactly what deploy/k8s/spark provisions.
  "spark-connect": {
    because: "Kubernetes uses the per-run Spark provider, which creates a driver pod per run",
    provenBy: ["src/utils/etl/sparkCluster.server.ts", /one cluster PER RUN/],
  },
};

describe("every service that ships is deployable on Kubernetes", () => {
  it.each(runnable)("$name has a workload, or a reason it does not", ({ name }) => {
    if (name in NO_K8S_WORKLOAD) {
      const { provenBy } = NO_K8S_WORKLOAD[name];
      const [file, pattern] = provenBy;
      // The exemption is only valid while the code it claims still says so.
      expect(
        rd(file),
        `${name} is exempt from Kubernetes for a reason ${file} no longer supports`,
      ).toMatch(pattern);
      return;
    }
    expect(k8sText, `${name} has no Kubernetes manifest and no stated exemption`).toContain(name);
  });

  it("says in the manifests which Compose services have no Kubernetes equivalent", () => {
    // An operator comparing compose to the cluster finds two services missing
    // and has no way to tell "deliberate" from "forgotten". The answer belongs
    // where they are looking.
    // Every manifest, because the explanation belongs in the file an operator
    // opens looking for that service — the Spark one in the Spark manifest.
    const notes = K8S_FILES.map(rd).join("\n");
    for (const name of Object.keys(NO_K8S_WORKLOAD)) {
      expect(notes, `nothing in the manifests explains why ${name} is not here`).toContain(name);
    }
  });
});

describe("every service is documented where somebody would look", () => {
  const installSection = (() => {
    const s = rd("docs/INSTALL.md");
    const i = s.indexOf("## 7. The services");
    return s.slice(i, s.indexOf("\n## ", i + 1));
  })();

  const appSection = (() => {
    const s = rd("src/routes/docs.self-hosting.tsx");
    const i = s.indexOf('<H2 id="services">');
    return s.slice(i, s.indexOf("<H2", i + 1));
  })();

  /** How each compose service is spelled where operators read about it. */
  const IN_PROSE: Record<string, RegExp> = {
    agentswarms: /app|application/i,
    docgen: /docgen|document renderer|doc-gen/i,
    "js-sandbox": /js.sandbox|javascript sandbox/i,
    "notebook-gateway": /notebook|developer.workspace/i,
    "notebook-egress": /notebook|egress/i,
    "notebook-docker-proxy": /notebook|docker/i,
    "lakehouse-catalog": /lakehouse.catalog/i,
    minio: /minio|object store/i,
    qdrant: /qdrant|vector store/i,
    valkey: /valkey|feature store/i,
    "spark-connect": /spark/i,
  };

  it.each(SERVICES)("INSTALL.md's service table covers %s", (name) => {
    const pattern = IN_PROSE[name];
    expect(pattern, `${name} has no prose spelling — add one with the service`).toBeTruthy();
    expect(pattern.test(installSection), `INSTALL.md §7 does not cover ${name}`).toBe(true);
  });

  it.each(SERVICES)("the in-app self-hosting page covers %s", (name) => {
    const pattern = IN_PROSE[name];
    expect(pattern.test(appSection), `the in-app services table does not cover ${name}`).toBe(true);
  });

  // NOTHING may still call these optional. The word was true when seven of
  // them sat behind compose profiles; now it tells a reader they can skip a
  // service the product assumes is there — and the installers no longer offer
  // any way to skip one.
  const COUNTED = [
    "README.md",
    "docs/DEPLOYMENT.md",
    "docs/INSTALL.md",
    "docs/SYSTEM_REQUIREMENTS.md",
    ...docsFamilyFiles("self-hosting"),
  ];

  it.each(COUNTED)("%s does not describe the services as optional", (file) => {
    const text = rd(file);
    const claims = [
      ...text.matchAll(
        /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|[0-9]+)\s+(?:more\s+)?optional\s+(?:profiles?|services?)\b/gi,
      ),
      ...text.matchAll(/\boptional\s+(?:compose\s+)?profiles?\b/gi),
    ].map((m) => `"${m[0]}"`);
    expect(claims, `${file} still calls shipped services optional: ${claims.join(", ")}`).toEqual(
      [],
    );
  });

  it("the in-app page does not claim a count of its own", () => {
    // It said "All three are optional" while offering three of six. A page
    // that enumerates is allowed; a page that counts has to keep counting.
    expect(appSection.toLowerCase()).not.toMatch(/all (three|four|five|six|seven) are optional/);
  });
});

describe("the sizing guide knows what each service costs", () => {
  // docs/SYSTEM_REQUIREMENTS.md §1 is the table somebody reads to decide how
  // big a machine to buy. A service missing from it is a service whose RAM
  // they did not budget for — which for a vector index is the entire point of
  // running it.
  const sizing = (() => {
    const s = rd("docs/SYSTEM_REQUIREMENTS.md");
    const i = s.indexOf("## 1. What actually consumes resources");
    return s.slice(i, s.indexOf("\n## ", i + 1));
  })();

  /** What each service is called in prose, where that differs from compose. */
  const LABELS: Record<string, RegExp> = {
    agentswarms: /App server/i,
    "notebook-gateway": /Notebook \/ MCP runtime|Developer workspace/i,
    "notebook-docker-proxy": /Notebook \/ MCP runtime|Developer workspace/i,
    "notebook-egress": /Notebook \/ MCP runtime|Developer workspace/i,
    docgen: /docgen|Document renderer/i,
    "js-sandbox": /JS sandbox|JavaScript sandbox/i,
    "lakehouse-catalog": /[Ll]akehouse catalog/,
    "spark-connect": /Spark/,
    qdrant: /[Vv]ector store|Qdrant/,
    valkey: /[Oo]nline feature store|[Vv]alkey/,
    minio: /[Oo]bject store|MinIO/,
  };

  /**
   * The first cell of each row — the component's NAME, not its description.
   *
   * Matching the whole section was too weak: renaming the vector store's row
   * still passed, because the words "Qdrant" and "vector store" appear in the
   * text of other rows. Having a row is the claim being checked, so rows are
   * what gets read.
   */
  const rowLabels = [...sizing.matchAll(/^\| ([^|]+?) *\|/gm)]
    .map((m) => m[1].trim())
    .filter((l) => l && !/^-+$/.test(l) && l !== "Component");

  it.each(runnable)("$name has a row of its own in the resource table", ({ name }) => {
    const pattern = LABELS[name];
    expect(pattern, `${name} has no label mapping — add one when you add the service`).toBeTruthy();
    expect(
      rowLabels.filter((l) => pattern.test(l)),
      `no row in the sizing guide is about ${name} — the rows are: ${rowLabels.join(", ")}`,
    ).not.toHaveLength(0);
  });
});
