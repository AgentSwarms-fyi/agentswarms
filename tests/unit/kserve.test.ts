// Warm endpoints on KServe (R532): the settings, names and objects the app
// applies, and how it reads them back. Pure; the I/O is kserveServer.test.ts.
import { describe, expect, it } from "vitest";
import {
  INSTALL_LABEL,
  inferenceService,
  isvcName,
  isvcState,
  kserveConfigFrom,
  parseEndpoint,
  podsSummary,
  predictorProxyPath,
  predictorServiceUrl,
  replicaBounds,
  scaleRuleText,
  servingApiUrl,
  tokenSecret,
  tokenSecretName,
} from "@/lib/kserve";

const MODEL = "3f0c2a9e-7b1d-4e55-9a10-6c2b8d4e1f77";
const on = {
  ML_SERVING_BACKEND: "kserve",
  KSERVE_SCORER_IMAGE: "ghcr.io/example/scorer:1",
  NOTEBOOK_APP_INTERNAL_URL: "http://agentswarms-web.agentswarms.svc.cluster.local",
};

describe("the settings", () => {
  it("are off by default, and say what a deployment gets when on", () => {
    const off = kserveConfigFrom({});
    expect(off.config.enabled).toBe(false);
    expect(off.problems).toEqual([]);

    const { config, problems } = kserveConfigFrom(on);
    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      enabled: true,
      namespace: "agentswarms-serving",
      mode: "Standard",
      access: "direct",
      image: "ghcr.io/example/scorer:1",
      serviceAccount: null,
      scaleMetric: "cpu",
      scaleTarget: 60,
      appUrl: "http://agentswarms-web.agentswarms.svc.cluster.local",
      readyTimeoutSeconds: 300,
    });
  });

  it("scale Knative on concurrency by default, and take KServe's older mode names", () => {
    expect(kserveConfigFrom({ ...on, KSERVE_MODE: "Knative" }).config).toMatchObject({
      mode: "Knative",
      scaleMetric: "concurrency",
      scaleTarget: 4,
    });
    expect(kserveConfigFrom({ ...on, KSERVE_MODE: "Serverless" }).config.mode).toBe("Knative");
    expect(kserveConfigFrom({ ...on, KSERVE_MODE: "RawDeployment" }).config.mode).toBe("Standard");
  });

  it("report a value they cannot use instead of guessing around it", () => {
    const { problems } = kserveConfigFrom({
      ...on,
      KSERVE_NAMESPACE: "Not_A_Namespace",
      KSERVE_MODE: "Turbo",
      KSERVE_ACCESS: "tunnel",
      KSERVE_CPU_LIMIT: "two",
      KSERVE_SERVICE_ACCOUNT: "Bad Name",
      KSERVE_READY_TIMEOUT_SECONDS: "5",
    });
    expect(problems.join("\n")).toMatch(/KSERVE_NAMESPACE/);
    expect(problems.join("\n")).toMatch(/KSERVE_MODE "Turbo"/);
    expect(problems.join("\n")).toMatch(/KSERVE_ACCESS "tunnel"/);
    expect(problems.join("\n")).toMatch(/KSERVE_CPU_LIMIT "two"/);
    expect(problems.join("\n")).toMatch(/KSERVE_SERVICE_ACCOUNT/);
    expect(problems.join("\n")).toMatch(/KSERVE_READY_TIMEOUT_SECONDS/);
  });

  it("refuse a request-based metric in Standard mode, whose HPA scales on resources", () => {
    const { config, problems } = kserveConfigFrom({ ...on, KSERVE_SCALE_METRIC: "concurrency" });
    expect(config.scaleMetric).toBe("cpu");
    expect(problems.join()).toMatch(/not one Standard mode scales on/);
  });

  it("need an image to run when on", () => {
    expect(kserveConfigFrom({ ML_SERVING_BACKEND: "kserve" }).problems.join()).toMatch(
      /KSERVE_SCORER_IMAGE/,
    );
    // The sandbox image holds the scorer, so it serves as the default.
    const fallback = kserveConfigFrom({
      ML_SERVING_BACKEND: "kserve",
      NOTEBOOK_RUNTIME_IMAGE: "nb:2",
      NOTEBOOK_APP_INTERNAL_URL: "http://app.test",
    });
    expect(fallback.config.image).toBe("nb:2");
    expect(fallback.problems).toEqual([]);
  });

  it("need the app's address as a pod reaches it, for the model", () => {
    const { NOTEBOOK_APP_INTERNAL_URL: _in, ...noApp } = on;
    expect(kserveConfigFrom(noApp).problems.join()).toMatch(/KSERVE_APP_URL/);
    expect(kserveConfigFrom({ ...noApp, KSERVE_APP_URL: "app:8080" }).problems.join()).toMatch(
      /KSERVE_APP_URL/,
    );
    const set = kserveConfigFrom({ ...on, KSERVE_APP_URL: "http://host.docker.internal:8102/" });
    expect(set.problems).toEqual([]);
    expect(set.config.appUrl).toBe("http://host.docker.internal:8102");
  });
});

