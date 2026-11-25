// Importing a model straight from an MLflow server's registry (R535).
//
// The other direction of R534: pick a registered model and a version (or an
// alias, such as @production) on one of your MLflow connections, and it
// becomes the next version of a model here. Only two files are read: the
// version's MLmodel (parsed like any import's, nothing in it executed) and
// the model file it names, counted as it arrives against the import limit.
// Both then go through the zip import of R533 unchanged: the same checks, the
// same staging under the model's own prefix, the same sandbox job that is the
// only place a pickle is ever opened.
import { strToU8, zipSync } from "fflate";

import { readMlmodel } from "@/lib/mlflowFormat";
import { importMaxBytes, importMlflowZip } from "./mlflow.server";
import {
  MlflowError,
  mlflowBase,
  mlflowCall,
  mlflowDownload,
  proxiedArtifactPath,
  safeId,
  type MlflowConnection,
} from "./mlflowClient.server";
import { mlflowConnectionOf } from "./mlflowTracking.server";

type Fail = { ok: false; status: number; error: string };

const MLMODEL_MAX_BYTES = 1024 * 1024;
const VERSION = /^\d{1,9}$/;
const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;

export type RegisteredModelSummary = {
  name: string;
  description: string | null;
  aliases: { alias: string; version: string }[];
  latest: string | null;
};

export type ModelVersionSummary = {
  version: string;
  aliases: string[];
  run_id: string | null;
  status: string;
  created: number | null;
};

async function connection(
  userId: string,
  integrationId: string,
): Promise<{ ok: true; conn: MlflowConnection; server: string } | Fail> {
  const c = await mlflowConnectionOf(userId, integrationId);
  if (!c.ok) {
    return {
      ok: false,
      status: 404,
      error: /was removed/.test(c.error) ? "That MLflow connection is not one of yours." : c.error,
    };
  }
  return { ok: true, conn: c.conn, server: mlflowBase(c.conn.tracking_uri) ?? "" };
}

function fail(e: unknown, status = 502): Fail {
  return {
    ok: false,
    status: e instanceof MlflowError && e.status === 404 ? 404 : status,
    error:
      e instanceof MlflowError
        ? e.message
        : `The MLflow server could not be read: ${(e as Error).message}`,
  };
}

/** A registered model's name as MLflow stores it: plain text, never a filter expression. */
function cleanName(name: string): string | null {
  const n = name.trim();
  return n && n.length <= 200 && !/[\p{Cc}]/u.test(n) ? n : null;
}

