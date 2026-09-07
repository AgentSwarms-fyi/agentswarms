// Per-run Spark clusters: the manifest the platform asks Kubernetes for.
//
// Everything that keeps a per-run cluster from leaking or over-reaching is a
// property of this one object — executors owned by the driver, a deadline the
// kubelet enforces whatever the app does, an unprivileged non-root pod, and
// credentials that are never cluster-wide. They are asserted here because the
// failure mode of getting them wrong is money spent on pods nobody deletes.
import { beforeEach, describe, expect, it } from "vitest";

import { sparkDriverManifests, type SparkClusterSettings } from "@/utils/etl/sparkCluster.server";

const SETTINGS: SparkClusterSettings = {
  provider: "k8s",
  staticUrl: null,
  image: "apache/spark:4.2.0-python3",
  executors: 3,
  executorCores: 2,
  executorMemMb: 4096,
  driverMemMb: 2048,
};

const RUN = { runId: "8f1c2a34-5b6d-4e7f-8091-a2b3c4d5e6f7", userId: "u-1", timeoutMinutes: 30 };

type Pod = {
  metadata: { name: string; namespace: string; labels: Record<string, string> };
  spec: {
    restartPolicy: string;
    serviceAccountName: string;
    automountServiceAccountToken: boolean;
    activeDeadlineSeconds: number;
    securityContext: Record<string, unknown>;
    nodeSelector?: Record<string, string>;
    tolerations?: unknown[];
    containers: {
      image: string;
      command: string[];
      env: { name: string; value: string }[];
      ports: { name: string; containerPort: number }[];
      resources: { requests: Record<string, string>; limits: Record<string, string> };
      securityContext: Record<string, unknown>;
    }[];
  };
};

const build = (s: Partial<SparkClusterSettings> = {}, o: Partial<typeof RUN> = {}) =>
  sparkDriverManifests({ ...SETTINGS, ...s }, { ...RUN, ...o });

const podOf = (m: ReturnType<typeof build>) => m.pod as Pod;
/** The value of `--conf key=…` in the driver command. */
const conf = (m: ReturnType<typeof build>, key: string): string | undefined => {
  const cmd = podOf(m).spec.containers[0].command;
  return cmd.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
};

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SPARK_")) delete process.env[k];
  }
});