describe("names", () => {
  it("fit every name Kubernetes derives from them in a DNS label", () => {
    const primary = isvcName(MODEL, "primary");
    const candidate = isvcName(MODEL, "candidate");
    expect(primary).toMatch(/^ml-[0-9a-f]{20}$/);
    expect(candidate).toBe(`${primary}-c`);
    // <name>-predictor-<replicaset hash>-<pod suffix>
    expect(`${candidate}-predictor-5d9c7b8f4b-x7k2q`.length).toBeLessThanOrEqual(63);
    expect(isvcName(MODEL.toUpperCase(), "primary")).toBe(primary);
    expect(() => isvcName("model-1", "primary")).toThrow(/Not a model id/);
  });

  it("read the endpoint a pod says it is, and nothing shaped otherwise", () => {
    expect(parseEndpoint("agentswarms-serving/ml-0123456789abcdef0123")).toEqual({
      ns: "agentswarms-serving",
      name: "ml-0123456789abcdef0123",
    });
    for (const bad of [
      null,
      "",
      "ml-x",
      "a/b/c",
      "../ml-x",
      "Serving/ml-x",
      "ns/ml x",
      `ns/${"a".repeat(64)}`,
    ]) {
      expect(parseEndpoint(bad)).toBe(null);
    }
    expect(servingApiUrl("http://app:8080/")).toBe("http://app:8080/api/ml/serving");
  });

  it("address the predictor in the cluster and through the API server", () => {
    expect(predictorServiceUrl("ml-abc", "serving")).toBe(
      "http://ml-abc-predictor.serving.svc.cluster.local",
    );
    expect(predictorProxyPath("ml-abc", "serving")).toBe(
      "/api/v1/namespaces/serving/services/ml-abc-predictor:80/proxy",
    );
  });
});

describe("the pod range", () => {
  it("holds at least one pod in Standard mode, and may go to zero only on Knative", () => {
    expect(replicaBounds("Standard", 0, 4)).toEqual({ minReplicas: 1, maxReplicas: 4 });
    expect(replicaBounds("Knative", 0, 4)).toEqual({ minReplicas: 0, maxReplicas: 4 });
    expect(replicaBounds("Standard", 5, 2)).toEqual({ minReplicas: 2, maxReplicas: 2 });
    expect(replicaBounds("Knative", 0, 0)).toEqual({ minReplicas: 0, maxReplicas: 1 });
  });
});

describe("the InferenceService", () => {
  const config = kserveConfigFrom({
    ...on,
    KSERVE_SERVICE_ACCOUNT: "agentswarms-predictor",
  }).config;
  const obj = inferenceService({
    name: "ml-abc",
    config,
    minReplicas: 0,
    maxReplicas: 4,
    labels: { "agentswarms.dev/role": "primary", [INSTALL_LABEL]: "abc123" },
  });
  const predictor = obj.spec.predictor;
  const container = predictor.containers[0];
  const env = Object.fromEntries(container.env.map((e) => [e.name, e]));

  it("is a Standard-mode predictor scaled by an HPA on the configured metric", () => {
    expect(obj.apiVersion).toBe("serving.kserve.io/v1beta1");
    expect(obj.metadata.annotations).toEqual({
      "serving.kserve.io/deploymentMode": "Standard",
      "serving.kserve.io/autoscalerClass": "hpa",
    });
    expect(predictor).toMatchObject({
      minReplicas: 1,
      maxReplicas: 4,
      scaleMetric: "cpu",
      scaleTarget: 60,
      serviceAccountName: "agentswarms-predictor",
    });
    expect(obj.metadata.labels).toMatchObject({
      "app.kubernetes.io/managed-by": "agentswarms",
      [INSTALL_LABEL]: "abc123",
    });
  });

  it("leaves the autoscaler to Knative in Knative mode", () => {
    const k = inferenceService({
      name: "ml-abc",
      config: kserveConfigFrom({ ...on, KSERVE_MODE: "Knative" }).config,
      minReplicas: 0,
      maxReplicas: 2,
      labels: {},
    });
    expect(k.metadata.annotations).toEqual({ "serving.kserve.io/deploymentMode": "Knative" });
    expect(k.spec.predictor.minReplicas).toBe(0);
  });

  it("runs the same scorer, which asks the app for this endpoint's model", () => {
    expect(container.image).toBe("ghcr.io/example/scorer:1");
    expect(env.NB_MODE.value).toBe("score");
    expect(env.AGENTSWARMS_SERVING_URL.value).toBe(
      "http://agentswarms-web.agentswarms.svc.cluster.local/api/ml/serving",
    );
    expect(env.AGENTSWARMS_ENDPOINT.value).toBe("agentswarms-serving/ml-abc");
    // No STORAGE_URI: KServe adds no storage initializer, and the pod holds no
    // storage credential that would reach other endpoints' models.
    expect(env.STORAGE_URI).toBeUndefined();
    expect(JSON.stringify(obj)).not.toMatch(/s3:|storage/i);
    expect(container.readinessProbe.httpGet).toEqual({ path: "/healthz", port: 8080 });
  });

  it("takes its token from the Secret, never from the object itself", () => {
    expect(env.KG_AUTH_TOKEN).toEqual({
      name: "KG_AUTH_TOKEN",
      valueFrom: { secretKeyRef: { name: tokenSecretName("ml-abc"), key: "token" } },
    });
    expect("value" in env.KG_AUTH_TOKEN).toBe(false);
  });

  it("runs unprivileged as the image's own uid", () => {
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1000,
      capabilities: { drop: ["ALL"] },
    });
  });

  it("has a Secret beside it holding the token and the same labels", () => {
    const secret = tokenSecret("ml-abc", "serving", "test-token-1", { [INSTALL_LABEL]: "abc123" });
    expect(secret.metadata.name).toBe("ml-abc-token");
    expect(secret.stringData).toEqual({ token: "test-token-1" });
    expect(secret.metadata.labels).toMatchObject({ [INSTALL_LABEL]: "abc123" });
  });
});

