// Compose profile rules.
//
// Six of the seven services sit behind profiles, so `docker compose up` starts
// the app alone — deliberate, because each optional service costs something.
// The cost of that design is a one-command way to start everything, which is
// the `all` profile every profiled service also carries.
//
// The failure this file exists to prevent: someone adds a service with
// `profiles: [something]` and forgets `all`, so `--profile all` quietly stops
// meaning all. Nothing errors, the docs still read correctly, and the service
// is simply missing — which is exactly the shape of bug that survives review.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

type ComposeFile = {
  services: Record<string, { profiles?: string[] }>;
};

const compose = yaml.load(
  readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8"),
) as ComposeFile;

const services = Object.entries(compose.services);
const profiled = services.filter(([, s]) => Array.isArray(s.profiles) && s.profiles.length > 0);
const unprofiled = services.filter(([, s]) => !s.profiles || s.profiles.length === 0);

describe("docker compose profiles", () => {
  it("gives every profiled service the `all` profile", () => {
    const missing = profiled.filter(([, s]) => !s.profiles!.includes("all")).map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("still starts the app alone on a plain `docker compose up`", () => {
    // An unprofiled service starts under every invocation. Exactly one service
    // may do that: adding a second would make the lightweight path heavier
    // without anyone choosing it.
    expect(unprofiled.map(([name]) => name)).toEqual(["agentswarms"]);
  });

  it("makes `--profile all` resolve to every service in the file", () => {
    // What compose itself would select for `--profile all`: unprofiled services
    // always, plus every service listing `all`.
    const selected = services
      .filter(([, s]) => !s.profiles?.length || s.profiles.includes("all"))
      .map(([name]) => name);
    expect(selected.sort()).toEqual(services.map(([name]) => name).sort());
  });

  it("keeps the narrower profiles working alongside `all`", () => {
    // `all` is additive; it must not have replaced the per-service profiles the
    // docs and setup scripts still pass.
    const named = new Set(profiled.flatMap(([, s]) => s.profiles!).filter((p) => p !== "all"));
    for (const profile of ["docgen", "notebooks", "sandbox"]) {
      expect(named).toContain(profile);
    }
  });

  it("is the command the docs actually advertise", () => {
    // A profile nobody is told about is not a feature.
    for (const doc of ["README.md", "docs/INSTALL.md", "docs/DEPLOYMENT.md"]) {
      const text = readFileSync(resolve(process.cwd(), doc), "utf8");
      expect(text, `${doc} does not mention --profile all`).toContain("--profile all");
    }
  });
});
