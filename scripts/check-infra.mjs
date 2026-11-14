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
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
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

// ── 3. every service starts, and the installers do not gate any of them ─────
// Compose profiles are gone: one command installs the product. What can break
// that is a `profiles:` line creeping back in, or an installer learning a flag
// that skips something.
const compose = yaml.load(rd("docker-compose.yml"));
const profiled = Object.entries(compose.services ?? {})
  .filter(([, s]) => Array.isArray(s.profiles) && s.profiles.length > 0)
  .map(([n]) => n);
for (const n of profiled)
  problem(
    `docker-compose.yml: ${n} is behind a profile, so a plain \`docker compose up -d\` skips it`,
  );
const setupSh = rd("scripts/setup.sh");
const setupPs = rd("scripts/setup.ps1");
if (!setupSh.includes("docker compose up -d --build"))
  problem("scripts/setup.sh no longer starts the stack with a plain compose command");
if (!setupPs.includes("docker compose up -d --build"))
  problem("scripts/setup.ps1 no longer starts the stack with a plain compose command");
// The flags in people's notes must still work, and still change nothing.
for (const flag of [
  "all",
  "docgen",
  "notebooks",
  "sandbox",
  "lakehouse",
  "spark",
  "vectors",
  "featurestore",
]) {
  if (!new RegExp(`--${flag}\\b`).test(setupSh))
    problem(`scripts/setup.sh rejects --${flag}, which older docs and habits still use`);
  const sw = flag[0].toUpperCase() + flag.slice(1);
  if (!setupPs.includes(`[switch]$${sw}`))
    problem(`scripts/setup.ps1 rejects -${sw}, which older docs and habits still use`);
}
// Every service a host-run app must reach publishes a loopback port, or --dev
// silently runs without it.
for (const name of ["qdrant", "valkey", "lakehouse-catalog", "spark-connect", "minio"]) {
  const ports = compose.services?.[name]?.ports ?? [];
  if (ports.length === 0)
    problem(`docker-compose.yml: ${name} publishes no port, so \`setup.sh --dev\` cannot reach it`);
  for (const p of ports)
    if (!String(p).startsWith("127.0.0.1:"))
      problem(`docker-compose.yml: ${name} publishes ${p} beyond loopback`);
}
note(
  `${Object.keys(compose.services ?? {}).length} compose services, none profiled; both installers start them all`,
);

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

