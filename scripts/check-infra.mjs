#!/usr/bin/env node
// Installation and deployment assets, checked without a cluster.
//
// The install scripts, the compose file, the Dockerfiles and the Kubernetes
// manifests were, until this existed, verified by nothing: CI built the app
// and ran the unit tests, and a shell script with a typo, a manifest whose
// Service selected no pod, or a script an operator could not execute after a
// fresh clone (no exec bit) reached a release untouched. This runs in
// `npm run check` and in CI and needs only node, git and (where present) the
// shells and Docker — a check that needs a tool the runner does not have is
// reported as skipped, never as passed.
//
//   node scripts/check-infra.mjs            # report and exit non-zero on a problem
//   node scripts/check-infra.mjs --quiet    # problems only
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");
const problems = [];
const skipped = [];
const passed = [];
const note = (s) => passed.push(s);
const problem = (s) => problems.push(s);
const skip = (s) => skipped.push(s);
const rd = (rel) => readFileSync(path.join(root, rel), "utf8");
const has = (cmd, args = ["--version"]) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  return r.status === 0;
};

// ── 1. tracked shell scripts: executable, and parseable ─────────────────────
// `./scripts/setup.sh` is what the handbook says; a clone on Linux or macOS
// honours the mode git recorded, and 100644 there is "Permission denied".
const tracked = execFileSync("git", ["ls-files", "-s"], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => {
    const [mode, , , file] = l.split(/\s+/);
    return { mode, file };
  });
const shellScripts = tracked.filter((t) => t.file.endsWith(".sh"));
for (const s of shellScripts) {
  if (s.mode !== "100755")
    problem(`${s.file}: tracked as ${s.mode}, not executable (git update-index --chmod=+x)`);
}
if (shellScripts.every((s) => s.mode === "100755"))
  note(`${shellScripts.length} shell scripts tracked as executable`);
const bash = has("bash", ["--version"]);
if (bash) {
  for (const s of shellScripts) {
    const r = spawnSync("bash", ["-n", s.file], { cwd: root, encoding: "utf8" });
    if (r.status !== 0) problem(`${s.file}: bash -n: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  note(`${shellScripts.length} shell scripts parse (bash -n)`);
} else skip("bash not available: shell scripts not parsed");
for (const s of shellScripts) {
  if (rd(s.file).includes("\r\n"))
    problem(`${s.file}: CRLF line endings would break the shebang on Linux`);
}

// ── 2. the PowerShell installer parses ──────────────────────────────────────
const ps1 = tracked.filter((t) => t.file.endsWith(".ps1")).map((t) => t.file);
const pwsh = ["pwsh", "powershell"].find((c) => has(c, ["-NoProfile", "-Command", "exit 0"]));
if (pwsh) {
  for (const f of ps1) {
    const script = `$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.join(root, f).replace(/'/g, "''")}',[ref]$null,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{Write-Output ("$($_.Extent.StartLineNumber): "+$_.Message)};exit 1}`;
    const r = spawnSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", script], {
      cwd: root,
      encoding: "utf8",
    });
    if (r.status !== 0)
      problem(`${f}: PowerShell parse: ${(r.stdout || r.stderr || "").trim().split("\n")[0]}`);
  }
  note(`${ps1.length} PowerShell script(s) parse`);
} else skip("PowerShell not available: .ps1 not parsed");

// ── 3. the installers agree with the compose file ───────────────────────────
// Every compose profile (besides `all`) must be a flag of both installers, and
// --all / -All must request every one of them.
const compose = yaml.load(rd("docker-compose.yml"));
const profiles = new Set();
for (const svc of Object.values(compose.services ?? {}))
  for (const p of svc.profiles ?? []) profiles.add(p);
profiles.delete("all");
const setupSh = rd("scripts/setup.sh");
const setupPs = rd("scripts/setup.ps1");
for (const p of profiles) {
  if (!setupSh.includes(`--${p}) `))
    problem(`scripts/setup.sh: no --${p} flag for compose profile "${p}"`);
  if (!new RegExp(`add_profile ${p}\\b`).test(setupSh.split("--all)")[1]?.split(";;")[0] ?? ""))
    problem(`scripts/setup.sh: --all does not request profile "${p}"`);
  const sw = p[0].toUpperCase() + p.slice(1);
  if (!setupPs.includes(`[switch]$${sw}`))
    problem(`scripts/setup.ps1: no -${sw} switch for compose profile "${p}"`);
  if (!new RegExp(`if \\(\\$All\\) \\{[^}]*\\$${sw} = \\$true`).test(setupPs))
    problem(`scripts/setup.ps1: -All does not set -${sw}`);
  if (!setupSh.includes(`--${p}`) || !/^#\s+bash scripts\/setup\.sh --/m.test(setupSh)) continue;
  if (!new RegExp(`^#\\s+bash scripts/setup\\.sh --${p}\\b`, "m").test(setupSh))
    problem(`scripts/setup.sh: --help does not list --${p}`);
}
note(`${profiles.size} compose profiles, each a flag of both installers and part of --all`);
const count = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][
  profiles.size
];
for (const [file, text] of [
  ["scripts/setup.sh", setupSh],
  ["scripts/setup.ps1", setupPs],
]) {
  const m = text.match(/the same (\w+) profiles/);
  if (m && m[1] !== count)
    problem(`${file}: says "the same ${m[1]} profiles" but the compose file has ${count}`);
}

