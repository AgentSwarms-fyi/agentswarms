// Availability is a property of the shipped manifests, so it is pinned here.
// A stateless tier quietly dropped to one replica, or losing its disruption
// budget, is an outage nobody notices until a node drains.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");

/** The YAML documents of a manifest, split the way `---` separates them. */
function docs(path: string): string[] {
  return rd(path).split(/^---$/m);
}

/** The document that declares `kind` for `name`, or undefined. */
function objectOf(paths: string[], kind: string, name: string): string | undefined {
  for (const p of paths) {
    for (const d of docs(p)) {
      if (
        new RegExp(`^kind: ${kind}$`, "m").test(d) &&
        new RegExp(`^  name: ${name}$`, "m").test(d)
      )
        return d;
    }
  }
  return undefined;
}

const APP = "deploy/k8s/app/agentswarms.yaml";
const SERVICES = "deploy/k8s/app/services.yaml";
const NOTEBOOKS = "deploy/k8s/notebooks/notebook-runtime.yaml";
const ALL = [APP, SERVICES, NOTEBOOKS];

/** Every stateless tier, by the Deployment name and the component label it selects. */
const STATELESS = [
  { name: "agentswarms-web", component: "web" },
  // Carries the in-process scheduler: one replica means scheduled work stops
  // silently, because nothing is serving traffic to notice.
  { name: "agentswarms-analytics", component: "analytics" },
  { name: "agentswarms-docgen", component: "docgen" },
  { name: "agentswarms-js-sandbox", component: "js-sandbox" },
];

describe("the vector store survives losing a node", () => {
  // A vector index is stateful but REBUILDABLE: Postgres still holds every
  // chunk, so losing Qdrant costs a re-index rather than data. That is the
  // reason it can be clustered rather than treated like the catalog — and the
  // reason it should be, because a single node is an outage that turns
  // retrieval into keyword search until somebody notices.
  const sts = objectOf(ALL, "StatefulSet", "qdrant") ?? "";

  it("runs three nodes, which is what Raft needs to lose one", () => {
    expect(sts, "no qdrant StatefulSet").not.toBe("");
    const m = /^ {2}replicas: (\d+)$/m.exec(sts);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(3);
  });

  it("spreads them across nodes", () => {
    // Three replicas on one node is one node's worth of availability.
    expect(sts).toContain("topologySpreadConstraints");
    expect(sts).toContain("topologyKey: kubernetes.io/hostname");
    expect(sts).toContain("whenUnsatisfiable: ScheduleAnyway");
  });

  it("keeps a quorum through a node drain", () => {
    // minAvailable: 1 would let a drain take a three-node Raft cluster to one,
    // where the survivor cannot reach consensus on a write.
    const pdb = objectOf(ALL, "PodDisruptionBudget", "agentswarms-qdrant") ?? "";
    expect(pdb, "no PDB for qdrant").not.toBe("");
    const m = /minAvailable: (\d+)/.exec(pdb);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
  });

  it("finds its peers by a headless service, not a load balancer", () => {
    // Cluster members address each other by stable per-pod DNS. A ClusterIP
    // would round-robin the peer traffic and no cluster would ever form.
    const headless = objectOf(ALL, "Service", "qdrant-headless") ?? "";
    expect(headless).toContain("clusterIP: None");
    // And a joining peer must be reachable BEFORE it is ready, because
    // becoming ready is what joining accomplishes.
    expect(headless).toContain("publishNotReadyAddresses: true");
    expect(sts).toContain("serviceName: qdrant-headless");
    expect(sts).toContain("QDRANT__CLUSTER__ENABLED");
  });

  it("starts one node at a time, so three cannot each go first", () => {
    expect(sts).toContain("podManagementPolicy: OrderedReady");
    expect(sts).toContain("--bootstrap");
  });

  it("takes traffic off a node that is not in the cluster yet", () => {
    // /livez only says the process is up. Readiness has to mean "in the
    // cluster and able to serve", or the Service sends queries to a node
    // still catching up.
    expect(sts).toMatch(/readinessProbe:[\s\S]{0,120}\/readyz/);
    expect(sts).toMatch(/livenessProbe:[\s\S]{0,120}\/livez/);
    // And a startup probe, because loading a large index off disk is minutes
    // and a liveness probe firing during it restarts the pod for ever.
    expect(sts).toContain("startupProbe");
  });

  it("never ships an empty API key, which would reject every request", () => {
    // Qdrant reads an EMPTY key as "auth is on, and the key is the empty
    // string". `optional: true` omits the variable when the secret has no such
    // key; a plain secretKeyRef would fail the pod, and a default of "" would
    // 401 every request while blaming the caller's credentials.
    expect(sts).toContain("QDRANT__SERVICE__API_KEY");
    expect(sts).toMatch(/QDRANT__SERVICE__API_KEY[\s\S]{0,200}optional: true/);
  });

  it("says that replicas alone are not replication", () => {
    // THE TRAP THIS SECTION EXISTS FOR. `replicas: 3` places pods;
    // QDRANT_REPLICATION decides how many copies of each shard Qdrant keeps,
    // and the app reads it when the collection is FIRST CREATED. Three pods
    // with a replication factor of 1 still lose a third of the index with a
    // node. The manifest and the deployment guide both have to say so.
    // The warning lives in the manifest's comment block, above the objects,
    // so this reads the FILE rather than the parsed StatefulSet.
    expect(readFileSync(SERVICES, "utf8")).toContain("QDRANT_REPLICATION");
    const deploy = readFileSync("docs/DEPLOYMENT.md", "utf8");
    // Not "the name appears somewhere" — the guide has to hand over a command
    // that actually sets it to more than one. A first version of this asserted
    // the name was present, and renaming it in the prose still passed because
    // the code block below mentioned it too.
    expect(deploy, "no runnable instruction to set the replication factor").toMatch(
      /"QDRANT_REPLICATION"\s*:\s*"([2-9]|\d\d+)"/,
    );
    expect(deploy).toMatch(/first created|before the first document/i);
  });
});

