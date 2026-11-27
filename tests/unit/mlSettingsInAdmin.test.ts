// Machine-learning settings in Admin → Developer runtime (R550).
//
// Ten settings could only be set in the server's environment, and two had a
// column but no field. They resolve like every other setting now: saved on
// the page, then the environment, then the built-in value. Along the way the
// page stopped lying about where a value comes from, and stopped writing a
// built-in default over a value the environment set.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/utils/notebookRuntime/token.server", () => ({
  runtimeSecretConfigured: async () => true,
}));

const {
  ENV_BACKED_SETTINGS,
  resolvePlatformResources,
  settingEnvName,
  settingKey,
  settingSources,
} = await import("@/utils/notebookRuntime/config.server");
const { settingsAuditChanges, settingsPatch } = await import("@/lib/runtimeSettingsPatch");
const { servingEnvView } = await import("@/lib/servingEnv");

const rd = (p: string) => readFileSync(p, "utf8");
const codeOnly = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

const NEW = {
  ml_api_rate_limit_per_min: ["mlApiRateLimitPerMin", 60],
  ml_evaluations_per_sweep: ["mlEvaluationsPerSweep", 20],
  ml_explain_max_rows: ["mlExplainMaxRows", 20],
  ml_explain_top_k: ["mlExplainTopK", 8],
  ml_explain_batch_max_rows: ["mlExplainBatchMaxRows", 50_000],
  ml_explain_batch_top_k: ["mlExplainBatchTopK", 3],
  ml_explain_chunk_rows: ["mlExplainChunkRows", 2000],
  ml_serve_target_rpm_per_replica: ["mlServeTargetRpmPerReplica", 120],
  ml_serve_scale_cooldown_seconds: ["mlServeScaleCooldownSeconds", 180],
  ml_import_max_mb: ["mlImportMaxMb", 500],
} as const;

const saved: string[] = [];
function setEnv(name: string, v: string) {
  saved.push(name);
  vi.stubEnv(name, v);
}
afterEach(() => {
  vi.unstubAllEnvs();
  saved.length = 0;
});

describe("saved, then the environment, then built in", () => {
  for (const [column, [key, builtIn]] of Object.entries(NEW)) {
    it(`${column}`, () => {
      const env = settingEnvName(column as never);
      expect(resolvePlatformResources(null)[key]).toBe(builtIn);
      setEnv(env, "7");
      expect(resolvePlatformResources(null)[key]).toBe(7);
      expect(resolvePlatformResources({ [column]: 11 } as never)[key]).toBe(11);
    });
  }

  it("an import cap is 1 to 4096 MB; anything else is not a cap", () => {
    expect(resolvePlatformResources({ ml_import_max_mb: 9000 } as never).mlImportMaxMb).toBe(500);
    setEnv("ML_IMPORT_MAX_MB", "5000");
    expect(resolvePlatformResources(null).mlImportMaxMb).toBe(500);
    setEnv("ML_IMPORT_MAX_MB", "64");
    expect(resolvePlatformResources(null).mlImportMaxMb).toBe(64);
  });

  it("the read is the whole row, so a pending migration's column cannot fail it", () => {
    const body = rd("src/utils/notebookRuntime/config.server.ts");
    const fn = body.slice(body.indexOf("export async function getPlatformResources"));
    expect(fn.slice(0, fn.indexOf("return resolvePlatformResources(data);"))).toContain(
      '.select("*")',
    );
  });
});

describe("where a value comes from", () => {
  it("saved on the page, the environment, or built in", () => {
    setEnv("ML_EXPLAIN_TOP_K", "5");
    const s = settingSources({ ml_drift_alert_psi: 0.3 });
    expect(s.ml_drift_alert_psi).toBe("saved");
    expect(s.ml_explain_top_k).toBe("env");
    expect(s.ml_explain_max_rows).toBe("default");
  });

  it("an environment value the resolver would not take is not 'from the environment'", () => {
    setEnv("ML_EXPLAIN_TOP_K", "lots");
    setEnv("ML_EXPLAIN_MAX_ROWS", "0");
    // The one setting whose 0 is a value.
    setEnv("AI_GATEWAY_CACHE_MAX_TEMPERATURE", "0");
    const s = settingSources(null);
    expect(s.ml_explain_top_k).toBe("default");
    expect(s.ml_explain_max_rows).toBe("default");
    expect(s.gateway_cache_max_temperature).toBe("env");
  });

  it("names each setting's variable and resolved field correctly", () => {
    const config = rd("src/utils/notebookRuntime/config.server.ts");
    const resolved = resolvePlatformResources(null);
    for (const column of ENV_BACKED_SETTINGS) {
      const env = settingEnvName(column);
      // The resolver reads that very variable for that very column.
      expect(config, `${column} → ${env}`).toMatch(
        new RegExp(`data\\?\\.${column}[\\s\\S]{0,160}${env}`),
      );
      expect(resolved, `${column} → ${settingKey(column)}`).toHaveProperty(settingKey(column));
    }
    expect(settingEnvName("gateway_cache_ttl_hours")).toBe("AI_GATEWAY_CACHE_TTL_HOURS");
  });
});

