// How long we wait for a model. The bug being fixed here was not a crash:
// the AI Analyst REQUIRES a reasoning model, and the deadline was computed
// at a generation rate only chat models achieve, so the one class of model
// the feature insists on was the one class that reliably ran out of clock.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  clientDeadlineMs,
  isSlowReasoningModel,
  MS_PER_TOKEN_DEFAULT,
  MS_PER_TOKEN_REASONING,
  UPSTREAM_CEILING_MS,
  UPSTREAM_FLOOR_MS,
  UPSTREAM_FLOOR_REASONING_MS,
  upstreamDeadlineMs,
} from "@/lib/llmDeadline";
import { ANALYST_TOKENS } from "@/lib/aiAnalyst";

describe("recognising a model that thinks", () => {
  it("knows the reasoning families by their gateway ids", () => {
    for (const id of [
      "deepseek/deepseek-r1",
      "openai/o3",
      "openai/o4-mini",
      "openai/gpt-5",
      "anthropic/claude-opus-4",
      "google/gemini-2.5-pro",
      "qwen/qwq-32b",
      "some/model-thinking",
      "deepseek/deepseek-reasoner",
    ]) {
      expect(isSlowReasoningModel(id), `${id} should be treated as reasoning`).toBe(true);
    }
  });

  it("leaves ordinary chat models on the short clock", () => {
    for (const id of [
      "openai/gpt-4o-mini",
      "anthropic/claude-3-5-haiku",
      "meta-llama/llama-3.1-8b-instruct",
      "mistralai/mistral-small",
      "",
      undefined,
    ]) {
      expect(isSlowReasoningModel(id), `${id} should not be treated as reasoning`).toBe(false);
    }
  });
});

describe("the deadline itself", () => {
  it("gives a reasoning model materially longer at the same budget", () => {
    const chat = upstreamDeadlineMs(6000, "openai/gpt-4o-mini");
    const reasoning = upstreamDeadlineMs(6000, "deepseek/deepseek-r1");
    expect(chat).toBe(UPSTREAM_FLOOR_MS + 6000 * MS_PER_TOKEN_DEFAULT);
    expect(reasoning).toBe(
      Math.min(UPSTREAM_CEILING_MS, UPSTREAM_FLOOR_REASONING_MS + 6000 * MS_PER_TOKEN_REASONING),
    );
    expect(reasoning).toBeGreaterThan(chat * 2);
  });

  it("COVERS the call that actually failed", () => {
    // Measured: deepseek-r1 produced 1,785 tokens in 59.8s ≈ 33ms/token. The
    // analyst's planning budget is 6,000 tokens, so a full-length plan needs
    // roughly 200s. The old rule allowed 108s and the request was killed at
    // 108.0s with zero output tokens.
    const observedMsPerToken = 59_760 / 1785;
    const needed = ANALYST_TOKENS.plan * observedMsPerToken;
    expect(Math.round(needed / 1000)).toBeGreaterThan(108);
    expect(upstreamDeadlineMs(ANALYST_TOKENS.plan, "deepseek/deepseek-r1")).toBeGreaterThanOrEqual(
      needed,
    );
  });

  it("still refuses to hang forever", () => {
    expect(upstreamDeadlineMs(16000, "deepseek/deepseek-r1")).toBe(UPSTREAM_CEILING_MS);
    expect(upstreamDeadlineMs(999999, "deepseek/deepseek-r1")).toBe(UPSTREAM_CEILING_MS);
  });

  it("floors a request with no completion budget", () => {
    expect(upstreamDeadlineMs(0, "openai/gpt-4o-mini")).toBe(UPSTREAM_FLOOR_MS);
    expect(upstreamDeadlineMs(-5, "openai/gpt-4o-mini")).toBe(UPSTREAM_FLOOR_MS);
  });

  it("gives an UNCAPPED reasoning call room too — the per-token rate cannot", () => {
    // biAgent.generateSql passes no maxTokens, so it lands exactly on the
    // floor. Measured deepseek-r1 calls in this codebase took 55.3s, 59.8s
    // and 78.3s; a 60s floor is inside that spread, which is a step that
    // works or not depending on the day.
    const uncapped = upstreamDeadlineMs(undefined, "deepseek/deepseek-r1");
    expect(uncapped).toBe(UPSTREAM_FLOOR_REASONING_MS);
    expect(uncapped).toBeGreaterThan(78_300);
    // Chat models keep the old floor — this is not a blanket loosening.
    expect(upstreamDeadlineMs(undefined, "openai/gpt-4o-mini")).toBe(UPSTREAM_FLOOR_MS);
  });
});

describe("the ordering the user actually sees", () => {
  it("keeps the CLIENT waiting longer than the server, everywhere", () => {
    // If the browser aborts first, the server's specific "did not finish
    // within Ns" never arrives and the user gets a bare network error
    // instead. This held by coincidence of two hand-written formulas until
    // one of them changed.
    for (const cap of [0, 1, 500, 2000, 6000, 8000, 12000, 16000, 40000]) {
      for (const model of ["openai/gpt-4o-mini", "deepseek/deepseek-r1", "openai/o3", ""]) {
        expect(
          clientDeadlineMs(cap, model),
          `client must outlast server at cap=${cap} model=${model}`,
        ).toBeGreaterThan(upstreamDeadlineMs(cap, model));
      }
    }
  });
});

describe("both sides use the shared rule", () => {
  // Two independently-written deadline expressions is exactly how the
  // ordering above got inverted once already.
  it("the server route computes its deadline from the module", () => {
    const src = readFileSync("src/routes/api/bi.ts", "utf8");
    expect(src).toContain("upstreamDeadlineMs(completionCap, model)");
    expect(src).not.toMatch(/60_000 \+ completionCap \* 8/);
  });

  it("the browser client computes its abort from the module", () => {
    const src = readFileSync("src/lib/biAgent.ts", "utf8");
    expect(src).toContain("clientDeadlineMs(opts.maxTokens");
    expect(src).not.toMatch(/90_000 \+ Math\.min\(opts\.maxTokens/);
  });

  it("the timeout message points at the fix that exists", () => {
    // "pick a different model" was unactionable while an analyst's model
    // could not be changed after creation.
    const src = readFileSync("src/routes/api/bi.ts", "utf8");
    expect(src).toContain("isSlowReasoningModel(model)");
    expect(src).toMatch(/Edit button is on the analyst card/);
    // And it says WHY it ran long, so the reader knows this is a clock
    // problem rather than a broken model.
    expect(src).toMatch(/Reasoning models spend most of that time thinking/);
    expect(src).toMatch(/ran out\b[\s\S]{0,40}of clock rather than failing/);
  });
});
