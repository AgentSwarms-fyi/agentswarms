// R125: the session's access token changes on every refresh (about hourly,
// and when a tab regains focus near expiry). A load keyed on it ran again each
// time and put the saved copy back over what the user was editing. R120 found
// it in Sheets; the sweep found it in 21 more places: the ETL pipeline editor,
// the report designer, the workflow editor, the admin runtime settings, the
// IAM model-rules draft, the audit retention box, the lakehouse layout dialog,
// six ML panels, two "copy this key now" dialogs, the Git sync dialog, a
// connection import pick, two typed delete confirmations, a table sheet's
// selection and the BI explore dialog's sort and page.
//
// Each fixed load reads the token through a ref (`useTokenRef`) and is keyed
// on signed-in state. The last test is the guard for the next one: every
// other hook keyed on the token was read and found to only re-fetch read-only
// data; a new one fails here until someone has done the same.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

/** A dependency list: from a closing "}," through "[...]" to its ")". */
const DEPS = /\}\s*,\s*(?:\/\/[^\n]*\n\s*)*\[([^\]]*)\]\s*,?\s*\)/g;
const TOKEN_DEP = /(^|[.?])(token|access_token)$/;

function items(list: string): string[] {
  return list
    .split(",")
    .map((x) => x.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean);
}

/** The hook around `marker`: where it starts, its body, and its dependency list. */
function hookAt(src: string, marker: string) {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
  expect(src.indexOf(marker, at + 1), `marker not unique: ${marker}`).toBe(-1);
  // The hook the marker is in (or starts): the last one opened before its end.
  const end = at + marker.length;
  const start = Math.max(src.lastIndexOf("useCallback(", end), src.lastIndexOf("useEffect(", end));
  expect(start, `no hook around: ${marker}`).toBeGreaterThan(-1);
  const re = new RegExp(DEPS.source, "g");
  re.lastIndex = end;
  const m = re.exec(src);
  expect(m, `no dependency list after: ${marker}`).not.toBeNull();
  return { body: src.slice(start, m!.index), deps: items(m![1]) };
}

const FIXED: { file: string; marker: string; what: string; callsLoad?: true }[] = [
  {
    file: "src/routes/_authenticated/etl.tsx",
    marker: "const reloadPipeline = useCallback(",
    what: "the pipeline editor's load",
  },
  {
    file: "src/routes/_authenticated/bi_.report.$reportId.tsx",
    marker: "const res = await getFn({ data: { accessToken: token, id: reportId } });",
    what: "the report designer's load",
  },
  {
    file: "src/routes/_authenticated/workflows.tsx",
    marker: "const res = await getFn({ data: { accessToken: token, id: selectedId } });",
    what: "the workflow editor's load",
  },
  {
    file: "src/routes/_authenticated/workflows.tsx",
    marker: "const loadRuns = useCallback(",
    what: "the workflow runs load (the editor's load depends on it)",
  },
  {
    file: "src/routes/_authenticated/admin.iam.tsx",
    marker: "  const reload = useCallback(() => {\n    const token = tokenRef.current;",
    what: "the IAM page's reload",
  },
  {
    file: "src/components/admin/RuntimeTab.tsx",
    marker: "const load = useCallback(() => {\n    setLoadError(null);",
    what: "the runtime settings load",
  },
  {
    file: "src/components/observability/AuditLog.tsx",
    marker: "  const load = useCallback(\n    async (actionFilter: string) => {",
    what: "the audit log's load",
  },
  {
    file: "src/components/observability/AuditLog.tsx",
    marker: "void load(action);",
    what: "the audit log's reload effect",
    callsLoad: true,
  },
  {
    file: "src/routes/_authenticated/lakehouse.tsx",
    marker: "access_token: tokenRef.current, schema, table",
    what: "the layout dialog's load",
  },
  {
    file: "src/components/ml/MlApiKeysDialog.tsx",
    marker: "const load = useCallback(() => {",
    what: "the model API keys load (it clears the one-time key)",
  },
  {
    file: "src/components/notebooks/PublishNotebookDialog.tsx",
    marker: "const load = useCallback(() => {",
    what: "the notebook API keys load (it clears the one-time key)",
  },
  {
    file: "src/components/ml/PromotionGate.tsx",
    marker: "const load = useCallback(",
    what: "the approvers load",
  },
  {
    file: "src/components/ml/FairnessPanel.tsx",
    marker: "const load = useCallback(",
    what: "the fairness settings load",
  },
  {
    file: "src/components/ml/AccuracyPanel.tsx",
    marker: "const load = useCallback(",
    what: "the outcome source load",
  },
  {
    file: "src/components/ml/DeploymentPanel.tsx",
    marker: "const load = useCallback(",
    what: "the deployment load",
  },
  {
    file: "src/components/ml/CalibrationPanel.tsx",
    marker: "const load = useCallback(",
    what: "the operating point load",
  },
  {
    file: "src/components/ml/ExperimentsPanel.tsx",
    marker: "const load = useCallback(",
    what: "the experiments load (a new list resets the description being typed)",
  },
  {
    file: "src/components/ml/ExperimentsPanel.tsx",
    marker: "accessToken: tokenRef.current, experimentId: selected }",
    what: "the runs load (its spinner unmounts the description box)",
  },
  {
    file: "src/components/sheets/OpenTableDialog.tsx",
    marker: "access_token: tokenRef.current, connection_id: connId",
    what: "the connection tables load (it clears the table picked)",
  },
  {
    file: "src/components/bi/BiGitSyncDialog.tsx",
    marker: "getConfig({ data: { access_token: token } })",
    what: "the Git sync settings load",
  },
  {
    file: "src/routes/_authenticated/data-sql.tsx",
    marker: "const loadDependents = useCallback(",
    what: "the delete dialog's dependents (it clears the typed name)",
  },
  {
    file: "src/components/bi/DataPrepTab.tsx",
    marker: "const loadDependents = useCallback(",
    what: "the prep tab's delete dialog dependents",
  },
  {
    file: "src/components/sheets/TableSheet.tsx",
    marker: "const fetchPage = useCallback(",
    what: "a table sheet's page loader (its reset clears the loaded rows and the selection)",
  },
  {
    file: "src/components/bi/BiExploreDialog.tsx",
    marker: "const run = useCallback(",
    what: "the explore dialog's query (its re-run drops the sort and page)",
  },
];

