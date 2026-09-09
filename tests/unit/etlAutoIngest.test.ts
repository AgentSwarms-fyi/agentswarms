// Auto-ingest from object storage: a prefix watched for new files. The
// generated program keeps a ledger on the cursor and reads only what is new;
// the pipeline becomes drainable, and so continuous-eligible.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileGraph, type EtlGraph } from "@/utils/etl/codegen";
import { canRunContinuously, isAutoIngest } from "@/utils/etl/continuous";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";

const rd = (p: string) => readFileSync(p, "utf8");

const graph = (extra: Record<string, unknown> = {}): EtlGraph => ({
  nodes: [
    {
      id: "s1",
      kind: "source",
      label: "Landing zone",
      config: { type: "object_storage", path: "landing/*.csv", format: "csv", ...extra },
    },
    {
      id: "t1",
      kind: "target",
      label: "Lakehouse",
      config: { type: "lakehouse", schema: "analytics", table: "landed", write_mode: "append" },
    },
  ] as EtlGraph["nodes"],
  edges: [{ id: "e1", from: "s1", to: "t1" }],
});

describe("what it is", () => {
  it("is an object-storage source with the setting on, and nothing else", () => {
    expect(isAutoIngest({ type: "object_storage", new_files_only: true })).toBe(true);
    expect(isAutoIngest({ type: "object_storage" })).toBe(false);
    expect(isAutoIngest({ type: "kafka", new_files_only: true })).toBe(false);
    expect(isAutoIngest(null)).toBe(false);
  });

  it("makes a storage source drainable, so the pipeline may run continuously", () => {
    expect(canRunContinuously("visual", graph())).toMatch(/drain again and again/);
    expect(canRunContinuously("visual", graph({ new_files_only: true }))).toBeNull();
  });
});

describe("the generated program", () => {
  const program = compileGraph(graph({ new_files_only: true, max_files_per_run: 2 }));
  const src = program.slice(program.indexOf("def _src_s1"), program.indexOf("def _tick"));

  it("lists the prefix and reads only files newer than the ledger, oldest first, capped", () => {
    // Listed fresh every tick: fsspec caches listings per (cached) filesystem
    // instance, and a continuous run would otherwise never see a later file.
    expect(src).toContain(
      'fs.invalidate_cache()\n    _listing = fs.glob(f"{base}/{path}", detail=True)',
    );
    expect(src).toContain(
      "_new = [(m, k) for (m, k) in _entries if m > _mark or (m == _mark and k not in _seen)]",
    );
    expect(src).toContain("_entries.sort()");
    expect(src).toContain("_max = max(1, int(2))");
    expect(src).toContain("_new = _new[:_max]");
    expect(src).toContain("keys = [k for (m, k) in _new]");
    // Directories in a listing are not files.
    expect(src).toContain("if (_info or {}).get('type') == 'directory':");
  });

  it("keeps a small ledger: the newest time loaded and the keys at that time, plus the columns", () => {
    expect(src).toContain("_cur = _json.loads(os.environ.get('ETL_S1_CURSOR') or '{}')");
    expect(src).toContain("_top = max(m for (m, k) in _new)");
    expect(src).toContain(
      "_keys = sorted([k for (m, k) in _new if m == _top] + (sorted(_seen) if _top == _mark else []))",
    );
    expect(src).toContain(
      "_files_last_s1 = _json.dumps({'mtime': _top, 'keys': _keys, 'columns': [str(c) for c in out.columns]})",
    );
  });

  it("an idle tick keeps the ledger and hands downstream an empty frame of the right shape", () => {
    expect(src).toContain(
      "out = pd.DataFrame(columns=[str(c) for c in (_cur.get('columns') or [])])",
    );
    expect(src).toContain("_files_last_s1 = None");
    // The ledger is a watermark like any other: reported only when set,
    // persisted by the platform after the load commits.
    expect(program).toContain("_files_last_s1 = None\n");
    expect(program).toContain("if _files_last_s1:\n        _watermarks['s1'] = _files_last_s1");
    expect(program).toContain('_CURSOR_ENV = {"s1": "ETL_S1"}');
  });

  it("without the setting the source reads the prefix whole, as it always did", () => {
    const plain = compileGraph(graph());
    expect(plain).toContain('keys = [p for p in fs.glob(f"{base}/{path}")] or [f"{base}/{path}"]');
    expect(plain).not.toContain("_files_last_s1");
    expect(plain).not.toContain('_CURSOR_ENV = {"s1"');
  });

  it("the Spark engine refuses it by name rather than reading the prefix whole", () => {
    expect(() => compileSparkGraph(graph({ new_files_only: true }))).toThrow(
      /reads only new files, which the sandbox engine does/,
    );
    expect(() => compileSparkGraph(graph())).not.toThrow();
  });
});

describe("the wiring", () => {
  it("the run seeds the ledger from the platform's cursor, and the editor offers the setting", () => {
    const svc = rd("src/utils/etl/service.server.ts");
    expect(svc).toContain("isAutoIngest(c) ||");
    const page = rd("src/routes/_authenticated/etl.tsx");
    expect(page).toContain("Only files not loaded before (auto-ingest)");
    expect(page).toContain("max_files_per_run");
    expect(page).toContain("a storage prefix watched for new files");
    expect(rd("docs/ETL_PIPELINES.md")).toContain("## Auto-ingest from object storage");
    expect(rd("README.md")).toContain("auto-ingest");
  });
});
