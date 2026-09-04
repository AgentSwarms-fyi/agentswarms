#!/usr/bin/env node
// Back up everything a self-hosted AgentSwarms cannot regenerate.
//
//   npm run backup                       # -> backups/<timestamp>/
//   npm run backup -- --out /mnt/nas/as  # elsewhere
//   npm run backup -- --dry-run          # show what would be captured
//
// Four things are stateful (see scripts/lib/backup-core.mjs for why each one
// matters): the Supabase database, the lakehouse catalog Postgres, the Parquet
// files in the lake bucket, and the secrets in .env. This captures the first
// three and writes a manifest naming the fourth -- names only, never values.
//
//   catalog   docker compose exec lakehouse-catalog pg_dump  (custom format)
//             or a local pg_dump when the catalog is an external Postgres
//   lake      every object under LAKEHOUSE_DATA_URL, mirrored byte-for-byte
//   supabase  pg_dump against --db-url / SUPABASE_DB_URL (self-hosted), or
//             `supabase db dump` for a linked hosted project when
//             SUPABASE_DB_PASSWORD is set; otherwise skipped with the exact
//             command to run -- this script never prompts and never hangs
//
// Exit code is non-zero if any step that was attempted failed. Skipped steps
// are recorded in manifest.json, so a scheduled backup that silently lost a
// component is visible the next time anyone looks.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  loadEnv,
  lakeS3Config,
  parsePostgresUrl,
  resolveCatalogRunner,
  checkCatalogDump,
  secretsManifest,
  s3List,
  s3Get,
} from "./lib/backup-core.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const env = { ...loadEnv(".env"), ...process.env };
const dryRun = flag("--dry-run");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const out = path.resolve(opt("--out") ?? path.join("backups", stamp));
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

const manifest = {
  createdAt: new Date().toISOString(),
  appVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
  dryRun,
  catalog: { skipped: "not attempted" },
  lake: { skipped: "not attempted" },
  supabase: { skipped: "not attempted" },
  secrets: secretsManifest(env),
};
let failed = false;

if (!dryRun) mkdirSync(out, { recursive: true });
log(`${dryRun ? "[dry-run] " : ""}backup -> ${out}`);

// ── 1. Lakehouse catalog ─────────────────────────────────────────────────────
if (flag("--skip-catalog")) {
  manifest.catalog = { skipped: "--skip-catalog" };
} else {
  const pg = parsePostgresUrl(env.LAKEHOUSE_CATALOG_URL);
  if (!pg) {
    manifest.catalog = { skipped: "LAKEHOUSE_CATALOG_URL not set (no lakehouse configured)" };
    log("catalog: skipped -- LAKEHOUSE_CATALOG_URL not set");
  } else {
    const file = path.join(out, "lakehouse-catalog.dump");
    const runner = resolveCatalogRunner(pg.host, catalogProbes);
    const plan =
      runner.kind === "local"
        ? `pg_dump --dbname=<LAKEHOUSE_CATALOG_URL> -Fc`
        : `${runner.via} pg_dump -U ${pg.user} -Fc ${pg.database}`;
    log(`catalog: ${plan}`);
    if (dryRun) {
      manifest.catalog = { planned: plan, file, via: runner.via };
    } else {
      try {
        const dump =
          runner.kind === "local"
            ? execFileSync("pg_dump", ["--dbname", env.LAKEHOUSE_CATALOG_URL, "-Fc"], {
                maxBuffer: 1 << 30,
              })
            : execFileSync(
                runner.bin,
                [...runner.prefix, "pg_dump", "-U", pg.user, "-Fc", pg.database],
                { maxBuffer: 1 << 30 },
              );
        writeFileSync(file, dump);
        // A DuckLake catalog is never tiny: the schema alone is ~70 tables.
        // A dump this small means the wrong Postgres answered.
        const toc = spawnSync(
          runner.kind === "local" ? "pg_restore" : runner.bin,
          runner.kind === "local" ? ["-l", file] : [...runner.prefix, "pg_restore", "-l"],
          { input: dump, maxBuffer: 1 << 30, encoding: "utf8" },
        );
        const { objects: entries } = checkCatalogDump(
          toc.stdout,
          `${pg.host}/${pg.database} via ${runner.via}`,
        );
        manifest.catalog = {
          file: path.basename(file),
          bytes: dump.length,
          objects: entries,
          via: runner.via,
          host: pg.host,
          database: pg.database,
        };
        log(`catalog: ${dump.length} bytes, ${entries} objects, via ${runner.via}`);
      } catch (e) {
        failed = true;
        manifest.catalog = { error: String(e.message ?? e).slice(0, 500), via: runner.via };
        log(`catalog: FAILED -- ${manifest.catalog.error}`);
      }
    }
  }
}

