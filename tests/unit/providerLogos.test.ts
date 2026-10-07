// The provider logos are served by the app (R326).
//
// FOUND IN R326, finishing R321. The Integrations and Model Registry pages
// loaded their logos from jsdelivr (Simple Icons v11), huggingface.co and
// groq.com. Offline they did not show, every browser asked three third parties
// for them, and four of the jsdelivr URLs (cohere, deepseek, elevenlabs,
// mistralai) had never existed in v11: those cards always showed an empty
// slot. The SVGs are now in public/provider-logos; a provider with no Simple
// Icons mark (Cohere, Groq) shows its own icon instead.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGES = {
  integrations: { file: "src/routes/_authenticated/integrations.tsx", map: "const PROVIDER_LOGO" },
  registry: { file: "src/routes/_authenticated/model-registry.tsx", map: "const LOGO" },
};

/** The values of a page's logo map. */
function logos(file: string, map: string): string[] {
  const src = readFileSync(file, "utf8");
  const start = src.indexOf(`${map}: Record<string, string> = {`);
  expect(start, `${file}: ${map}`).toBeGreaterThan(0);
  const block = src.slice(start, src.indexOf("};", start));
  return [...block.matchAll(/^\s*\w+: "([^"]+)",/gm)].map((m) => m[1]);
}

describe.each(Object.entries(PAGES))("the %s page's logos", (_name, { file, map }) => {
  const urls = logos(file, map);

  it("are all served by the app", () => {
    expect(urls.length).toBeGreaterThan(10);
    for (const url of urls) expect(url, url).toMatch(/^\/provider-logos\/[a-z0-9]+\.(svg|png)$/);
  });

  it("each exists in public/", () => {
    for (const url of urls) expect(existsSync(`public${url}`), url).toBe(true);
  });
});

describe("public/provider-logos", () => {
  const dir = "public/provider-logos";

  it("holds SVGs that are SVGs", () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg"))) {
      expect(readFileSync(`${dir}/${f}`, "utf8").trimStart(), f).toMatch(/^<svg[\s>]/);
    }
  });

  it("says where they came from and under what terms", () => {
    const note = readFileSync(`${dir}/ATTRIBUTION.md`, "utf8");
    expect(note).toContain("Simple Icons");
    expect(note).toContain("CC0 1.0");
    expect(note).toMatch(/trademark of its owner/);
  });

  it("is not asked of a third party anywhere in the code", () => {
    const hosts =
      /cdn\.jsdelivr\.net\/npm\/simple-icons|huggingface\.co\/front\/assets|groq\.com\/favicon/;
    for (const page of Object.values(PAGES)) {
      expect(hosts.test(readFileSync(page.file, "utf8")), page.file).toBe(false);
    }
  });
});
