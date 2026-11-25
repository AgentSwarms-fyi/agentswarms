// The GPU training pool on EKS (R537), checked before anyone pays for it.
//
// Nothing here reaches AWS. The Terraform root is read as text (terraform
// validate runs in check-infra when terraform is installed), the Helm chart
// is rendered when helm is, and the preflight script runs against a stand-in
// AWS CLI that answers the way the real one does.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const MAIN = rd("deploy/aws/terraform/eks/main.tf");
const VARS = rd("deploy/aws/terraform/eks/variables.tf");

/** One `resource "type" "name" {…}` block, by brace counting. */
function block(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`no ${head}`);
  let depth = 0;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unclosed ${head}`);
}

describe("the GPU node pool (deploy/aws/terraform/eks)", () => {
  const pool = block(MAIN, 'resource "aws_eks_node_group" "gpu"');

  it("is off unless asked for, and scales from zero", () => {
    expect(VARS).toMatch(/variable "gpu_node_max" \{[\s\S]*?default\s+= 0/);
    expect(pool).toContain("count           = var.gpu_node_max > 0 ? 1 : 0");
    expect(pool).toMatch(/min_size\s+= 0/);
    expect(pool).toMatch(/desired_size = 0/);
    expect(pool).toContain('ami_type        = "AL2023_x86_64_NVIDIA"');
  });

  it("takes only sandboxes that asked for a GPU", () => {
    // Both taints: the sandbox one keeps the app off, the GPU one keeps CPU
    // sandboxes off a node that costs ten times theirs.
    const taints = block(MAIN, "gpu_taints = {");
    expect(taints).toContain('(local.sbx_tag)  = "true:NoSchedule"');
    expect(taints).toContain('"nvidia.com/gpu" = "true:NoSchedule"');
    expect(pool).toContain('dynamic "taint"');
  });

  it("tells Cluster Autoscaler what a node it has not started would offer", () => {
    // From zero there is no node to read: the ASG tags are all it has.
    const tags = block(MAIN, 'resource "aws_autoscaling_group_tag" "gpu"');
    expect(tags).toContain(
      '"k8s.io/cluster-autoscaler/node-template/resources/nvidia.com/gpu" = tostring(local.gpus_per_node)',
    );
    expect(tags).toContain('"k8s.io/cluster-autoscaler/node-template/label/${k}" => v');
    expect(tags).toContain('"k8s.io/cluster-autoscaler/node-template/taint/${k}" => v');
    expect(tags).toContain("aws_eks_node_group.gpu[0].resources[0].autoscaling_groups[0].name");
    const labels = block(MAIN, "gpu_labels = {");
    expect(labels).toContain('"k8s.amazonaws.com/accelerator" = "nvidia"');
  });

  it("runs the device plugin where the GPUs are, and nowhere else", () => {
    const plugin = block(MAIN, 'resource "helm_release" "nvidia_device_plugin"');
    expect(plugin).toContain('version    = "0.20.1"');
    expect(plugin).toContain('nodeSelector = { "agentswarms.io/pool" = "gpu" }');
    // The chart's own affinity wants this label (or node-feature-discovery's).
    expect(block(MAIN, "gpu_labels = {")).toContain('"nvidia.com/gpu.present" = "true"');
    expect(plugin).toContain('{ key = local.sbx_tag, operator = "Exists", effect = "NoSchedule" }');
  });

  it("refuses a GPU count no node of the pool has", () => {
    expect(pool).toContain("var.train_gpus >= 1 && var.train_gpus <= local.gpus_per_node");
  });

  it("hands the chart the pool, and the app waits for the plugin", () => {
    const release = block(MAIN, 'resource "helm_release" "agentswarms"');
    expect(release).toContain("enabled      = var.gpu_node_max > 0");
    expect(release).toContain("trainGpus    = var.train_gpus");
    expect(release).toContain('nodeSelector = { "agentswarms.io/pool" = "gpu" }');
    expect(release).toContain("helm_release.nvidia_device_plugin,");
  });
});

const helm = [process.env.HELM_BIN, "helm"].find(
  (c) => c && spawnSync(c, ["version", "--short"], { encoding: "utf8" }).status === 0,
);

describe.skipIf(!helm)("the chart's GPU settings (helm template)", () => {
  const render = (...set: string[]) => {
    const r = spawnSync(
      helm!,
      [
        "template",
        "t",
        "deploy/helm/agentswarms",
        "--set",
        "publicUrl=https://agentswarms.example.com",
        "--set",
        "database.host=db",
        "--set",
        "aws.region=us-east-1",
        ...set,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };

  it("say nothing about GPUs unless the pool is on", () => {
    expect(render()).not.toContain("NOTEBOOK_K8S_GPU_NODE_SELECTOR");
  });

  it("name the pool and the GPUs per sandbox when it is", () => {
    const out = render(
      "--set",
      "sandboxes.gpu.enabled=true",
      "--set",
      "sandboxes.gpu.trainGpus=2",
      "--set-json",
      'sandboxes.gpu.nodeSelector={"agentswarms.io/pool":"gpu"}',
    );
    expect(out).toContain('- { name: ML_TRAIN_GPUS, value: "2" }');
    expect(out).toContain(
      '- { name: NOTEBOOK_K8S_GPU_NODE_SELECTOR, value: "{\\"agentswarms.io/pool\\":\\"gpu\\"}" }',
    );
  });
});

const bash = ["bash"].find((c) => spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0);

// The AWS CLI, as far as the preflight asks it anything.
const FAKE_AWS = `#!/usr/bin/env bash
case "$*" in
  *describe-instance-types*) printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' 4 "\${FAKE_GPUS:-1}" L4 "\${FAKE_MAKER:-NVIDIA}" 22888 "\${FAKE_ARCH:-x86_64}" ;;
  *describe-availability-zones*) printf 'us-east-1a\\tus-east-1b\\tus-east-1c\\n' ;;
  *describe-instance-type-offerings*) printf '%s\\n' "\${FAKE_OFFERED:-us-east-1b us-east-1c}" | tr ' ' '\\t' ;;
  *get-service-quota*)
    case "$*" in *L-DB2E81BA*) echo "\${FAKE_QUOTA:-0.0}" ;; *L-3819A6DF*) echo "\${FAKE_SPOT_QUOTA:-64.0}" ;; *) echo None ;; esac ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`;

describe.skipIf(!bash)("deploy/aws/scripts/gpu-preflight.sh", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gpu-preflight-"));
  writeFileSync(path.join(dir, "aws"), FAKE_AWS.replace(/\r/g, ""));
  chmodSync(path.join(dir, "aws"), 0o755);
  const script = path.resolve("deploy/aws/scripts/gpu-preflight.sh");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(bash!, [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };

  it("fails a new account's GPU quota of 0, and says how to raise it", () => {
    const r = run(["us-east-1", "g6.xlarge", "2"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ok    g6.xlarge: 1 x NVIDIA L4 (22 GiB), 4 vCPU");
    expect(r.out).toContain(
      'FAIL  "Running On-Demand G and VT instances" is 0 vCPU; 2 x g6.xlarge needs 8',
    );
    expect(r.out).toContain("--quota-code L-DB2E81BA --desired-value 8");
    expect(r.out).toContain("Not ready");
  });

  it("passes with the quota, and names the zones that will get GPU nodes", () => {
    const r = run(["us-east-1", "g6.xlarge", "2"], { FAKE_QUOTA: "16.0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("offered in us-east-1b of the cluster's zones (us-east-1a us-east-1b)");
    expect(r.out).toContain("Ready: terraform apply -var gpu_node_max=2");
  });

  it("reads the Spot quota for a Spot pool", () => {
    const r = run(["us-east-1", "g6.xlarge", "2", "SPOT"]);
    expect(r.out).toContain('"All G and VT Spot Instance Requests" is 64 vCPU');
    expect(r.code).toBe(0);
  });

  it("refuses a type with no NVIDIA GPU, an Arm one, or one the cluster's zones lack", () => {
    expect(
      run(["us-east-1", "m7g.xlarge", "1"], {
        FAKE_GPUS: "None",
        FAKE_MAKER: "None",
        FAKE_QUOTA: "64",
      }).out,
    ).toContain("has no NVIDIA GPU");
    expect(
      run(["us-east-1", "g5g.xlarge", "1"], { FAKE_ARCH: "arm64", FAKE_QUOTA: "64" }).out,
    ).toContain("x86 only");
    const r = run(["us-east-1", "g6.xlarge", "1"], {
      FAKE_OFFERED: "us-east-1c",
      FAKE_QUOTA: "64",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("none of the cluster's zones (us-east-1a us-east-1b)");
  });

  it("is read-only", () => {
    const src = rd("deploy/aws/scripts/gpu-preflight.sh")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"));
    const run = src.filter((l) => !/^\s*(echo|printf) /.test(l)).join("\n");
    const calls = run.match(/aws [a-z0-9-]+ [a-z-]+/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) {
      expect(c, c).toMatch(/ (describe-|get-)/);
    }
    // The increase is printed for a person to run, never run.
    expect(src.join("\n")).toContain(
      'echo "        aws service-quotas request-service-quota-increase',
    );
  });
});
