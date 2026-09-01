// A failing pipeline should say what to fix, not just what threw.
//
// FOUND FROM THE UI. Previewing a Data Prep node against an object-storage
// source produced forty frames of s3fs/aiobotocore internals ending in
// `PermissionError: Forbidden`. Every word of that is true and none of it says
// which source failed, what "Forbidden" means for a bucket, or what to change.
//
// The underlying cause was mundane and completely invisible in the trace: the
// storage source had been configured against a MinIO that was later replaced,
// so its stored access key no longer existed. The object store answered 403 to
// ListObjectsV2 and the traceback dutifully reported the last re-raise.
//
// The real traceback is used verbatim as the fixture, so these tests fail if
// the phrasing they key on ever stops appearing.
import { describe, expect, it } from "vitest";

import { etlErrorMessage, explainEtlError } from "@/utils/etl/explainError";

const REAL_403 = `Traceback (most recent call last):
  File "/home/runner/.local/lib/python3.12/site-packages/s3fs/core.py", line 867, in _lsdir
    async for c in self._iterdir(
  File "/home/runner/.local/lib/python3.12/site-packages/aiobotocore/client.py", line 449, in _make_api_call
    raise error_class(parsed_response, operation_name)
botocore.exceptions.ClientError: An error occurred (403) when calling the ListObjectsV2 operation: Forbidden

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "/opt/agentswarms/batch_runner.py", line 84, in main
    result = asyncio.run(_run(compiled, ns))
  File "<notebook>", line 91, in _src_s_pay
  File "/home/runner/.local/lib/python3.12/site-packages/s3fs/core.py", line 947, in _glob
    return await super()._glob(path, **kwargs)
PermissionError: Forbidden`;

describe("explainEtlError", () => {
  it("recognises the 403 the user actually hit, and names the fix", () => {
    const out = explainEtlError(REAL_403);
    expect(out?.kind).toBe("s3_forbidden");
    expect(out?.summary).toMatch(/rejected this source's credentials/i);
    // The specific cause worth naming, because it is invisible in the trace and
    // is what actually happened here.
    expect(out?.summary).toMatch(/recreated since the source was set up/i);
    // It was a listing call, and saying so tells the reader it failed before
    // reading a single object.
    expect(out?.summary).toMatch(/when listing the path/i);
  });

  it("never throws away the traceback", () => {
    // An explanation is a guess about the cause. Hiding the evidence would make
    // a wrong guess unfalsifiable.
    const msg = etlErrorMessage(REAL_403);
    expect(msg).toContain("rejected this source's credentials");
    expect(msg).toContain("ListObjectsV2");
    expect(msg).toContain("PermissionError: Forbidden");
    expect(msg.indexOf("rejected this source's credentials")).toBeLessThan(
      msg.indexOf("Traceback"),
    );
  });

  it("separates a missing bucket from a rejected key", () => {
    const bucket = explainEtlError(
      "botocore.exceptions.ClientError: An error occurred (NoSuchBucket) when calling the ListObjectsV2 operation",
    );
    expect(bucket?.kind).toBe("s3_no_such_bucket");
    const key = explainEtlError(
      "botocore.exceptions.ClientError: InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records",
    );
    expect(key?.kind).toBe("s3_unknown_key");
  });

  it("calls out loopback specifically, because it is the common trap", () => {
    // The sandbox is a container: 127.0.0.1 is the container, not the host.
    // docs/ETL_PIPELINES.md records this, but only helps someone who read it
    // before hitting it.
    const out = explainEtlError(
      'botocore.exceptions.EndpointConnectionError: Could not connect to the endpoint URL: "http://127.0.0.1:19000/etl"',
    );
    expect(out?.kind).toBe("endpoint_unreachable");
    expect(out?.summary).toMatch(/0\.0\.0\.0/);
    expect(out?.summary).toMatch(/LAN address/i);
  });

  it("gives generic unreachability a different fix than loopback", () => {
    const out = explainEtlError(
      "requests.exceptions.ConnectionError: Failed to establish a new connection to warehouse.internal",
    );
    expect(out?.kind).toBe("endpoint_unreachable");
    expect(out?.summary).toMatch(/egress proxy/i);
    expect(out?.summary).not.toMatch(/0\.0\.0\.0/);
  });

  it("blames squid for a blocked DuckDB extension, not DuckDB", () => {
    // DuckDB reports a proxy 403 on an S3 read as an authentication failure,
    // which sends you after credentials that are fine.
    const out = explainEtlError('IO Error: Failed to download extension "ducklake" (HTTP 403)');
    expect(out?.kind).toBe("egress_blocked_extension");
    expect(out?.summary).toContain(".duckdb.org");
  });

  it("names the missing package and the missing column", () => {
    expect(explainEtlError("ModuleNotFoundError: No module named 'pyarrow'")?.summary).toContain(
      '"pyarrow"',
    );
    expect(explainEtlError("KeyError: 'order_total'")?.summary).toContain('"order_total"');
  });

  it("passes unfamiliar errors through untouched", () => {
    // A confident wrong label is worse than no label.
    for (const other of [
      "ValueError: could not convert string to float: 'abc'",
      "MemoryError",
      "",
      null,
      undefined,
    ]) {
      expect(explainEtlError(other), String(other)).toBeNull();
    }
    expect(etlErrorMessage("MemoryError")).toBe("MemoryError");
    expect(etlErrorMessage("")).toBe("Preview failed");
  });

  it("is wired into the preview, over the whole log rather than its last line", () => {
    // The cause sits mid-trace; the last line is the generic re-raise. Reading
    // only the last line is how "PermissionError: Forbidden" reached the UI.
    const src = readFileSync("src/utils/etl.functions.ts", "utf8");
    expect(src).toContain("etlErrorMessage(");
    expect(src).toContain("[session.error, session.logs].filter(Boolean).join");
    expect(src).not.toContain('.split("\\n").filter(Boolean).slice(-1)[0]');
  });
});

// Imported down here so the fixture above reads first.
import { readFileSync } from "node:fs";

describe("the scheduled-run path gets the same treatment", () => {
  // A run that fails overnight is read from the run list hours later, with no
  // chance to reproduce it interactively. If anything deserves the explanation
  // it is that one, and it was the path still storing the raw re-raise.
  const service = readFileSync("src/utils/etl/service.server.ts", "utf8");

  it("explains the recorded error, not just the preview", () => {
    expect(service).toContain('import { etlErrorMessage } from "@/utils/etl/explainError"');
    expect(service).toContain("etlErrorMessage(");
  });

  it("reads the whole log when recording it", () => {
    expect(service).toContain("[session.error, session.logs].filter(Boolean).join");
  });
});