describe("a save writes only what was changed", () => {
  const loaded = { ml_explain_top_k: 8, ml_drift_alert_psi: 0.3, egress_allowlist: ["a"] };

  it("nothing changed: nothing sent", () => {
    expect(settingsPatch(loaded, { ...loaded }, new Set())).toEqual({});
  });

  it("a changed field, and only it", () => {
    expect(settingsPatch(loaded, { ...loaded, ml_explain_top_k: 5 }, new Set())).toEqual({
      ml_explain_top_k: 5,
    });
  });

  it("Reset sends null, which puts the environment's or the built-in value back", () => {
    expect(
      settingsPatch(
        loaded,
        { ...loaded, ml_drift_alert_psi: 0.25 },
        new Set(["ml_drift_alert_psi"]),
      ),
    ).toEqual({ ml_drift_alert_psi: null });
  });

  it("the page sends the patch, never the whole form", () => {
    const tab = codeOnly(rd("src/components/admin/RuntimeTab.tsx"));
    expect(tab).toContain("...(patch as Partial<NbRuntimeSettings>),");
    expect(tab).not.toContain("data: { access_token: token, ...form,");
    // And it shows the values in force, not built-in defaults.
    const admin = codeOnly(rd("src/utils/notebookRuntimeAdmin.functions.ts"));
    expect(admin).toContain(
      "(settings as Record<string, unknown>)[column] = inForce[settingKey(column)];",
    );
  });
});

describe("the audit keeps both sides", () => {
  it("old and new value, unchanged ones left out, sorted", () => {
    expect(
      settingsAuditChanges(
        { ml_explain_top_k: 8, ml_drift_alert_psi: 0.25, pip_allowed: true },
        { ml_explain_top_k: 5, ml_drift_alert_psi: null, pip_allowed: true },
      ),
    ).toEqual([
      { field: "ml_drift_alert_psi", from: 0.25, to: null },
      { field: "ml_explain_top_k", from: 8, to: 5 },
    ]);
  });

  it("a list by its length, an address only as changed", () => {
    expect(
      settingsAuditChanges(
        { egress_allowlist: ["a", "b"], spark_connect_url: "sc://user:pw@host" },
        { egress_allowlist: ["a"], spark_connect_url: "sc://other" },
      ),
    ).toEqual([
      { field: "egress_allowlist", from: "2 entries", to: "1 entries" },
      { field: "spark_connect_url", from: "(set)", to: "(changed)" },
    ]);
  });

  it("is written after the update, by the superadmin who made it", () => {
    const admin = codeOnly(rd("src/utils/notebookRuntimeAdmin.functions.ts"));
    const fn = admin.slice(admin.indexOf("export const nbRuntimeUpdateSettings"));
    expect(fn.indexOf('action: "runtime.settings.update"')).toBeGreaterThan(
      fn.indexOf(".update(patch)"),
    );
    expect(fn).toContain("userId: guard.userId,");
  });
});

describe("found in the UI test", () => {
  const tab = codeOnly(rd("src/components/admin/RuntimeTab.tsx"));
  const admin = codeOnly(rd("src/utils/notebookRuntimeAdmin.functions.ts"));

  it("a save before the migration says nothing was saved, and which setting needs it", () => {
    // It led with "Could not find the 'ml_explain_top_k' column of
    // 'notebook_runtime_settings' in the schema cache".
    expect(admin).toContain("const column = /'([a-z0-9_]+)' column/.exec(error.message)?.[1];");
    expect(admin).toContain(
      'Nothing was saved: ${column ?? "this setting"} needs migration 20261210000000.',
    );
  });

  it("a fallback reads as a number a person reads, and the hint points where it is", () => {
    // "Reset to the built-in 2000000"; "KSERVE_SCALE_TARGET below", which is
    // only below when KServe is on.
    expect(tab).toContain("const n = s.fallback.toLocaleString();");
    expect(tab).not.toContain("KSERVE_SCALE_TARGET below");
  });
});

