// Nothing the reader starts may fail without saying so.
//
// FOUND IN R245. The Iceberg publish button was written as
//
//   try { … if (!r.ok) return toast.error(r.error); … } finally { setBusy(false); }
//
// — a `finally` with no `catch`. A server function that RESOLVES with
// `ok: false` is reported; one that REJECTS stops the spinner, leaves the
// dialog open and says nothing. That is what "No toast" meant in the
// 2026-10-01 run, over a publish the catalog had refused with HTTP 500.
//
// The shape is a family, not an incident: a sweep for handlers that toast
// `ok: false` inside a try with no catch found 68. Each deserves its own
// sentence and they are being written one at a time; `installSilentFailureNet`
// is the floor underneath that work, so the worst case is a vague message
// rather than silence.
import { readFileSync, readdirSync } from "node:fs";

import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { silentFailureToast } from "@/lib/silentFailureNet";
import { publishFailureHelp } from "@/lib/icebergPublishHelp";

/** A fresh "last thing we said", as the listener keeps one per install. */
const fresh = () => ({ message: "", at: 0 });

describe("the net under an unreported rejection", () => {
  it("says something, and shows the real message", () => {
    const said = silentFailureToast(
      new Error("Failed to commit Iceberg transaction: HTTP 500"),
      fresh(),
    );
    expect(said?.title).toMatch(/did not finish/i);
    expect(said?.description).toContain("HTTP 500");
  });

  it("stays quiet for an abort, which is someone cancelling", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(silentFailureToast(abort, fresh())).toBeNull();
    expect(silentFailureToast(new Error("the request was aborted"), fresh())).toBeNull();

    // By NAME alone, with a message that says nothing about aborting. Browsers
    // word this differently ("signal is aborted without reason", "The user
    // aborted a request", and DOMExceptions with no message at all), so the
    // name is the only reliable half. Without this case a mutant that deleted
    // the name check survived, because both cases above also say "aborted".
    const quiet = new Error("signal stopped");
    quiet.name = "AbortError";
    expect(silentFailureToast(quiet, fresh())).toBeNull();
    const canceled = new Error("request cancelled by the client");
    canceled.name = "CanceledError";
    expect(silentFailureToast(canceled, fresh())).toBeNull();
  });

  it("does not say the same thing three times", () => {
    const seen = fresh();
    expect(silentFailureToast(new Error("the same failure"), seen, 1000)).not.toBeNull();
    expect(silentFailureToast(new Error("the same failure"), seen, 1500)).toBeNull();
    // Far enough apart and it is news again: a failure that keeps happening
    // should keep being reported.
    expect(silentFailureToast(new Error("the same failure"), seen, 9000)).not.toBeNull();
    expect(silentFailureToast(new Error("a different failure"), seen, 9100)).not.toBeNull();
  });

  it("handles a rejection that is not an Error at all", () => {
    expect(silentFailureToast({ status: 500 }, fresh())?.description).toContain("500");
    expect(silentFailureToast("a bare string", fresh())?.description).toBe("a bare string");
    expect(silentFailureToast(new Error(""), fresh())?.description).toMatch(/without saying why/i);
  });

  it("is wired to the window, and can be torn down", () => {
    // The listener half is three lines over the decision above; pinned by
    // reading it rather than by standing up a DOM the suite does not have.
    const src = readFileSync("src/lib/silentFailureNet.ts", "utf8");
    expect(src).toContain('window.addEventListener("unhandledrejection"');
    expect(src).toContain('window.removeEventListener("unhandledrejection"');
    expect(src).toContain('typeof window === "undefined"');
    const root = readFileSync("src/routes/__root.tsx", "utf8");
    expect(root).toContain("installSilentFailureNet()");
    expect(root).toContain("<SilentFailureNet />");
  });
});

