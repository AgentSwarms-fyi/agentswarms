// ORC, read in a child process — because the extension can kill this one.
//
// MEASURED, not defensive programming. DuckDB has no built-in ORC reader; the
// community extension provides `read_orc`. Against files published by the
// Apache ORC project itself, on DuckDB v1.5.5:
//
//   demo-11-none.orc              flat, 9 cols     DESCRIBE ok   rows ok
//   TestOrcFile.testDate1900.orc  flat, timestamps DESCRIBE ok   rows ok
//   orc_split_elim.orc            flat             DESCRIBE ok   rows -> error
//   TestOrcFile.test1.orc         nested STRUCT    DESCRIBE ok   rows -> PANIC
//
// That last one is the reason this file exists. It is a Rust panic inside the
// extension's Arrow bridge ("assertion `left == right` failed, left: 12,
// right: 11") in a function that cannot unwind, so it calls abort(). Node
// cannot catch it, no try/catch helps, and the whole server goes down.
//
// It is reachable by putting an ORC file with a nested column in a bucket the
// crawler reads. That makes it a denial of service, so ORC never runs in the
// server process. A child dies; the parent reports "this file could not be
// read" and carries on.
//
// Parquet and CSV do NOT go through here. They are handled by DuckDB's
// built-in readers, which are stable, and a process spawn per object would be
// a real cost paid for a risk that does not exist there.
//
// THE SECOND SURPRISE: read_orc CANNOT READ s3://. Measured on the same
// connection, in the same child, one statement apart:
//
//   read_parquet('s3://bucket/orders.parquet')   OK, 4 columns
//   read_orc('s3://bucket/flat.orc')             "no files found matching"
//   read_orc('http://host/bucket/flat.orc')      "no files found matching"
//   read_orc('/local/path/flat.orc')             OK, 9 columns
//
// The extension does not go through DuckDB's virtual filesystem, so httpfs
// does not help it. An ORC object therefore has to be DOWNLOADED first, which
// is why this module fetches bytes rather than composing an s3:// URL — and
// why it has a size ceiling that Parquet does not need.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sampleObject, type ObjectStoreConfig } from "./objectStore.server";
import { assertEndpointAllowed } from "./objectStoreRead.server";

const run = promisify(execFile);

/** Wall clock for one child. An unresponsive extension must not hang a crawl. */
const ORC_TIMEOUT_MS = 60_000;
/** Bytes of JSON a child may return. Beyond this the read is refused, not truncated. */
const ORC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Largest ORC object this will pull down, since the whole file must be local.
 *
 * A cap rather than a stream because a partial ORC is not a smaller ORC — the
 * footer is at the end, so a truncated download is simply unreadable. Better
 * to refuse with a size than to download 8 GB and then fail.
 */
function orcMaxBytes(): number {
  const n = Number(process.env.ORC_MAX_DOWNLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 256 * 1024 * 1024;
}

/**
 * Bring an ORC object to local disk, or explain why not.
 *
 * `sampleObject` issues a ranged GET; asking for one byte past the ceiling
 * distinguishes "the whole file" from "the first N bytes of a larger one"
 * without a separate HEAD.
 */
async function download(
  cfg: ObjectStoreConfig,
  key: string,
): Promise<{ dir: string; file: string }> {
  // A crawled FOLDER of same-format files is one asset with a glob key
  // (`sales/*.orc`). Parquet and CSV handle that — httpfs expands the glob,
  // verified — but this path fetches one object, and a glob is not an object
  // key. Refuse by name rather than issuing a GET that 404s on a path with a
  // literal asterisk in it.
  if (key.includes("*")) {
    throw new Error(
      `"${key}" is a folder of ORC files, and the ORC reader cannot expand one — it opens a ` +
        `single local file. Query an individual .orc object, or convert the folder to Parquet, ` +
        `which is read in place and does expand globs.`,
    );
  }
  const cap = orcMaxBytes();
  const buf = await sampleObject(cfg, key, cap + 1);
  if (buf.length > cap) {
    throw new Error(
      `"${key}" is larger than the ${Math.round(cap / 1024 / 1024)} MB ORC limit. The ORC reader ` +
        `cannot stream from object storage, so the file has to be downloaded whole. Raise ` +
        `ORC_MAX_DOWNLOAD_BYTES, or convert the file to Parquet — Parquet is read in place.`,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "as-orc-"));
  const file = join(dir, "object.orc");
  await writeFile(file, buf);
  return { dir, file };
}

export type OrcResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; error: string; crashed: boolean };

