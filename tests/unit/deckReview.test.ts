// R405 (VA-2026-10-25-37): Deep mode's slide review runs in the app as the
// user, not in the doc-gen container on its own key with a model the request
// named. The pure half (parse, apply) and the wiring both are pinned here.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyDeckFixes, parseDeckFixes, reviewNote } from "@/lib/docGen/deckReview";
import { REVIEW_IMAGE_CHARS, slideImages } from "@/utils/deckReview.server";
import { isConversationTooLarge, MAX_BODY_CHARS } from "@/utils/observability/traceSanitize";
import type { PptxPlan } from "@/lib/docGen/types";

const rd = (p: string) => readFileSync(p, "utf8");

function plan(): PptxPlan {
  return {
    title: "Q3 review",
    slides: [
      { title: "A".repeat(120), bullets: ["one", "two"] },
      { title: "Bullets", bullets: ["x".repeat(200), "b", "c", "d", "e", "f"] },
      {
        title: "Chart only",
        chart: { type: "bar", data: [] } as never,
        notes: "Revenue rose 12%.",
      },
      { title: "Chart, nothing to promote", chart: { type: "bar", data: [] } as never },
      { title: "Short", bullets: ["fine"] },
    ],
  };
}

describe("parseDeckFixes", () => {
  it("reads the fixes from a fenced or prose-wrapped answer", () => {
    const text =
      'Here you go:\n```json\n{"fixes":[{"slide":1,"action":"shrink_title","reason":"overflows"}]}\n```';
    expect(parseDeckFixes(text)).toEqual([
      { slide: 1, action: "shrink_title", reason: "overflows" },
    ]);
  });

  it("drops unknown actions, non-integer or non-positive slides, and anything past six", () => {
    const fixes = [
      { slide: 1, action: "rewrite_everything" },
      { slide: 0, action: "trim_bullets" },
      { slide: 1.5, action: "trim_bullets" },
      { slide: "2", action: "trim_bullets" },
      ...Array.from({ length: 8 }, (_, i) => ({ slide: i + 1, action: "drop_visual" })),
    ];
    const out = parseDeckFixes(JSON.stringify({ fixes }));
    expect(out[0]).toEqual({ slide: 2, action: "trim_bullets" });
    expect(out).toHaveLength(6);
    expect(out.every((f) => f.action !== ("rewrite_everything" as never))).toBe(true);
  });

  it("answers no fixes for prose, broken JSON or a missing list", () => {
    expect(parseDeckFixes("The deck looks good.")).toEqual([]);
    expect(parseDeckFixes('{"fixes": [')).toEqual([]);
    expect(parseDeckFixes('{"summary":"fine"}')).toEqual([]);
  });
});

describe("applyDeckFixes", () => {
  it("shrinks a long title and trims bullets to four of 90 characters", () => {
    const p = plan();
    const changed = applyDeckFixes(p, [
      { slide: 1, action: "shrink_title" },
      { slide: 2, action: "trim_bullets" },
    ]);
    expect(changed).toBe(true);
    expect(p.slides[0].title).toHaveLength(70);
    expect(p.slides[1].bullets).toHaveLength(4);
    expect(p.slides[1].bullets![0]).toHaveLength(90);
  });

  it("promotes the notes when dropping the only visual, and refuses when there is nothing to promote", () => {
    const p = plan();
    applyDeckFixes(p, [
      { slide: 3, action: "drop_visual" },
      { slide: 4, action: "drop_visual" },
    ]);
    expect(p.slides[2].chart).toBeUndefined();
    expect(p.slides[2].paragraph).toBe("Revenue rose 12%.");
    // A weak visual beats a blank slide.
    expect(p.slides[3].chart).toBeDefined();
  });

  it("reports no change for fixes that leave the slide as it was, or name a slide that is not there", () => {
    const p = plan();
    const before = JSON.stringify(p);
    expect(
      applyDeckFixes(p, [
        { slide: 5, action: "shrink_title" },
        { slide: 5, action: "trim_bullets" },
        { slide: 5, action: "drop_visual" },
        { slide: 9, action: "shrink_title" },
      ]),
    ).toBe(false);
    expect(JSON.stringify(p)).toBe(before);
  });

  it("says what the review did, naming the model", () => {
    expect(reviewNote("openrouter/openai/gpt-4o-mini", [], false)).toBe(
      "Reviewed by openrouter/openai/gpt-4o-mini: no problems found.",
    );
    expect(reviewNote("m", [{ slide: 1, action: "shrink_title" }], true)).toBe(
      "Reviewed by m: 1 fix applied.",
    );
    expect(reviewNote("m", [{ slide: 9, action: "shrink_title" }], false)).toContain(
      "did not apply",
    );
    expect(reviewNote("m", [], false, { reviewed: 4, total: 10 })).toBe(
      "Reviewed by m (the first 4 of 10 slides): no problems found.",
    );
    expect(reviewNote("m", [], false, { reviewed: 10, total: 10 })).toBe(
      "Reviewed by m: no problems found.",
    );
  });
});

