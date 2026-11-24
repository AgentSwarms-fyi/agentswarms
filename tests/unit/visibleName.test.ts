// The rules for an agent's, a swarm's and a knowledge base's name.
//
// Agents and swarms saved a name made only of spaces, on create and on update,
// and it then showed as a blank row in every list, picker and trash toast.
// `required` on the input and NOT NULL on the column both stop only an EMPTY
// name. Nor did anything bound a name's length: hundreds of characters were
// saved and ran the Agent Chat picker off the screen. These tests pin the
// rules, every place that writes such a name, and the database constraints
// that hold them for clients that skip the forms.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NAME_MAX_LENGTH,
  clampName,
  hasVisibleName,
  nameLength,
  nameProblem,
} from "@/lib/visibleName";
import { importSwarm } from "@/lib/swarmPortable";
import { parseImportedAgent } from "@/lib/agentExport";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

describe("hasVisibleName", () => {
  it("refuses empty and whitespace-only names", () => {
    for (const blank of ["", " ", "     ", "\t", "\n", " \t\r\n ", "  "]) {
      expect(hasVisibleName(blank), JSON.stringify(blank)).toBe(false);
    }
  });

  it("accepts any name with something visible, spaces around it included", () => {
    for (const name of ["a", "Test Agent 1", "  padded  ", "नमस्ते", "🙂"]) {
      expect(hasVisibleName(name), JSON.stringify(name)).toBe(true);
    }
  });

  it("refuses what is not a string", () => {
    for (const v of [undefined, null, 0, 42, {}, []]) {
      expect(hasVisibleName(v)).toBe(false);
    }
  });
});

describe("the length limit", () => {
  it("is the 120 the database already holds for dashboards, reports and workflows", () => {
    expect(NAME_MAX_LENGTH).toBe(120);
    for (const migration of [
      "20260720500000_bi_dashboards.sql",
      "20260892000000_bi_reports.sql",
      "20260893000000_workflows.sql",
    ]) {
      expect(read(`supabase/migrations/${migration}`)).toMatch(/length\(name\) BETWEEN 1 AND 120/);
    }
  });

  it("counts characters as Postgres's char_length does: an emoji is one", () => {
    expect(nameLength("abc")).toBe(3);
    expect(nameLength("🙂🙂")).toBe(2);
    expect("🙂🙂".length).toBe(4); // what .length would have said
  });

  it("clampName cuts to the limit and never through an emoji", () => {
    expect(clampName("x".repeat(500))).toBe("x".repeat(NAME_MAX_LENGTH));
    const emojis = "🙂".repeat(130);
    const cut = clampName(emojis);
    expect(nameLength(cut)).toBe(NAME_MAX_LENGTH);
    expect(cut).toBe("🙂".repeat(NAME_MAX_LENGTH)); // no half emoji at the end
    expect(clampName("Support Copilot")).toBe("Support Copilot");
  });

  it("nameProblem: blank, too long, or fine", () => {
    expect(nameProblem("   ", "agent")).toBe("Give the agent a name");
    expect(nameProblem("x".repeat(NAME_MAX_LENGTH), "swarm")).toBeNull();
    expect(nameProblem("x".repeat(NAME_MAX_LENGTH + 1), "swarm")).toBe(
      "Keep the swarm's name to 120 characters (it has 121)",
    );
    expect(nameProblem("🙂".repeat(NAME_MAX_LENGTH), "knowledge base")).toBeNull();
    expect(nameProblem("Product docs", "knowledge base")).toBeNull();
  });
});

describe("importing", () => {
  const swarmFile = (name: unknown) => ({ kind: "agent-swarm", name, nodes: [], edges: [] });

  it("a swarm file with a blank name is named 'Imported Swarm'", () => {
    expect(importSwarm(swarmFile("   ")).name).toBe("Imported Swarm");
    expect(importSwarm(swarmFile("\t\n")).name).toBe("Imported Swarm");
  });

  it("a swarm file's real name is kept, cut to the limit", () => {
    expect(importSwarm(swarmFile("Support Copilot")).name).toBe("Support Copilot");
    expect(nameLength(importSwarm(swarmFile("s".repeat(500))).name)).toBe(NAME_MAX_LENGTH);
  });

  it("an agent file's name is cut to the same limit (it used to be 200)", () => {
    const json = parseImportedAgent(JSON.stringify({ name: "a".repeat(300) }), "agent.json");
    expect(nameLength(json.name)).toBe(NAME_MAX_LENGTH);
    const yaml = parseImportedAgent(
      `agents:\n  researcher:\n    role: "${"r".repeat(300)}"\n`,
      "agents.yaml",
    );
    expect(nameLength(yaml.name)).toBe(NAME_MAX_LENGTH);
    expect(parseImportedAgent(JSON.stringify({ name: "Bob" }), "a.json").name).toBe("Bob");
  });
});

