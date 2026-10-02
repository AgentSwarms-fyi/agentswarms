// A failed chat request, named by who refused it (R193).
//
// FOUND IN R193, sweep 3's survey ("a cause named that the evidence cannot
// support"). The chat route answers 402 `budget_exceeded` itself when a
// monthly cap is reached and 403 `model_not_allowed` when the administrator's
// model rules refuse the model. The playground showed the first as "AI
// credits exhausted · … Pick another model and we'll continue this chat"
// with five models offered, every one refused by the same cap, and the
// second as "openrouter: Your administrator has not allowed …". Driven on
// the hot deploy of R192 with the route's exact bodies answered from the
// browser (the cap is opt-in, ENFORCE_BUDGET_CAP, and was not switched on).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { classifyChatFailure, PLATFORM_REFUSALS } from "@/lib/chatFailure";

const BUDGET = {
  error: "budget_exceeded",
  message: "You have reached your monthly AI budget ($5.00). (spent $5.12 of $5.00 this month.)",
};

describe("classifyChatFailure", () => {
  it("names the platform's own refusals, whatever their status", () => {
    expect(classifyChatFailure(402, BUDGET, BUDGET.message)).toBe("platform");
    expect(
      classifyChatFailure(
        403,
        { error: "model_not_allowed", message: "Your administrator has not allowed x/y." },
        "Your administrator has not allowed x/y.",
      ),
    ).toBe("platform");
    expect(classifyChatFailure(413, { error: "conversation_too_large", message: "m" }, "m")).toBe(
      "platform",
    );
    expect([...PLATFORM_REFUSALS].sort()).toEqual(
      ["budget_exceeded", "conversation_too_large", "model_not_allowed"].sort(),
    );
  });

  it("still sends a provider's 402 and 429 to the fallback picker", () => {
    const credits = "AI credits exhausted for this provider.";
    expect(classifyChatFailure(402, { error: credits }, credits)).toBe("credits");
    expect(
      classifyChatFailure(429, { error: "Rate limit exceeded." }, "Rate limit exceeded."),
    ).toBe("rate_limit");
    expect(classifyChatFailure(500, { error: "insufficient_quota" }, "insufficient_quota")).toBe(
      "credits",
    );
    expect(classifyChatFailure(500, { error: "Too many requests" }, "Too many requests")).toBe(
      "rate_limit",
    );
  });

  it("leaves anything else as the provider's error", () => {
    expect(classifyChatFailure(500, { error: "upstream exploded" }, "upstream exploded")).toBe(
      "error",
    );
    expect(classifyChatFailure(500, null, "Request failed (500)")).toBe("error");
    expect(classifyChatFailure(500, "not json", "Request failed (500)")).toBe("error");
  });

  it("does not take a provider's message in `error` for a platform code", () => {
    // An upstream failure carries its sentence in `error`; only an exact
    // code is the platform's.
    expect(classifyChatFailure(402, { error: "budget_exceeded on the provider" }, "x")).toBe(
      "credits",
    );
  });
});

describe("the playground", () => {
  const SRC = readFileSync("src/routes/_authenticated/playground.tsx", "utf8");

  it("classifies with the parsed body and names the provider only for its own errors", () => {
    expect(SRC).toContain("const reason = classifyChatFailure(resp.status, errBody, errMsg);");
    expect(SRC).toMatch(/errBody = j;/);
    expect(SRC).toMatch(/if \(reason === "error"\) \{\s*errMsg = `\$\{provider\}: \$\{errMsg\}`;/);
    expect(SRC).not.toMatch(/resp\.status === 402 \|\| \/credit/);
  });

  it("opens the fallback picker only for a provider's rate limit or credits", () => {
    expect(SRC).toMatch(
      /if \(result\.reason === "rate_limit" \|\| result\.reason === "credits"\) \{/,
    );
  });
});