describe("only rendered slides reach the model", () => {
  it("keeps rendered JPEG and PNG data URIs, at most ten", () => {
    const png = "data:image/png;base64,AAAA";
    const jpg = "data:image/jpeg;base64,BBBB";
    expect(
      slideImages([jpg, "https://evil.example/x.png", 3, "data:text/html;base64,PHA+", png]),
    ).toEqual({ images: [jpg, png], total: 2 });
    expect(slideImages(Array(14).fill(jpg)).images).toHaveLength(10);
    expect(slideImages("nope")).toEqual({ images: [], total: 0 });
  });

  it("sends only as many slides, from the first, as fit under the chat channel's ceiling", () => {
    // MEASURED: ten 90 dpi PNGs were refused by /api/chat with 413.
    expect(REVIEW_IMAGE_CHARS).toBeLessThan(MAX_BODY_CHARS);
    const big = `data:image/jpeg;base64,${"A".repeat(150_000)}`;
    const { images, total } = slideImages(Array(10).fill(big));
    expect(total).toBe(10);
    expect(images.length).toBe(2);
    const message = [
      { role: "user", content: images.map((url) => ({ type: "image_url", image_url: { url } })) },
    ];
    expect(isConversationTooLarge(message)).toBe(false);
    expect(slideImages(Array(3).fill(big), 1_000)).toEqual({ images: [], total: 3 });
  });
});

describe("the doc-gen container calls no model", () => {
  const py = readdirSync("docgen-service")
    .filter((f) => f.endsWith(".py"))
    .map((f) => rd(`docgen-service/${f}`))
    .join("\n");

  it("has no model key, no OpenRouter endpoint and no outbound HTTP client", () => {
    expect(py).not.toMatch(/OPENROUTER/);
    expect(py).not.toMatch(/openrouter\.ai/);
    expect(py).not.toMatch(/^\s*import httpx|^\s*from httpx|requests\.post/m);
    expect(rd("docgen-service/requirements.txt")).not.toMatch(/^(httpx|requests|aiohttp)\b/m);
  });

  it("is not handed the operator's model key by Compose", () => {
    const compose = rd("docker-compose.yml");
    const svc = compose.slice(compose.indexOf("\n  docgen:"));
    const block = svc.slice(0, svc.slice(1).search(/\n {2}[a-z][\w-]*:\n/) + 1);
    expect(block).toContain("image: agentswarms/docgen");
    expect(block).not.toMatch(/OPENROUTER/);
  });

  it("the app route reviews as the user through the internal chat channel", () => {
    const route = rd("src/routes/api/docgen.pptx.ts");
    expect(route).toContain("reviewDeck({");
    expect(route).toContain("userId: user.id");
    expect(route).not.toMatch(/model:\s*body\.model/);
    const server = rd("src/utils/deckReview.server.ts");
    expect(server).toContain("chooseModel(args.userId");
    expect(server).toContain("internalChatText({");
    expect(server).toContain("modelFallback: chosen.fellBack");
  });
});
