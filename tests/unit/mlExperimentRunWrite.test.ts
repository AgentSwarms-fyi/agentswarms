// An experiment run's log and finish are one locked statement each (R316).
//
// FOUND IN R316. The API read the run, merged what it was sent onto what it had
// read, and wrote the result over whatever the run held by then: twenty
// metrics logged from twenty threads in a notebook kept five. And `finish`
// wrote every field it could be sent, so the `finish()` at the end of
// `with start_run(...)`, which sends no artifact, wrote null over the model
// `save_model` had just recorded, and the run could not be registered.
//
// Both now call `ml_experiment_run_write`, which locks the run, merges onto
// what it holds, and writes only the fields it is given. The function itself
// was run against Postgres 16 (twenty overlapping logs, an artifact kept, half
// a pair, the cap, the grants); here the route's side of that contract runs
// for real over a recorded `rpc`, and the function's statements are pinned.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  tableWrites: [] as string[],
  answer: { data: { ok: true } as unknown, error: null as null | { message: string } },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/utils/notebookRuntime/caller.server", () => ({
  resolvePythonCaller: async () => ({ userId: "user-1", scopeUserId: "user-1", sessionId: null }),
}));
vi.mock("@/integrations/supabase/client.server", () => {
  const table = (t: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "maybeSingle", "single"]) b[m] = () => b;
    b.update = () => (calls.tableWrites.push(`update ${t}`), b);
    b.insert = () => (calls.tableWrites.push(`insert ${t}`), b);
    return b;
  };
  return {
    supabaseAdmin: {
      from: table,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.rpc.push({ fn, args });
        return calls.answer;
      },
    },
  };
});

const { Route } = (await import("@/routes/api/ml.experiments")) as unknown as {
  Route: {
    options: { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } };
  };
};