// ── 4b. the app's Kubernetes identity: the RBAC names who really calls ──────
// The app calls the API for sandboxes (NOTEBOOK_RUNTIME_BACKEND=k8s) and
// per-run Spark clusters (SPARK_PROVIDER=k8s), and setup-k8s.sh turns both on.
// Until R488 the manifests disagreed about who that was: the app ran as
// `default` with no token mounted, the sandbox RoleBinding named an
// `agentswarms` account nothing ran as, the Spark one named an account in
// another namespace, and NOTEBOOK_K8S_NAMESPACE was unset, so the app would
// have made sandboxes in its own namespace, where it had no rights at all.
{
  const podSpecOf = (d) =>
    d.kind === "CronJob"
      ? d.spec?.jobTemplate?.spec?.template?.spec
      : ["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(d.kind)
        ? d.spec?.template?.spec
        : undefined;
  const pods = docs.map(({ f, d }) => ({ f, d, pod: podSpecOf(d) })).filter((p) => p.pod);
  const saOf = (pod) => pod.serviceAccountName ?? pod.serviceAccount ?? "default";
  // Accounts some pod can run as: a manifest's workload, or a pod the app
  // makes itself (the per-run Spark driver; its defaults are in the code).
  const runnable = new Set(pods.map(({ d, pod }) => `${ns(d)}/${saOf(pod)}`));
  const spark = rd("src/utils/etl/sparkCluster.server.ts");
  const sparkNs = /SPARK_K8S_NAMESPACE\?\.trim\(\) \|\| "([a-z0-9-]+)"/.exec(spark)?.[1];
  const sparkSa = /SPARK_K8S_SERVICE_ACCOUNT\?\.trim\(\) \|\| "([a-z0-9-]+)"/.exec(spark)?.[1];
  if (sparkNs && sparkSa) runnable.add(`${sparkNs}/${sparkSa}`);
  else problem("check-infra: could not read the Spark driver's default namespace and account");

  const bindings = docs.filter(({ d }) => ["RoleBinding", "ClusterRoleBinding"].includes(d.kind));
  for (const { f, d } of bindings) {
    for (const s of d.subjects ?? []) {
      if (s.kind !== "ServiceAccount") continue;
      const who = `${s.namespace ?? ns(d)}/${s.name}`;
      if (!runnable.has(who))
        problem(
          `${f}: ${nameOf(d)} grants ServiceAccount ${who}, which no pod runs as — the rights go to nobody`,
        );
    }
  }
  // May `who` do `verb` on `resource` in namespace `where`?
  const grants = (who, where, resource, verb) =>
    bindings.some(
      ({ d: b }) =>
        ns(b) === where &&
        (b.subjects ?? []).some(
          (s) => s.kind === "ServiceAccount" && `${s.namespace ?? ns(b)}/${s.name}` === who,
        ) &&
        docs.some(
          ({ d: r }) =>
            r.kind === b.roleRef?.kind &&
            r.metadata?.name === b.roleRef?.name &&
            (r.kind === "ClusterRole" || ns(r) === where) &&
            (r.rules ?? []).some(
              (rule) =>
                (rule.resources ?? []).includes(resource) && (rule.verbs ?? []).includes(verb),
            ),
        ),
    );

  const SA_CA = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  const app = pods.filter(({ pod }) =>
    (pod.containers ?? []).some((c) => /\/agentswarms:[^/]*$/.test(String(c.image ?? ""))),
  );
  if (!app.length)
    problem("deploy/k8s: no workload runs the app image, so its identity is unchecked");
  for (const { f, d, pod } of app) {
    const who = `${ns(d)}/${saOf(pod)}`;
    const env = Object.fromEntries(
      (pod.containers ?? []).flatMap((c) => (c.env ?? []).map((e) => [e.name, e.value])),
    );
    if (pod.automountServiceAccountToken === false)
      problem(
        `${f}: ${nameOf(d)} mounts no API token, so the k8s sandbox and Spark backends cannot call the API`,
      );
    if (env.NODE_EXTRA_CA_CERTS !== SA_CA)
      problem(`${f}: ${nameOf(d)} does not trust the cluster CA (NODE_EXTRA_CA_CERTS=${SA_CA})`);
    const sandboxNs = env.NOTEBOOK_K8S_NAMESPACE;
    if (!sandboxNs)
      problem(
        `${f}: ${nameOf(d)} sets no NOTEBOOK_K8S_NAMESPACE, so sandboxes go in its own namespace (${ns(d)})`,
      );
    else if (!grants(who, sandboxNs, "pods", "create"))
      problem(
        `${f}: ${nameOf(d)} runs as ${who}, which may not create pods in ${sandboxNs}, its NOTEBOOK_K8S_NAMESPACE`,
      );
    const sparkWhere = env.SPARK_K8S_NAMESPACE ?? sparkNs;
    if (docs.some(({ d: n }) => n.kind === "Namespace" && n.metadata?.name === sparkWhere))
      for (const resource of ["pods", "services"])
        if (!grants(who, sparkWhere, resource, "create"))
          problem(
            `${f}: ${nameOf(d)} runs as ${who}, which may not create ${resource} in ${sparkWhere}, where it makes Spark drivers`,
          );
  }
  note(
    `${bindings.length} RoleBindings name accounts pods run as; ${app.length} app workloads hold a token and the rights their sandbox and Spark namespaces need`,
  );
}

// ── 5. characters a strict YAML reader refuses ──────────────────────────────
// Windows' compose parsed a file carrying U+0080 U+0094 — an em-dash that went
// through a bad decode in an editing script — and Linux's rejected it with
// "yaml: control characters are not allowed". The difference reached CI, which
// is the one place it was ever going to be noticed. Bytes are the same
// everywhere, so check the bytes: C1 controls (U+0080–U+009F) and DEL in any
// tracked text file, plus a lone CR in a YAML or shell file.
{
  const TEXT =
    /\.(ya?ml|md|json|mjs|ts|tsx|sh|ps1|example|toml|conf)$|^(Dockerfile|\.env\.example)$/;
  let scanned = 0;
  for (const t of tracked) {
    const name = t.file.split("/").pop() ?? t.file;
    if (!TEXT.test(t.file) && !TEXT.test(name)) continue;
    let text;
    try {
      text = rd(t.file);
    } catch {
      continue; // not utf-8, or gone
    }
    scanned++;
    const bad = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.codePointAt(i);
      if (c !== undefined && c >= 0x7f && c <= 0x9f) {
        const line = text.slice(0, i).split("\n").length;
        bad.push(`U+${c.toString(16).toUpperCase().padStart(4, "0")} on line ${line}`);
        if (bad.length >= 3) break;
      }
    }
    if (bad.length)
      problem(`${t.file}: control character(s) a strict YAML/parser rejects — ${bad.join(", ")}`);
  }
  note(`${scanned} tracked text files carry no control characters`);
}

