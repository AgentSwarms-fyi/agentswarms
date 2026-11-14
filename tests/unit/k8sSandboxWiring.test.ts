// Where sandboxes go, and who may put them there (R488).
//
// Five mismatches found while documenting every setting (R485), each a place
// where two parts of the platform answered the same question differently:
//
//   - the admin preflight resolved the k8s sandbox namespace without the app
//     pod's own namespace, so it could pass on agentswarms-notebooks while the
//     orchestrator created every sandbox somewhere else;
//   - the preflight checked `bridge` for a host-run app on Docker, a network
//     the orchestrator never uses (it uses agentswarms_nb-dev);
//   - deploy/k8s ran the app as `default` with no API token, while the sandbox
//     RoleBinding named an `agentswarms` account and the Spark one an account
//     in another namespace, and NOTEBOOK_K8S_NAMESPACE was unset there;
//   - the Spark manifest said to mount the executor pod template into the
//     driver, which the app built with no way to mount anything.
//
// The fix for the first two is one function each, shared; these pin that the
// preflight calls them and that they answer as the orchestrators did.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAll } from "js-yaml";

const fake = vi.hoisted(() => ({
  podNamespace: null as string | null,
  inContainer: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const SA = "/var/run/secrets/kubernetes.io/serviceaccount/";
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const p = String(path);
    if (p === `${SA}namespace`) {
      if (fake.podNamespace === null) throw new Error("ENOENT");
      return fake.podNamespace;
    }
    if (p.startsWith(SA)) return "sa-token";
    return (fs.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  const existsSync = ((path: unknown) =>
    String(path) === "/.dockerenv"
      ? fake.inContainer
      : fs.existsSync(path as string)) as typeof fs.existsSync;
  return {
    ...fs,
    default: { ...fs, readFileSync, existsSync },
    readFileSync,
    existsSync,
  };
});

import { K8sOrchestrator, k8sSandboxNamespace } from "@/utils/notebookRuntime/k8s.server";
import { kernelNetwork } from "@/utils/notebookRuntime/docker.server";
import { EXECUTOR_TEMPLATE_DIR } from "@/utils/etl/sparkCluster.server";
import type { KernelSpec } from "@/utils/notebookRuntime/orchestrator";

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const saved = { ...process.env };

beforeEach(() => {
  delete process.env.NOTEBOOK_K8S_NAMESPACE;
  delete process.env.NOTEBOOK_NETWORK;
  fake.podNamespace = null;
  fake.inContainer = false;
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

describe("the k8s sandbox namespace: one resolution for the orchestrator and the preflight", () => {
  it("is NOTEBOOK_K8S_NAMESPACE, then the app pod's own namespace, then agentswarms-notebooks", () => {
    expect(k8sSandboxNamespace()).toEqual({ name: "agentswarms-notebooks", source: "default" });
    fake.podNamespace = "agentswarms";
    expect(k8sSandboxNamespace()).toEqual({ name: "agentswarms", source: "pod" });
    process.env.NOTEBOOK_K8S_NAMESPACE = "agentswarms-sandboxes";
    expect(k8sSandboxNamespace()).toEqual({ name: "agentswarms-sandboxes", source: "env" });
  });

  it("is where the orchestrator really creates a sandbox", async () => {
    // The case the preflight got wrong: the variable unset, the app in
    // `agentswarms`. The pod goes to the app's own namespace.
    fake.podNamespace = "agentswarms";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response("{}", { status: 201 });
      }),
    );
    const spec: KernelSpec = {
      sessionId: "6f0d3c1e-2b4a-4c5d-8e9f-0a1b2c3d4e5f",
      userId: "u1",
      kind: "interactive",
      image: "img",
      cpuLimit: "1",
      memLimitMb: 1024,
      timeoutSeconds: 60,
      env: {},
    };
    await new K8sOrchestrator().create(spec);
    expect(urls[0]).toContain(`/api/v1/namespaces/${k8sSandboxNamespace().name}/pods`);
    expect(urls[0]).toContain("/namespaces/agentswarms/pods");
  });

  it("is what the preflight checks, with no fallback of its own", () => {
    const admin = src("src/utils/notebookRuntimeAdmin.functions.ts");
    const pre = admin.slice(
      admin.indexOf("export const nbRuntimePreflight"),
      admin.indexOf("export const nbRuntimeAddGrant"),
    );
    expect(pre.length, "the preflight moved; re-anchor this test").toBeGreaterThan(1000);
    expect(pre).toContain("k8sSandboxNamespace()");
    expect(pre).toContain("k8sFetch(");
    expect(pre).not.toMatch(/NOTEBOOK_K8S_NAMESPACE\s*\|\|/);
    expect(pre).not.toContain('"agentswarms-notebooks"');
    // Its own token read and API address were a second copy of k8sFetch.
    expect(pre).not.toContain("serviceaccount/token");
    expect(pre).not.toContain("KUBERNETES_SERVICE_HOST");
  });
});

describe("the Docker kernel network: one resolution for the orchestrator and the preflight", () => {
  it("is NOTEBOOK_NETWORK, else nb-internal in a container and nb-dev on the host — never bridge", () => {
    expect(kernelNetwork()).toBe("agentswarms_nb-dev");
    fake.inContainer = true;
    expect(kernelNetwork()).toBe("agentswarms_nb-internal");
    process.env.NOTEBOOK_NETWORK = "my-net";
    expect(kernelNetwork()).toBe("my-net");
  });

  it("is what the orchestrator attaches kernels to and what the preflight checks", () => {
    expect(src("src/utils/notebookRuntime/docker.server.ts")).toContain(
      "NetworkMode: kernelNetwork()",
    );
    const admin = src("src/utils/notebookRuntimeAdmin.functions.ts");
    const pre = admin.slice(
      admin.indexOf("export const nbRuntimePreflight"),
      admin.indexOf("export const nbRuntimeAddGrant"),
    );
    expect(pre).toContain("const net = kernelNetwork()");
    expect(pre).not.toContain('"bridge"');
    expect(pre).not.toContain("default bridge");
    expect(pre).not.toMatch(/"agentswarms_nb-(internal|dev)"/);
  });
});

type K8sDoc = {
  kind: string;
  metadata: { name: string; namespace?: string };
  subjects?: { kind: string; name: string; namespace?: string }[];
  rules?: { resources?: string[]; verbs?: string[] }[];
  roleRef?: { kind: string; name: string };
  data?: Record<string, string>;
  spec?: {
    template?: {
      spec?: {
        serviceAccountName?: string;
        automountServiceAccountToken?: boolean;
        containers?: { env?: { name: string; value?: string }[] }[];
      };
    };
    ingress?: {
      from?: {
        namespaceSelector?: { matchLabels?: Record<string, string> };
        podSelector?: { matchLabels?: Record<string, string> };
      }[];
      ports?: { port: number }[];
    }[];
  };
};
const manifest = (p: string) => (loadAll(src(p)) as K8sDoc[]).filter(Boolean);
const appDocs = manifest("deploy/k8s/app/agentswarms.yaml");
const notebookDocs = manifest("deploy/k8s/notebooks/notebook-runtime.yaml");
const sparkDocs = manifest("deploy/k8s/spark/spark-runtime.yaml");

describe("deploy/k8s: the RBAC names the identity the app runs as", () => {
  const apps = appDocs.filter(
    (d) => d.kind === "Deployment" && d.metadata.name.startsWith("agentswarms-"),
  );
  const identities = apps.map(
    (d) => `${d.metadata.namespace}/${d.spec?.template?.spec?.serviceAccountName ?? "default"}`,
  );
  const subjectsOf = (docs: K8sDoc[], name: string) =>
    (docs.find((d) => d.kind === "RoleBinding" && d.metadata.name === name)?.subjects ?? []).map(
      (s) => `${s.namespace}/${s.name}`,
    );

  it("both app tiers run as one account, with its token", () => {
    expect(apps.map((d) => d.metadata.name)).toEqual(["agentswarms-web", "agentswarms-analytics"]);
    expect(new Set(identities)).toEqual(new Set(["agentswarms/agentswarms"]));
    for (const d of apps) expect(d.spec?.template?.spec?.automountServiceAccountToken).toBe(true);
  });

  it("the sandbox and Spark RoleBindings both name it", () => {
    // Until R488: agentswarms/agentswarms (an account nothing ran as) and
    // agentswarms-notebooks/notebook-orchestrator (one no app pod could run as).
    expect(subjectsOf(notebookDocs, "notebook-orchestrator")).toEqual([identities[0]]);
    expect(subjectsOf(sparkDocs, "spark-orchestrator")).toEqual([identities[0]]);
    expect(
      notebookDocs.some((d) => d.kind === "ServiceAccount"),
      "a ServiceAccount in the sandbox namespace is one no app pod can run as",
    ).toBe(false);
  });

  it("NOTEBOOK_K8S_NAMESPACE names the namespace where the app may create sandboxes", () => {
    const role = notebookDocs.find((d) => d.kind === "Role")!;
    expect(
      role.rules?.some((r) => r.resources?.includes("pods") && r.verbs?.includes("create")),
    ).toBe(true);
    for (const d of apps) {
      const env = d.spec?.template?.spec?.containers?.[0]?.env ?? [];
      expect(env.find((e) => e.name === "NOTEBOOK_K8S_NAMESPACE")?.value).toBe(
        role.metadata.namespace,
      );
    }
  });

  it("lets the app's pods reach a driver's Connect port, which it waits on before a run", () => {
    const np = sparkDocs.find((d) => d.kind === "NetworkPolicy")!;
    const fromApp = (np.spec?.ingress ?? []).find((rule) =>
      (rule.from ?? []).some(
        (f) =>
          f.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"] === "agentswarms" &&
          f.podSelector?.matchLabels?.["app.kubernetes.io/name"] === "agentswarms",
      ),
    );
    expect(fromApp, "the app's readiness check is refused by an enforcing CNI").toBeTruthy();
    expect(fromApp?.ports?.map((p) => p.port)).toEqual([15002]);
  });
});

describe("deploy/k8s/spark: the executor pod template can reach the driver", () => {
  it("tells the operator to name the ConfigMap, which the app mounts where it says", () => {
    const raw = src("deploy/k8s/spark/spark-runtime.yaml");
    const cm = sparkDocs.find((d) => d.kind === "ConfigMap")!;
    expect(raw).toContain(`SPARK_K8S_EXECUTOR_POD_TEMPLATE_CONFIGMAP=${cm.metadata.name}`);
    expect(raw).toContain(EXECUTOR_TEMPLATE_DIR);
    expect(Object.keys(cm.data ?? {})).toEqual(["executor.yaml"]);
    // The old instruction: mount it into the driver, which nothing could do.
    expect(raw).not.toContain("/opt/spark/conf/executor.yaml");
  });
});