describe("serving wiring is shown, not edited", () => {
  it("sandbox serving: the backend and the GPU node rules", () => {
    const v = servingEnvView({});
    expect(v.backend).toBe("sandbox");
    expect(v.rows.map((r) => r.name)).toEqual([
      "ML_SERVING_BACKEND",
      "NOTEBOOK_K8S_GPU_NODE_SELECTOR",
      "NOTEBOOK_K8S_GPU_TOLERATIONS",
    ]);
    expect(v.rows.every((r) => !r.fromEnv)).toBe(true);
  });

  it("KServe: every setting with its value in force and whether the environment set it", () => {
    const v = servingEnvView({
      ML_SERVING_BACKEND: "kserve",
      KSERVE_NAMESPACE: "serving",
      KSERVE_SCORER_IMAGE: "registry.example.com/scorer:1",
    });
    expect(v.backend).toBe("kserve");
    const by = Object.fromEntries(v.rows.map((r) => [r.name, r]));
    expect(by.KSERVE_NAMESPACE).toEqual({
      name: "KSERVE_NAMESPACE",
      value: "serving",
      fromEnv: true,
    });
    expect(by.KSERVE_MODE.fromEnv).toBe(false);
    expect(by.KSERVE_MODE.value).toBe("Standard");
    expect(by.KSERVE_SERVICE_ACCOUNT.value).toBe("(none)");
  });

  it("has no field, and no way to save one", () => {
    const admin = rd("src/utils/notebookRuntimeAdmin.functions.ts");
    const validator = admin.slice(
      admin.indexOf("export const nbRuntimeUpdateSettings"),
      admin.indexOf(".parse(input)", admin.indexOf("export const nbRuntimeUpdateSettings")),
    );
    for (const k of ["kserve", "serving_backend", "gpu_node_selector", "tolerations"]) {
      expect(validator.toLowerCase()).not.toContain(k);
    }
  });
});

describe("every setting is wired end to end", () => {
  const admin = rd("src/utils/notebookRuntimeAdmin.functions.ts");
  const tab = rd("src/components/admin/RuntimeTab.tsx");
  const types = rd("src/integrations/supabase/types.ts");
  const env = rd(".env.example");
  const migration = rd("supabase/migrations/20261210000000_ml_settings_in_admin.sql");

  it.each([...ENV_BACKED_SETTINGS])("%s", (column) => {
    // A column, a field that says where its value comes from, a validator that
    // can clear it, and its variable documented.
    expect(types).toContain(`          ${column}: number | null;`);
    expect(tab).toContain(`source={src("${column}")}`);
    expect(admin).toMatch(
      // One field's chain, however prettier wraps it, never running into the next.
      new RegExp(
        `\\n\\s+${column}: z(?:(?!\\n\\s+[a-z_]+: z)[\\s\\S]){0,240}?\\.nullable\\(\\)\\s*\\.optional\\(\\),`,
      ),
    );
    expect(env).toContain(settingEnvName(column));
  });

  it("the migration only adds, each column with its check", () => {
    for (const column of Object.keys(NEW)) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column} integer`);
    }
    expect(migration).not.toMatch(/\bDROP\b|\bRENAME\b/i);
  });

  it("no use site reads these from the environment directly any more", () => {
    for (const f of [
      "src/utils/ml/predict.server.ts",
      "src/utils/ml/serve.server.ts",
      "src/utils/ml/evaluate.server.ts",
      "src/utils/ml/api.server.ts",
      "src/utils/ml/mlflow.server.ts",
    ]) {
      const code = codeOnly(rd(f));
      for (const name of [
        "ML_EXPLAIN_MAX_ROWS",
        "ML_EXPLAIN_TOP_K",
        "ML_EXPLAIN_BATCH_TOP_K",
        "ML_EXPLAIN_CHUNK_ROWS",
        "ML_SERVE_TARGET_RPM_PER_REPLICA",
        "ML_SERVE_SCALE_COOLDOWN_SECONDS",
        "ML_EVALUATIONS_PER_SWEEP",
        "ML_API_RATE_LIMIT_PER_MIN",
      ]) {
        expect(code, `${f} reads ${name}`).not.toMatch(
          new RegExp(`(process\\.env\\.|envCount\\("|envInt\\(")${name}`),
        );
      }
      expect(code, f).not.toContain("process.env.ML_IMPORT_MAX_MB");
    }
  });
});
