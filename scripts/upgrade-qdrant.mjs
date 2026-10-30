#!/usr/bin/env node
// Carry the bundled Qdrant's volume to the pinned release, one minor at a time.
//
//   node scripts/upgrade-qdrant.mjs            # the installers run this before `docker compose up`
//   node scripts/upgrade-qdrant.mjs --dry-run  # say what it would run, and run nothing
//   node scripts/upgrade-qdrant.mjs --k8s      # print the steps for the Kubernetes StatefulSet
//
// Qdrant opens storage written by the previous minor release only, so a volume
// last opened by 1.12 has to be opened by 1.13, 1.14 ... 1.19 before 1.20 can
// open it (scripts/lib/qdrant-upgrade.mjs says why, and holds the path). This
// stops the running Qdrant, then starts each release in between on the volume,
// waits until it has loaded every collection, and stops it again. Compose then
// starts the pinned release as usual.
//
// Each release runs with --network none: nothing can reach a Qdrant started
// without the service's API key, and every check is made from inside the
// container. A release is stopped once every collection is green, not merely
// once it answers. Nothing is deleted. A step that fails leaves the volume where
// the last good step left it, and running this again carries on from there.
//
// WHICH RELEASE THE VOLUME IS AT. Nothing Qdrant writes says, so this reads it
// from what does: the release in QDRANT_FROM if the operator states one;
// otherwise the newest of the marker this script leaves after each release
// that loads the volume, and the image of each container that ran on it
// cleanly. A crash loop is not a release that opened it. Where no healthy
// Qdrant vouches for the volume, the pinned release is tried first: if it
// loads the volume there is nothing to do. If it cannot, and nothing says
// which release last could, this stops and asks rather than guess, because
// running an older release than the volume's is a downgrade.
//
// QDRANT_UPGRADE_TIMEOUT_S (default 1800) bounds each release's wait for its
// collections to load and settle; a large collection on a slow disk can need
// more.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  LAST_PIN_BEFORE_R416,
  MARKER_FILE,
  parseQdrantVersion,
  planQdrantSteps,
  showVersion,
  storedRelease,
} from "./lib/qdrant-upgrade.mjs";

// The repository root, so `docker compose` reads this checkout's project
// whichever directory this was started from.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const TIMEOUT_S = Number(process.env.QDRANT_UPGRADE_TIMEOUT_S) || 1800;
const STORAGE = "/qdrant/storage";

const say = (s) => console.log(`▸ ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exit(1);
};

function run(cmd, argv, { allowFail = false, input } = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", cwd: REPO, input });
  if (r.error) fail(`${cmd} could not be run: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(
      `${cmd} ${argv.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`,
    );
  }
  return r;
}
const docker = (argv, opts) => run("docker", argv, opts);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One HTTP/1.0 request to the Qdrant inside the container, through bash's
 * /dev/tcp: the image has no curl, and the container has no network to reach
 * it from outside. `{ status, json }`, or status 0 when nothing answered.
 */
function http(name, method, urlPath, body) {
  const head =
    `${method} ${urlPath} HTTP/1.0\r\nHost: localhost\r\n` +
    (body
      ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
      : "");
  const r = docker(
    ["exec", "-i", name, "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/6333 && cat >&3 && cat <&3"],
    { allowFail: true, input: `${head}\r\n${body ?? ""}` },
  );
  const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(r.stdout)?.[1] ?? 0);
  const at = r.stdout.indexOf("\r\n\r\n");
  let json = null;
  try {
    json = at >= 0 ? JSON.parse(r.stdout.slice(at + 4)) : null;
  } catch {
    json = null;
  }
  return { status, json };
}

/**
 * Until the release has loaded the volume AND finished what it does to it:
 * /readyz, then every collection green. Not /readyz alone. Qdrant's notes do
 * not say which work a release does while loading and which it leaves to the
 * optimizer. Measured: 1.16.3 logs "Migrating … payload storage from RocksDB
 * into new format" while it loads, but 1.15.5 answered /readyz with both
 * collections grey, optimizations pending and not running. Stopping a release
 * half way through would hand the next one storage it may not read. A grey
 * collection gets the nudge Qdrant documents, an empty optimizers_config
 * update. Red is an error, and the step stops there.
 */
async function waitSettled(name) {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let ready = false;
  let waiting = [];
  while (Date.now() < deadline) {
    const state = docker(["inspect", "-f", "{{.State.Running}}", name], { allowFail: true });
    if (state.stdout.trim() !== "true") return { ok: false, why: "it exited" };
    if (!ready) {
      ready = http(name, "GET", "/readyz").status === 200;
    } else {
      const list = http(name, "GET", "/collections").json?.result?.collections;
      if (Array.isArray(list)) {
        const states = list.map((c) => [
          c.name,
          http(name, "GET", `/collections/${c.name}`).json?.result?.status,
        ]);
        const red = states.find(([, s]) => s === "red");
        if (red) return { ok: false, why: `collection ${red[0]} is red` };
        waiting = states.filter(([, s]) => s !== "green");
        if (waiting.length === 0) return { ok: true };
        for (const [coll, s] of waiting) {
          if (s === "grey") {
            http(name, "PATCH", `/collections/${coll}`, JSON.stringify({ optimizers_config: {} }));
          }
        }
      }
    }
    await sleep(3000);
  }
  return {
    ok: false,
    why: ready
      ? `still optimizing after ${TIMEOUT_S} s: ${waiting.map(([c, s]) => `${c} ${s}`).join(", ")} (QDRANT_UPGRADE_TIMEOUT_S)`
      : `not ready after ${TIMEOUT_S} s (QDRANT_UPGRADE_TIMEOUT_S)`,
  };
}