describe("every stateless tier survives losing one instance", () => {
  it.each(STATELESS)("$name runs at least two replicas", ({ name }) => {
    const d = objectOf(ALL, "Deployment", name);
    expect(d, `${name} Deployment not found`).toBeDefined();
    const m = /^ {2}replicas: (\d+)$/m.exec(d ?? "");
    expect(m, `${name} declares no replicas`).not.toBeNull();
    expect(Number(m?.[1]), name).toBeGreaterThanOrEqual(2);
  });

  it.each(STATELESS)("$name spreads across nodes", ({ name, component }) => {
    const d = objectOf(ALL, "Deployment", name) ?? "";
    // Two replicas on one node survive exactly as much as one.
    expect(d, name).toContain("topologySpreadConstraints");
    expect(d, name).toContain("topologyKey: kubernetes.io/hostname");
    // ScheduleAnyway: a hard constraint leaves the second replica Pending for
    // ever on a single-node cluster.
    expect(d, name).toContain("whenUnsatisfiable: ScheduleAnyway");
    expect(d, name).toContain(`app.kubernetes.io/component: ${component}`);
  });

  it.each(STATELESS)("$name keeps one pod through a drain", ({ name, component }) => {
    const pdb = objectOf(ALL, "PodDisruptionBudget", name);
    expect(pdb, `${name} has no PodDisruptionBudget`).toBeDefined();
    expect(pdb).toContain("minAvailable: 1");
    expect(pdb).toContain(`app.kubernetes.io/component: ${component}`);
  });
});

describe("the notebook tier too", () => {
  it("the gateway and the egress proxy each run two, spread, with a budget", () => {
    const nb = rd(NOTEBOOKS);
    for (const app of ["notebook-gateway", "notebook-egress"]) {
      const d = docs(NOTEBOOKS).find(
        (x) => /^kind: Deployment$/m.test(x) && new RegExp(`name: ${app}$`, "m").test(x),
      );
      expect(d, `${app} Deployment`).toBeDefined();
      expect(Number(/replicas: (\d+)/.exec(d ?? "")?.[1]), app).toBeGreaterThanOrEqual(2);
      expect(d, `${app} spread`).toContain("topologySpreadConstraints");
    }
    // Without a budget a drain evicts both: every open notebook drops, and
    // while the proxy is gone every pip install inside a kernel fails.
    for (const app of ["notebook-gateway", "notebook-egress"]) {
      const pdb = docs(NOTEBOOKS).find(
        (x) => /^kind: PodDisruptionBudget$/m.test(x) && new RegExp(`name: ${app}$`, "m").test(x),
      );
      expect(pdb, `${app} PodDisruptionBudget`).toBeDefined();
      expect(pdb).toContain("minAvailable: 1");
    }
    expect(nb).toContain("app: notebook-egress");
  });
});

