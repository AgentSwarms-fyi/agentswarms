// What a notebook kernel can reach of the lakehouse.
//
// HISTORY. This file used to pin the OPPOSITE. An ETL pipeline whose target
// was a lakehouse table once attached DuckLake from inside its kernel, with the
// catalog's connection string, and kernels sit on `agentswarms_nb-internal`, an
// `internal: true` network whose only way out is the HTTP egress proxy. A raw
// Postgres connection cannot go through that, so with the catalog only on
// `default` every lakehouse-target pipeline failed with "Network is
// unreachable" (found by running one), and the catalog joined nb-internal.
//
// Then sandboxes stopped holding any lakehouse credential
// (sandboxLake.server.ts; R230 for the Spark target): the app runs a run's
// declared reads and loads its staged writes. From then on the catalog on
// nb-internal was only a Postgres that every notebook could reach, and an
// install on the `change-me` default handed notebooks the lakehouse's metadata
// (VA-2026-10-25-42, R412). Measured after moving it off: a notebook cell could
// no longer resolve or route to either catalog, and the fixture pipeline
// r227_gateway (lakehouse -> Custom Python -> lakehouse) still loaded its 108
// rows.
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
    expect(orchestrator).toContain(
      `appInContainer() ? "agentswarms_nb-internal" : "agentswarms_nb-dev"`,
    );
  });

  it("can be overridden with NOTEBOOK_NETWORK", () => {
    expect(orchestrator).toContain("process.env.NOTEBOOK_NETWORK");
  });
});

describe("the lakehouse catalog is the app's alone (VA-42)", () => {
  it("is on the app's network and not on the kernels'", () => {
    const nets = compose.services["lakehouse-catalog"]?.networks ?? [];
    expect(nets, "lakehouse-catalog must be on the app's network").toContain("default");
    expect(
      nets,
      "lakehouse-catalog must NOT be on nb-internal: no sandbox holds its credentials, " +
        "so there it only hands every notebook a Postgres to try",
    ).not.toContain("nb-internal");
  });

  it("starts whenever the runtime starts", () => {
    expect(compose.services["lakehouse-catalog"]?.profiles ?? []).toEqual([]);
    expect(compose.services["notebook-gateway"]?.profiles ?? []).toEqual([]);
  });

  it("leaves the egress proxy as the kernels' way out", () => {
    // Parquet and everything else HTTP leaves through squid.
    const nets = compose.services["notebook-egress"]?.networks ?? [];
    expect(nets).toContain("nb-internal");
  });
});
