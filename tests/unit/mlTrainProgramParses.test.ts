// The trainer program is Python, so compile it as Python.
//
// `TRAIN_PY` is a ~2,000-line module carried as a TypeScript string. Every
// other property of it is tested by reading substrings out of that string —
// which is exactly how an unbalanced quote gets shipped: the substring is
// there, the assertion passes, and the sandbox dies at import with a
// SyntaxError that names a line nobody can map back to a diff.
//
// Written after adding one warning whose message contained an apostrophe
// inside a single-quoted Python literal. The TypeScript was fine. The Python
// was not, and nothing in the suite would have said so.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TRAIN_PY } from "@/utils/ml/pyTrain";

/** The interpreter, if this machine has one; the check is skipped if not. */
const PY = (() => {
  for (const c of ["python3", "python", "py"]) {
    try {
      execFileSync(c, ["-c", "pass"], { stdio: "ignore" });
      return c;
    } catch {
      /* try the next one */
    }
  }
  return null;
})();

describe("the ML program the sandbox executes", () => {
  it("compiles as Python", () => {
    if (!PY) {
      // Say so rather than passing silently: a skipped check that looks green
      // is the failure mode this file exists to prevent.
      console.warn("no Python interpreter found; TRAIN_PY was not compiled");
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "ml-train-py-"));
    try {
      const file = join(dir, "train.py");
      writeFileSync(file, TRAIN_PY, "utf8");
      execFileSync(
        PY,
        [
          "-c",
          `compile(open(${JSON.stringify(file)}, encoding='utf8').read(), 'train.py', 'exec')`,
        ],
        { stdio: "pipe" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries no control characters a heredoc may have smuggled in", () => {
    // A `\b` written in a shell heredoc becomes a literal BACKSPACE, which
    // compiles, runs, and quietly means something else. Tabs and newlines are
    // the only control characters Python source should contain.
    const bad = [...TRAIN_PY].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c < 0x20 && ch !== "\n" && ch !== "\t" && ch !== "\r";
    });
    expect(bad.map((c) => c.codePointAt(0))).toEqual([]);
  });
});
