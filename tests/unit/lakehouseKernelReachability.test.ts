// Can a notebook kernel actually reach the lakehouse catalog?
//
// FOUND BY RUNNING A PIPELINE. An ETL pipeline whose target is a lakehouse
// table attaches DuckLake from inside a kernel. Kernels are placed on
// `agentswarms_nb-internal`, a Docker network with `internal: true` — no route
// off it at all — and reach the outside world only through the HTTP egress
// proxy. Parquet is HTTP and goes through the proxy happily. The CATALOG is a
// raw Postgres TCP connection, and no HTTP proxy can carry that.
//
// So with the catalog only on `default`, every lakehouse-target pipeline died
// with "connection to server at ... failed: Network is unreachable" — but ONLY
// once the app ran in a container. Under `npm run dev` the orchestrator picks
// the routable nb-dev network instead, so the whole class of failure was
// invisible in development and certain in production. That asymmetry is why
// this is pinned by a test rather than left to a comment.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

type Compose = {
  services: Record<string, { networks?: string[]; profiles?: string[] }>;
};

const compose = load(readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8")) as Compose;
const orchestrator = readFileSync(
  resolve(process.cwd(), "src/utils/notebookRuntime/docker.server.ts"),
  "utf8",
);

describe("the kernel network", () => {
  it("is the internal one when the app runs in a container", () => {
    // Restating the rule the bug depended on, so a change to it fails here and
    // sends the reader to the catalog wiring below.
    expect(orchestrator).toContain(
      `appInContainer() ? "agentswarms_nb-internal" : "agentswarms_nb-dev"`,
    );
  });

  it("can be overridden, which is the escape hatch for an external catalog", () => {
    // A catalog outside Docker (managed Postgres, another host) cannot join
    // nb-internal, so the operator needs a way to place kernels somewhere with
    // a route. Documented in docs/LAKEHOUSE.md.
    expect(orchestrator).toContain("process.env.NOTEBOOK_NETWORK");
  });
});

describe("the lakehouse catalog is reachable from kernels", () => {
  it("joins the kernel network as well as the app network", () => {
    const nets = compose.services["lakehouse-catalog"]?.networks ?? [];
    expect(nets, "lakehouse-catalog must be on the app's network").toContain("default");
    expect(
      nets,
      "lakehouse-catalog must ALSO be on nb-internal or ETL lakehouse targets " +
        "fail with 'Network is unreachable' whenever the app runs in a container",
    ).toContain("nb-internal");
  });

  it("is in the same profiles as the runtime that needs it", () => {
    // `--profile all` must bring up a working combination; a catalog that only
    // appears under a profile the notebook runtime does not share would
    // reintroduce the same failure by a different route.
    const catalog = compose.services["lakehouse-catalog"]?.profiles ?? [];
    expect(catalog).toContain("all");
  });

  it("the egress proxy is on the kernel network too", () => {
    // The other half of a kernel's connectivity: HTTP leaves through squid.
    const nets = compose.services["notebook-egress"]?.networks ?? [];
    expect(nets).toContain("nb-internal");
  });
});