describe("sparkDriverManifests — naming and addressing", () => {
  it("derives every name from the run id, so a leak is always findable", () => {
    const m = build();
    expect(podOf(m).metadata.name).toBe("spark-8f1c2a345b6d4e7f8091");
    expect(m.ref).toBe(`agentswarms-spark/${podOf(m).metadata.name}`);
    expect(m.url).toBe(`sc://${podOf(m).metadata.name}.agentswarms-spark.svc.cluster.local:15002`);
    expect(podOf(m).metadata.labels["agentswarms.spark/run"]).toBe(RUN.runId);
    expect(podOf(m).metadata.labels["app.kubernetes.io/component"]).toBe("spark-driver");
  });

  it("lives in its own namespace by default, and where the operator says otherwise", () => {
    expect(build().namespace).toBe("agentswarms-spark");
    process.env.SPARK_K8S_NAMESPACE = "data-spark";
    const m = build();
    expect(m.namespace).toBe("data-spark");
    expect(m.url).toContain(".data-spark.svc.cluster.local:");
  });

  it("the Service is headless and selects only this run's driver", () => {
    const svc = build().service as {
      spec: { clusterIP: string; selector: Record<string, string>; ports: { port: number }[] };
    };
    // Headless: the name must resolve to the pod IP, which is what
    // spark.driver.host has to be for executors to call back.
    expect(svc.spec.clusterIP).toBe("None");
    expect(svc.spec.selector).toEqual({ "agentswarms.spark/run": RUN.runId });
    expect(svc.spec.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([7078, 7079, 15002]);
  });
});

describe("sparkDriverManifests — the cluster cannot outlive its run", () => {
  it("executors are the driver pod's children, so deleting it deletes them", () => {
    const m = build();
    expect(conf(m, "spark.kubernetes.driver.pod.name")).toBe(podOf(m).metadata.name);
    expect(conf(m, "spark.kubernetes.executor.deleteOnTermination")).toBe("true");
  });

  it("carries a deadline the kubelet enforces even if this app never comes back", () => {
    const deadline = podOf(build()).spec.activeDeadlineSeconds;
    // The run's own ceiling, plus room to start, plus slack — never less.
    expect(deadline).toBeGreaterThan(30 * 60);
    expect(
      podOf(build({}, { timeoutMinutes: 1 })).spec.activeDeadlineSeconds,
    ).toBeGreaterThanOrEqual(600);
    expect(podOf(build({}, { timeoutMinutes: 600 })).spec.activeDeadlineSeconds).toBeGreaterThan(
      600 * 60,
    );
  });

  it("never restarts: a run gets one driver, not a restart loop", () => {
    expect(podOf(build()).spec.restartPolicy).toBe("Never");
  });
});

describe("sparkDriverManifests — hardening", () => {
  it("runs unprivileged, non-root, read-only, with no capabilities", () => {
    const pod = podOf(build());
    expect(pod.spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 185,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("writes only where a read-only root filesystem allows", () => {
    const env = Object.fromEntries(
      podOf(build()).spec.containers[0].env.map((e) => [e.name, e.value]),
    );
    // The launcher makes a log dir and a pid file before Spark starts; both
    // default under SPARK_HOME, which is not writable here.
    expect(env.SPARK_LOG_DIR).toBe("/tmp/spark-logs");
    expect(env.SPARK_PID_DIR).toBe("/tmp");
    expect(env.HOME).toBe("/tmp");
    expect(env.SPARK_NO_DAEMONIZE).toBe("true");
    expect(conf(build(), "spark.jars.ivy")).toBe("/tmp/ivy");
  });

  it("takes an API token only because the driver must ask for its executors", () => {
    const pod = podOf(build());
    expect(pod.spec.automountServiceAccountToken).toBe(true);
    expect(pod.spec.serviceAccountName).toBe("spark-driver");
    process.env.SPARK_K8S_SERVICE_ACCOUNT = "my-spark";
    expect(podOf(build()).spec.serviceAccountName).toBe("my-spark");
    expect(conf(build(), "spark.kubernetes.authenticate.driver.serviceAccountName")).toBe(
      "my-spark",
    );
  });
});

describe("sparkDriverManifests — sizing and placement", () => {
  it("passes the operator's sizing through to Spark", () => {
    const m = build();
    expect(conf(m, "spark.executor.instances")).toBe("3");
    expect(conf(m, "spark.executor.cores")).toBe("2");
    expect(conf(m, "spark.executor.memory")).toBe("4096m");
    expect(conf(m, "spark.driver.memory")).toBe("2048m");
    expect(conf(m, "spark.kubernetes.container.image")).toBe("apache/spark:4.2.0-python3");
  });

  it("the pod's memory limit leaves room beside the JVM heap", () => {
    // A limit equal to the heap is a limit the kubelet enforces by killing the
    // driver the moment the JVM's own overhead lands on top of it.
    const limit = podOf(build()).spec.containers[0].resources.limits.memory;
    expect(Number.parseInt(limit, 10)).toBeGreaterThan(2048);
    expect(podOf(build()).spec.containers[0].resources.requests.memory).toBe("2048Mi");
  });

  it("binds to every interface but advertises the Service name", () => {
    const m = build();
    expect(conf(m, "spark.driver.bindAddress")).toBe("0.0.0.0");
    expect(conf(m, "spark.driver.host")).toBe(
      `${podOf(m).metadata.name}.agentswarms-spark.svc.cluster.local`,
    );
    expect(conf(m, "spark.connect.grpc.binding.port")).toBe("15002");
  });

  it("resolves the connectors by default, and skips it for an image that has them", () => {
    const cmd = podOf(build()).spec.containers[0].command;
    expect(cmd).toContain("--packages");
    expect(cmd.join(" ")).toContain("io.delta:delta-spark_2.13");
    expect(conf(build(), "spark.sql.extensions")).toBe("io.delta.sql.DeltaSparkSessionExtension");
    process.env.SPARK_PACKAGES = "";
    expect(podOf(build()).spec.containers[0].command).not.toContain("--packages");
  });

  it("honours node placement and extra conf for clusters that need them", () => {
    process.env.SPARK_K8S_NODE_SELECTOR = '{"pool":"spark"}';
    process.env.SPARK_K8S_TOLERATIONS = '[{"key":"spark","operator":"Exists"}]';
    process.env.SPARK_K8S_EXTRA_CONF = "spark.sql.shuffle.partitions=64,spark.foo=bar";
    const pod = podOf(build());
    expect(pod.spec.nodeSelector).toEqual({ pool: "spark" });
    expect(pod.spec.tolerations).toEqual([{ key: "spark", operator: "Exists" }]);
    expect(conf(build(), "spark.sql.shuffle.partitions")).toBe("64");
    expect(conf(build(), "spark.foo")).toBe("bar");
  });

  it("ignores malformed placement rather than failing every run", () => {
    process.env.SPARK_K8S_NODE_SELECTOR = "{not json";
    expect(podOf(build()).spec.nodeSelector).toBeUndefined();
  });
});