/** Compose's own view: the project, the pinned image, the volume's real name. */
function composeQdrant() {
  const r = docker(["compose", "config", "--format", "json"], { allowFail: true });
  if (r.status !== 0) fail(`docker compose config failed: ${r.stderr.trim().slice(-400)}`);
  const cfg = JSON.parse(r.stdout);
  const svc = cfg.services?.qdrant;
  if (!svc) return null;
  const mount = (svc.volumes ?? []).find((m) => m.target === STORAGE && m.type === "volume");
  if (!mount) return null;
  const volume = cfg.volumes?.[mount.source]?.name ?? `${cfg.name}_${mount.source}`;
  return { project: cfg.name, image: svc.image, volume };
}

/** Every container that mounts the volume, with what its state says it did. */
function containersOn(volume) {
  const ids = docker(["ps", "-aq", "--filter", `volume=${volume}`])
    .stdout.split(/\s+/)
    .filter(Boolean);
  return ids.map((id) => {
    const f =
      "{{.Config.Image}}|{{.State.Running}}|{{.State.Restarting}}|{{.State.ExitCode}}|" +
      "{{if .State.Health}}{{.State.Health.Status}}{{end}}";
    const [image, running, restarting, exitCode, health] = docker(["inspect", "-f", f, id])
      .stdout.trim()
      .split("|");
    return {
      id,
      image,
      running: running === "true",
      restarting: restarting === "true",
      exitCode: Number(exitCode),
      health,
    };
  });
}

/** The marker, read through a container that only reads: no network, read-only mount. */
function readMarker(volume, image) {
  const r = docker(
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "cat",
      "-v",
      `${volume}:/s:ro`,
      image,
      `/s/${MARKER_FILE}`,
    ],
    { allowFail: true },
  );
  return r.status === 0 ? r.stdout.trim() : null;
}

const markerWrite = (release) => `printf %s ${release} > ${STORAGE}/${MARKER_FILE}`;

/**
 * Start one release on the volume, unreachable, until it has loaded every
 * collection; record it on the volume; stop it. `{ ok }` or why not.
 */
async function openWith(q, image) {
  const v = parseQdrantVersion(image);
  const name = `${q.project}-qdrant-upgrade`;
  docker(["rm", "-f", name], { allowFail: true });
  docker(["run", "-d", "--name", name, "--network", "none", "-v", `${q.volume}:${STORAGE}`, image]);
  const ready = await waitSettled(name);
  if (!ready.ok) {
    const logs = docker(["logs", "--tail", "60", name], { allowFail: true });
    docker(["rm", "-f", name], { allowFail: true });
    // Without the backtrace's frames, which push the panic's own line (the
    // one that says what it could not read) out of the last lines shown.
    const lines = (logs.stdout + logs.stderr)
      .split("\n")
      .filter((l) => l.trim() && !/^\s+\d+: /.test(l))
      .slice(-8);
    return { ok: false, why: ready.why, logs: lines.join("\n") };
  }
  docker(["exec", name, "bash", "-c", markerWrite(showVersion(v))]);
  docker(["stop", "-t", "300", name]);
  const code = docker(["inspect", "-f", "{{.State.ExitCode}}", name]).stdout.trim();
  docker(["rm", "-f", name], { allowFail: true });
  // 143 is how Qdrant ends on SIGTERM, the same stop `docker compose stop`
  // gives it. 137 would be Docker killing one that did not stop in 300 s.
  if (code !== "0" && code !== "143") return { ok: false, why: `it exited ${code} while stopping` };
  return { ok: true };
}

function stopAll(containers) {
  const live = containers.filter((c) => c.running || c.restarting);
  if (live.length === 0) return;
  say(`Stopping the Qdrant that has the volume (${live.map((c) => c.id).join(", ")})`);
  docker(["stop", "-t", "120", ...live.map((c) => c.id)]);
}

