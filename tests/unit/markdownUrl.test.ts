// URL sanitisation in rendered model output.
//
// MarkdownMessage renders what the MODEL produced, and the model can be
// steered — by the visitor's own message on a public embed, or by a poisoned
// knowledge-base document. A link in a completion is untrusted markup.
//
// react-markdown ships a urlTransform that strips `javascript:`, `vbscript:`
// and unknown `data:` payloads. It had been replaced with `(url) => url`,
// which is not a narrowing of that policy but the removal of it, so
// `[click me](javascript:…)` rendered as a live anchor. In the playground that
// anchor sits in the user's own authenticated origin.
//
// The reason it was removed was real — the default also strips `data:` on
// <img>, so Gemini's base64 image replies rendered as broken icons. So the
// replacement keeps that one exception and restores everything else.
import { describe, expect, it } from "vitest";

import { safeUrl } from "@/components/playground/MarkdownMessage";

describe("blocks script-bearing URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(document.cookie)",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    it(`blocks ${JSON.stringify(url)}`, () => expect(safeUrl(url)).toBe(""));
  }

  it("blocks schemes hidden behind control characters", () => {
    // Browsers ignore tabs and newlines when resolving a scheme, so a checker
    // that does not strip them first can be walked straight past.
    expect(safeUrl("java\tscript:alert(1)")).toBe("");
    expect(safeUrl("java\nscript:alert(1)")).toBe("");
    expect(safeUrl("java\rscript:alert(1)")).toBe("");
  });
});

describe("data: URLs are images only", () => {
  it("allows a base64 image, which is why the default was removed", () => {
    expect(safeUrl("data:image/png;base64,iVBORw0KGgo=")).toBeTruthy();
    expect(safeUrl("data:image/jpeg;base64,/9j/4AAQ")).toBeTruthy();
    expect(safeUrl("data:image/webp;base64,UklGRg==")).toBeTruthy();
  });

  it("blocks non-image data payloads", () => {
    expect(safeUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe("");
    expect(safeUrl("data:application/javascript,alert(1)")).toBe("");
  });

  it("allows SVG only as base64, never as raw markup", () => {
    // Inline SVG can carry <script> and event handlers; base64 cannot be
    // crafted into markup the parser will execute from an <img> src.
    expect(safeUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeTruthy();
    expect(safeUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBe("");
  });
});

describe("ordinary links still work", () => {
  for (const url of [
    "https://example.com/a?b=1#c",
    "http://example.com",
    "mailto:someone@example.com",
    "tel:+441234567890",
    "/relative/path",
    "./docs/page.md",
    "#anchor",
  ]) {
    it(`allows ${JSON.stringify(url)}`, () => expect(safeUrl(url)).toBe(url));
  }

  it("returns empty for empty input rather than throwing", () => {
    expect(safeUrl("")).toBe("");
    expect(safeUrl("   ")).toBe("");
    expect(safeUrl(undefined as unknown as string)).toBe("");
  });
});

describe("the sanitiser is actually wired into the renderer", () => {
  it("urlTransform uses safeUrl, not the identity function", () => {
    // Testing the function while the component passes `(url) => url` would be
    // the definition-not-the-call-site trap this codebase keeps hitting.
    const src = new TextDecoder().decode(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").readFileSync("src/components/playground/MarkdownMessage.tsx"),
    );
    expect(src).toMatch(/urlTransform=\{safeUrl\}/);
    expect(src, "the identity transform is back").not.toMatch(/urlTransform=\{\(url\) => url\}/);
  });

  it("does not enable raw HTML rendering", () => {
    // rehypeRaw would let the model emit <script> directly, which no URL
    // sanitiser can help with.
    const src = new TextDecoder().decode(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").readFileSync("src/components/playground/MarkdownMessage.tsx"),
    );
    expect(src).not.toMatch(/rehypeRaw/);
  });
});
