// The app's Kubernetes manifest.
//
// Every assertion here corresponds to something that was OBSERVED failing in a
// real cluster (Docker Desktop, Kubernetes 1.36, 8-core node) while writing it.
// A manifest is copy-pasted once and lived with for years, so the details that
// bite are worth pinning rather than trusting to review.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { loadAll } from "js-yaml";

type Container = {
  resources?: { limits?: Record<string, string>; requests?: Record<string, string> };
  livenessProbe?: { httpGet?: { path?: string } };
  readinessProbe?: { httpGet?: { path?: string } };
  env?: { name: string; value?: string }[];
  imagePullPolicy?: string;
  volumeMounts?: { name: string; mountPath: string }[];
  securityContext?: {
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    capabilities?: { drop?: string[] };
  };
};
type PodSpec = {
  containers?: Container[];
  automountServiceAccountToken?: boolean;
  terminationGracePeriodSeconds?: number;
  securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
  topologySpreadConstraints?: { topologyKey?: string; whenUnsatisfiable?: string }[];
};
type Doc = {
  kind: string;
  metadata: { name: string };
  spec?: {
    selector?: { matchLabels?: Record<string, string> } & Record<string, string>;
    template?: { spec?: PodSpec };
  };
};

const RAW = readFileSync(resolve(process.cwd(), "deploy/k8s/app/agentswarms.yaml"), "utf8");
const docs = (loadAll(RAW) as Doc[]).filter(Boolean);

// Kind AND name: the Namespace and the Service are both called "agentswarms",
// so a name-only lookup silently returns the wrong object.
const byKind = (kind: string, name: string) =>
  docs.find((d) => d.kind === kind && d.metadata?.name === name);
const containerOf = (name: string) =>
  byKind("Deployment", name)?.spec?.template?.spec?.containers?.[0];

describe("the manifest declares what it must", () => {
  it("ships every object a working deployment needs", () => {
    expect(docs.map((d) => d.kind).sort()).toEqual(
      [
        "CronJob",
        "Deployment",
        "Deployment",
        "HorizontalPodAutoscaler",
        "Namespace",
        "PodDisruptionBudget",
        "Service",
      ].sort(),
    );
  });
});

describe("CPU limits, because the worker count follows them", () => {
  // MEASURED: a pod with limits.cpu 500m on this 8-core node logged
  // "single process". Without a limit the container sees the NODE's cores and
  // forks one worker per core at ~0.5-1 GB RSS each — an OOMKill that presents
  // as an unexplained crash loop.
  it("sets a CPU limit on both deployments", () => {
    for (const name of ["agentswarms-web", "agentswarms-analytics"]) {
      const limits = containerOf(name)?.resources?.limits ?? {};
      expect(limits.cpu, `${name} must set resources.limits.cpu`).toBeTruthy();
      expect(limits.memory, `${name} must set resources.limits.memory`).toBeTruthy();
    }
  });
});

describe("probes", () => {
  it("web probes liveness and readiness at their different endpoints", () => {
    const c = containerOf("agentswarms-web");
    expect(c?.livenessProbe?.httpGet?.path).toBe("/api/health");
    // Readiness on /api/health means a pod that cannot reach the database keeps
    // receiving traffic, and analytics nodes are never drained.
    expect(c?.readinessProbe?.httpGet?.path).toBe("/api/health/ready");
  });

  it("analytics has NO readiness probe", () => {
    // MEASURED: adding one wedges the Deployment for ever. APP_ROLE=analytics
    // answers readiness with 503 by design, so a new pod never becomes Ready,
    // so the rolling update never retires the old one — `kubectl rollout
    // status` sat on "1 old replicas are pending termination" until killed.
    // Kubernetes gates rollout progress on readiness; a probe that can never
    // pass is a deploy that can never finish.
    const c = containerOf("agentswarms-analytics");
    expect(c?.readinessProbe, "a readiness probe here makes rollouts hang").toBeUndefined();
    expect(c?.livenessProbe?.httpGet?.path).toBe("/api/health");
  });
});

describe("roles", () => {
  it("marks the analytics deployment with APP_ROLE", () => {
    const env = containerOf("agentswarms-analytics")?.env ?? [];
    expect(env.find((e) => e.name === "APP_ROLE")?.value).toBe("analytics");
  });

  it("turns the in-process scheduler off on the web tier", () => {
    // The lease already prevents double-firing; this stops every worker of
    // every replica ticking each minute to lose it.
    const env = containerOf("agentswarms-web")?.env ?? [];
    expect(env.find((e) => e.name === "DISABLE_INPROCESS_SCHEDULER")?.value).toBe("1");
  });

  it("routes the Service to web pods only", () => {
    const sel = byKind("Service", "agentswarms")?.spec?.selector as Record<string, string>;
    expect(sel["app.kubernetes.io/component"]).toBe("web");
  });
});

