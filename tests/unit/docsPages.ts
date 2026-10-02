// A long in-app guide is a FAMILY of route files: the overview
// `src/routes/docs.<name>.tsx` and its sub-pages `docs.<name>_.<sub>.tsx`
// (the `_` is TanStack's escape — /docs/ml/training is a sibling route,
// not a child rendered inside the overview). Guards that read "the ML page"
// read the whole family, so a section moving between sub-pages never turns
// a documentation guard into a false alarm, while removing the section from
// the guide altogether is still caught.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");

/** Repo-relative paths of a guide's route files, overview first. */
export function docsFamilyFiles(name: string): string[] {
  return readdirSync(path.join(REPO, "src/routes"))
    .filter((f) => f === `docs.${name}.tsx` || f.startsWith(`docs.${name}_.`))
    .sort()
    .map((f) => `src/routes/${f}`);
}

/** The guide's pages concatenated, overview first. */
export function docsFamily(name: string): string {
  const files = docsFamilyFiles(name);
  if (files.length === 0) throw new Error(`no in-app guide named "${name}"`);
  return files.map((f) => readFileSync(path.join(REPO, f), "utf8")).join("\n");
}