// ── 2. Lake data (Parquet) ───────────────────────────────────────────────────
if (flag("--skip-lake")) {
  manifest.lake = { skipped: "--skip-lake" };
} else {
  const cfg = lakeS3Config(env);
  if (!cfg) {
    manifest.lake = {
      skipped: "LAKEHOUSE_DATA_URL / LAKEHOUSE_S3_KEY / LAKEHOUSE_S3_SECRET not set",
    };
    log("lake: skipped -- lake S3 settings not set");
  } else {
    try {
      const objects = await s3List(cfg);
      const bytes = objects.reduce((n, o) => n + o.size, 0);
      log(`lake: ${objects.length} objects, ${bytes} bytes under s3://${cfg.bucket}/${cfg.prefix}`);
      if (dryRun) {
        manifest.lake = {
          planned: true,
          objects: objects.length,
          bytes,
          source: `s3://${cfg.bucket}/${cfg.prefix}`,
        };
      } else {
        const lakeDir = path.join(out, "lake");
        let done = 0;
        const queue = [...objects];
        const worker = async () => {
          for (let o = queue.shift(); o; o = queue.shift()) {
            const body = await s3Get(cfg, o.key);
            const target = path.join(lakeDir, o.key);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, body);
            done += 1;
          }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
        writeFileSync(
          path.join(out, "lake-objects.json"),
          JSON.stringify({ bucket: cfg.bucket, prefix: cfg.prefix, objects }, null, 2),
        );
        manifest.lake = {
          dir: "lake",
          objects: done,
          bytes,
          source: `s3://${cfg.bucket}/${cfg.prefix}`,
        };
        log(`lake: mirrored ${done} objects`);
      }
    } catch (e) {
      failed = true;
      manifest.lake = { error: String(e.message ?? e).slice(0, 500) };
      log(`lake: FAILED -- ${manifest.lake.error}`);
    }
  }
}

// ── 3. Supabase database ─────────────────────────────────────────────────────
if (flag("--skip-supabase")) {
  manifest.supabase = { skipped: "--skip-supabase" };
} else {
  const dbUrl = opt("--db-url") ?? env.SUPABASE_DB_URL;
  const linked = existsSync(path.join("supabase", ".temp", "project-ref"));
  if (dbUrl) {
    const file = path.join(out, "supabase.dump");
    log("supabase: pg_dump --dbname=<db-url> -Fc");
    if (dryRun) {
      manifest.supabase = { planned: "pg_dump", file };
    } else {
      try {
        const dump = execFileSync(
          "pg_dump",
          ["--dbname", dbUrl, "-Fc", "--no-owner", "--no-privileges"],
          {
            maxBuffer: 1 << 30,
          },
        );
        writeFileSync(file, dump);
        manifest.supabase = { file: path.basename(file), bytes: dump.length, via: "pg_dump" };
        log(`supabase: ${dump.length} bytes`);
      } catch (e) {
        failed = true;
        manifest.supabase = { error: String(e.message ?? e).slice(0, 500) };
        log(`supabase: FAILED -- ${manifest.supabase.error}`);
      }
    }
  } else if (linked && env.SUPABASE_DB_PASSWORD) {
    const schema = path.join(out, "supabase-schema.sql");
    const data = path.join(out, "supabase-data.sql");
    log("supabase: npx supabase db dump (linked project)");
    if (dryRun) {
      manifest.supabase = {
        planned: "supabase db dump",
        files: ["supabase-schema.sql", "supabase-data.sql"],
      };
    } else {
      try {
        const run = (extra) =>
          execFileSync(
            "npx",
            ["supabase", "db", "dump", "-p", env.SUPABASE_DB_PASSWORD, ...extra],
            {
              stdio: ["ignore", "pipe", "pipe"],
              shell: process.platform === "win32",
            },
          );
        run(["-f", schema]);
        run(["--data-only", "-f", data]);
        manifest.supabase = {
          files: ["supabase-schema.sql", "supabase-data.sql"],
          bytes: statSync(schema).size + statSync(data).size,
          via: "supabase db dump",
        };
        log(`supabase: ${manifest.supabase.bytes} bytes`);
      } catch (e) {
        failed = true;
        manifest.supabase = { error: String(e.message ?? e).slice(0, 500) };
        log(`supabase: FAILED -- ${manifest.supabase.error}`);
      }
    }
  } else {
    const how = linked
      ? "set SUPABASE_DB_PASSWORD (Supabase dashboard -> Project Settings -> Database) or pass --db-url"
      : "pass --db-url postgresql://postgres:<POSTGRES_PASSWORD>@<db-host>:5432/postgres or set SUPABASE_DB_URL";
    manifest.supabase = { skipped: `no database credential: ${how}` };
    log(`supabase: SKIPPED -- ${how}`);
  }
}

// ── 4. Secrets: names only ───────────────────────────────────────────────────
const missing = manifest.secrets.filter((s) => s.set);
const secretsText = [
  "Secrets this backup CANNOT contain -- store them in your secret manager.",
  "A restored database is unreadable for credentials without PROVIDER_CREDS_SECRET",
  "and every Answer Passport is unverifiable without PROVENANCE_SIGNING_SECRET.",
  "",
  ...manifest.secrets.map((s) => `${s.set ? "[set]  " : "[unset]"} ${s.name.padEnd(28)} ${s.why}`),
  "",
].join("\n");
if (!dryRun) {
  writeFileSync(path.join(out, "SECRETS-REQUIRED.txt"), secretsText);
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
}
log(
  `secrets: ${missing.length} set in .env -- listed by NAME in SECRETS-REQUIRED.txt, back them up separately`,
);
log(failed ? "backup finished WITH ERRORS" : "backup finished");
process.exitCode = failed ? 1 : 0;

function composeServiceRunning(service) {
  const r = spawnSync("docker", ["compose", "ps", "--services", "--status", "running"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.split(/\r?\n/).includes(service);
}
