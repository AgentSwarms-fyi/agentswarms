// A saved LLM gateway or n8n connection can be removed (R357).
//
// FOUND FROM THE UI (R347, R357). Integrations → LLM Gateway offered "Save
// (disabled)" and nothing else, and the n8n tab "Validate & Save": once saved,
// either could be changed or switched off but never taken away, so a gateway
// saved to try the page stayed in the account for good. Pinned by source, as
// the page's other writes are: both live in the route file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/routes/_authenticated/integrations.tsx", "utf8");
const between = (from: string, to: string) => {
  const a = SRC.indexOf(from);
  expect(a, from).toBeGreaterThan(0);
  const b = SRC.indexOf(to, a);
  expect(b, to).toBeGreaterThan(a);
  return SRC.slice(a, b);
};

describe("removing a saved gateway or n8n connection", () => {
  const clear = () => between("async function clearIntegration(", "async function removeGateway()");

  it("asks first, then clears the row as a provider disconnect does", () => {
    const fn = clear();
    expect(fn.indexOf("if (!(await confirmAsk(ask))) return false;")).toBeGreaterThan(0);
    expect(fn.indexOf("confirmAsk(ask)")).toBeLessThan(fn.indexOf(".update("));
    expect(fn).toContain(".update({ is_active: false, config: {} })");
    expect(fn).toContain('.eq("id", existing.id);');
  });

  it("says so when the write fails, and does not clear the form", () => {
    expect(clear()).toMatch(
      /if \(error\) \{\s*toast\.error\(`Could not remove it: \$\{error\.message\}\. It is still saved\.`\);\s*return false;/,
    );
  });

  it("the gateway's removal resets every field, routing included", () => {
    const fn = between("async function removeGateway()", "async function removeN8n()");
    for (const reset of [
      'setGatewayUrl("");',
      'setGatewayKey("");',
      "setGatewayHasKey(false);",
      "setGatewayRoute(false);",
      "setGatewayRouteAll(false);",
    ]) {
      expect(fn, reset).toContain(reset);
    }
    expect(fn.indexOf("if (!removed) return;")).toBeLessThan(fn.indexOf('setGatewayUrl("");'));
  });

  it("each tab offers removal only when something is saved", () => {
    expect(SRC).toMatch(
      /\{textOf\(integrations\.find\(\(i\) => i\.type === "llm_gateway"\)\?\.config\.base_url\) && \(\s*<Button[\s\S]*?onClick=\{\(\) => void removeGateway\(\)\}[\s\S]*?Remove gateway/,
    );
    expect(SRC).toMatch(
      /\{textOf\(integrations\.find\(\(i\) => i\.type === "n8n"\)\?\.config\.instance_url\) && \(\s*<Button[\s\S]*?onClick=\{\(\) => void removeN8n\(\)\}[\s\S]*?Remove connection/,
    );
  });
});