const RUN = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
async function post(body: Record<string, unknown>) {
  const res = await Route.options.server.handlers.POST({
    request: new Request("http://app/api/ml/experiments", {
      method: "POST",
      body: JSON.stringify({ run_id: RUN, ...body }),
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const sent = () => calls.rpc[0]?.args ?? {};

beforeEach(() => {
  calls.rpc = [];
  calls.tableWrites = [];
  calls.answer = { data: { ok: true }, error: null };
});

describe("log", () => {
  it("sends what it was given to the one statement, as the caller, and writes no row itself", async () => {
    const r = await post({ op: "log", params: { lr: 0.1 }, metrics: { "loss@3": 0.4 } });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].fn).toBe("ml_experiment_run_write");
    expect(sent()).toEqual({
      p_run_id: RUN,
      p_user_id: "user-1",
      p_params: { lr: 0.1 },
      p_metrics: { "loss@3": 0.4 },
      p_max_keys: 2000,
    });
    // No read-merge-write of its own: that is what lost the other threads' keys.
    expect(calls.tableWrites).toEqual([]);
  });

  it("is not a finish", async () => {
    await post({ op: "log", metrics: { auc: 0.9 } });
    expect(sent()).not.toHaveProperty("p_close");
  });
});

describe("finish", () => {
  it("without an artifact sends none, so a model save_model recorded is kept", async () => {
    await post({ op: "finish" });
    expect(sent().p_close).toEqual({ status: "finished" });
    expect(sent().p_params).toEqual({});
  });

  it("sends only the fields it was given", async () => {
    await post({
      op: "finish",
      status: "failed",
      error: "ValueError: boom",
      metrics: { auc: 0.5 },
    });
    expect(sent().p_close).toEqual({ status: "failed", error: "ValueError: boom" });
    expect(sent().p_metrics).toEqual({ auc: 0.5 });
  });

  it("sends the artifact as a pair, even when given half", async () => {
    await post({ op: "finish", artifact_uri: "s3://lake/m.joblib" });
    expect(sent().p_close).toEqual({
      status: "finished",
      artifact_uri: "s3://lake/m.joblib",
      artifact_sha256: null,
    });
  });
});

describe("what the statement answers", () => {
  it("a run that is not the caller's is not found", async () => {
    calls.answer = { data: { error: "missing" }, error: null };
    expect(await post({ op: "log", metrics: { a: 1 } })).toEqual({
      status: 404,
      body: { error: "Run not found" },
    });
  });

  it("a run that has ended refuses the write", async () => {
    calls.answer = { data: { error: "closed", status: "finished" }, error: null };
    expect(await post({ op: "log", metrics: { a: 1 } })).toEqual({
      status: 409,
      body: { error: "That run already finished" },
    });
  });

  it("a map past the cap is refused with the count", async () => {
    calls.answer = { data: { error: "too_many", what: "metrics", count: 2001 }, error: null };
    expect(await post({ op: "log", metrics: { a: 1 } })).toEqual({
      status: 400,
      body: { error: "A run may hold 2000 metrics; this would make 2001" },
    });
  });

  it("a database error is reported, not taken for success", async () => {
    calls.answer = { data: null, error: { message: "function does not exist" } };
    expect(await post({ op: "log", metrics: { a: 1 } })).toEqual({
      status: 400,
      body: { error: "function does not exist" },
    });
  });

  it("an answer it does not know is not taken for success", async () => {
    calls.answer = { data: {}, error: null };
    expect((await post({ op: "finish" })).status).toBe(500);
  });
});

describe("the statement", () => {
  const sql = readFileSync(
    "supabase/migrations/20261006120000_ml_experiment_run_write.sql",
    "utf8",
  );
  const body = sql.slice(sql.indexOf("AS $$"), sql.lastIndexOf("$$;"));

  it("locks the caller's run before it reads what to merge onto", () => {
    expect(body).toMatch(
      /SELECT \* INTO r\s+FROM public\.ml_experiment_runs\s+WHERE id = p_run_id AND user_id = p_user_id\s+FOR UPDATE;/,
    );
    expect(body.indexOf("FOR UPDATE")).toBeLessThan(body.indexOf("r.params ||"));
  });

  it("refuses a run that has ended, before it writes", () => {
    expect(body).toContain("IF r.status <> 'running' THEN");
    expect(body.indexOf("r.status <> 'running'")).toBeLessThan(body.indexOf("UPDATE public"));
  });

  it("adds to what the run holds, and counts the cap on the merged map", () => {
    expect(body).toContain("merged_params := r.params || COALESCE(p_params, '{}'::jsonb);");
    expect(body).toContain("merged_metrics := r.metrics || COALESCE(p_metrics, '{}'::jsonb);");
    expect(body).toContain("SELECT count(*) INTO n FROM jsonb_object_keys(merged_params);");
    expect(body).toContain("SELECT count(*) INTO n FROM jsonb_object_keys(merged_metrics);");
  });

  it("keeps every finish field it was not given", () => {
    expect(body).toContain(
      "error = CASE WHEN p_close ? 'error' THEN p_close->>'error' ELSE r.error END",
    );
    expect(body).toContain(
      "notes = CASE WHEN p_close ? 'notes' THEN p_close->>'notes' ELSE r.notes END",
    );
    for (const col of ["artifact_uri", "artifact_sha256"]) {
      expect(body).toMatch(
        new RegExp(
          `${col} = CASE WHEN p_close \\?\\| array\\['artifact_uri', 'artifact_sha256'\\]\\s+THEN p_close->>'${col}' ELSE r\\.${col} END`,
        ),
      );
    }
  });

  it("is reachable by the service role only", () => {
    const sig = "public.ml_experiment_run_write(uuid, uuid, jsonb, jsonb, integer, jsonb)";
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`);
    }
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    expect(sql).toContain("SET search_path = public");
  });
});

describe("the notebook helper", () => {
  const helper = readFileSync("docker/notebook-runtime/agentswarms_helper.py", "utf8");

  it("ends a `with` block with a finish that sends no artifact, which the statement must keep", () => {
    const exit = helper.slice(helper.indexOf("def __exit__"), helper.indexOf("def start_run"));
    expect(exit).toContain("self.finish()");
    const finish = helper.slice(
      helper.indexOf("    def finish("),
      helper.indexOf("    def save_model("),
    );
    expect(finish).toContain("if artifact_uri:");
  });
});
