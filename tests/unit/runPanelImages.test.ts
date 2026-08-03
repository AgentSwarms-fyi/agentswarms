// Images pulled out of swarm node output, and rendered as links.
//
// The run panel scans every node's output for image URLs and renders each as
//
//     <a href={img.url} target="_blank"><img src={img.url} /></a>
//
// Two patterns feed it. The bare-URL branch checked its match. The MARKDOWN
// branch pushed its capture untouched, and MD_IMAGE_RE captures `([^)\s]+)` —
// any scheme at all. So `![chart](javascript:alert(document.domain))` in a
// node's output became a clickable thumbnail that ran script in the signed-in
// owner's session.
//
// That output is model-generated, so it is reachable by prompt injection: a
// web_browse result, a knowledge-base document, or an embed visitor's message.
// It needs a click — but the thing rendered is an image thumbnail, and clicking
// to enlarge is the obvious interaction.
//
// This is the same defect fixed in MarkdownMessage's urlTransform earlier, in a
// second place that had its own copy of the idea. The fix imports safeUrl
// rather than restating it.
import { describe, expect, it } from "vitest";

import { extractImages } from "@/components/swarms/RunPanel";

const urls = (text: string) => extractImages(text, "node1").map((i) => i.url);

describe("a scheme that can execute never reaches an href", () => {
  it("drops javascript: from a markdown image", () => {
    expect(urls("![chart](javascript:alert(document.domain))")).toEqual([]);
  });

  it("drops the other executable schemes too", () => {
    for (const p of [
      "![x](vbscript:msgbox(1))",
      "![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "![x](file:///etc/passwd)",
    ]) {
      expect(urls(p), p).toEqual([]);
    }
  });

  // NO CONTROL-CHARACTER CASE HERE, deliberately. safeUrl strips them so that
  // "java\nscript:" cannot resolve, and that behaviour is tested directly in
  // markdownUrl.test.ts. It cannot be reached through THIS function: the
  // markdown pattern captures [^)\s]+, so any payload carrying whitespace fails
  // to match the pattern at all. A version of that test lived here briefly and
  // passed against every mutation, because it was asserting on a string the
  // extractor never sees.

  it("drops raw SVG data URIs, which can carry script", () => {
    // NO SPACES IN THE PAYLOAD. A first version used
    // `data:image/svg+xml,<svg onload=alert(1)>` and passed vacuously: the
    // markdown pattern captures [^)\s]+, so a space means it never matched at
    // all and the assertion held no matter what safeUrl did. Mutation testing
    // caught that — removing safeUrl's SVG rule broke nothing.
    expect(urls("![x](data:image/svg+xml,<svg/onload=alert(1)/>)")).toEqual([]);
    expect(urls("![x](data:image/svg+xml;utf8,<svg/onload=alert(1)/>)")).toEqual([]);
  });
});

describe("real images still come through", () => {
  it("keeps https images from markdown and from bare URLs", () => {
    expect(urls("![chart](https://example.com/a.png)")).toEqual(["https://example.com/a.png"]);
    expect(urls("see https://example.com/b.jpg for detail")).toEqual(["https://example.com/b.jpg"]);
  });

  it("keeps base64 image data URIs, which is what image models return", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    expect(urls(`![out](${uri})`)).toEqual([uri]);
  });

  it("keeps base64 SVG, where the payload cannot be raw markup", () => {
    const uri = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
    expect(urls(`![out](${uri})`)).toEqual([uri]);
  });

  it("keeps a relative path, which has no scheme to abuse", () => {
    expect(urls("![local](/assets/pic.webp)")).toEqual(["/assets/pic.webp"]);
  });

  it("carries the alt text and the node it came from", () => {
    const [img] = extractImages("![Revenue chart](https://example.com/r.png)", "analyst");
    expect(img.alt).toBe("Revenue chart");
    expect(img.source).toBe("analyst");
  });
});

describe("mixed and repeated output", () => {
  it("keeps the safe images from text that also contains a payload", () => {
    // Failing closed on the whole message would lose legitimate output; the
    // rule is per-URL.
    const text = "![bad](javascript:alert(1)) and ![good](https://example.com/ok.png)";
    expect(urls(text)).toEqual(["https://example.com/ok.png"]);
  });

  it("does not list the same image twice", () => {
    const text = "![a](https://example.com/x.png) ![b](https://example.com/x.png)";
    expect(urls(text)).toEqual(["https://example.com/x.png"]);
  });

  it("returns nothing for output with no images at all", () => {
    expect(urls("Just a plain answer with no media.")).toEqual([]);
    expect(urls("")).toEqual([]);
  });

  it("ignores a non-image link, which is not what this panel renders", () => {
    expect(urls("visit https://example.com/docs for more")).toEqual([]);
  });
});