describe("the stateful pieces are named as such", () => {
  it("the catalog is a StatefulSet with a real volume claim, not an emptyDir", () => {
    const ss = objectOf([SERVICES], "StatefulSet", "lakehouse-catalog") ?? "";
    expect(ss).toContain("volumeClaimTemplates");
    expect(ss).toContain("storage: 10Gi");
    // Postgres refuses to initialise into a directory that has lost+found.
    expect(ss).toContain("/var/lib/postgresql/data/pgdata");
    expect(ss).not.toContain("emptyDir");
  });

  it("and the manifest tells the operator to use managed Postgres instead", () => {
    // The one piece whose loss cannot be recovered from object storage.
    expect(rd(SERVICES)).toContain("IN PRODUCTION, PREFER MANAGED POSTGRES");
  });
});

describe("a single host recovers on its own", () => {
  const compose = rd("docker-compose.yml");

  it("every long-running service restarts unless it was stopped on purpose", () => {
    // `notebook-runtime-image` is a build-only helper that exits at once.
    const services = compose.split(/\n {2}(?=[a-z0-9-]+:\n)/).slice(1);
    const longRunning = services.filter((s) => !/restart: "no"/.test(s) && /image:|build:/.test(s));
    for (const s of longRunning) {
      const name = /^([a-z0-9-]+):/.exec(s)?.[1] ?? "?";
      expect(s, `${name} has no restart policy`).toContain("restart: unless-stopped");
    }
  });

  it("and the services that can answer for themselves are health-checked", () => {
    // A restart policy sees a process that EXITS. It cannot see one that is
    // running and wedged, which is the failure an operator actually meets.
    for (const probe of [
      "http://127.0.0.1:8080/api/health", // the app
      "http://127.0.0.1:8099/health", // the Office renderer
      "http://127.0.0.1:8091/health", // the JS sandbox
    ]) {
      expect(compose, probe).toContain(probe);
    }
    expect(compose).toContain("pg_isready -U $${POSTGRES_USER:-lakehouse}");
    // Long, because an unclean stop makes Postgres replay its WAL first.
    expect(compose).toContain("start_period: 300s");
  });

  it("the catalog's data is a named volume, never anonymous", () => {
    // An anonymous volume holding the catalog is one `docker volume prune`
    // away from an unreadable lakehouse.
    expect(compose).toContain("lakehouse-catalog-data:/var/lib/postgresql/data");
    expect(compose).toMatch(/^volumes:\n(.*\n)*? {2}lakehouse-catalog-data:/m);
  });
});

describe("the documentation says how", () => {
  const dep = rd("docs/DEPLOYMENT.md");

  it("separates availability from durability and names the three decisions", () => {
    expect(dep).toContain("### High availability: what survives the loss of one instance");
    expect(dep).toContain("#### Every service, and what it takes to make it highly available");
    expect(dep).toContain("#### The two databases are the whole game");
    expect(dep).toContain("point `LAKEHOUSE_CATALOG_URL` at managed Postgres");
    // Single-node MinIO is a development convenience, not a production store.
    expect(dep).toContain("**MinIO in single-node mode is not**");
  });

  it("is honest that one host is not highly available", () => {
    expect(dep).toContain("A single host gives you neither");
    expect(dep).toContain("#### What is still not covered");
    expect(dep).toContain("**No multi-region.**");
  });

  it("and the in-app page carries the same guidance", () => {
    const page = rd("src/routes/docs.self-hosting.tsx");
    expect(page).toContain('id="high-availability"');
    expect(page).toContain("PodDisruptionBudget");
    expect(page).toContain("kubectl -n agentswarms get deploy,statefulset,pdb");
  });
});