describe("loads that replace what the user edits do not follow the token", () => {
  for (const f of FIXED) {
    it(`${f.what} — ${f.file}`, () => {
      const { body, deps } = hookAt(read(f.file), f.marker);
      expect(deps.filter((d) => TOKEN_DEP.test(d))).toEqual([]);
      // It still calls the server with the current token (an effect that
      // only runs a fixed load reaches it through that load).
      if (!f.callsLoad) expect(body).toContain("tokenRef.current");
    });
  }

  it("the model-rules draft starts again only when that principal's saved rules change", () => {
    const src = read("src/routes/_authenticated/admin.iam.tsx");
    const { deps } = hookAt(src, "setDraft(JSON.parse(savedRules)");
    expect(deps).toEqual(["principalType", "principalId", "savedRules"]);
  });

  it("a table sheet's loader does not follow the workbook object either", () => {
    // useWorkbook returns a new object on every render of the page around the
    // sheet; keyed on it, any re-render (a save finishing, the session
    // refreshing) started the sheet over.
    const { deps } = hookAt(
      read("src/components/sheets/TableSheet.tsx"),
      "const fetchPage = useCallback(",
    );
    expect(deps).not.toContain("wb");
  });

  it("the explore dialog re-queries when the drill path or cross-filter says something new", () => {
    const src = read("src/components/bi/BiExploreDialog.tsx");
    const at = src.indexOf("const predicates = useMemo(");
    // An arrow that returns an expression: its list closes the memo, after "),".
    const block = src.slice(at, src.indexOf(");", at) + 2);
    const m = /\[([^\]]*)\]\s*,?\s*\);$/.exec(block)!;
    expect(items(m[1])).toEqual(["drillKey", "contextKey"]);
    expect(src).toContain("const drillKey = JSON.stringify(drillPath ?? []);");
  });

  it("the token ref follows the latest token and says whether one is signed in", () => {
    const src = read("src/hooks/use-token-ref.ts");
    expect(src).toContain('tokenRef.current = token ?? "";');
    expect(src).toContain("return { tokenRef, signedIn: !!token };");
  });
});

/**
 * Every other hook keyed on the token, file by file. Each was read for R125
 * and found to re-fetch read-only data only (a list, options for a picker, a
 * status). A new hook keyed on the token, or one more in any of these files,
 * fails below: read it, and if its re-run can replace something the user is
 * editing, use `useTokenRef` instead; if it only re-reads what the user sees,
 * raise the count here.
 */
