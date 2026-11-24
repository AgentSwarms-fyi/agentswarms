// Agents and swarms saved a name made only of spaces, on create and on update,
// and it then showed as a blank row in every list, picker and trash toast.
// `required` on the input and NOT NULL on the column both stop only an EMPTY
// name. These tests pin the rule, every place that writes such a name, and the
// database constraint that holds it for clients that skip the forms.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { hasVisibleName } from "@/lib/visibleName";
import { importSwarm } from "@/lib/swarmPortable";

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

describe("importing a swarm file", () => {
  const file = (name: unknown) => ({
    kind: "agent-swarm",
    name,
    nodes: [],
    edges: [],
  });

  it("names a swarm whose file name is only whitespace 'Imported Swarm'", () => {
    expect(importSwarm(file("   ")).name).toBe("Imported Swarm");
    expect(importSwarm(file("\t\n")).name).toBe("Imported Swarm");
  });

  it("keeps a real name as the file gives it", () => {
    expect(importSwarm(file("Support Copilot")).name).toBe("Support Copilot");
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

describe("every place that writes an agent's or a swarm's name checks it first", () => {
  it("the agent form refuses a blank name before it creates or updates", () => {
    const body = bodyOf(
      read("src/components/agents/AgentForm.tsx"),
      "async function handleSubmit(",
      'toast.success(agent ? "Agent updated" : "Agent created")',
    );
    const check = body.indexOf("if (!hasVisibleName(name))");
    expect(check).toBeGreaterThan(-1);
    // Before the one handler's update AND its insert.
    expect(body.indexOf('.from("agents").update(')).toBeGreaterThan(check);
    expect(body.indexOf(".insert(payload)")).toBeGreaterThan(check);
  });

  it("the swarm canvas refuses a blank name before it creates or updates", () => {
    const body = bodyOf(
      read("src/routes/_authenticated/swarms.tsx"),
      "const handleSave = async (",
      "toast.success",
    );
    const check = body.indexOf("if (!hasVisibleName(swarmName))");
    expect(check).toBeGreaterThan(-1);
    expect(body.indexOf("setSaving(true)")).toBeGreaterThan(check);
    expect(body.indexOf(".insert(")).toBeGreaterThan(check);
  });

  it("restoring an agent version never writes a blank name back", () => {
    const src = read("src/components/agents/AgentVersionsDialog.tsx");
    expect(src).toContain("name: hasVisibleName(v.config.name) ? v.config.name : current.name");
    expect(src).not.toMatch(/name:\s*v\.config\.name,/);
  });
});

describe("the database holds the same rule", () => {
  const sql = read("supabase/migrations/20261129000000_agent_swarm_names_not_blank.sql");

  for (const table of ["agents", "swarms"]) {
    it(`${table}: repairs blank names, then adds a validated constraint`, () => {
      const repair = sql.indexOf(`UPDATE public.${table} SET name = `);
      const add = sql.indexOf(
        `ALTER TABLE public.${table} ADD CONSTRAINT ${table}_name_not_blank CHECK (name ~ '\\S');`,
      );
      expect(repair).toBeGreaterThan(-1);
      expect(add).toBeGreaterThan(repair);
      // Re-runnable, like the other constraint migrations.
      expect(sql).toContain(
        `ALTER TABLE public.${table} DROP CONSTRAINT IF EXISTS ${table}_name_not_blank;`,
      );
    });
  }

  it("is not NOT VALID: old rows are repaired, so every later update still passes", () => {
    expect(sql).not.toMatch(/NOT VALID\s*;/);
  });
});