describe("security posture", () => {
  // VERIFIED IN A CLUSTER: `id` inside a running web pod reported uid=1000, a
  // write to / was refused, and a write to /tmp succeeded. The image gained a
  // USER line for this; asserting runAsNonRoot against an image that runs as
  // root leaves pods in CreateContainerConfigError, so the two move together.
  it("runs both app deployments as a non-root user", () => {
    for (const name of ["agentswarms-web", "agentswarms-analytics"]) {
      const pod = byKind("Deployment", name)?.spec?.template?.spec as PodSpec;
      expect(pod.securityContext?.runAsNonRoot, `${name} must not run as root`).toBe(true);
      expect(pod.securityContext?.runAsUser).toBe(1000);
    }
  });

  it("drops capabilities and forbids privilege escalation", () => {
    for (const name of ["agentswarms-web", "agentswarms-analytics"]) {
      const c = containerOf(name);
      expect(c?.securityContext?.allowPrivilegeEscalation).toBe(false);
      expect(c?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    }
  });

  it("uses a read-only root filesystem, with real scratch for spill", () => {
    // The lakehouse engine spills to a temp directory; a read-only root with
    // nowhere to spill turns a slow query into a failed one.
    for (const name of ["agentswarms-web", "agentswarms-analytics"]) {
      const c = containerOf(name);
      expect(c?.securityContext?.readOnlyRootFilesystem).toBe(true);
      expect(c?.volumeMounts?.some((m) => m.mountPath === "/tmp")).toBe(true);
    }
  });

  it("does not mount a Kubernetes API token the app never uses", () => {
    for (const name of ["agentswarms-web", "agentswarms-analytics"]) {
      const pod = byKind("Deployment", name)?.spec?.template?.spec as PodSpec;
      expect(pod.automountServiceAccountToken).toBe(false);
    }
  });

  it("the image itself drops root", () => {
    // Without this the securityContext above cannot be satisfied.
    expect(readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8")).toMatch(/^USER node$/m);
  });
});

describe("availability", () => {
  it("keeps a web pod through a node drain", () => {
    const pdb = byKind("PodDisruptionBudget", "agentswarms-web");
    expect(pdb, "a drain can otherwise evict every replica at once").toBeTruthy();
  });

  it("spreads replicas across nodes without wedging a one-node cluster", () => {
    const pod = byKind("Deployment", "agentswarms-web")?.spec?.template?.spec as PodSpec;
    const spread = pod.topologySpreadConstraints?.[0];
    expect(spread?.topologyKey).toBe("kubernetes.io/hostname");
    // DoNotSchedule would leave the second replica Pending for ever on a
    // single-node cluster — which is what most people try this on first.
    expect(spread?.whenUnsatisfiable).toBe("ScheduleAnyway");
  });

  it("gives the drain time to finish in-flight requests", () => {
    const pod = byKind("Deployment", "agentswarms-web")?.spec?.template?.spec as PodSpec;
    expect(pod.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(30);
  });
});

describe("the optional services each get their own Deployment", () => {
  const svc = readFileSync(resolve(process.cwd(), "deploy/k8s/app/services.yaml"), "utf8");
  const svcDocs = (loadAll(svc) as Doc[]).filter(Boolean);
  const kinds = svcDocs.map((d) => `${d.kind}/${d.metadata?.name}`);

  it("covers docgen, the JS sandbox and the lakehouse catalog", () => {
    expect(kinds).toContain("Deployment/agentswarms-docgen");
    expect(kinds).toContain("Deployment/agentswarms-js-sandbox");
    // A StatefulSet, not a Deployment: the catalog is the one piece of the
    // lakehouse that cannot be rebuilt from object storage.
    expect(kinds).toContain("StatefulSet/lakehouse-catalog");
    for (const s of ["Service/docgen", "Service/js-sandbox", "Service/lakehouse-catalog"]) {
      expect(kinds).toContain(s);
    }
  });

  it("isolates the sandbox that runs user code", () => {
    expect(kinds).toContain("NetworkPolicy/js-sandbox-isolation");
    const np = svcDocs.find((d) => d.kind === "NetworkPolicy") as unknown as {
      spec: { egress: unknown[]; policyTypes: string[] };
    };
    expect(np.spec.policyTypes).toContain("Egress");
    expect(np.spec.egress, "the sandbox has no reason to open a connection").toEqual([]);
  });

  it("pins imagePullPolicy on every :latest image", () => {
    // MEASURED: `:latest` defaults to Always, so Kubernetes ignored the
    // locally-built images and tried Docker Hub — ImagePullBackOff on both
    // docgen and js-sandbox while the images sat on the node.
    for (const d of svcDocs) {
      for (const c of d.spec?.template?.spec?.containers ?? []) {
        if (String((c as { image?: string }).image ?? "").endsWith(":latest")) {
          expect(c.imagePullPolicy, `${d.metadata?.name} uses :latest without a pull policy`).toBe(
            "IfNotPresent",
          );
        }
      }
    }
  });

  it("warns about the compose defaults Kubernetes does not have", () => {
    // MEASURED: docker-compose fills 13 variables with ${VAR:-default} that
    // this .env never defines. Two of them are required secretKeyRefs, so the
    // pods failed with "couldn't find key … in Secret".
    expect(svc).toContain("INTERNAL_RUN_SECRET");
    expect(svc).toContain("LAKEHOUSE_CATALOG_PASSWORD");
    expect(svc).toContain("Kubernetes has");
  });
});

describe("the secret instructions", () => {
  it("warn that kubectl keeps the quotes docker compose strips", () => {
    // MEASURED: `kubectl create secret --from-env-file=.env` produced
    // SUPABASE_URL='"https://…"' — quotes included — and every pod failed
    // readiness with `Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL`.
    expect(RAW).toContain("Invalid supabaseUrl");
    expect(RAW).toContain(".env.k8s");
  });

  it("says the cron token is required", () => {
    // Without it the CronJob sits in CreateContainerConfigError, which names
    // no cause at all.
    expect(RAW).toContain("BI_CRON_TOKEN");
    expect(RAW).toContain("CreateContainerConfigError");
  });
});