const REVIEWED: Record<string, number> = {
  "src/components/admin/GroupBudgetsTab.tsx": 1,
  "src/components/admin/VectorStorePanel.tsx": 1,
  "src/components/bi/BiBuilderPane.tsx": 1,
  "src/components/bi/BiModelSelect.tsx": 1,
  "src/components/bi/BiWorkspaceManager.tsx": 1,
  "src/components/bi/DataPrepTab.tsx": 3,
  "src/components/bi/ReportsTab.tsx": 1,
  "src/components/catalog/AddSourceWizard.tsx": 1,
  "src/components/catalog/CatalogView.tsx": 1,
  "src/components/catalog/DatasetQualityPanel.tsx": 1,
  "src/components/dashboard/SpendPanel.tsx": 1,
  "src/components/etl/SourcePickers.tsx": 5,
  "src/components/gateway/GatewayApiCard.tsx": 1,
  "src/components/integrations/SaasSourcesTab.tsx": 1,
  "src/components/integrations/SlackRoutingCard.tsx": 1,
  "src/components/integrations/SlackTab.tsx": 1,
  "src/components/integrations/StreamStateDialog.tsx": 1,
  "src/components/integrations/TeamsTab.tsx": 1,
  "src/components/integrations/WarehousesTab.tsx": 1,
  "src/components/lakehouse/IcebergDialog.tsx": 1,
  "src/components/ml/FeatureViewsPanel.tsx": 2,
  "src/components/ml/ModelCardDialog.tsx": 1,
  "src/components/ml/PredictionsPanel.tsx": 2,
  "src/components/ml/SchedulesPanel.tsx": 2,
  "src/components/notebooks/NotebookGitDialog.tsx": 1,
  "src/components/notebooks/RunningKernels.tsx": 1,
  "src/components/observability/TeamSpend.tsx": 1,
  "src/components/sheets/OpenTableDialog.tsx": 3,
  "src/components/sheets/SaveToLakehouseDialog.tsx": 1,
  "src/routes/_authenticated/admin.iam.tsx": 3,
  "src/routes/_authenticated/ai-analyst.tsx": 3,
  "src/routes/_authenticated/bi_.$dashboardId.tsx": 6,
  "src/routes/_authenticated/bi_.report.$reportId.tsx": 3,
  "src/routes/_authenticated/data-monitors.tsx": 2,
  "src/routes/_authenticated/data-sql.tsx": 2,
  "src/routes/_authenticated/etl.tsx": 7,
  "src/routes/_authenticated/lakehouse.tsx": 6,
  "src/routes/_authenticated/ml.tsx": 1,
  "src/routes/_authenticated/ml_.$modelId.tsx": 2,
  "src/routes/_authenticated/ml_.new.tsx": 2,
  "src/routes/_authenticated/model-registry.tsx": 1,
  "src/routes/_authenticated/monitoring.tsx": 2,
  "src/routes/_authenticated/notebooks.py.$pyNotebookId.tsx": 1,
  "src/routes/_authenticated/notebooks.sample.$sampleSlug.tsx": 1,
  "src/routes/_authenticated/secrets.tsx": 1,
  "src/routes/_authenticated/semantics.tsx": 3,
  "src/routes/_authenticated/sheets.tsx": 2,
  "src/routes/_authenticated/sql-models.tsx": 1,
  "src/routes/_authenticated/traces.tsx": 1,
  "src/routes/_authenticated/workflows.tsx": 3,
};

function tokenKeyedHooks(): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = read(p);
        let n = 0;
        for (const m of src.matchAll(new RegExp(DEPS.source, "g")))
          if (items(m[1]).some((x) => TOKEN_DEP.test(x))) n++;
        if (n) out[p.split("\\").join("/")] = n;
      }
    }
  };
  walk("src");
  return out;
}

describe("every hook keyed on the token has been read", () => {
  it("no file has one that was not reviewed", () => {
    const found = tokenKeyedHooks();
    const unreviewed = Object.entries(found)
      .filter(([file, n]) => n > (REVIEWED[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} (reviewed ${REVIEWED[file] ?? 0})`);
    expect(unreviewed).toEqual([]);
  });

  it("finds them however the dependency list is laid out", () => {
    const one = "useEffect(() => {\n  load();\n}, [token, id]);";
    const wrapped =
      "useCallback(\n  async () => {\n    x();\n  },\n  // why\n  [listFn, token],\n);";
    for (const src of [one, wrapped]) {
      const hits = [...src.matchAll(new RegExp(DEPS.source, "g"))].filter((m) =>
        items(m[1]).some((x) => TOKEN_DEP.test(x)),
      );
      expect(hits).toHaveLength(1);
    }
    const ref = "useCallback(() => x, [tokenRef, signedIn]);";
    expect(
      [...ref.matchAll(new RegExp(DEPS.source, "g"))].filter((m) =>
        items(m[1]).some((x) => TOKEN_DEP.test(x)),
      ),
    ).toEqual([]);
  });
});
