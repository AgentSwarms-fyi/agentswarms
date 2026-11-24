// Warm endpoints on KServe (R532), as deployed: the Helm chart's serving
// objects, the EKS root that installs KServe, and the kind rig that tries it,
// agree with each other and with what the app expects. `helm lint` and
// `helm template` check the syntax; these check the intent.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kserveConfigFrom } from "@/lib/kserve";

const rd = (p: string) => readFileSync(p, "utf8");
const serving = rd("deploy/helm/agentswarms/templates/serving.yaml");
const helpers = rd("deploy/helm/agentswarms/templates/_helpers.tpl");
const values = rd("deploy/helm/agentswarms/values.yaml");
const eks = rd("deploy/aws/terraform/eks/main.tf");
const rig = rd("deploy/kind/kserve/run.sh");
const k8sSetup = rd("scripts/setup-k8s.sh");

describe("the chart", () => {
  it("makes nothing for serving unless it is turned on, and is off by default", () => {
    expect(serving.indexOf("{{- if .Values.serving.kserve.enabled }}")).toBeLessThan(
      serving.indexOf("kind: Namespace"),
    );
    expect(values).toMatch(/serving:\n {2}kserve:\n {4}enabled: false/);
    expect(helpers).toContain("{{- if .Values.serving.kserve.enabled }}");
  });

  it("gives the app exactly what the KServe client calls, in the serving namespace", () => {
    // kserve.server.ts: apply (create + patch), read, list, delete
    // InferenceServices; apply and delete their Secrets; read pods and logs.
    expect(serving).toContain('resources: ["inferenceservices"]');
    expect(serving).toContain('verbs: ["get", "list", "watch", "create", "patch", "delete"]');
    expect(serving).toContain('resources: ["secrets"]');
    expect(serving).toContain('verbs: ["get", "create", "patch", "delete"]');
    expect(serving).toContain('resources: ["pods", "pods/log"]');
    // A Role, never a ClusterRole: the app has no business elsewhere.
    expect(serving).not.toContain("ClusterRole");
  });

  it("sets the app's serving settings to names the app reads", () => {
    const set = [...helpers.matchAll(/name: (KSERVE_[A-Z_]+|ML_SERVING_BACKEND)/g)].map(
      (m) => m[1],
    );
    expect(set).toEqual([
      "ML_SERVING_BACKEND",
      "KSERVE_NAMESPACE",
      "KSERVE_MODE",
      "KSERVE_SCALE_METRIC",
      "KSERVE_SCALE_TARGET",
      "KSERVE_SERVICE_ACCOUNT",
      "KSERVE_SCORER_IMAGE",
    ]);
    // And the defaults it passes are ones the app accepts as they are.
    const { problems } = kserveConfigFrom({
      ML_SERVING_BACKEND: "kserve",
      KSERVE_NAMESPACE: "agentswarms-serving",
      KSERVE_MODE: "Standard",
      KSERVE_SCALE_METRIC: "cpu",
      KSERVE_SCALE_TARGET: "60",
      KSERVE_SERVICE_ACCOUNT: "agentswarms-predictor",
      NOTEBOOK_APP_INTERNAL_URL: "http://agentswarms-web.agentswarms.svc.cluster.local",
      KSERVE_SCORER_IMAGE: "ghcr.io/agentswarms-fyi/notebook-runtime:1.7.0",
    });
    expect(problems).toEqual([]);
  });

  it("lets predictors be reached by the app alone, and reach only the app", () => {
    expect(serving).toContain("key: serving.kserve.io/inferenceservice, operator: Exists");
    expect(serving).toContain("values: [web, analytics]");
    expect(serving).toContain("ports: [{ protocol: TCP, port: 8080 }]");
    // Egress: DNS, and the app's web pods for the model. No storage, no internet.
    const egress = serving.slice(serving.indexOf("  egress:"));
    expect(egress).toContain("podSelector: { matchLabels: { app.kubernetes.io/component: web } }");
    expect(egress).not.toMatch(/443|ipBlock|egressPorts/);
    // Knative's activator would be refused, so the policy is Standard-only.
    expect(serving).toContain('{{- if eq $k.mode "Standard" }}');
  });

  it("runs predictors under an account with nothing in it", () => {
    expect(serving).toContain("name: {{ $k.predictor.serviceAccount }}");
    expect(serving).toContain("automountServiceAccountToken: false");
    expect(serving).not.toMatch(/s3-endpoint|s3-region|storage\./);
  });

  it("bounds every endpoint's pods together with a quota", () => {
    expect(serving).toContain("kind: ResourceQuota");
    expect(serving).toMatch(/pods: \{\{ \$k\.quota\.pods \| quote \}\}/);
  });
});

