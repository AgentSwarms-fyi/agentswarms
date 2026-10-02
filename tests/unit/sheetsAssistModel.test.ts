// The Sheets assistant's model (R158). It was the admin's alone
// (SHEETS_ASSIST_MODEL): Ask AI had no picker, and an answer did not say
// which model gave it. Now the panel has the platform's picker (the person's
// connected providers, filtered by their IAM model rules), with the admin's
// model as the named default; the pick is remembered in the browser, runs
// Fill with AI too, and each answer names its model. The server takes the
// pick as a name only: the chat channel it goes through applies the person's
// model rules, budget and credentials, as for any chat.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGatewayModel } from "@/utils/gateway/keys";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { encodeModelChoice, parseModelChoice } from "@/utils/providers/modelChoice";

const src = (p: string) => readFileSync(p, "utf8");
const fns = src("src/utils/sheetsAssist.functions.ts");

/** How the server reads a pick: provider::model, then a gateway provider/model. */
const specOf = (choice: string) => {
  const p = parseModelChoice(choice)!;
  const spec = `${p.provider}/${p.model}`;
  const t = parseGatewayModel(spec, GATEWAY_PROVIDERS);
  return t && t.kind === "model" ? spec : null;
};

describe("a pick, as the server reads it", () => {
  it("the picker's provider::model is a gateway provider/model", () => {
    expect(specOf(encodeModelChoice("openrouter", "google/gemini-2.5-flash"))).toBe(
      "openrouter/google/gemini-2.5-flash",
    );
    expect(specOf(encodeModelChoice("openai", "gpt-4o-mini"))).toBe("openai/gpt-4o-mini");
  });
  it("a provider the gateway doesn't know is refused", () => {
    expect(specOf("nosuch::model-x")).toBeNull();
  });
});

describe("the server", () => {
  it("both the assistant and Fill with AI take a pick, and run on it", () => {
    expect(
      fns.match(/model: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(300\)\.optional\(\),/g)?.length,
    ).toBe(2);
    expect(fns.match(/const m = await modelFor\(data\.model\);/g)?.length).toBe(2);
    expect(fns).toMatch(
      /const picked = choice \? parseModelChoice\(choice\) : null;\s*const spec = picked \? `\$\{picked\.provider\}\/\$\{picked\.model\}` : settings\.sheetsAssistModel;/,
    );
  });
  it("a pick that isn't a model is refused, naming it", () => {
    expect(fns).toMatch(/is not a model the assistant can use; pick another, or the default\./);
  });
  it("still through the chat channel, with the person as the caller", () => {
    expect(fns.match(/internalChatText\(\{\s*userId: who\.userId,/g)?.length).toBe(2);
    expect(fns).toMatch(/provider: m\.provider,\s*model: m\.model,/);
  });
  it("says which model answered, and names the admin's for the default", () => {
    expect(fns).toMatch(/reply: parseAssistReply\(text\), cost, model: m\.spec/);
    expect(fns).toMatch(/return \{ ok: true, outputs, cost, model: m\.spec \};/);
    expect(fns).toMatch(
      /export const sheetsAssistDefaults = [\s\S]{0,400}model: settings\.sheetsAssistModel/,
    );
  });
});

describe("the panel and Fill with AI", () => {
  const panel = src("src/components/sheets/AssistPanel.tsx");
  const hook = src("src/components/sheets/useAssistModel.ts");
  const assist = src("src/components/sheets/useSheetAssist.tsx");
  const fill = src("src/components/sheets/AiFillDialog.tsx");
  it("the panel has the platform's picker, the admin's model as its named default", () => {
    expect(panel).toMatch(
      /<BiModelSelect[\s\S]{0,200}value=\{model\}[\s\S]{0,60}onChange=\{onModel\}[\s\S]{0,40}allowUnset/,
    );
    expect(panel).toMatch(
      /unsetLabel=\{defaultModel \? `Default · \$\{defaultModel\}` : "Default"\}/,
    );
  });
  it("each question sends the pick, and each answer names its model", () => {
    expect(panel).toMatch(/\.\.\.\(model \? \{ model \} : \{\}\),/);
    expect(panel).toMatch(/answeredBy = r\.model;/);
    expect(panel).toMatch(/model: answeredBy,/);
    expect(panel).toMatch(/data-testid="assist-meta"/);
  });
  it("a pick no longer the person's (provider gone, or a model rule refusing it) goes back to the default", () => {
    expect(hook).toMatch(
      /if \(rules && !isModelAllowedByRules\(rules, p\.provider, p\.model\)\) return drop\(\);/,
    );
    expect(hook).toMatch(
      /if \(!cancelled && !list\.some\(\(i\) => i\.provider === p\.provider\)\) drop\(\);/,
    );
    expect(hook).toMatch(/const drop = \(\) => \{\s*update\(null\);\s*toast\.info\(/);
  });
  it("the pick is remembered in the browser, and Fill with AI runs on it", () => {
    expect(hook).toMatch(/window\.localStorage\.setItem\(KEY, m\)/);
    expect(hook).toMatch(/else window\.localStorage\.removeItem\(KEY\);/);
    expect(assist).toMatch(/const \[model, setModel\] = useAssistModel\(\);/);
    expect(assist).toMatch(/maxRows=\{aiFillMaxRows\}\s*model=\{model\}/);
    expect(fill).toMatch(/\.\.\.\(model \? \{ model \} : \{\}\),/);
    expect(fill).toMatch(/data-testid="ai-fill-model"/);
  });
});
