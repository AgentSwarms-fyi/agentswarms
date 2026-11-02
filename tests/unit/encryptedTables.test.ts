// R438: ENCRYPTED_TABLES is the sweep's and the card's whole world. It said
// "derived by grepping all call sites", but Slack workspaces, Teams bots and
// signed embed viewers had been added since without it: their secrets stayed
// on a retired key after a rotation sweep, and the card did not count them.
// These hold the list to the code that writes ciphertext.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ENCRYPTED_TABLES } from "@/utils/providers/keyRotation.server";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

// What produces a stored blob: the crypto module's encrypt, and the three
// helpers around it.
const WRITERS =
  /\b(encryptJson|encryptViewerSecret|encryptMcpAuthToken|encryptIntegrationConfig)\(/;
// Where those are defined, or only re-encrypt what the sweep already lists.
const DEFINITIONS = new Set([
  "src/utils/providers/crypto.server.ts",
  "src/utils/providers/keyRotation.server.ts",
  "src/utils/embedViewer.server.ts",
  "src/lib/mcp/auth.server.ts",
  "src/utils/providers/integrationConfig.server.ts",
]);

describe("the encrypted tables", () => {
  it("include every table a ciphertext writer writes to", () => {
    const listed = new Set<string>(ENCRYPTED_TABLES);
    const misses: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(ROOT, f).replace(/\\/g, "/");
      if (DEFINITIONS.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      if (!WRITERS.test(src)) continue;
      // The tables the file writes: .from("x") followed by an insert,
      // update or upsert before the next .from(.
      const written = [...src.matchAll(/\.from\("([a-z_]+)"\)([\s\S]*?)(?=\.from\(|$)/g)]
        .filter(([, , rest]) => /\.(insert|update|upsert)\(/.test(rest.slice(0, 400)))
        .map(([, t]) => t);
      if (!written.some((t) => listed.has(t))) misses.push(`${rel}: ${written.join(", ") || "?"}`);
    }
    expect(misses).toEqual([]);
  });

  it("include every table with an encrypted column", () => {
    const types = readFileSync(join(SRC, "integrations", "supabase", "types.ts"), "utf8");
    const withEnc = new Set<string>();
    let table = "";
    let inRow = false;
    for (const line of types.split("\n")) {
      const t = /^ {6}([a-z_]+): \{$/.exec(line);
      if (t) table = t[1];
      if (/^ {8}Row: \{$/.test(line)) inRow = true;
      else if (/^ {8}\};$/.test(line)) inRow = false;
      else if (inRow && /^ {10}[a-z_]+_enc\??: /.test(line)) withEnc.add(table);
    }
    expect(withEnc.size).toBeGreaterThan(0);
    for (const t of withEnc) expect(ENCRYPTED_TABLES as readonly string[]).toContain(t);
  });

  // kb_sources.user_id is nullable in the schema; a row without an owner is
  // written and swept under the deployment's key, as every row was before R438.
  it("are owned rows: every one has a user_id the sweep can put a value's key by", () => {
    const types = readFileSync(join(SRC, "integrations", "supabase", "types.ts"), "utf8");
    for (const t of ENCRYPTED_TABLES) {
      const start = types.indexOf(`      ${t}: {\n        Row: {`);
      expect(start, t).toBeGreaterThan(0);
      const row = types.slice(start, types.indexOf("        };", start));
      expect(row, t).toMatch(/\n {10}user_id: string( \| null)?;/);
    }
  });
});
