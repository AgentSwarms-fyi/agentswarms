// Which release this server is (R470).
//
// The app image records it at build time in /app/release.json: the release
// workflow passes the tag and the commit, a build from a checkout says "dev".
// A file, not an environment variable, because Compose hands the app its whole
// .env, and .env's AGENTSWARMS_VERSION names the release to RUN. Read from the
// environment, a checkout built under a release's name (`up --build` with a
// version set) would report itself as that release. `npm run dev` has no file,
// which is "dev" too.
import { readFileSync } from "node:fs";
import path from "node:path";

export type ReleaseInfo = { version: string; revision: string | null };

const DEV: ReleaseInfo = { version: "dev", revision: null };
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const REVISION_RE = /^[0-9a-f]{7,64}$/;

/** Parses release.json's text. Anything malformed is "dev". */
export function parseRelease(text: string): ReleaseInfo {
  try {
    const j = JSON.parse(text) as { version?: unknown; revision?: unknown };
    const version = typeof j.version === "string" ? j.version.trim() : "";
    if (!VERSION_RE.test(version)) return DEV;
    const revision = typeof j.revision === "string" ? j.revision.trim() : "";
    return { version, revision: REVISION_RE.test(revision) ? revision : null };
  } catch {
    return DEV;
  }
}

let cached: ReleaseInfo | undefined;

/** This server's release, read once. */
export function releaseInfo(file = path.join(process.cwd(), "release.json")): ReleaseInfo {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return (cached = DEV);
  }
  return (cached = parseRelease(text));
}

export function resetReleaseInfoForTests(): void {
  cached = undefined;
}
