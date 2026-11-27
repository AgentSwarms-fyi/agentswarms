// A small client for an MLflow tracking server's REST API (R534).
//
// The server is one the user named, reached from inside this server's network,
// so every call goes through the SSRF guard (metadata and link-local always
// refused; private networks as the deployment allows, since a team's MLflow
// usually lives on one). Calls never follow a redirect: the token would go
// with it. Answers are read up to a bound and every id MLflow hands back is
// checked before it is put in a URL or shown as a link.
import { safeFetch } from "@/utils/ssrfGuard.server";

export type MlflowConnection = {
  tracking_uri: string;
  /** "none" | "token" | "basic" */
  auth?: string;
  username?: string;
  token?: string;
  password?: string;
};

export class MlflowError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "MlflowError";
    this.status = status;
    this.code = code;
  }
}

const API_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 600_000;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

/**
 * The tracking server's base URL, or null when it is not one we will call:
 * http(s) only, no credentials in it (they belong in the token field, where
 * they are encrypted), no query or fragment.
 */
export function mlflowBase(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

export function mlflowHeaders(c: MlflowConnection): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  const auth = c.auth ?? (c.token ? "token" : "none");
  if (auth === "token" && c.token?.trim()) {
    h.Authorization = `Bearer ${c.token.trim().replace(/^Bearer\s+/i, "")}`;
  } else if (auth === "basic" && c.username?.trim()) {
    const pair = `${c.username.trim()}:${c.password ?? ""}`;
    h.Authorization = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  }
  return h;
}