// ── 4. Kubernetes manifests: what a cluster would reject or silently ignore ──
const manifests = tracked.filter((t) => /^deploy\/k8s\/.*\.ya?ml$/.test(t.file)).map((t) => t.file);
const docs = [];
for (const f of manifests) {
  let parsed;
  try {
    parsed = yaml.loadAll(rd(f)).filter(Boolean);
  } catch (e) {
    problem(`${f}: not valid YAML: ${e.message.split("\n")[0]}`);
    continue;
  }
  for (const d of parsed) docs.push({ f, d });
}
const nameOf = (d) => `${d.kind}/${d.metadata?.name} (${d.metadata?.namespace ?? "default"})`;
const subset = (sel, labels) => Object.entries(sel ?? {}).every(([k, v]) => labels?.[k] === v);
for (const { f, d } of docs) {
  if (!d.apiVersion || !d.kind || !d.metadata?.name)
    problem(`${f}: a document lacks apiVersion, kind or metadata.name`);
}
const workloads = docs.filter(({ d }) =>
  ["Deployment", "StatefulSet", "DaemonSet"].includes(d.kind),
);
const ns = (d) => d.metadata?.namespace ?? "default";
// A namespace with a ResourceQuota on requests refuses a pod that declares
// none — unless a LimitRange in that namespace fills them in at admission.
const quotaNamespaces = new Set(
  docs
    .filter(
      ({ d }) =>
        d.kind === "ResourceQuota" &&
        Object.keys(d.spec?.hard ?? {}).some((k) => k.startsWith("requests.")),
    )
    .map(({ d }) => ns(d)),
);
const defaultedNamespaces = new Set(
  docs
    .filter(
      ({ d }) =>
        d.kind === "LimitRange" &&
        (d.spec?.limits ?? []).some((l) => l.type === "Container" && l.defaultRequest),
    )
    .map(({ d }) => ns(d)),
);
for (const { f, d } of workloads) {
  const sel = d.spec?.selector?.matchLabels;
  const labels = d.spec?.template?.metadata?.labels;
  if (!sel) problem(`${f}: ${nameOf(d)} has no spec.selector.matchLabels`);
  else if (!subset(sel, labels))
    problem(`${f}: ${nameOf(d)} selector does not match its pod template labels`);
  for (const c of d.spec?.template?.spec?.containers ?? []) {
    if (!c.image) problem(`${f}: ${nameOf(d)} container ${c.name} has no image`);
    if (!c.resources?.requests && quotaNamespaces.has(ns(d)) && !defaultedNamespaces.has(ns(d)))
      problem(
        `${f}: ${nameOf(d)} container ${c.name} declares no resource requests in a namespace whose ResourceQuota counts them and whose LimitRange sets no defaultRequest — admission refuses the pod`,
      );
  }
}
const podsIn = (namespace) =>
  workloads
    .filter(({ d }) => ns(d) === namespace)
    .map(({ d }) => d.spec?.template?.metadata?.labels ?? {});
