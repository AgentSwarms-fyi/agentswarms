// The product could not read back what the product had just written.
//
// Found live, in one sitting, from one run. The shipped "Orders ↔ payments
// reconciliation" template landed 257 matched rows as Parquet and 52
// exceptions as JSONL. Both targets succeeded. Then:
//
//   * the Data Catalog listed `recon_exceptions` with **10 rows**, not 52;
//   * "Query data" on it failed with
//       IO Error: No files found that match the pattern
//       "s3://etl/finance/recon_exceptions/*.ndjson"
//   * and a pipeline reading that folder back would have died with
//       UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8b
//
// One cause behind all three: **dlt gzips text output**. The file in the
// bucket is `1789716749.8566182.2f2a328a13.jsonl.gz`, and three separate
// places assumed it was called `.ndjson` and contained text.
//
//   1. the crawler's glob   `${dir}/*.${logical format}` — the logical format
//      of a `.jsonl.gz` file is "ndjson", so the catalog stored a glob that
//      matched nothing in its own folder. That string is the catalog's join
//      key: the Workbench reads through it, an ETL catalog-asset source
//      resolves to it, and catalog lineage matches it.
//   2. the row estimate     counted newlines in GZIP BYTES — 0x0A appears in
//      compressed data about as often as in any other noise, which is how 52
//      rows became a confident, plausible 10.
//   3. the object-storage reader  `fs.open(k, 'rb')` handed pandas gzip.
//
// And a fourth that only shows up once the first is fixed: the run REPORTS
// its target's fqn, lineage joins on that string, so the compiler and the
// crawler have to spell the same filename. What dlt actually writes was
// measured against dlt 1.30.0 rather than assumed — see DLT_FILE_EXT.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import { lineageKey, sourceLineageFor } from "@/lib/dataCatalog";
import { objectSqlName } from "@/lib/objectSqlName";
import { datasetFqn, estimateRows, isDatasetGroup } from "@/utils/catalog/crawler.server";
import { objectExt } from "@/utils/catalog/objectStore.server";
import { DLT_FILE_EXT, compileGraph, compilePreview, type EtlGraph } from "@/utils/etl/codegen";
import { compileSparkGraph } from "@/utils/etl/sparkCodegen";

/** A listing entry, shaped the way the crawler's grouping produces them. */
const obj = (key: string, size = 2253) => ({ key, size, last_modified: "2026-09-18T07:32:00Z" });

/** The folder the reconciliation run actually left behind. */
const gzGroup = {
  dir: "finance/recon_exceptions",
  format: "ndjson",
  objects: [obj("finance/recon_exceptions/1789716749.8566182.2f2a328a13.jsonl.gz")],
};

describe("what a key is called, versus what it is", () => {
  it("keeps the .gz tail, because a glob has to match the name", () => {
    expect(objectExt("finance/x/1789716749.85.2f2a.jsonl.gz")).toBe("jsonl.gz");
    expect(objectExt("finance/x/orders.csv.gz")).toBe("csv.gz");
    expect(objectExt("finance/x/1789716743.90.58bd.parquet")).toBe("parquet");
    // Spark's own naming, where the second-to-last segment is a codec and not
    // a format — `*.parquet` still matches it, so "parquet" is the answer.
    expect(objectExt("t/part-00000-c000.snappy.parquet")).toBe("parquet");
    expect(objectExt("t/README")).toBe("");
  });
});