describe("the EKS root", () => {
  it("installs KServe in Standard mode without ingress only when asked", () => {
    for (const r of ["cert_manager", "kserve_crd", "kserve"]) {
      expect(eks).toMatch(
        new RegExp(
          `resource "helm_release" "${r}" \\{\\n {2}count\\s+= var\\.serving_kserve \\? 1 : 0`,
        ),
      );
    }
    expect(eks).toContain('deploymentMode = "Standard"');
    expect(eks).toContain("disableIngressCreation = true");
    expect(eks).toContain("kserve = { enabled = var.serving_kserve }");
  });

  it("gives predictors no cloud role: they get their model from the app", () => {
    expect(eks).not.toMatch(/ml-storage|ml-serving|serving_roles/);
  });

  it("pins the same KServe and cert-manager the rig tests", () => {
    const pin = (name: string) => new RegExp(`${name}=(v[\\d.]+)`).exec(rig)?.[1];
    expect(eks).toContain(`version          = "${pin("CERT_MANAGER_VERSION")}"`);
    expect(eks.match(new RegExp(`version\\s+= "${pin("KSERVE_VERSION")}"`, "g"))).toHaveLength(2);
  });
});

describe("the kind rig", () => {
  it("applies the chart's own serving objects rather than a copy of them", () => {
    expect(rig).toContain("--show-only templates/serving.yaml");
    expect(rig).toContain("--set serving.kserve.enabled=true");
  });

  it("never prints or exports a predictor's token", () => {
    // The load generator reads it inside the cluster, from the Secret.
    expect(rig).toContain("secretKeyRef: { name: $name-token, key: token }");
    expect(rig).not.toMatch(/get secret[^\n]*-o/);
  });
});

describe("the Kubernetes installer", () => {
  it("serves on KServe only when asked, with the chart's own serving objects", () => {
    expect(k8sSetup).toContain('SERVING="${SERVING:-sandbox}"');
    expect(k8sSetup).toContain('if [ "$SERVING" = kserve ]; then');
    expect(k8sSetup).toContain("--show-only templates/serving.yaml");
    expect(k8sSetup).toContain(
      "--set serving.kserve.enabled=true --set serviceAccount.name=agentswarms",
    );
    expect(k8sSetup).toContain("--from-literal=ML_SERVING_BACKEND=kserve");
    // An empty list must not trip `set -u` on bash 3.2.
    expect(k8sSetup).toContain('${SERVING_ENV[@]+"${SERVING_ENV[@]}"}');
  });

  it("pins the same cert-manager and KServe as the rig and the EKS root", () => {
    for (const name of ["CERT_MANAGER_VERSION", "KSERVE_VERSION"]) {
      const pin = (src: string) => new RegExp(`${name}=(v[\\d.]+)`).exec(src)?.[1];
      // Found, not merely equal: two misses would agree as well.
      expect(pin(rig), name).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(pin(k8sSetup), name).toBe(pin(rig));
    }
  });

  it("names the app the way the chart's network policy expects", () => {
    const app = rd("deploy/k8s/app/agentswarms.yaml");
    expect(app).toContain("app.kubernetes.io/component: web");
    expect(app).toContain("app.kubernetes.io/component: analytics");
    expect(app).toMatch(
      /kind: ServiceAccount\nmetadata:\n {2}name: agentswarms\n {2}namespace: agentswarms/,
    );
    // A predictor finds the app here for its model.
    expect(app).toContain("name: NOTEBOOK_APP_INTERNAL_URL");
  });
});
