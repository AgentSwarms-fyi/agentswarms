// The pure half of scripts/upgrade-qdrant.mjs: which Qdrant releases a stored
// volume has to pass through to reach the pinned one. No side effects, so the
// plan can be tested without Docker.
//
// WHY THIS EXISTS (VA-2026-10-25-38, R416). Qdrant opens storage written by
// the previous minor release and no older one: "upgrade to the latest patch
// version of each intermediate minor version first" (qdrant.tech, Upgrades).
// The bundled Qdrant sat on v1.12.4 while 1.20.0 shipped, so moving the pin is
// eight minor releases at once, and `docker compose up -d` would hand a 1.12
// volume straight to 1.20. Each release in between migrates the storage it
// opens (1.18 dropped RocksDB entirely), which is why the steps cannot be
// skipped, only run.

/**
 * The latest patch of every minor release from 1.13, pinned by digest like
 * every other image here (VA-24). Each one only has to open the previous
 * one's storage. When Dependabot moves the compose pin to a new minor, the
 * minor it leaves goes on the end of this list (the unit test says so).
 */
export const QDRANT_PATH = [
  "qdrant/qdrant:v1.13.6@sha256:bd67306b6cc77c98122cada2321eb60b20d00b19d26cb61c86681e7bd5951498",
  "qdrant/qdrant:v1.14.1@sha256:419d72603f5346ee22ffc4606bdb7beb52fcb63077766fab678e6622ba247366",
  "qdrant/qdrant:v1.15.5@sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863",
  "qdrant/qdrant:v1.16.3@sha256:0425e3e03e7fd9b3dc95c4214546afe19de2eb2e28ca621441a56663ac6e1f46",
  "qdrant/qdrant:v1.17.1@sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f",
  "qdrant/qdrant:v1.18.3@sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286",
  "qdrant/qdrant:v1.19.2@sha256:b7b0444c4c351c970b98e90a6f89c2ee4287c65b44e52b4cb503fa5b2aa927ad",
  "qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2",
];

/** The release this repository pinned until R416, and the only one before it. */
export const LAST_PIN_BEFORE_R416 = "1.12.4";

/** `1.12.4`, `v1.12.4` or an image reference carrying either; null otherwise. */
export function parseQdrantVersion(text) {
  const m = /(?:^|[:v\s])v?(\d+)\.(\d+)\.(\d+)(?=$|[@\s-])/.exec(String(text ?? "").trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

export const showVersion = (v) => `${v.major}.${v.minor}.${v.patch}`;
const show = showVersion;

export const compareVersions = (a, b) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * The file the upgrade script leaves on the volume: the release that last
 * opened it under the script. Needed because nothing Qdrant writes says so.
 * Measured: every collection's `version.info` reads `0.4.2` and every
 * segment's `0.6.0` on 1.12.4, and again after 1.13.6 and 1.14.1.
 */
export const MARKER_FILE = ".agentswarms-qdrant-release";

/**
 * Whether a container's image can be taken as a release that opened the
 * volume: one running and healthy, or one that stopped the way Qdrant stops
 * (0, or 143 on SIGTERM). Not a crash loop: 1.20.0 started on a 1.12.4 volume
 * panics and exits 101, and `restart: unless-stopped` starts it again.
 */
export function ranCleanly(c) {
  if (c.restarting) return false;
  if (c.running) return c.health === "healthy";
  return c.exitCode === 0 || c.exitCode === 143;
}

/**
 * The release the volume is at, from what is known about it. QDRANT_FROM,
 * stated by the operator, wins outright. Otherwise the newest of the marker
 * and the containers that ran cleanly, since each of those is a release that
 * did open the volume. `{ from: null }` when nothing is known.
 */
export function storedRelease({ stated, marker, containers }) {
  if (stated) {
    const v = parseQdrantVersion(stated);
    return v
      ? { from: v, source: "QDRANT_FROM" }
      : { error: `QDRANT_FROM=${stated} names no release` };
  }
  const known = [];
  const m = parseQdrantVersion(marker);
  if (m) known.push({ from: m, source: `the volume's ${MARKER_FILE}` });
  for (const c of containers) {
    const v = ranCleanly(c) ? parseQdrantVersion(c.image) : null;
    if (v) known.push({ from: v, source: `container ${c.id} (${c.image})` });
  }
  known.sort((a, b) => compareVersions(b.from, a.from));
  return known[0] ?? { from: null };
}

/**
 * The images to run, in order, so a volume last opened by `from` can be
 * opened by `to`. Only the releases strictly between the two minors: `to`
 * itself is the pinned service, started by Compose afterwards.
 *
 * `{ steps }` or `{ error }`, never a guess. A volume newer than the pin, a
 * major release, or a minor missing from the path is refused: running the
 * wrong release against a volume is the outage this exists to prevent.
 */
export function planQdrantSteps(from, to, path = QDRANT_PATH) {
  if (!from || !to) return { error: "a Qdrant version could not be read" };
  if (from.major !== to.major) {
    return {
      error: `Qdrant ${show(from)} to ${show(to)} crosses a major release; there is no path`,
    };
  }
  if (from.minor > to.minor || (from.minor === to.minor && from.patch > to.patch)) {
    return {
      error:
        `the volume was last opened by Qdrant ${show(from)}, newer than the pinned ${show(to)}; ` +
        `Qdrant cannot open storage from a newer release`,
    };
  }
  const steps = [];
  for (let minor = from.minor + 1; minor < to.minor; minor++) {
    const image = path.find((ref) => {
      const v = parseQdrantVersion(ref);
      return v && v.major === to.major && v.minor === minor;
    });
    if (!image) {
      return {
        error: `no ${to.major}.${minor} release in the upgrade path (scripts/lib/qdrant-upgrade.mjs)`,
      };
    }
    steps.push(image);
  }
  return { steps };
}