/**
 * The child program.
 *
 * Passed with `node -e` rather than shipped as a separate file: a sidecar
 * script has to be copied into the Docker image and found at runtime, and one
 * missing file would turn every ORC read into a confusing ENOENT. Keeping it
 * here means it cannot go missing. It is passed as a single argv element, so
 * no shell parses it and quoting is not a hazard.
 *
 * Everything it needs arrives through the ENVIRONMENT, never argv: argv is
 * visible in the process list on most systems and the S3 secret must not be.
 */
const CHILD = `
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
(async () => {
  const req = createRequire(pathToFileURL(process.cwd() + "/"));
  const { DuckDBInstance } = req("@duckdb/node-api");
  const conn = await (await DuckDBInstance.create(":memory:")).connect();
  const go = (sql) => conn.run(sql).then((r) => r.getRowObjects());
  // Installed already in the common case; a real failure surfaces on LOAD.
  try { await go("INSTALL orc FROM community"); } catch {}
  await go("LOAD orc");
  // No httpfs and no credentials here: read_orc cannot open s3:// or http://,
  // so the parent has already put the bytes on local disk.
  const rows = await go(process.env.AS_ORC_SQL);
  // BigInt is not JSON-serialisable. The parent normalises again through
  // toJsValue, so a string here loses nothing.
  process.stdout.write(JSON.stringify(rows, (k, v) => (typeof v === "bigint" ? String(v) : v)));
})().catch((err) => {
  process.stderr.write(String((err && err.message) || err));
  process.exit(1);
});
`;

/**
 * Read one ORC object, in a child process, from a local copy.
 *
 * `sqlFor` receives the LOCAL path and returns the statement to run. Callers
 * never build an s3:// URL for ORC — read_orc cannot open one — and never pass
 * user text, which is the same rule as the rest of the object-store path.
 *
 * The temporary copy is deleted in a finally, including when the child aborts.
 */
export async function runOrcIsolated(
  cfg: ObjectStoreConfig,
  key: string,
  sqlFor: (localPath: string) => string,
): Promise<OrcResult> {
  assertEndpointAllowed(cfg.endpoint);

  let tmp: { dir: string; file: string } | null = null;
  try {
    tmp = await download(cfg, key);
  } catch (e) {
    // A download failure is the bucket's or the size limit's, not the reader's.
    return { ok: false, crashed: false, error: (e as Error).message };
  }

  // Forward slashes: the path is interpolated into SQL, and a Windows path is
  // full of backslashes.
  const sql = sqlFor(tmp.file.split("\\").join("/"));
  try {
    const { stdout } = await run(process.execPath, ["-e", CHILD], {
      env: { ...process.env, AS_ORC_SQL: sql },
      timeout: ORC_TIMEOUT_MS,
      maxBuffer: ORC_MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, rows: JSON.parse(stdout || "[]") as Record<string, unknown>[] };
  } catch (e) {
    const err = e as { code?: number | string; killed?: boolean; stderr?: string };
    const stderr = String(err.stderr ?? "");
    if (err.killed) {
      return { ok: false, crashed: false, error: `ORC read timed out after ${ORC_TIMEOUT_MS}ms` };
    }
    // A panic ABORTS rather than exiting: nothing we wrote on stderr, and a
    // status that is not our own process.exit(1). Say that plainly — "could
    // not read this file" would send someone hunting for corruption in a file
    // the Apache ORC project publishes as a conformance test.
    const crashed = /panicked|cannot unwind/.test(stderr) || (err.code !== 1 && !stderr.trim());
    return {
      ok: false,
      crashed,
      error: crashed
        ? "The ORC reader crashed on this file — the community extension does not handle its " +
          "nested types. The file is still cataloged; convert it to Parquet to query it."
        : stderr.split("\n")[0]?.slice(0, 300) || "ORC read failed",
    };
  } finally {
    await rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
  }
}