describe("what a refused publish says", () => {
  it("keeps the engine's own words and adds where to look", () => {
    const help = publishFailureHelp(
      new Error("Failed to commit Iceberg transaction: HTTP 500 from catalog"),
    );
    expect(help).toContain("HTTP 500");
    // The diagnosis, not only the commands: a remedy with nothing to explain
    // it is a ritual. A mutant that deleted this sentence and left the two
    // docker lines standing survived the first version of this test.
    expect(help).toMatch(/accepted the request and refused the write/i);
    expect(help).toMatch(/SQLITE_BUSY/);
    expect(help).toContain("docker logs aswarm-iceberg-rest");
    expect(help).toContain("docker compose restart aswarm-iceberg-rest");
  });

  it("does not claim the lock, because the client cannot see it", () => {
    // The lock is in the catalog's log. A confident wrong cause is the thing
    // this log keeps finding; "its log says SQLITE_BUSY when that is what
    // happened" is a place to look, not an assertion.
    const help = publishFailureHelp(new Error("Failed to commit Iceberg transaction: HTTP 500"));
    expect(help).not.toMatch(/the database is locked\./i);
    expect(help).toMatch(/when that is what happened|Check /);
  });

  it("leaves an unrelated failure exactly as it was", () => {
    const plain = "That namespace name is not usable here.";
    expect(publishFailureHelp(new Error(plain))).toBe(plain);
    // A 500 with nothing to do with the catalog is not given catalog advice.
    expect(publishFailureHelp(new Error("500 rows were rejected"))).not.toMatch(/SQLITE_BUSY/);
  });

  it("says something even when the throw carried no message", () => {
    expect(publishFailureHelp(new Error(""))).toMatch(/without a message/i);
  });
});

describe("the publish button reports both ways a publish can fail", () => {
  const SRC = readFileSync("src/components/lakehouse/IcebergDialog.tsx", "utf8");

  it("catches a rejection as well as an ok:false", () => {
    const at = SRC.indexOf("const r = await publishFn(");
    const handler = SRC.slice(at, at + 1600);
    expect(handler).toContain("if (!r.ok) return toast.error(r.error);");
    expect(handler).toMatch(/\} catch \([^)]*\) \{/);
    expect(handler).toContain("publishFailureHelp(");
    // The catch must come before the finally that stops the spinner, or it is
    // not a catch at all.
    expect(handler.indexOf("} catch")).toBeLessThan(handler.indexOf("} finally"));
  });
});

describe("the family this came from", () => {
  /** Handlers that toast ok:false inside a try that has no catch. */
  function silentHandlers(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) {
          const src = readFileSync(full, "utf8");
          for (const m of src.matchAll(/\btry\s*\{/g)) {
            let depth = 0;
            let i = m.index! + m[0].length - 1;
            for (; i < src.length; i++) {
              if (src[i] === "{") depth++;
              else if (src[i] === "}" && --depth === 0) break;
            }
            const body = src.slice(m.index!, i);
            if (
              !src
                .slice(i + 1, i + 12)
                .trimStart()
                .startsWith("finally")
            )
              continue;
            if (body.includes("toast.error(") && body.includes("await ")) {
              out.push(`${full}:${src.slice(0, m.index!).split("\n").length}`);
            }
          }
        }
      }
    };
    walk("src/routes/_authenticated");
    walk("src/components");
    return out;
  }

  it("does not grow", () => {
    // 68 when R245 found them, 67 once the publish button was fixed. This
    // number is a debt, not a budget: it should only ever go down, and a
    // handler with its own sentence beats the net every time.
    const silent = silentHandlers();
    expect(
      silent.length,
      `now: ${silent.length}\n${silent.slice(0, 5).join("\n")}`,
    ).toBeLessThanOrEqual(67);
  });

  it("no longer includes the publish handler it was found by", () => {
    // IcebergDialog holds FOUR handlers of this shape and only the publish one
    // was given a sentence, so the file still appears — asserting on the file
    // would have passed while the publish button was still silent, and
    // asserting it is absent would fail for the wrong reason. The line is what
    // changed, so the line is what is checked.
    const src = readFileSync("src/components/lakehouse/IcebergDialog.tsx", "utf8");
    const publishAt = src.slice(0, src.indexOf("const r = await publishFn(")).split("\n").length;
    const inFile = silentHandlers()
      .filter((h) => h.includes("IcebergDialog"))
      .map((h) => Number(h.split(":").pop()));
    expect(inFile.length, "the other three are still owed a sentence").toBe(3);
    expect(
      inFile.some((line) => Math.abs(line - publishAt) < 12),
      "the publish handler is silent again",
    ).toBe(false);
  });
});