/** The body of the function that starts at `signature`, up to `end`. */
function bodyOf(src: string, signature: string, end: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const stop = src.indexOf(end, start);
  expect(stop, `${end} not found after ${signature}`).toBeGreaterThan(start);
  return src.slice(start, stop);
}

describe("every place that writes one of these names checks it first", () => {
  it("the agent form checks the name before it creates or updates", () => {
    const src = read("src/components/agents/AgentForm.tsx");
    const body = bodyOf(
      src,
      "async function handleSubmit(",
      'toast.success(agent ? "Agent updated" : "Agent created")',
    );
    const check = body.indexOf('nameProblem(name, "agent")');
    expect(check).toBeGreaterThan(-1);
    // Before the one handler's update AND its insert.
    expect(body.indexOf('.from("agents").update(')).toBeGreaterThan(check);
    expect(body.indexOf(".insert(payload)")).toBeGreaterThan(check);
    expect(src).toMatch(/value=\{name\}[\s\S]{0,120}maxLength=\{NAME_MAX_LENGTH\}/);
  });

  it("the swarm canvas checks the name before it creates or updates", () => {
    const src = read("src/routes/_authenticated/swarms.tsx");
    const body = bodyOf(src, "const handleSave = async (", "toast.success");
    const check = body.indexOf('nameProblem(swarmName, "swarm")');
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf("setSaving(true)")).toBeGreaterThan(check);
    expect(body.indexOf(".insert(")).toBeGreaterThan(check);
    expect(src).toMatch(/value=\{swarmName\}[\s\S]{0,120}maxLength=\{NAME_MAX_LENGTH\}/);
  });

  it("creating a knowledge base checks the name before it inserts", () => {
    const src = read("src/routes/_authenticated/knowledge.tsx");
    const body = bodyOf(
      src,
      "async function createBase(",
      'toast.success("Knowledge base created")',
    );
    const check = body.indexOf('nameProblem(newBaseName, "knowledge base")');
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf('.from("knowledge_bases").insert(')).toBeGreaterThan(check);
    expect(src).toMatch(/value=\{newBaseName\}[\s\S]{0,120}maxLength=\{NAME_MAX_LENGTH\}/);
  });

  it("restoring an agent version never writes a blank or over-long name back", () => {
    const src = read("src/components/agents/AgentVersionsDialog.tsx");
    expect(src).toContain(
      "name: hasVisibleName(v.config.name) ? clampName(v.config.name) : current.name",
    );
    expect(src).not.toMatch(/name:\s*v\.config\.name,/);
  });
});

describe("the database holds the same rules", () => {
  const blank = read("supabase/migrations/20261129000000_agent_swarm_names_not_blank.sql");
  const length = read("supabase/migrations/20261130000000_names_max_length.sql");

  for (const table of ["agents", "swarms"]) {
    it(`${table}: blank names repaired, then a validated not-blank constraint`, () => {
      const repair = blank.indexOf(`UPDATE public.${table} SET name = `);
      const add = blank.indexOf(
        `ALTER TABLE public.${table} ADD CONSTRAINT ${table}_name_not_blank CHECK (name ~ '\\S');`,
      );
      expect(repair).toBeGreaterThan(-1);
      expect(add).toBeGreaterThan(repair);
      expect(blank).toContain(
        `ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${table}_name_not_blank;`,
      );
    });
  }

  for (const table of ["agents", "swarms", "knowledge_bases"]) {
    it(`${table}: long names cut first, then a validated 120-character constraint`, () => {
      const repair = length.indexOf(`UPDATE public.${table}\nSET name = CASE`);
      const add = length.indexOf(
        `ADD CONSTRAINT ${table}_name_max_length CHECK (char_length(name) <= 120);`,
      );
      expect(repair).toBeGreaterThan(-1);
      expect(add).toBeGreaterThan(repair);
      expect(length).toContain(
        `ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${table}_name_max_length;`,
      );
    });
  }

  it("knowledge bases get the not-blank rule agents and swarms have", () => {
    expect(length).toContain("ADD CONSTRAINT knowledge_bases_name_not_blank CHECK (name ~ '\\S');");
  });

  it("the migration's 120 is the code's NAME_MAX_LENGTH", () => {
    expect(length.match(/<= (\d+)\);/g)?.every((m) => m === `<= ${NAME_MAX_LENGTH});`)).toBe(true);
  });

  it("neither migration is NOT VALID: old rows are repaired, so later updates still pass", () => {
    expect(blank).not.toMatch(/NOT VALID\s*;/);
    expect(length).not.toMatch(/NOT VALID\s*;/);
  });
});
