#!/usr/bin/env node
// The in-app "All settings" page (/docs/self-hosting/settings) is generated
// from .env.example, so the reference and the file people copy cannot drift:
// they are the same text.
//
// It also holds the completeness rule (R485). Every environment variable the
// app's runtime reads must have a NAME= line in .env.example, set or commented
// out, or be listed in INTERNAL below with the reason no operator sets it. The
// docs had promised "every variable" while 109 the runtime read were missing
// from .env.example, and checks that only proved what the docs said was true
// could not see what they left out.
//
//   node scripts/build-settings-reference.mjs           write the reference
//   node scripts/build-settings-reference.mjs --check   fail if it is stale,
//                                                       or a setting is missing
import fs from "node:fs";
import path from "node:path";

const OUT = "src/components/docs/settingsReference.ts";
const read = (p) => fs.readFileSync(p, "utf8");

// ── What the runtime reads ──────────────────────────────────────────────────

/**
 * Read by the app but set by something other than an operator. A name here
 * must still be read somewhere, so the list cannot outlive the code.
 */
const INTERNAL = {
  KUBERNETES_SERVICE_HOST: "set by Kubernetes in every pod",
  KUBERNETES_SERVICE_PORT: "set by Kubernetes in every pod",
  AGENTSWARMS_WORKERS: "written by server.mjs for its workers (the count is WEB_CONCURRENCY)",
  AGENTSWARMS_BOOT_TOKEN:
    "a random value server.mjs makes at each start for its own scheduler calls",
  ML_ARTIFACT_URI: "set by the app in the environment of the training job it starts",
  AS_ORC_SQL: "set by the app for the isolated ORC reader it starts",
  ANTHROPIC_API_KEY: "named in the code the app generates when an agent is exported",
  GEMINI_API_KEY: "named in the code the app generates when an agent is exported",
  OPENAI_API_KEY: "named in the code the app generates when an agent is exported",
  AGENTSWARMS_VIEWER_SECRET:
    "named in the code the app generates for an embed host's backend (signed viewer tokens)",
  AGENTSWARMS_ORIGIN:
    "set by the app in each sandbox's environment; ecs.server.ts reads it from the kernel spec",
};

/**
 * `env.NAME` (also process.env.NAME), env["NAME"], and the helpers that read
 * one by name: envInt("NAME", …) and its kin, and jsonEnv<T>("NAME"). Not
 * sandboxEnv, which writes Python that reads a job's own environment. A name
 * built at run time (env[`AWS_ENDPOINT_URL_${service}`]) cannot be seen here;
 * those are in .env.example by hand.
 */
const READS = [
  // Not import.meta.env (Vite's build-time values), not an assignment.
  /(?<!meta\.)\benv\.([A-Z][A-Z0-9_]*[A-Z0-9])\b(?!\s*=[^=])/g,
  /(?<!meta\.)\benv\[\s*["']([A-Z][A-Z0-9_]*[A-Z0-9])["']\s*\](?!\s*=[^=])/g,
  /\b(?:env[A-Z]\w*|jsonEnv)(?:<[^>(]*>)?\(\s*["']([A-Z][A-Z0-9_]*[A-Z0-9])["']/g,
];

function runtimeReads() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/node_modules|dist|\.git/.test(p)) walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/^docs\./.test(e.name) && !/\.test\./.test(e.name))
        files.push(p);
    }
  };
  walk("src");
  for (const f of fs.readdirSync(".")) if (/^server.*\.mjs$/.test(f)) files.push(f);
  const where = new Map();
  for (const f of files) {
    const src = read(f);
    for (const re of READS)
      for (const m of src.matchAll(re))
        if (!where.has(m[1])) where.set(m[1], f.replace(/\\/g, "/"));
  }
  return where;
}

// ── .env.example → sections ─────────────────────────────────────────────────

const SETTING = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/;

/** Lines that read as a setting and then go on as prose (see parseLine). */
const misread = [];

/**
 * The assignment as the file has it — commented out or not, since that is the
 * difference between a value that is set and an example — and the comment
 * after it on the same line.
 *
 * Any comment line that starts `# NAME=` is a setting to this parser, so a
 * sentence that happens to wrap there ("set\n# KMS_PROVIDER="vault" and
 * restart") would split its paragraph and lose the rest of the line. Text
 * after the value that is not a `#` comment is reported instead of dropped;
 * reword the sentence, or indent an example two spaces so it reads as code.
 */
function parseLine(commented, name, rest) {
  let value = "";
  let tail = rest;
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    value = end > 0 ? rest.slice(0, end + 1) : rest;
    tail = end > 0 ? rest.slice(end + 1) : "";
  } else {
    const m = rest.match(/^(\S*)(.*)$/);
    value = m[1];
    tail = m[2];
  }
  if (tail.trim() && !tail.trim().startsWith("#"))
    misread.push(`.env.example: "${name}=${rest.trim()}" reads as a setting followed by prose`);
  const note = tail.match(/^\s*#\s*(.*)$/)?.[1]?.replace(/^[—-]+\s*/, "") ?? "";
  return { name, line: `${commented ? "# " : ""}${name}=${value}`, note: note.trim() };
}