describe("the fqn the catalog stores", () => {
  it("globs the extension on disk, not the logical format", () => {
    // The whole defect in one assertion.
    expect(datasetFqn(gzGroup)).toBe("finance/recon_exceptions/*.jsonl.gz");
    expect(datasetFqn(gzGroup)).not.toBe("finance/recon_exceptions/*.ndjson");
  });

  it("is unchanged for the formats that were never compressed", () => {
    expect(
      datasetFqn({
        dir: "finance/orders_reconciled",
        format: "parquet",
        objects: [obj("finance/orders_reconciled/1789716743.9029138.58bdd233ab.parquet")],
      }),
    ).toBe("finance/orders_reconciled/*.parquet");
  });

  it("falls back to the format when one folder mixes spellings", () => {
    // A single glob cannot match both, and picking one would silently drop
    // the other half of the dataset. Staying with the logical format is no
    // worse than before and is at least not a lie about which files exist.
    const mixed = {
      dir: "raw/events",
      format: "ndjson",
      objects: [obj("raw/events/a.jsonl.gz"), obj("raw/events/b.ndjson")],
    };
    expect(datasetFqn(mixed)).toBe("raw/events/*.ndjson");
  });

  it("is what the crawler actually STORES, not just what it can compute", () => {
    // The first cut of this fix changed the helper and left the asset push
    // building its own string from `g.format` a few lines below — so every
    // assertion above passed while the catalog went on storing `*.ndjson`.
    // The crawl itself needs a bucket, so the push is pinned by reading it.
    const crawler = readFileSync("src/utils/catalog/crawler.server.ts", "utf8");
    const at = crawler.indexOf('asset_type: "dataset"');
    expect(at, "the dataset push was renamed; re-anchor this test").toBeGreaterThan(-1);
    const push = crawler.slice(at, at + 400);
    expect(push).toContain("fqn: datasetFqn(g),");
    expect(push).not.toMatch(/fqn: `\$\{g\.dir \|\| "\."\}\/\*\.\$\{g\.format\}`/);
  });

  it("still returns the key itself for a lone file at the bucket root", () => {
    const root = { dir: "", format: "csv", objects: [obj("orders.csv")] };
    expect(isDatasetGroup(root)).toBe(false);
    expect(datasetFqn(root)).toBe("orders.csv");
  });
});

describe("the SQL name both sides have to agree on", () => {
  it("names the folder, not the glob, for a gzipped dataset", () => {
    // Without the `(\.gz)?` in the trim, the name came out of "*.jsonl.gz"
    // instead of the folder, and the Catalog's seeded query named a table the
    // server could not resolve.
    expect(objectSqlName("finance/recon_exceptions/*.jsonl.gz")).toBe("recon_exceptions");
    expect(objectSqlName("finance/orders/*.csv.gz")).toBe("orders");
    // The cases that already worked still do.
    expect(objectSqlName("finance/orders_reconciled/*.parquet")).toBe("orders_reconciled");
    expect(objectSqlName("data/orders.parquet")).toBe("orders");
  });
});

describe("counting rows in a file that is not text", () => {
  /** 52 exception rows, shaped like the ones the run wrote, gzipped. */
  const exceptions = (() => {
    const lines: string[] = [];
    for (let i = 0; i < 52; i++) {
      lines.push(
        JSON.stringify({
          order_id: `ORD-1${String(i).padStart(3, "0")}`,
          customer_id: `C0${i}`,
          order_date: "2026-08-01",
          updated_at: "2026-08-01T00:00:00Z",
          amount: 546.09 + i,
          currency: "USD",
          status: "completed",
          country: "DE",
          paid_total: 0,
          n_payments: 0,
          recon_status: "missing_payment",
        }),
      );
    }
    return zlib.gzipSync(Buffer.from(lines.join("\n") + "\n", "utf8"));
  })();

  it("decompresses first, and gets the real number", () => {
    // The sample covered the whole object, so this is a count, not an estimate.
    expect(estimateRows(exceptions, exceptions.length, "ndjson", "x/load.jsonl.gz")).toBe(52);
  });

  it("would have invented a number from the compressed bytes", () => {
    // What the old code did, restated, so the size of the error is visible
    // rather than asserted in the abstract: newlines that happen to occur in
    // a gzip stream, scaled by a bytes-per-line ratio built from them.
    const text = exceptions.toString("utf8");
    const bogusLines = text.split("\n").filter((l) => l.trim() !== "").length;
    const bogus = Math.round(exceptions.length / (exceptions.length / bogusLines));
    expect(bogus).toBeLessThan(30);
    expect(bogus).not.toBe(52);
    // And the live catalog showed exactly this shape of wrongness: 52 → 10.
  });

  it("counts an uncompressed sample that covers the file exactly", () => {
    const plain = Buffer.from(["a", "b", "c"].map((v) => `{"v":"${v}"}`).join("\n"), "utf8");
    expect(estimateRows(plain, plain.length, "ndjson", "x/load.jsonl")).toBe(3);
    // CSV's header is not a row.
    const csv = Buffer.from("a,b\n1,2\n3,4\n", "utf8");
    expect(estimateRows(csv, csv.length, "csv", "x/load.csv")).toBe(2);
  });

  it("still estimates when the sample is only the head of a big file", () => {
    const rows: string[] = [];
    for (let i = 0; i < 100; i++) rows.push(JSON.stringify({ i, pad: "0123456789" }));
    const head = Buffer.from(rows.join("\n"), "utf8");
    // Ten times the sampled bytes: about ten times the rows. The last line of
    // a partial sample is dropped as unmeasured, so 99 scale to ~990.
    const got = estimateRows(head, head.length * 10, "ndjson", "x/load.jsonl");
    expect(got).toBeGreaterThan(900);
    expect(got).toBeLessThan(1010);
  });

  it("answers null for a format it cannot count", () => {
    expect(estimateRows(Buffer.from("x"), 1, "parquet", "x/a.parquet")).toBeNull();
    // Unreadable gzip is honestly "no idea", not zero.
    expect(estimateRows(Buffer.from("not gzip"), 8, "ndjson", "x/a.jsonl.gz")).toBeNull();
  });
});

