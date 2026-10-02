// A sandbox that was created and then would not start.
//
// FOUND FROM THE SURVEY (R94). create() tears the container down again when
// the start fails - the only thing that ever will, since no session row will
// carry its ref - and it threw that teardown's answer away, so a cleanup that
// failed too left a container in `created` and reported only the start.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/utils/notebookRuntime/docker.server.ts", "utf8");
const result = readFileSync("src/routes/api/notebook.runtime.result.ts", "utf8");

const between = (s: string, start: string, end: string) => {
  const i = s.indexOf(start);
  expect(i, `missing anchor: ${start}`).toBeGreaterThan(-1);
  const j = s.indexOf(end, i);
  expect(j, `missing anchor: ${end}`).toBeGreaterThan(-1);
  return s.slice(i, j);
};
const flat = (s: string) => s.replace(/\s+/g, " ");

const failedStart = flat(
  between(src, "const start = await dockerFetch(", "private async inspect("),
);

describe("a sandbox that would not start", () => {
  it("keeps the start's own explanation, read before the teardown", () => {
    expect(failedStart).toContain("const detail = await start.text()");
    expect(failedStart.indexOf("const detail = await start.text()")).toBeLessThan(
      failedStart.indexOf("await this.stop(created.Id)"),
    );
    expect(failedStart).toContain("docker start failed (${start.status}): ${detail}");
  });

  it("reads the teardown's answer instead of discarding it", () => {
    expect(failedStart).toContain("const teardown = await this.stop(created.Id)");
    expect(failedStart).not.toContain("await this.stop(created.Id).catch(() => {});");
    expect(failedStart).toContain("teardown.removed");
  });

  it("says a container is left behind, and where, when the teardown fails too", () => {
    expect(failedStart).toContain("could not be removed either");
    expect(failedStart).toContain("still on this host");
    expect(failedStart).toContain("taken away by hand");
  });

  it("says nothing extra when the teardown worked", () => {
    expect(failedStart).toContain('teardown.removed ? ""');
  });
});

describe("a batch sandbox that reported its own result", () => {
  const terminal = flat(
    between(
      result,
      'const status = body.status === "error" ? "error" : "succeeded";',
      "return json(200, { ok: true });",
    ),
  );

  it("reads the container it is about to be finished with", () => {
    expect(terminal).toContain('.select("etl_run_id, inputs, container_ref")');
  });

  it("takes the sandbox off the host once the row is terminal", () => {
    expect(terminal).toContain("if (updated?.container_ref) {");
    expect(terminal).toContain(".then((orch) => orch.stop(ref))");
  });

  it("tears down AFTER the finalisations, which read the same row", () => {
    expect(terminal.indexOf("finalizeSparkQuery")).toBeLessThan(
      terminal.indexOf("if (updated?.container_ref) {"),
    );
  });

  it("says what is left, and that nothing else will come looking", () => {
    expect(terminal).toContain("was not removed:");
    expect(terminal).toContain("nothing else will look for it");
  });
});