/** Comment lines → paragraphs and code blocks. Indented runs are code. */
function toBlocks(lines) {
  const blocks = [];
  let para = [];
  let code = [];
  const flush = () => {
    if (para.length)
      blocks.push({ kind: "text", text: para.join(" ").replace(/\s+/g, " ").trim() });
    if (code.length) blocks.push({ kind: "code", text: code.join("\n") });
    para = [];
    code = [];
  };
  for (const raw of lines) {
    if (raw.trim() === "") {
      flush();
      continue;
    }
    if (/^ {2,}\S/.test(raw)) {
      if (para.length) {
        blocks.push({ kind: "text", text: para.join(" ").replace(/\s+/g, " ").trim() });
        para = [];
      }
      code.push(raw.replace(/^ {2}/, ""));
    } else {
      if (code.length) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = [];
      }
      para.push(raw.trim());
    }
  }
  flush();
  return blocks;
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function parse(text) {
  const tiers = [];
  let tier = null;
  let section = null;
  let comment = [];
  let entry = null;
  const closeEntry = () => {
    if (entry) section.entries.push(entry);
    entry = null;
  };
  const closeNote = () => {
    // A comment block followed by no setting: the section's own prose.
    if (section && comment.some((l) => l.trim()))
      section.entries.push({ settings: [], body: toBlocks(comment) });
    comment = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.match(/^#\s+\d\.\s+([A-Z][A-Z ]+?)\s*$/);
    if (t) {
      closeEntry();
      comment = [];
      section = null;
      const title = t[1][0] + t[1].slice(1).toLowerCase();
      tier = { title, id: slug(title), sections: [] };
      tiers.push(tier);
      continue;
    }
    if (!tier) continue; // the file's own preamble
    if (/^# =+\s*$/.test(line)) continue;
    const s = line.match(/^# ── (.+?)\s*─+\s*$/);
    if (s) {
      closeEntry();
      closeNote();
      section = { title: s[1], id: slug(s[1]), entries: [] };
      tier.sections.push(section);
      continue;
    }
    if (!section) continue;
    const v = line.match(SETTING);
    if (v) {
      if (!entry) {
        entry = { settings: [], body: toBlocks(comment) };
        comment = [];
      }
      entry.settings.push(parseLine(Boolean(v[1]), v[2], v[3]));
      continue;
    }
    const c = line.match(/^#(.*)$/);
    if (c) {
      closeEntry();
      comment.push(c[1].replace(/^ /, ""));
      continue;
    }
    // A blank line ends an entry; a comment block before it stands alone.
    closeEntry();
    closeNote();
  }
  closeEntry();
  closeNote();
  // Section ids must be unique on the page.
  const seen = new Map();
  for (const tr of tiers)
    for (const sec of tr.sections) {
      const n = (seen.get(sec.id) ?? 0) + 1;
      seen.set(sec.id, n);
      if (n > 1) sec.id = `${sec.id}-${n}`;
    }
  return tiers;
}

// ── Output ──────────────────────────────────────────────────────────────────

function render(tiers) {
  return `// GENERATED by scripts/build-settings-reference.mjs from .env.example.
// Do not edit: change .env.example and run \`npm run docs:settings\`.

export type SettingsBlock = { kind: "text" | "code"; text: string };
export interface Setting {
  name: string;
  /** The line as .env.example has it: "# NAME=…" when commented out. */
  line: string;
  /** The comment after it on the same line, if any. */
  note: string;
}
export interface SettingsEntry {
  settings: Setting[];
  body: SettingsBlock[];
}
export interface SettingsSection {
  title: string;
  id: string;
  entries: SettingsEntry[];
}
export interface SettingsTier {
  title: string;
  id: string;
  sections: SettingsSection[];
}

export const SETTINGS_REFERENCE: SettingsTier[] = ${JSON.stringify(tiers, null, 2)};
`;
}

const tiers = parse(read(".env.example"));
const out = render(tiers);
const problems = [...misread];

const documented = new Set(
  tiers.flatMap((t) =>
    t.sections.flatMap((s) => s.entries.flatMap((e) => e.settings.map((x) => x.name))),
  ),
);
const reads = runtimeReads();
for (const [name, file] of [...reads].sort()) {
  if (!documented.has(name) && !INTERNAL[name])
    problems.push(
      `undocumented setting: ${name} (read in ${file}) has no ${name}= line in .env.example`,
    );
}
for (const name of Object.keys(INTERNAL))
  if (!reads.has(name)) problems.push(`INTERNAL lists ${name}, which nothing reads any more`);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? read(OUT) : "";
  if (current.replace(/\r\n/g, "\n") !== out)
    problems.push(`${OUT} is stale: run npm run docs:settings`);
  for (const p of problems) console.error(p);
  if (problems.length) process.exit(1);
  console.log(
    `settings reference: ${documented.size} settings, all ${reads.size} the runtime reads accounted for.`,
  );
} else {
  fs.writeFileSync(OUT, out);
  console.log(
    `wrote ${OUT}: ${documented.size} settings in ${tiers.reduce((n, t) => n + t.sections.length, 0)} sections.`,
  );
  for (const p of problems) console.error(p);
  if (problems.length) process.exitCode = 1;
}