// ── The compiler's half of the agreement ────────────────────────────────────

const storageGraph = (format: "jsonl" | "csv" | "parquet"): EtlGraph =>
  ({
    nodes: [
      {
        id: "n1",
        kind: "source",
        label: "in",
        config: { type: "object_storage", path: "raw/orders/*.csv", format: "csv" },
      },
      {
        id: "n2",
        kind: "target",
        label: "out",
        config: {
          type: "object_storage",
          dataset: "finance",
          table: "recon_exceptions",
          format,
          write_mode: "replace",
        },
      },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("the filename a run reports for its target", () => {
  it("matches what dlt 1.30.0 leaves in the bucket", () => {
    // Measured, in the runtime image, writing one resource per format:
    //   jsonl   -> 1789717247.006242.313c9cc5f7.jsonl.gz
    //   csv     -> 1789717247.5861135.1a09cd7f30.csv.gz
    //   parquet -> 1789717248.6333005.a2880ca09f.parquet
    expect(DLT_FILE_EXT).toEqual({ jsonl: "jsonl.gz", csv: "csv.gz", parquet: "parquet" });
  });

  it("is the same string the crawler would store for that folder", () => {
    // The two sides of the lineage join, computed independently and compared.
    for (const [format, written] of [
      ["jsonl", "1789716749.8566182.2f2a328a13.jsonl.gz"],
      ["csv", "1789717247.5861135.1a09cd7f30.csv.gz"],
      ["parquet", "1789716743.9029138.58bdd233ab.parquet"],
    ] as const) {
      const reported = compileGraph(storageGraph(format)).match(
        /'fqn': '(finance\/recon_exceptions\/[^']+)'/,
      );
      expect(reported, `no fqn emitted for ${format}`).not.toBeNull();
      const crawled = datasetFqn({
        dir: "finance/recon_exceptions",
        format: format === "parquet" ? "parquet" : format === "csv" ? "csv" : "ndjson",
        objects: [obj(`finance/recon_exceptions/${written}`)],
      });
      expect(reported![1], `${format}: run and crawler disagree`).toBe(crawled);
    }
  });

  it("reports Spark's naming on the Spark engine, which is not dlt's", () => {
    // Spark writes part-*.json (uncompressed) and part-*.snappy.parquet.
    // Same requirement, different writer — so the same graph reports a
    // different glob depending on which engine ran it, on purpose.
    const spark = compileSparkGraph(storageGraph("jsonl"));
    expect(spark).toContain("'finance/recon_exceptions/*.json'");
    expect(spark).not.toContain("*.ndjson");
  });
});

describe("reading a bucket object back", () => {
  it("infers compression, in both compilers", () => {
    const graph = {
      nodes: [
        {
          id: "n1",
          kind: "source",
          label: "in",
          config: {
            type: "object_storage",
            path: "finance/recon_exceptions/*.jsonl.gz",
            format: "jsonl",
          },
        },
        {
          id: "n2",
          kind: "transform",
          label: "keep",
          config: { type: "filter", expr: "n_payments == 0" },
        },
        {
          id: "n3",
          kind: "target",
          label: "out",
          config: { type: "lakehouse", schema: "analytics", table: "t", write_mode: "replace" },
        },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    // The preview is a second compiler over the same nodes; a preview that
    // opened the file raw would fail on a file the run reads fine.
    for (const code of [compileGraph(graph), compilePreview(graph, "n2")]) {
      expect(code).toContain("fs.open(k, 'rb', compression='infer')");
      expect(code).not.toContain("fs.open(k, 'rb')");
    }
  });
});

/** A pandas+fsspec interpreter, or null — the runtime image is where this runs. */
const RUNNER: { cmd: string; args: string[] } | null = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "import pandas, fsspec"], { stdio: "ignore" });
      return { cmd: c, args: ["-"] };
    } catch {
      /* next */
    }
  }
  try {
    execFileSync("docker", ["image", "inspect", "agentswarms/notebook-runtime:latest"], {
      stdio: "ignore",
    });
    return {
      cmd: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        "--entrypoint",
        "python",
        "agentswarms/notebook-runtime:latest",
        "-",
      ],
    };
  } catch {
    return null;
  }
})();