for (const { f, d } of docs.filter(({ d }) => d.kind === "Service")) {
  if (!d.spec?.selector) continue; // headless/external
  if (!podsIn(ns(d)).some((labels) => subset(d.spec.selector, labels)))
    problem(`${f}: ${nameOf(d)} selects no pod template in its namespace`);
}
for (const { f, d } of docs.filter(({ d }) => d.kind === "PodDisruptionBudget")) {
  if (!podsIn(ns(d)).some((labels) => subset(d.spec?.selector?.matchLabels, labels)))
    problem(`${f}: ${nameOf(d)} selects no pod template in its namespace`);
}
for (const { f, d } of docs.filter(({ d }) => d.kind === "HorizontalPodAutoscaler")) {
  const t = d.spec?.scaleTargetRef;
  if (
    !workloads.some(
      ({ d: w }) => w.kind === t?.kind && w.metadata?.name === t?.name && ns(w) === ns(d),
    )
  )
    problem(`${f}: ${nameOf(d)} targets ${t?.kind}/${t?.name}, which no manifest defines`);
}
// Every Secret a pod reads must exist: defined in a manifest, or created by
// the installer or the handbook's manual step.
const created = new Set(
  docs.filter(({ d }) => d.kind === "Secret").map(({ d }) => d.metadata.name),
);
for (const src of [
  "scripts/setup-k8s.sh",
  "src/routes/docs.self-hosting_.kubernetes.tsx",
  "docs/DEPLOYMENT.md",
]) {
  if (!existsSync(path.join(root, src))) continue;
  for (const m of rd(src).matchAll(/create secret generic ([a-z0-9-]+)/g)) created.add(m[1]);
}
const refs = new Set();
for (const { d } of workloads.concat(docs.filter(({ d }) => d.kind === "CronJob"))) {
  const spec =
    d.kind === "CronJob" ? d.spec?.jobTemplate?.spec?.template?.spec : d.spec?.template?.spec;
  for (const c of spec?.containers ?? []) {
    for (const e of c.env ?? [])
      if (e.valueFrom?.secretKeyRef?.name) refs.add(e.valueFrom.secretKeyRef.name);
    for (const e of c.envFrom ?? []) if (e.secretRef?.name) refs.add(e.secretRef.name);
  }
}
for (const r of refs)
  if (!created.has(r))
    problem(
      `Kubernetes: secret "${r}" is read by a pod but created by nothing (no manifest, installer or handbook step)`,
    );
note(
  `${manifests.length} Kubernetes manifests, ${docs.length} documents: selectors, images, requests, ${refs.size} secret references resolved`,
);

// ── 5. compose renders, with and without every profile (needs Docker) ───────
if (has("docker", ["compose", "version"])) {
  for (const args of [
    ["compose", "config", "-q"],
    ["compose", "--profile", "all", "config", "-q"],
  ]) {
    const r = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0)
      problem(`docker ${args.join(" ")}: ${(r.stderr || "").trim().split("\n")[0]}`);
  }
  note("docker compose config renders with and without --profile all");
} else skip("docker compose not available: compose not rendered");

// ── 6. the compose build args and the image the manifests run agree ─────────
const dockerfile = rd("Dockerfile");
const appArgs = [...dockerfile.matchAll(/^ARG (VITE_[A-Z0-9_]+)/gm)].map((m) => m[1]);
const composeArgs = Object.keys(compose.services?.agentswarms?.build?.args ?? {});
for (const a of appArgs)
  if (!composeArgs.includes(a))
    problem(`docker-compose.yml: build arg ${a} declared in the Dockerfile is not passed`);
note(`${appArgs.length} Dockerfile build args passed by compose`);

// ── report ──────────────────────────────────────────────────────────────────
if (!quiet) {
  for (const p of passed) console.log(`  ok   ${p}`);
  for (const s of skipped) console.log(`  skip ${s}`);
}
if (problems.length) {
  console.log(`\ninfra check: ${problems.length} problem(s)`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(
  `infra check: no problems found${skipped.length ? ` (${skipped.length} check(s) skipped for a missing tool)` : ""}.`,
);
