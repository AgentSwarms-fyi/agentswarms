// Turn a pipeline's Python traceback into something a person can act on.
//
// A failing ETL node reports whatever the runtime printed, and the runtime is
// pandas/boto/fsspec — so the operator gets forty frames of library internals
// ending in a sentence like `PermissionError: Forbidden`. That is the truth and
// it is nearly useless: it does not say which source failed, what "Forbidden"
// means for an object store, or what to change.
//
// These are the failures that actually happen, each phrased as the thing to go
// and fix. The raw text is never discarded — the explanation is prepended and
// the traceback stays underneath, because the traceback is what you need once
// the obvious cause is ruled out.
//
// Returns null for anything unrecognised, so an unfamiliar error passes through
// untouched rather than being mislabelled with a confident guess.

export type EtlErrorExplanation = {
  /** One or two sentences naming the cause and the fix. */
  summary: string;
  /** Short slug, for tests and telemetry. */
  kind: string;
};

/**
 * The sandbox has no route to the host's loopback, and `localhost` inside a
 * container is the container. This is the single most common object-store
 * misconfiguration in this app, and it is already called out in
 * docs/ETL_PIPELINES.md — but only where someone reads it *before* hitting it.
 */
function looksLoopback(text: string): boolean {
  return /127\.0\.0\.1|\blocalhost\b|::1\b/.test(text);
}

export function explainEtlError(raw: string | null | undefined): EtlErrorExplanation | null {
  const text = String(raw ?? "");
  if (!text.trim()) return null;

  // ── Object storage ───────────────────────────────────────────────────────
  // Order matters: a 403 mentioning ListObjectsV2 is a permissions problem,
  // while "NoSuchBucket" is a naming one, and both can carry a 40x.
  const isS3 = /s3fs|botocore|aiobotocore|ClientError|fsspec/.test(text);

  if (isS3 && /NoSuchBucket|Bucket does not exist/i.test(text)) {
    return {
      kind: "s3_no_such_bucket",
      summary:
        "The bucket named on this source does not exist at that endpoint. Check the " +
        "bucket name on the storage source, and that it points at the endpoint you " +
        "think it does.",
    };
  }

  if (isS3 && /InvalidAccessKeyId|does not exist in our records/i.test(text)) {
    return {
      kind: "s3_unknown_key",
      summary:
        "The object store does not recognise this source's access key. Re-enter the " +
        "access key and secret on the storage source — a key that was valid for a " +
        "previous object store stops working the moment that store is replaced.",
    };
  }

  if (isS3 && /NoCredentialsError|Unable to locate credentials/i.test(text)) {
    return {
      kind: "s3_no_credentials",
      summary:
        "No credentials reached the sandbox for this source. Open the storage source " +
        "and save its access key and secret again.",
    };
  }

  if (isS3 && /\b(403|Forbidden|SignatureDoesNotMatch|AccessDenied)\b/.test(text)) {
    const listing = /ListObjectsV2|_lsdir|_glob|_find/.test(text);
    return {
      kind: "s3_forbidden",
      summary:
        `The object store rejected this source's credentials${listing ? " when listing the path" : ""}. ` +
        "Either the access key and secret are wrong — most often because the store was " +
        "recreated since the source was set up, which invalidates the old key — or the " +
        "key is valid but not allowed to read this bucket. Re-enter the credentials on " +
        "the storage source and try again.",
    };
  }

  // ── Reachability ─────────────────────────────────────────────────────────
  if (
    /EndpointConnectionError|Could not connect to the endpoint|Connection refused|Name or service not known|Temporary failure in name resolution|Failed to establish a new connection/i.test(
      text,
    )
  ) {
    return {
      kind: "endpoint_unreachable",
      summary: looksLoopback(text)
        ? "The endpoint could not be reached because it points at loopback. Inside the " +
          "sandbox, 127.0.0.1 and localhost mean the sandbox itself, not your machine — " +
          "bind the service to 0.0.0.0 and use the host's LAN address instead."
        : "The endpoint could not be reached from the sandbox. Kernels reach the network " +
          "only through the egress proxy, so confirm the host is up and that its address " +
          "is on the allow-list under Admin → Developer runtime.",
    };
  }

  // A squid denial is an HTTP 403 with no body worth reading, and DuckDB in
  // particular reports it as an authentication failure — sending you after
  // credentials that are fine.
  if (/Failed to download extension|HTTP 403.*extension/i.test(text)) {
    return {
      kind: "egress_blocked_extension",
      summary:
        "The DuckDB extension registry was blocked by the egress proxy, not by DuckDB. " +
        "Add .duckdb.org to the allow-list under Admin → Developer runtime.",
    };
  }

  // ── Python environment ───────────────────────────────────────────────────
  const missing = /ModuleNotFoundError: No module named ['"]([^'"]+)['"]/.exec(text);
  if (missing) {
    return {
      kind: "missing_module",
      summary:
        `The pipeline needs the Python package "${missing[1]}", which is not installed in ` +
        "the runtime. Add it to the pipeline's requirements, and make sure PyPI is " +
        "reachable through the egress allow-list.",
    };
  }

  // ── Data shape ───────────────────────────────────────────────────────────
  const badKey = /KeyError: ['"]([^'"]+)['"]/.exec(text);
  if (badKey) {
    return {
      kind: "missing_column",
      summary:
        `A step referenced the column "${badKey[1]}", which is not in the frame at that ` +
        "point. Preview the node before it to see the columns it actually produces — a " +
        "rename or a dropped column upstream is the usual cause.",
    };
  }

  if (/No files match|IndexError: list index out of range.*frames|frames\[0\]/.test(text)) {
    return {
      kind: "no_files_matched",
      summary:
        "The source path matched no objects, so there was nothing to read. Check the " +
        "path pattern against what is actually in the bucket — a leading slash or a " +
        "wrong prefix silently matches nothing.",
    };
  }

  return null;
}

/**
 * The message a preview or run shows: the explanation first, the raw text kept
 * underneath. Never drops detail — an explanation that turns out to be the
 * wrong guess would otherwise hide the evidence that proves it wrong.
 */
export function etlErrorMessage(raw: string | null | undefined): string {
  const text = String(raw ?? "").trim();
  const explained = explainEtlError(text);
  if (!explained) return text || "Preview failed";
  return `${explained.summary}\n\n${text}`;
}