describe("what the two readers actually do, run as Python", () => {
  it("fails without the argument and works with it", () => {
    if (!RUNNER) {
      console.warn("no pandas+fsspec and no runtime image; the reader was not exercised");
      return;
    }
    const out = execFileSync(RUNNER.cmd, RUNNER.args, {
      input: [
        "import gzip, json, tempfile, os",
        "import fsspec",
        "import pandas as pd",
        "d = tempfile.mkdtemp()",
        "p = os.path.join(d, 'load.jsonl.gz')",
        "rows = [{'order_id': 'ORD-%d' % i, 'recon_status': 'missing_payment'} for i in range(5)]",
        "with gzip.open(p, 'wt') as fh:",
        "    for r in rows:",
        "        fh.write(json.dumps(r) + chr(10))",
        "fs = fsspec.filesystem('file')",
        "try:",
        "    with fs.open(p, 'rb') as f:",
        "        pd.read_json(f, lines=True)",
        "    print('OLD: no error')",
        "except Exception as e:",
        "    print('OLD:', type(e).__name__)",
        "with fs.open(p, 'rb', compression='infer') as f:",
        "    df = pd.read_json(f, lines=True)",
        "print('NEW rows:', len(df), 'cols:', list(df.columns))",
        "# and the argument must not change an uncompressed read",
        "q = os.path.join(d, 'load.jsonl')",
        "with open(q, 'w') as fh:",
        "    for r in rows:",
        "        fh.write(json.dumps(r) + chr(10))",
        "with fs.open(q, 'rb', compression='infer') as f:",
        "    df2 = pd.read_json(f, lines=True)",
        "print('PLAIN rows:', len(df2))",
      ].join("\n"),
      stdio: "pipe",
    }).toString();
    // The live failure this prevents, reproduced: the byte is gzip's magic.
    expect(out).not.toContain("OLD: no error");
    expect(out).toMatch(/OLD: (UnicodeDecodeError|ValueError)/);
    expect(out).toContain("NEW rows: 5 cols: ['order_id', 'recon_status']");
    expect(out).toContain("PLAIN rows: 5");
  }, 120_000);
});

// ── The joins that a longer filename would otherwise have broken ────────────
//
// Changing the stored fqn is not a local edit: it is the catalog's join key,
// and three other places parse it. Each of them assumed the last dot segment
// was the format, which is only true while nothing is compressed.