// ── 6. compose renders, with and without every profile (needs Docker) ───────
//
// The compose file declares `env_file: .env`, and `.env` is gitignored — so on
// a fresh checkout compose refuses to render at all: "env file … not found".
// That is CI, and every run there failed on it while every local run passed,
// because a developer's tree has the file. The fix is to render the way a
// fresh install does, `.env.example` copied to `.env`, which is also the first
// line of both installers.
if (has("docker", ["compose", "version"])) {
  const envPath = path.join(root, ".env");
  // Never touch a real one. A developer's .env holds their keys, and this
  // check is not worth the smallest chance of overwriting it.
  const borrowed = !existsSync(envPath) && existsSync(path.join(root, ".env.example"));
  if (borrowed) copyFileSync(path.join(root, ".env.example"), envPath);
  try {
    let rendered = true;
    for (const args of [
      ["compose", "config", "-q"],
      ["compose", "--profile", "all", "config", "-q"],
    ]) {
      const r = spawnSync("docker", args, { cwd: root, encoding: "utf8" });
      if (r.status !== 0) {
        // The LAST line, not the first. Compose prints one warning per unset
        // variable before it prints the reason it failed, so reporting the
        // first line reported "SUPABASE_SERVICE_ROLE_KEY is not set" for a
        // missing file — a true sentence about the wrong problem, which is
        // worse than no message.
        const lines = (r.stderr || "").trim().split("\n").filter(Boolean);
        const real = lines.filter((l) => !/level=warning/.test(l));
        problem(`docker ${args.join(" ")}: ${(real.length ? real : lines).at(-1) ?? "no output"}`);
        rendered = false;
      }
    }
    // Only claim it when it did: the first version printed the ok line beside
    // its own failure, which reads as two contradictory facts.
    if (rendered)
      note(
        `docker compose config renders with and without --profile all${borrowed ? " (.env from .env.example)" : ""}`,
      );
  } finally {
    if (borrowed) rmSync(envPath, { force: true });
  }
} else skip("docker compose not available: compose not rendered");

// ── 7. the app image carries no install's settings ──────────────────────────
// One image for every environment (R469): the browser's settings reach the
// page from the server's environment at runtime (R464). A VITE_* build arg
// would bake one install's values into an image a release publishes for all.
const dockerfile = rd("Dockerfile");
const appArgs = [...dockerfile.matchAll(/^ARG (VITE_[A-Z0-9_]+)/gm)].map((m) => m[1]);
const composeArgs = Object.keys(compose.services?.agentswarms?.build?.args ?? {}).filter((a) =>
  a.startsWith("VITE_"),
);
for (const a of appArgs) problem(`Dockerfile: ARG ${a} bakes a browser setting into the image`);
for (const a of composeArgs)
  problem(`docker-compose.yml: build arg ${a} bakes a browser setting into the image`);
if (!appArgs.length && !composeArgs.length) note("the app image is built with no VITE_* setting");

// ── 8. the AWS deploys: formatted Terraform, Lambdas that parse ─────────────
// `terraform validate` needs the providers (hundreds of MB), so it is the
// release workflow's and an operator's to run; formatting needs nothing (R480).
if (has("terraform", ["version"])) {
  const r = spawnSync("terraform", ["fmt", "-check", "-recursive", "deploy/aws/terraform"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status === 0) note("deploy/aws/terraform is terraform-fmt clean");
  else
    problem(
      `terraform fmt would change: ${(r.stdout || r.stderr).trim().split(/\r?\n/).join(", ")}`,
    );
} else skip("terraform not available: deploy/aws/terraform not format-checked");
const python = ["python3", "python"].find((p) => has(p, ["-c", "import ast"]));
if (python) {
  const lambdas = tracked.map((t) => t.file).filter((f) => /^deploy\/aws\/lambda\/.+\.py$/.test(f));
  for (const f of lambdas) {
    const r = spawnSync(
      python,
      ["-I", "-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", f],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    if (r.status !== 0) problem(`${f}: does not parse: ${r.stderr.trim().split(/\r?\n/).pop()}`);
  }
  if (lambdas.length) note(`${lambdas.length} AWS Lambda(s) parse`);
} else skip("python not available: the AWS Lambdas not parsed");

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