/** Registered models on the server whose names contain `query` (all of them when empty), at most 50. */
export async function searchRegisteredModels(
  userId: string,
  integrationId: string,
  query: string,
): Promise<{ ok: true; models: RegisteredModelSummary[] } | Fail> {
  const c = await connection(userId, integrationId);
  if (!c.ok) return c;
  // The query goes inside a quoted filter string: a quote or a backslash could
  // end it, so those go. "_" and "%" stay: inside the string they only widen
  // the search, and model names are full of underscores (stripping them found
  // nothing for "probe_…": caught against a real MLflow server).
  const q = query
    .replace(/['"\\\p{Cc}]/gu, "")
    .trim()
    .slice(0, 100);
  const params = new URLSearchParams({ max_results: "50" });
  if (q) params.set("filter", `name ILIKE '%${q}%'`);
  try {
    const r = await mlflowCall<{
      registered_models?: {
        name?: string;
        description?: string;
        aliases?: { alias?: string; version?: string }[];
        latest_versions?: { version?: string }[];
      }[];
    }>(c.conn, "GET", `/api/2.0/mlflow/registered-models/search?${params}`);
    const models = (r.registered_models ?? [])
      .filter((m) => typeof m.name === "string" && cleanName(m.name))
      .map((m) => ({
        name: m.name as string,
        description: typeof m.description === "string" ? m.description.slice(0, 300) : null,
        aliases: (m.aliases ?? [])
          .filter((a) => ALIAS.test(String(a.alias ?? "")) && VERSION.test(String(a.version ?? "")))
          .map((a) => ({ alias: String(a.alias), version: String(a.version) })),
        latest:
          (m.latest_versions ?? [])
            .map((v) => String(v.version ?? ""))
            .filter((v) => VERSION.test(v))
            .sort((a, b) => Number(b) - Number(a))[0] ?? null,
      }));
    return { ok: true, models };
  } catch (e) {
    return fail(e);
  }
}

/** The versions of one registered model, newest first, at most 200. */
export async function listModelVersions(
  userId: string,
  integrationId: string,
  name: string,
): Promise<{ ok: true; versions: ModelVersionSummary[] } | Fail> {
  const c = await connection(userId, integrationId);
  if (!c.ok) return c;
  const n = cleanName(name);
  if (!n) return { ok: false, status: 400, error: "Name the registered model." };
  // The name goes inside a quoted filter: a quote in it would end the string,
  // so a name with one is looked up the slow, exact way instead.
  const params = new URLSearchParams({ max_results: "200" });
  if (!/['"\\]/.test(n)) params.set("filter", `name='${n}'`);
  try {
    const r = await mlflowCall<{
      model_versions?: {
        name?: string;
        version?: string;
        aliases?: string[];
        run_id?: string;
        status?: string;
        creation_timestamp?: number | string;
      }[];
    }>(c.conn, "GET", `/api/2.0/mlflow/model-versions/search?${params}`);
    // MLflow's version search leaves the aliases out (MLflow 3.18: found in
    // the UI test, where @production showed on the model but on no version);
    // the registered model has them.
    const byVersion = new Map<string, string[]>();
    try {
      const m = await mlflowCall<{
        registered_model?: { aliases?: { alias?: string; version?: string }[] };
      }>(
        c.conn,
        "GET",
        `/api/2.0/mlflow/registered-models/get?${new URLSearchParams({ name: n })}`,
      );
      for (const a of m.registered_model?.aliases ?? []) {
        const alias = String(a.alias ?? "");
        const v = String(a.version ?? "");
        if (ALIAS.test(alias) && VERSION.test(v))
          byVersion.set(v, [...(byVersion.get(v) ?? []), alias]);
      }
    } catch {
      // Without them the versions still list; only the labels are missing.
    }
    const versions = (r.model_versions ?? [])
      .filter((v) => v.name === n && VERSION.test(String(v.version ?? "")))
      .map((v) => ({
        version: String(v.version),
        aliases: [
          ...new Set([
            ...(v.aliases ?? []).filter((a) => ALIAS.test(String(a))).map(String),
            ...(byVersion.get(String(v.version)) ?? []),
          ]),
        ],
        run_id:
          typeof v.run_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v.run_id) ? v.run_id : null,
        status: String(v.status ?? "").slice(0, 40),
        created: Number.isFinite(Number(v.creation_timestamp))
          ? Number(v.creation_timestamp)
          : null,
      }))
      .sort((a, b) => Number(b.version) - Number(a.version));
    return { ok: true, versions };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Take one registered version (by number, or by alias) from the server and
 * import it as the next version of `modelId`.
 */
export async function importFromMlflowServer(args: {
  userId: string;
  modelId: string;
  integrationId: string;
  name: string;
  version?: string;
  alias?: string;
}): Promise<{ ok: true; versionId: string; version: number; jobId: string; from: string } | Fail> {
  const c = await connection(args.userId, args.integrationId);
  if (!c.ok) return c;
  const name = cleanName(args.name);
  if (!name) return { ok: false, status: 400, error: "Name the registered model." };
  const q = (extra: Record<string, string>) => new URLSearchParams({ name, ...extra }).toString();

  let version = args.version?.trim() ?? "";
  const alias = args.alias?.trim() ?? "";
  try {
    if (!version) {
      if (!ALIAS.test(alias))
        return { ok: false, status: 400, error: "Choose a version or an alias." };
      const r = await mlflowCall<{ model_version?: { version?: string } }>(
        c.conn,
        "GET",
        `/api/2.0/mlflow/registered-models/alias?${q({ alias })}`,
      );
      version = String(r.model_version?.version ?? "");
    }
    if (!VERSION.test(version))
      return { ok: false, status: 400, error: "That is not a version number." };

    const mv = await mlflowCall<{ model_version?: { status?: string; run_id?: string } }>(
      c.conn,
      "GET",
      `/api/2.0/mlflow/model-versions/get?${q({ version })}`,
    );
    if (mv.model_version?.status && mv.model_version.status !== "READY") {
      return {
        ok: false,
        status: 409,
        error: `Version ${version} of ${name} is ${mv.model_version.status.toLowerCase().replace(/_/g, " ")} in MLflow, not ready.`,
      };
    }
    const dl = await mlflowCall<{ artifact_uri?: string }>(
      c.conn,
      "GET",
      `/api/2.0/mlflow/model-versions/get-download-uri?${q({ version })}`,
    );
    const path = proxiedArtifactPath(dl.artifact_uri);
    if (!path) {
      const where = String(dl.artifact_uri ?? "").split(":")[0] || "another store";
      return {
        ok: false,
        status: 409,
        error: `This server keeps that model in ${where}:, which this app does not read. Download the model folder from MLflow, zip it, and use Import MLflow model.`,
      };
    }

    const mlmodel = await mlflowDownload(c.conn, path, "MLmodel", MLMODEL_MAX_BYTES);
    const parsed = readMlmodel(new TextDecoder().decode(mlmodel));
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    const file = parsed.plan.modelFile;
    const bytes = await mlflowDownload(c.conn, path, file, importMaxBytes());

    // The two files, as the zip import takes them: it checks them again.
    const zip = zipSync({
      "model/MLmodel": mlmodel,
      [`model/${file}`]: [bytes, { level: 0 }],
      "model/SOURCE.txt": strToU8(`${c.server} · ${name} version ${version}\n`),
    });
    const runId = mv.model_version?.run_id;
    const out = await importMlflowZip({
      userId: args.userId,
      modelId: args.modelId,
      bytes: zip,
      fileName: `${name} v${version} (MLflow)`,
      source: {
        server: c.server,
        registered_model: name,
        version,
        ...(alias && !args.version ? { alias } : {}),
        run_id: typeof runId === "string" ? safeIdOrNull(runId) : null,
      },
    });
    return out.ok ? { ...out, from: `${name} v${version}` } : out;
  } catch (e) {
    return fail(e);
  }
}

function safeIdOrNull(v: string): string | null {
  try {
    return safeId(v, "run id");
  } catch {
    return null;
  }
}