async function compose() {
  const q = composeQdrant();
  if (!q) return say("No bundled Qdrant in this Compose project; nothing to upgrade.");
  const to = parseQdrantVersion(q.image);
  if (!to) fail(`the compose pin ${q.image} names no Qdrant release`);

  const exists = docker(["volume", "inspect", q.volume], { allowFail: true }).status === 0;
  if (!exists) return; // a fresh install: the pinned release creates the volume

  const containers = containersOn(q.volume);
  const stated = process.env.QDRANT_FROM?.trim();
  const marker = readMarker(q.volume, q.image);
  const known = storedRelease({ stated, marker, containers });
  if (known.error) fail(known.error);

  // A healthy Qdrant on the volume vouches for it, and keeps the marker current
  // for the day the container is gone.
  const vouching = containers.find((c) => c.running && c.health === "healthy");
  const vouched = vouching && parseQdrantVersion(vouching.image);
  if (
    vouched &&
    !DRY &&
    (!parseQdrantVersion(marker) || compareVersions(vouched, parseQdrantVersion(marker)) > 0)
  ) {
    docker(["exec", vouching.id, "bash", "-c", markerWrite(showVersion(vouched))], {
      allowFail: true,
    });
  }

  // Nothing vouches: try the pin itself. If it loads the volume, it is at most
  // one minor behind and Compose can start it.
  if (!vouched && !stated) {
    if (DRY) {
      say(`Would first check that ${showVersion(to)} loads ${q.volume}.`);
    } else {
      stopAll(containers);
      say(`Checking that Qdrant ${showVersion(to)} loads ${q.volume}`);
      const tried = await openWith(q, q.image);
      if (tried.ok) return say(`It does; nothing to upgrade.`);
      if (!known.from) {
        fail(
          `Qdrant ${showVersion(to)} cannot load ${q.volume} (${tried.why}), and nothing on it says ` +
            `which release last did. AgentSwarms pinned ${LAST_PIN_BEFORE_R416} until R416: if this ` +
            `install never ran another image, run\n` +
            `    QDRANT_FROM=${LAST_PIN_BEFORE_R416} node scripts/upgrade-qdrant.mjs\n` +
            `  or in PowerShell\n` +
            `    $env:QDRANT_FROM = "${LAST_PIN_BEFORE_R416}"; node scripts/upgrade-qdrant.mjs\n` +
            `Its last lines:\n${tried.logs ?? ""}`,
        );
      }
      say(`It cannot (${tried.why}), so the releases in between come first.`);
    }
  }
  if (!known.from) {
    if (DRY) say("Nothing says which release last opened the volume; set QDRANT_FROM to plan.");
    return;
  }

  const plan = planQdrantSteps(known.from, to);
  if (plan.error) fail(`${plan.error}. The volume is unchanged.`);
  if (plan.steps.length === 0) {
    if (vouched || stated || DRY) return;
    fail(
      `Qdrant ${showVersion(to)} cannot load ${q.volume}, though ${known.source} says it was last opened ` +
        `by ${showVersion(known.from)}. Set QDRANT_FROM to the release that last ran on it.`,
    );
  }

  const names = plan.steps.map((s) => showVersion(parseQdrantVersion(s)));
  say(
    `Qdrant's volume was last opened by ${showVersion(known.from)} (${known.source}); the pin is ` +
      `${showVersion(to)}. Qdrant upgrades one minor release at a time, so ${names.join(", ")} ` +
      `each load it first.`,
  );
  if (DRY) {
    for (const s of plan.steps) console.log(`    would run ${s} on ${q.volume}`);
    return;
  }

  stopAll(containersOn(q.volume));
  for (const [i, image] of plan.steps.entries()) {
    say(`${names[i]}: loading the volume (${i + 1} of ${plan.steps.length})`);
    const step = await openWith(q, image);
    if (!step.ok) {
      fail(
        `Qdrant ${names[i]} did not load the volume (${step.why}).` +
          (step.logs ? ` Its last lines:\n${step.logs}\n` : " ") +
          `The volume is as ${i === 0 ? "it was" : names[i - 1] + " left it"}; run this again to carry on. ` +
          `The index is rebuildable from Postgres: docs/KNOWLEDGE_BASES.md says how.`,
      );
    }
  }
  say(
    `Qdrant's volume is ready for ${showVersion(to)}. \`docker compose up -d qdrant\` starts it.`,
  );
}

function k8s() {
  const ns = process.env.QDRANT_NAMESPACE || "agentswarms";
  const r = run(
    "kubectl",
    [
      "-n",
      ns,
      "get",
      "statefulset",
      "qdrant",
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ],
    { allowFail: true },
  );
  if (r.status !== 0)
    fail(`kubectl could not read statefulset/qdrant in ${ns}: ${r.stderr.trim()}`);
  const from = parseQdrantVersion(process.env.QDRANT_FROM || r.stdout);
  // The target is the manifest's pin, read from the file about to be applied.
  const manifest = readFileSync(path.join(REPO, "deploy/k8s/app/services.yaml"), "utf8");
  const to = parseQdrantVersion(/image:\s*(qdrant\/qdrant:\S+)/.exec(manifest)?.[1]);
  const plan = planQdrantSteps(from, to);
  if (plan.error) fail(plan.error);
  if (plan.steps.length === 0)
    return say("statefulset/qdrant can move to the pin directly; apply the manifests.");
  say("Run these one at a time, BEFORE applying the manifests; each rollout must finish first:");
  for (const image of plan.steps) {
    console.log(`  kubectl -n ${ns} set image statefulset/qdrant qdrant=${image}`);
    console.log(`  kubectl -n ${ns} rollout status statefulset/qdrant --timeout=60m`);
  }
}

if (args.has("--k8s")) k8s();
else await compose();
