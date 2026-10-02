// A served model gets a serving budget, and a pod nobody can place says so.
//
// Both halves are about the same thing: how many copies of a model you can
// actually run on more than one machine. The first decides how much of a
// cluster's quota each copy spends; the second decides whether you find out
// that the cluster is full, or read "the scorer did not become ready".
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(p, "utf8");
const CONFIG = rd("src/utils/notebookRuntime/config.server.ts");
const SERVE = rd("src/utils/ml/serve.server.ts");
const K8S = rd("src/utils/notebookRuntime/k8s.server.ts");
const SERVICE = rd("src/utils/notebookRuntime/service.server.ts");
const ADMIN_FN = rd("src/utils/notebookRuntimeAdmin.functions.ts");
const ADMIN_UI = rd("src/components/admin/RuntimeTab.tsx");

/** The explicit column list getPlatformResources reads. */
const selectList = CONFIG.slice(
  CONFIG.indexOf("lakehouse_memory_limit"),
  CONFIG.indexOf("document_vision_max_pages") + "document_vision_max_pages".length,
);

describe("every knob is actually reachable", () => {
  // THE GENERAL VERSION OF A GUARD THAT WAS BEING WRITTEN ONE KNOB AT A TIME.
  // getPlatformResources selects columns by name, so a knob resolved from
  // `data?.x` but missing from that list reads as null for ever and the
  // default wins in silence — the setting exists, the admin page saves it, and
  // nothing happens. Checking the whole set at once means the next knob is
  // covered by this test on the day it is added rather than on the day
  // somebody remembers to pin it.
  // Scoped to getPlatformResources' own body. The file holds a SECOND reader,
  // getRuntimeSettings, which selects differently — checking its columns
  // against this list reports sixteen failures that are not bugs, which is how
  // a guard teaches people to ignore it.
  const platformBody = CONFIG.slice(
    CONFIG.indexOf("export async function getPlatformResources"),
    CONFIG.indexOf("export async function getRuntimeSettings"),
  );
  const resolved = [...platformBody.matchAll(/data\?\.([a-z0-9_]+)/g)].map((m) => m[1]);

  it("finds the knobs to check", () => {
    // If the resolution is ever rewritten in a shape this regex does not see,
    // the loop below would pass by checking nothing at all.
    expect(resolved.length).toBeGreaterThan(20);
    expect(resolved).toContain("ml_train_mem_limit_mb");
    // And the scoping is real: the other reader's columns are not in here.
    expect(resolved).not.toContain("egress_allowlist");
  });

  it.each([...new Set(resolved)])("%s is in the explicit SELECT list", (column) => {
    expect(selectList, `${column} is read but never selected`).toContain(column);
  });
});

describe("serving has its own memory budget", () => {
  it("resolved from a setting, an env var and a default", () => {
    expect(CONFIG).toContain("mlServeMemLimitMb: number;");
    expect(CONFIG).toContain('envInt("ML_SERVE_MEM_LIMIT_MB")');
    expect(CONFIG).toContain("?? 2048");
  });

  it("and every replica is started with it, not with the training budget", () => {
    // MEASURED: a scorer holding a fitted model and answering requests sat at
    // 169 MiB while its limit was 8 GiB, because serving borrowed
    // ml_train_mem_limit_mb — the budget for FITTING on two million rows. On
    // one host that costs nothing. On Kubernetes a namespace ResourceQuota
    // counts limits.memory per pod, so it is the ceiling on how many copies
    // may run: 32 GiB of quota buys four copies of a model that needs a sixth
    // of a gigabyte.
    const starts = [...SERVE.matchAll(/memLimitMb: ([^,\n]+)/g)].map((m) => m[1].trim());
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const expr of starts) {
      expect(expr, `a replica is still started with ${expr}`).not.toContain("mlTrainMemLimitMb");
    }
    expect(SERVE).toContain("limits.mlServeMemLimitMb");
    expect(SERVE).toContain("mlServeMemLimitMb,");
  });

  it("with a control an administrator can reach", () => {
    expect(ADMIN_FN).toContain("ml_serve_mem_limit_mb: number;");
    expect(ADMIN_FN).toContain("ml_serve_mem_limit_mb: row.ml_serve_mem_limit_mb ?? 2048");
    expect(ADMIN_UI).toContain('set("ml_serve_mem_limit_mb", n)');
  });
});

describe("a pod the cluster cannot place", () => {
  it("is read from the condition Kubernetes already wrote", () => {
    // Pending is how "the image is pulling" and "no node has room" both look.
    // The cluster knows which, and says so in PodScheduled.
    expect(K8S).toContain('c.type === "PodScheduled"');
    expect(K8S).toContain('scheduled?.status === "False" && scheduled.reason === "Unschedulable"');
    expect(K8S).toContain("Waiting for room in the cluster");
  });

  it("stays `starting`, because it is not failing", () => {
    // It becomes schedulable the moment a node arrives. Reporting an error
    // would throw away a copy that was about to start.
    const block = K8S.slice(K8S.indexOf('c.type === "PodScheduled"'));
    const decided = block.slice(0, block.indexOf("}"));
    expect(decided).not.toContain('state: "error"');
    expect(block.slice(0, 600)).toContain('state: "starting"');
  });

  it("and the reason survives the reconcile that would otherwise drop it", () => {
    // refreshSession kept `message` only on the error branch, so an
    // explanation for something still STARTING was thrown away — which is
    // exactly the case this is about.
    expect(SERVICE).toContain("patch.pending_reason = st.message ?? null;");
    expect(SERVICE).toContain("patch.pending_reason = null;");
  });

  it("so the readiness wait can say why instead of blaming the scorer", () => {
    expect(SERVE).toContain("if (session.pending_reason) lastError = session.pending_reason;");
    // And the generic line is still there for when nothing better is known.
    expect(SERVE).toContain('let lastError = "The scorer did not become ready";');
  });
});
