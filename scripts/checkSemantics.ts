// CI check for exported semantic models.
//
//   npm run check:semantics -- [dir]
//
// Reads every .json under `dir` (default: the repo working copy of a Git
// export), checks the definitions that can be checked without a warehouse, and
// exits non-zero on an error. This is what turns "someone changed a metric"
// into something a pull request can fail on.
//
// It deliberately needs NO credentials and NO network. A check that required a
// warehouse login would not run on a fork's PR, which is exactly when you want
// it most.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { checkSemanticFiles, formatCheckReport } from "../src/lib/semanticFileCheck";

/** Every .json under `dir`, recursively. */
function jsonFiles(dir: string, root: string, out: Array<{ path: string; content: string }> = []) {
  for (const entry of readdirSync(dir)) {
    // node_modules in an export tree would be someone's mistake, but reading it
    // would turn a fast check into a minute of IO.
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      jsonFiles(full, root, out);
    } else if (entry.endsWith(".json")) {
      out.push({
        path: relative(root, full).replace(/\\/g, "/"),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

function main() {
  const target = resolve(process.argv[2] ?? ".");
  let files: Array<{ path: string; content: string }>;
  try {
    files = jsonFiles(target, target);
  } catch (e) {
    console.error(`Could not read ${target}: ${(e as Error).message}`);
    process.exit(2);
  }

  if (files.length === 0) {
    // NOT a pass. A check that finds nothing and says "ok" is how a misspelled
    // path turns into a permanently green build.
    console.error(
      `No .json files under ${target}. Point this at the directory your Git export writes ` +
        `(default base path: agentswarms/), or the check is passing on an empty set.`,
    );
    process.exit(2);
  }

  const report = checkSemanticFiles(files);
  console.log(formatCheckReport(report));
  process.exit(report.ok ? 0 : 1);
}

main();