/** An id MLflow handed back, safe to put in a path or a link. */
export function safeId(v: unknown, what: string): string {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new MlflowError(`The MLflow server returned an unexpected ${what}.`);
  }
  return s;
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new MlflowError("The MLflow server's answer was larger than expected.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function send(
  c: MlflowConnection,
  method: string,
  path: string,
  body: BodyInit | undefined,
  extra: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  const base = mlflowBase(c.tracking_uri);
  if (!base)
    throw new MlflowError("The tracking URL must be an http(s) address with no credentials in it.");
  try {
    return await safeFetch(`${base}${path}`, {
      method,
      headers: { ...mlflowHeaders(c), ...extra },
      body,
      maxRedirects: 0,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const m = (e as Error).message ?? String(e);
    if (/Too many redirects/i.test(m)) {
      throw new MlflowError(
        "The MLflow server answered with a redirect. Enter the address it redirects to, so the token is never sent anywhere else.",
      );
    }
    if ((e as Error).name === "TimeoutError" || /aborted|timeout/i.test(m)) {
      throw new MlflowError(
        `The MLflow server did not answer within ${Math.round(timeoutMs / 1000)} s.`,
      );
    }
    // "fetch failed" says nothing: the cause underneath does (found in the UI
    // test, with the server stopped).
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? "";
    const host = (() => {
      try {
        return new URL(base).host;
      } catch {
        return base;
      }
    })();
    if (cause === "ECONNREFUSED") {
      throw new MlflowError(
        `Nothing is answering at ${host}: the MLflow server is not running there.`,
      );
    }
    if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
      throw new MlflowError(`${host} does not resolve from this server. Check the tracking URL.`);
    }
    if (/TIMEOUT|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(cause)) {
      throw new MlflowError(`${host} cannot be reached from this server (${cause}).`);
    }
    throw new MlflowError(`Could not reach the MLflow server: ${m.slice(0, 200)}`);
  }
}

/** One REST call; a non-2xx answer becomes an MlflowError with MLflow's own code. */
export async function mlflowCall<T = Record<string, unknown>>(
  c: MlflowConnection,
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await send(
    c,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    body === undefined ? {} : { "Content-Type": "application/json" },
    API_TIMEOUT_MS,
  );
  const text = await readBounded(res);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  if (!res.ok) {
    const j = (json ?? {}) as { error_code?: string; message?: string };
    const why =
      res.status === 401 || res.status === 403
        ? "The MLflow server refused the credentials."
        : (j.message ?? text ?? "").toString().replace(/\s+/g, " ").slice(0, 300) ||
          `MLflow answered ${res.status}.`;
    throw new MlflowError(why, res.status, j.error_code);
  }
  if (json === null) throw new MlflowError("The MLflow server's answer was not JSON.", res.status);
  return json as T;
}

/** The server's version (GET /version), or null when it does not say. */
export async function mlflowVersion(c: MlflowConnection): Promise<string | null> {
  try {
    const res = await send(c, "GET", "/version", undefined, {}, API_TIMEOUT_MS);
    if (!res.ok) return null;
    const v = (await readBounded(res)).trim();
    return /^\d+\.\d+(\.\d+)?[A-Za-z0-9.+-]*$/.test(v) ? v.slice(0, 40) : null;
  } catch {
    return null;
  }
}

/**
 * Where a run's artifacts are uploaded through the server, or null when the
 * server stores them somewhere this app does not write (s3://, dbfs:/, ...).
 * `mlflow-artifacts:/1/<run>/artifacts` and `mlflow-artifacts://host/1/...`
 * both become `1/<run>/artifacts`.
 */
export function proxiedArtifactPath(artifactUri: unknown): string | null {
  if (typeof artifactUri !== "string") return null;
  const m = /^mlflow-artifacts:(?:\/\/[^/]*)?\/*(.*)$/.exec(artifactUri);
  if (!m) return null;
  const path = m[1].replace(/\/+$/, "");
  const parts = path.split("/");
  if (!path || parts.some((p) => !p || p === "." || p === ".." || !/^[A-Za-z0-9_.-]+$/.test(p))) {
    return null;
  }
  return parts.join("/");
}

/**
 * Download one file from a proxied artifact store, refusing anything larger
 * than `maxBytes` as it arrives (a declared length is not trusted; the bytes
 * are counted). For the import from a server (R535).
 */
export async function mlflowDownload(
  c: MlflowConnection,
  artifactPath: string,
  file: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const segs = [...artifactPath.split("/"), ...file.split("/")];
  if (segs.some((s) => !s || s === "." || s === "..")) {
    throw new MlflowError(`Refused to download from an unsafe path (${file}).`);
  }
  const res = await send(
    c,
    "GET",
    `/api/2.0/mlflow-artifacts/artifacts/${segs.map(encodeURIComponent).join("/")}`,
    undefined,
    { Accept: "application/octet-stream" },
    UPLOAD_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await readBounded(res).catch(() => "");
    throw new MlflowError(
      res.status === 401 || res.status === 403
        ? "The MLflow server refused the credentials for reading artifacts."
        : res.status === 404
          ? `The MLflow server has no ${file} for that model.`
          : `Reading ${file} failed: ${res.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`,
      res.status,
    );
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new MlflowError(
        `${file} is larger than the ${Math.round(maxBytes / 1048576)} MB import limit (Admin -> Developer runtime, or ML_IMPORT_MAX_MB).`,
      );
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Upload one file into a run's proxied artifact store. */
export async function mlflowUpload(
  c: MlflowConnection,
  artifactPath: string,
  file: string,
  bytes: Uint8Array,
): Promise<void> {
  const segs = [...artifactPath.split("/"), ...file.split("/")];
  if (segs.some((s) => !s || s === "." || s === "..")) {
    throw new MlflowError(`Refused to upload to an unsafe path (${file}).`);
  }
  const res = await send(
    c,
    "PUT",
    `/api/2.0/mlflow-artifacts/artifacts/${segs.map(encodeURIComponent).join("/")}`,
    bytes as unknown as BodyInit,
    { "Content-Type": "application/octet-stream" },
    UPLOAD_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await readBounded(res).catch(() => "");
    throw new MlflowError(
      res.status === 401 || res.status === 403
        ? "The MLflow server refused the credentials for uploading artifacts."
        : `Uploading ${file} failed: ${res.status} ${text.replace(/\s+/g, " ").slice(0, 200)}`,
      res.status,
    );
  }
  await res.body?.cancel().catch(() => {});
}

/** Links into the MLflow UI, built from checked ids only. */
export function mlflowRunUrl(
  trackingUri: string,
  experimentId: string,
  runId: string,
): string | null {
  const base = mlflowBase(trackingUri);
  if (!base) return null;
  return `${base}/#/experiments/${encodeURIComponent(experimentId)}/runs/${encodeURIComponent(runId)}`;
}

export function mlflowModelVersionUrl(
  trackingUri: string,
  name: string,
  version: string,
): string | null {
  const base = mlflowBase(trackingUri);
  if (!base) return null;
  return `${base}/#/models/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}