describe("reading it back", () => {
  it("is ready when the controller says so, and says why not when it is not", () => {
    expect(
      isvcState({
        status: {
          conditions: [{ type: "Ready", status: "True" }],
          address: { url: "http://ml-abc-predictor.serving.svc.cluster.local" },
        },
      }),
    ).toEqual({
      ready: true,
      reason: null,
      url: "http://ml-abc-predictor.serving.svc.cluster.local",
    });
    expect(
      isvcState({
        status: {
          conditions: [
            {
              type: "PredictorReady",
              status: "False",
              message: "Deployment does not have minimum availability.",
            },
            { type: "Ready", status: "False" },
          ],
        },
      }),
    ).toMatchObject({ ready: false, reason: "Deployment does not have minimum availability." });
    expect(isvcState({})).toEqual({ ready: false, reason: null, url: null });
  });

  it("counts the pods serving and names what holds the others back", () => {
    const ready = { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } };
    const leaving = { ...ready, metadata: { deletionTimestamp: "2026-11-24T10:00:00Z" } };
    const loading = {
      status: {
        phase: "Pending",
        initContainerStatuses: [
          { name: "storage-initializer", state: { waiting: { reason: "PodInitializing" } } },
        ],
      },
    };
    expect(podsSummary([ready, ready, leaving, loading])).toEqual({
      ready: 2,
      total: 3,
      reason: null,
    });

    const unplaced = {
      status: {
        phase: "Pending",
        conditions: [
          {
            type: "PodScheduled",
            status: "False",
            reason: "Unschedulable",
            message: "0/1 nodes are available: 1 Insufficient cpu.",
          },
        ],
      },
    };
    expect(podsSummary([unplaced]).reason).toBe("0/1 nodes are available: 1 Insufficient cpu.");

    const noImage = {
      status: {
        phase: "Pending",
        containerStatuses: [
          {
            name: "kserve-container",
            state: { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } },
          },
        ],
      },
    };
    expect(podsSummary([noImage]).reason).toBe("The scorer: ImagePullBackOff (pull access denied)");

    const noBundle = {
      status: {
        phase: "Pending",
        initContainerStatuses: [
          { name: "storage-initializer", state: { terminated: { reason: "Error", exitCode: 1 } } },
        ],
      },
    };
    expect(podsSummary([noBundle]).reason).toBe("Setting up (storage-initializer) exited: Error");

    // A termination message holding a log tail is cut to its last line.
    const crashed = {
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "kserve-container",
            state: {
              terminated: {
                reason: "Error",
                exitCode: 1,
                message:
                  "[score] listening on :8080\nTraceback (most recent call last):\nRuntimeError: boom\n",
              },
            },
          },
        ],
      },
    };
    expect(podsSummary([crashed]).reason).toBe("The scorer exited: Error (RuntimeError: boom)");
  });
});

describe("the rule an owner reads", () => {
  it("says what makes Kubernetes add a pod, in the configured metric's terms", () => {
    expect(scaleRuleText("cpu", 60)).toBe(
      "pods use more than 60% of the CPU each one asks for, on average",
    );
    expect(scaleRuleText("memory", 75)).toMatch(/75% of the memory/);
    expect(scaleRuleText("concurrency", 1)).toBe("each pod has more than 1 request in flight");
    expect(scaleRuleText("rps", 20)).toBe("each pod gets more than 20 requests a second");
  });
});