describe("matching lineage to the asset it points at", () => {
  it("keys an object fqn on the whole path, not its last two dot pieces", () => {
    // `finance/x/*.jsonl.gz` split on "." ends in ["jsonl", "gz"] — a key
    // EVERY gzipped dataset in the bucket would share, so an exception report
    // would show the orders table's lineage.
    const a = "finance/recon_exceptions/*.jsonl.gz";
    const b = "medallion/orders_quarantine/*.jsonl.gz";
    expect(lineageKey(a)).toBe(a);
    expect(lineageKey(a)).not.toBe(lineageKey(b));
  });

  it("leaves a dotted warehouse name alone", () => {
    expect(lineageKey("hive_metastore.analytics.revenue_facts")).toBe("analytics.revenue_facts");
    expect(lineageKey("analytics.revenue_facts")).toBe("analytics.revenue_facts");
  });

  it("joins the fqn a RUN reports to the asset the CRAWLER stored", () => {
    // The end-to-end shape: what the compiler emits for a jsonl target and
    // what the crawler stores for the folder it lands in have to meet here.
    const reported = compileGraph(storageGraph("jsonl")).match(
      /'fqn': '(finance\/recon_exceptions\/[^']+)'/,
    )![1];
    const crawled = datasetFqn(gzGroup);
    const edges = [
      {
        upstream_fqn: "python",
        downstream_fqn: reported,
        upstream_column: null,
        downstream_column: null,
        exact: true,
      },
    ];
    expect(sourceLineageFor(edges, crawled).upstream).toHaveLength(1);
  });
});

describe("mounting a bucket as a lakehouse schema", () => {
  it("does not silently skip the compressed datasets", () => {
    // The mount parses the fqn with an inline regex. Pull the literal out of
    // the source and run it, so this checks behaviour rather than spelling —
    // before the `.gz` group it simply failed to match and the asset was
    // counted as `skipped`, with no message anywhere.
    const src = readFileSync("src/utils/lakehouse.functions.ts", "utf8");
    const lit = /const m = (\/\^.+?\/)i\.exec\(asset\.fqn\)/.exec(src);
    expect(lit, "the mount's fqn regex moved; re-anchor this test").not.toBeNull();
    const re = new RegExp(lit![1].slice(1, -1), "i");
    expect(re.exec("finance/recon_exceptions/*.jsonl.gz")?.[2]).toBe("jsonl");
    expect(re.exec("finance/orders/*.csv.gz")?.[2]).toBe("csv");
    expect(re.exec("finance/orders_reconciled/*.parquet")?.[2]).toBe("parquet");
    // A lone file is still not a dataset glob, and must still not match.
    expect(re.exec("orders.csv")).toBeNull();
  });
});

describe("the Query data button", () => {
  it("is offered on a compressed dataset, not withheld from it", () => {
    // The trade this fix could easily have made: correct the glob and lose the
    // button. The catalog decides whether to offer "Query data" with an
    // anchored extension test over the fqn, and `*.jsonl.gz` ends in `.gz` —
    // so the fixed asset would have had no button at all, on exactly the
    // assets this product writes most often. Caught by pressing it.
    const view = readFileSync("src/components/catalog/CatalogView.tsx", "utf8");
    const lit = /const QUERYABLE_OBJECT = (\/.+?\/)i;/.exec(view);
    expect(lit, "QUERYABLE_OBJECT moved; re-anchor this test").not.toBeNull();
    const re = new RegExp(lit![1].slice(1, -1), "i");
    expect(re.test("finance/recon_exceptions/*.jsonl.gz")).toBe(true);
    expect(re.test("finance/orders/*.csv.gz")).toBe(true);
    expect(re.test("finance/orders_reconciled/*.parquet")).toBe(true);
    expect(re.test("data/orders.parquet")).toBe(true);
    // Still no button on something the engine has no reader for.
    expect(re.test("archive/backup.zip")).toBe(false);
    expect(re.test("archive/backup.tar.gz")).toBe(false);
  });
});
