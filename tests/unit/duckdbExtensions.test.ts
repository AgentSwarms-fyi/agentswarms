// DuckDB extensions are baked into both images at build time, so no container
// downloads them at run time. The two lists that must agree — what the engine
// installs and what the image bakes — are pinned to each other here, because
// an extension added to the engine and not to the bake would be exactly the
// slow, offline-failing first request this exists to remove.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const rd = (p: string) => readFileSync(resolve(p), "utf8");

/** Every `INSTALL x;` name in a source string. */
const installs = (src: string): string[] =>
  [...src.matchAll(/INSTALL ([a-z_]+);/g)].map((m) => m[1]);

describe("the app image bakes every extension the lakehouse engine installs", () => {
  it("the Dockerfile runs the bake script as the app user", () => {
    const df = rd("Dockerfile");
    expect(df).toContain("RUN node scripts/bake-duckdb-extensions.mjs");
    // After USER node: the cache lives under that user's home, which is where
    // the engine looks at run time; baked as root it would sit under /root.
    expect(df.indexOf("USER node")).toBeLessThan(df.indexOf("bake-duckdb-extensions"));
  });

  it("the bake list covers the engine's list", () => {
    const script = rd("scripts/bake-duckdb-extensions.mjs");
    const baked = new Set(
      [...script.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((n) => n !== "memory"),
    );
    const engine = new Set(installs(rd("src/utils/lakehouse/core.server.ts")));
    expect([...engine].sort()).toEqual([
      "avro",
      "azure",
      "ducklake",
      "httpfs",
      "iceberg",
      "postgres",
    ]);
    for (const e of engine)
      expect(baked, `${e} is installed by the engine but not baked`).toContain(e);
  });

  it("the required four fail the build when missing; iceberg and avro stay optional", () => {
    const script = rd("scripts/bake-duckdb-extensions.mjs");
    expect(script).toContain('const required = ["ducklake", "postgres", "httpfs", "azure"]');
    expect(script).toContain("process.exit(1)");
  });

  it("installs everything before it loads anything", () => {
    // Once httpfs is loaded, DuckDB downloads further extensions through
    // httpfs's own HTTP client. The first build of this step baked ducklake,
    // postgres and httpfs and then failed on azure, avro and iceberg — so
    // the INSTALL pass must finish before the first LOAD.
    const script = rd("scripts/bake-duckdb-extensions.mjs");
    const install = script.indexOf("await c.run(`INSTALL ${ext};`)");
    const load = script.indexOf("await c.run(`LOAD ${ext};`)");
    expect(install).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(install);
    // and the LOAD loop is a separate pass, not the same loop body.
    expect(script.slice(install, load)).toContain("for (const ext of LAKEHOUSE_EXTENSIONS)");
  });

  it("the image has a CA bundle, installed before the app user takes over", () => {
    // node:22-slim ships none. Node's own root store hid it (every fetch()
    // worked) but DuckDB's httpfs is native OpenSSL: without the bundle it
    // cannot open any https:// object store — every cloud bucket — and
    // cannot download an extension once httpfs is loaded.
    const df = rd("Dockerfile");
    const apt = df.indexOf("apt-get install -y --no-install-recommends ca-certificates");
    expect(apt).toBeGreaterThan(-1);
    expect(apt).toBeLessThan(df.indexOf("USER node"));
    // and the apt lists do not stay in the image.
    expect(df.slice(apt, apt + 200)).toContain("rm -rf /var/lib/apt/lists/*");
  });
});

describe("the sandbox image bakes what lakehouse pipeline nodes load", () => {
  it("the runtime Dockerfile installs them into a read-only directory", () => {
    const df = rd("docker/notebook-runtime/Dockerfile");
    expect(df).toContain("'extension_directory': '/opt/agentswarms/duckdb-ext'");
    expect(df).toContain("INSTALL ducklake; INSTALL postgres; INSTALL httpfs;");
    expect(df).toContain("chmod -R a+rX /opt/agentswarms/duckdb-ext");
  });

  it("but no generated program attaches the catalog any more", () => {
    // R232. The bake stays because a NOTEBOOK may use duckdb with httpfs or
    // postgres, and that is the user's own code. What no longer exists is the
    // helper that attached DuckLake from engine credentials: ETL lost it in
    // R227, the Spark lakehouse target in R230 and ML in R231, after which
    // nothing in src called it and the bundler dropped it from dist — found by
    // checking a real image rather than by any test, because the tests that
    // named it called it themselves.
    //
    // Pinned as an absence, over every generated program, so that reaching for
    // an attach again is a failure here rather than a credential back in a
    // sandbox.
    for (const f of [
      "src/utils/etl/codegen.ts",
      "src/utils/etl/sparkCodegen.ts",
      "src/utils/ml/pyTrain.ts",
      "src/utils/lakehouse/sparkQueryCodegen.ts",
    ]) {
      expect(rd(f), f).not.toMatch(/ATTACH 'ducklake:|_lakehouse_con|lakehouseAttachFn/);
    }
    // The sandbox still uses duckdb — to read the Parquet the app stages and
    // to write what it loads — and neither needs an extension.
    expect(rd("src/utils/etl/codegen.ts")).toContain("con = duckdb.connect()");
  });
});
