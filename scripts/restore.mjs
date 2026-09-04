#!/usr/bin/env node
// Restore a backup made by scripts/backup.mjs -- or rehearse one.
//
//   npm run restore -- backups/<ts> --catalog --yes
//   npm run restore -- backups/<ts> --lake --yes
//   npm run restore -- backups/<ts> --supabase --db-url postgresql://... --yes
//
// Restoring is destructive, so nothing happens without --yes and an explicit
// choice of what to restore. The same script runs the RESTORE DRILL that the
// deployment docs ask you to do before you need it: restore the catalog into a
// scratch database and the Parquet into a scratch prefix, compare, then clean
// up. Nothing live is touched:
//
//   npm run restore -- backups/<ts> --drill
//
// A backup you have never restored is a hope, not a backup.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  loadEnv,
  lakeS3Config,
  parsePostgresUrl,
  resolveCatalogRunner,
  withDatabase,
  s3List,
  s3Put,
  s3Delete,
} from "./lib/backup-core.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a) => !a.startsWith("--") && existsSync(path.join(a, "manifest.json")));
if (!dir) {
  console.error(
    "usage: npm run restore -- <backup-dir> (--catalog | --lake | --supabase | --drill) [--yes]",
  );
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const env = { ...loadEnv(".env"), ...process.env };
const drill = flag("--drill");
const yes = flag("--yes");
const log = (m) => console.log(m);

// Docker probes for resolveCatalogRunner. Names only; nothing here reads data.
const catalogProbes = {
  containerExists: (name) =>
    spawnSync("docker", ["inspect", "--format", "{{.Name}}", name], { encoding: "utf8" }).status ===
    0,
  composeAliases: () => {
    if (!composeServiceRunning("lakehouse-catalog")) return [];
    const id = spawnSync("docker", ["compose", "ps", "-q", "lakehouse-catalog"], {
      encoding: "utf8",
    }).stdout.trim();
    const name = spawnSync("docker", ["inspect", "--format", "{{.Name}}", id], { encoding: "utf8" })
      .stdout.trim()
      .replace(/^\//, "");
    return ["lakehouse-catalog", name].filter(Boolean);
  },
};

if (!drill && !yes) {
  console.error(
    "refusing to restore without --yes (or use --drill for a non-destructive rehearsal)",
  );
  process.exit(2);
}
if (!drill && !flag("--catalog") && !flag("--lake") && !flag("--supabase")) {
  console.error("say what to restore: --catalog, --lake and/or --supabase");
  process.exit(2);
}

let failed = false;
const result = { dir, drill, catalog: null, lake: null, supabase: null };

// ── Catalog ─────────────────────────────────────────────────────────────────
if (drill || flag("--catalog")) {
  const dump = path.join(dir, manifest.catalog?.file ?? "lakehouse-catalog.dump");
  const pg = parsePostgresUrl(env.LAKEHOUSE_CATALOG_URL);
  if (!existsSync(dump) || !pg) {
    log(
      `catalog: nothing to restore (${existsSync(dump) ? "LAKEHOUSE_CATALOG_URL not set" : "no dump in backup"})`,
    );
  } else {
    const runner = resolveCatalogRunner(pg.host, catalogProbes);
    const target = drill ? `${pg.database}_drill` : (opt("--catalog-db") ?? pg.database);
    // psql / pg_restore through whichever runner serves the catalog host.
    const psql = (sql, db = "postgres") =>
      runner.kind === "local"
        ? execFileSync(
            "psql",
            ["--dbname", withDatabase(env.LAKEHOUSE_CATALOG_URL, db), "-tAc", sql],
            {
              encoding: "utf8",
            },
          ).trim()
        : execFileSync(
            runner.bin,
            [...runner.prefix, "psql", "-U", pg.user, "-d", db, "-tAc", sql],
            {
              encoding: "utf8",
            },
          ).trim();
    try {
      if (target !== pg.database) {
        psql(`DROP DATABASE IF EXISTS ${target}`);
        psql(`CREATE DATABASE ${target}`);
      }
      log(
        `catalog: pg_restore ${path.basename(dump)} -> ${pg.host}/${target} via ${runner.via}${drill ? " (scratch)" : ""}`,
      );
      const restoreArgs = ["--clean", "--if-exists", "--no-owner"];
      const rr =
        runner.kind === "local"
          ? spawnSync(
              "pg_restore",
              ["--dbname", withDatabase(env.LAKEHOUSE_CATALOG_URL, target), ...restoreArgs, dump],
              {
                maxBuffer: 1 << 30,
                encoding: "buffer",
              },
            )
          : spawnSync(
              runner.bin,
              [...runner.prefix, "pg_restore", "-U", pg.user, "-d", target, ...restoreArgs],
              {
                input: readFileSync(dump),
                maxBuffer: 1 << 30,
                encoding: "buffer",
              },
            );
      // pg_restore reports harmless "does not exist, skipping" notices on
      // stderr with exit code 0 and real failures with 1; --clean on a fresh
      // scratch database emits many notices.
      if (rr.status !== 0)
        throw new Error(`pg_restore exit ${rr.status}: ${String(rr.stderr).slice(-400)}`);
      const tables = Number(
        psql("SELECT count(*) FROM ducklake_table WHERE end_snapshot IS NULL", target),
      );
      const files = Number(
        psql("SELECT count(*) FROM ducklake_data_file WHERE end_snapshot IS NULL", target),
      );
      const snapshots = Number(psql("SELECT max(snapshot_id) FROM ducklake_snapshot", target));
      result.catalog = {
        database: target,
        via: runner.via,
        tables,
        dataFiles: files,
        latestSnapshot: snapshots,
      };
      log(
        `catalog: restored -- ${tables} tables, ${files} data files, latest snapshot ${snapshots}`,
      );
      if (drill) {
        const liveTables = Number(
          psql("SELECT count(*) FROM ducklake_table WHERE end_snapshot IS NULL", pg.database),
        );
        const liveSnap = Number(
          psql("SELECT max(snapshot_id) FROM ducklake_snapshot", pg.database),
        );
        result.catalog.liveTablesNow = liveTables;
        result.catalog.liveSnapshotNow = liveSnap;
        log(
          `catalog: live catalog now has ${liveTables} tables at snapshot ${liveSnap} (${liveSnap === snapshots ? "unchanged since the backup" : "moved since the backup"})`,
        );
        psql(`DROP DATABASE ${target}`);
        log("catalog: scratch database dropped");
      }
    } catch (e) {
      failed = true;
      result.catalog = { error: String(e.message ?? e).slice(0, 500) };
      log(`catalog: FAILED -- ${result.catalog.error}`);
    }
  }
}

// ── Lake data ────────────────────────────────────────────────────────────────
if (drill || flag("--lake")) {
  const listing = path.join(dir, "lake-objects.json");
  const cfg = lakeS3Config(env);
  if (!existsSync(listing) || !cfg) {
    log(
      `lake: nothing to restore (${cfg ? "no lake-objects.json in backup" : "lake S3 settings not set"})`,
    );
  } else {
    const { objects, prefix: backedPrefix } = JSON.parse(readFileSync(listing, "utf8"));
    const targetPrefix = drill
      ? `${cfg.prefix || "lake"}-restore-drill-${Date.now()}`
      : (opt("--lake-prefix") ?? cfg.prefix);
    const rekey = (key) =>
      backedPrefix
        ? key.replace(new RegExp(`^${escapeRe(backedPrefix)}/`), `${targetPrefix}/`)
        : `${targetPrefix}/${key}`;
    const sample = drill ? objects.slice(0, Math.min(objects.length, 25)) : objects;
    log(
      `lake: uploading ${sample.length}${drill ? ` of ${objects.length}` : ""} objects -> s3://${cfg.bucket}/${targetPrefix}${drill ? " (scratch)" : ""}`,
    );
    const uploaded = [];
    try {
      for (const o of sample) {
        const body = readFileSync(path.join(dir, "lake", o.key));
        const key = rekey(o.key);
        await s3Put(cfg, key, body);
        uploaded.push({ key, size: body.length });
      }
      const back = await s3List({ ...cfg, prefix: targetPrefix });
      const byKey = new Map(back.map((o) => [o.key, o.size]));
      const mismatched = uploaded.filter((u) => byKey.get(u.key) !== u.size);
      result.lake = {
        uploaded: uploaded.length,
        verified: uploaded.length - mismatched.length,
        prefix: targetPrefix,
      };
      if (mismatched.length)
        throw new Error(`${mismatched.length} objects differ in size after upload`);
      log(`lake: ${uploaded.length} objects re-listed with matching sizes`);
    } catch (e) {
      failed = true;
      result.lake = { ...(result.lake ?? {}), error: String(e.message ?? e).slice(0, 500) };
      log(`lake: FAILED -- ${result.lake.error}`);
    } finally {
      if (drill) {
        for (const u of uploaded) await s3Delete(cfg, u.key).catch(() => {});
        log(`lake: scratch prefix ${targetPrefix} removed`);
      }
    }
  }
}

// ── Supabase ─────────────────────────────────────────────────────────────────
if (flag("--supabase")) {
  const dbUrl = opt("--db-url") ?? env.SUPABASE_DB_URL;
  const custom = path.join(dir, "supabase.dump");
  const sqlFiles = readdirSync(dir).filter((f) => /^supabase-.*\.sql$/.test(f));
  if (!dbUrl) {
    log("supabase: --db-url (or SUPABASE_DB_URL) is required to restore the application database");
    failed = true;
  } else if (existsSync(custom)) {
    try {
      log(`supabase: pg_restore ${path.basename(custom)} (${statSync(custom).size} bytes)`);
      execFileSync(
        "pg_restore",
        ["--dbname", dbUrl, "--clean", "--if-exists", "--no-owner", "--no-privileges", custom],
        {
          stdio: "inherit",
        },
      );
      result.supabase = { restored: path.basename(custom) };
    } catch (e) {
      failed = true;
      result.supabase = { error: String(e.message ?? e).slice(0, 500) };
    }
  } else if (sqlFiles.length) {
    try {
      for (const f of sqlFiles.sort()) {
        log(`supabase: psql -f ${f}`);
        execFileSync(
          "psql",
          ["--dbname", dbUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(dir, f)],
          { stdio: "inherit" },
        );
      }
      result.supabase = { restored: sqlFiles };
    } catch (e) {
      failed = true;
      result.supabase = { error: String(e.message ?? e).slice(0, 500) };
    }
  } else {
    log("supabase: this backup has no database dump (it was skipped -- see manifest.json)");
    failed = true;
  }
} else if (drill) {
  log(
    "supabase: the drill does not touch the application database -- restore it into a scratch project with --supabase --db-url",
  );
}

log(JSON.stringify(result));
log(
  failed
    ? drill
      ? "DRILL FAILED"
      : "restore finished WITH ERRORS"
    : drill
      ? "DRILL PASSED"
      : "restore finished",
);
process.exitCode = failed ? 1 : 0;

function composeServiceRunning(service) {
  const r = spawnSync("docker", ["compose", "ps", "--services", "--status", "running"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.split(/\r?\n/).includes(service);
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
