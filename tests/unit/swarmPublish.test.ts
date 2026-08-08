// Draft vs published isolation.
//
// The bug being pinned here: editing a swarm on the canvas used to change what
// its API keys served the moment you pressed Save. The tests below cover the
// resolver itself AND the fact that every headless entry point uses it — the
// resolver being correct is worthless if one of the three loaders still reads
// `nodes` directly.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deployState,
  deployStateCopy,
  graphFingerprint,
  hasUnpublishedChanges,
  isPublished,
  resolveDeployedGraph,
} from "@/lib/swarmPublish";

const draft = [{ id: "a", type: "swarmNode", data: { kind: "agent", prompt: "DRAFT" } }];
const live = [{ id: "a", type: "swarmNode", data: { kind: "agent", prompt: "PUBLISHED" } }];

describe("resolveDeployedGraph", () => {
  it("serves the published snapshot, not the edited draft", () => {
    const r = resolveDeployedGraph({
      nodes: draft,
      edges: [{ id: "e1", source: "a", target: "b" }],
      published_nodes: live,
      published_edges: [],
      published_at: "2026-01-01T00:00:00Z",
    });
    expect(r.source).toBe("published");
    expect(r.nodes).toEqual(live);
    // The whole point: the draft's prompt must not reach a deployed caller.
    expect(JSON.stringify(r.nodes)).not.toContain("DRAFT");
    expect(r.edges).toEqual([]);
  });

  it("falls back to the live graph when nothing was ever published", () => {
    // Swarms deployed before this feature existed still have to run.
    const r = resolveDeployedGraph({ nodes: draft, edges: [], published_nodes: null });
    expect(r.source).toBe("live");
    expect(r.nodes).toEqual(draft);
  });

  it("treats an empty published array as published, not as absent", () => {
    // `[]` is falsy-adjacent in a way that invites `||` bugs: publishing a
    // swarm you had emptied must not silently resurrect the draft.
    const r = resolveDeployedGraph({ nodes: draft, edges: [], published_nodes: [] });
    expect(r.source).toBe("published");
    expect(r.nodes).toEqual([]);
    expect(isPublished({ nodes: draft, edges: [], published_nodes: [] })).toBe(true);
  });
});

describe("graphFingerprint", () => {
  it("ignores node position — dragging a node is not a deployable change", () => {
    const a = [{ id: "n1", type: "t", position: { x: 0, y: 0 }, data: { kind: "agent" } }];
    const b = [{ id: "n1", type: "t", position: { x: 900, y: 400 }, data: { kind: "agent" } }];
    expect(graphFingerprint(a, [])).toBe(graphFingerprint(b, []));
  });

  it("ignores key order, so re-saving an untouched swarm is not 'drift'", () => {
    const a = [{ id: "n1", type: "t", data: { kind: "agent", model: "x", prompt: "p" } }];
    const b = [{ id: "n1", type: "t", data: { prompt: "p", kind: "agent", model: "x" } }];
    expect(graphFingerprint(a, [])).toBe(graphFingerprint(b, []));
  });

  it("ignores node ORDER within the array", () => {
    const a = [
      { id: "n1", data: {} },
      { id: "n2", data: {} },
    ];
    const b = [
      { id: "n2", data: {} },
      { id: "n1", data: {} },
    ];
    expect(graphFingerprint(a, [])).toBe(graphFingerprint(b, []));
  });

  it("ignores per-node run state, so pressing Run is not an edit", () => {
    // Found live. A run writes `status` into every node it touches; without
    // this, running a swarm you had not touched lit up "Draft ahead".
    const idle = [{ id: "n1", data: { kind: "agent", status: "idle" } }];
    const running = [{ id: "n1", data: { kind: "agent", status: "running", lastOutput: "hi" } }];
    expect(graphFingerprint(idle, [])).toBe(graphFingerprint(running, []));
  });

  it("treats a present-but-undefined key as absent", () => {
    // The save handler writes `lastOutput: undefined`, which JSON drops on the
    // way to the database — so the in-memory node and the saved row disagree
    // about whether the key exists at all. The panel used to report that
    // disagreement as unsaved work, immediately after a successful save.
    const inMemory = [{ id: "n1", data: { kind: "agent", note: undefined } }];
    const persisted = [{ id: "n1", data: { kind: "agent" } }];
    expect(graphFingerprint(inMemory, [])).toBe(graphFingerprint(persisted, []));
  });

  it("notices a changed prompt", () => {
    expect(graphFingerprint(draft, [])).not.toBe(graphFingerprint(live, []));
  });

  it("notices rewiring, even with identical nodes", () => {
    const e1 = [{ id: "e", source: "a", target: "b" }];
    const e2 = [{ id: "e", source: "a", target: "c" }];
    expect(graphFingerprint(draft, e1)).not.toBe(graphFingerprint(draft, e2));
  });

  it("notices a deleted node", () => {
    expect(graphFingerprint([...draft, { id: "b", data: {} }], [])).not.toBe(
      graphFingerprint(draft, []),
    );
  });

  it("notices a nested data change several levels down", () => {
    const a = [{ id: "n", data: { params: { retries: [{ max: 1 }] } } }];
    const b = [{ id: "n", data: { params: { retries: [{ max: 9 }] } } }];
    expect(graphFingerprint(a, [])).not.toBe(graphFingerprint(b, []));
  });
});

describe("hasUnpublishedChanges / deployState", () => {
  const pinned = { nodes: draft, edges: [], published_nodes: live, published_edges: [] };

  it("reports drift when the draft moved on", () => {
    expect(hasUnpublishedChanges(pinned)).toBe(true);
    expect(deployState(pinned, true)).toBe("drifted");
  });

  it("reports in-sync when they match", () => {
    const same = { nodes: live, edges: [], published_nodes: live, published_edges: [] };
    expect(hasUnpublishedChanges(same)).toBe(false);
    expect(deployState(same, true)).toBe("in-sync");
  });

  it("never claims drift for an unpinned swarm — the draft IS what runs", () => {
    const unpinned = { nodes: draft, edges: [], published_nodes: null };
    expect(hasUnpublishedChanges(unpinned)).toBe(false);
    expect(deployState(unpinned, true)).toBe("unpinned");
    expect(deployState(unpinned, false)).toBe("not-deployed");
  });

  it("tells an unpinned operator that saves reach production", () => {
    // If this copy stops warning, the honest fallback becomes a silent one.
    expect(deployStateCopy("unpinned").detail).toMatch(/immediately/i);
    expect(deployStateCopy("drifted").detail).toMatch(/NOT using|not using/);
  });

  it("does not guess WHY a swarm is unpinned", () => {
    // There are two ways to be unpinned — deployed before publishing existed,
    // or unpinned on purpose — and the panel cannot tell them apart. Naming
    // either one is a coin flip presented as a fact.
    expect(deployStateCopy("unpinned").detail).not.toMatch(/before publishing existed/i);
  });
});

describe("deployment rows cannot name someone else's swarm", () => {
  // Found while validating the auto-pin trigger's ownership guard: the RLS
  // policies on both deployment tables only checked `auth.uid() = user_id`, so
  // any authenticated user could insert an API key row pointing at another
  // tenant's swarm — with a key_hash they chose — and then run that swarm
  // through /api/swarm/run and read its output. Verified live, then fixed.
  const sql = readFileSync(
    resolve("supabase/migrations/20260813000000_swarm_deploy_owner_rls.sql"),
    "utf-8",
  );

  for (const table of ["swarm_api_keys", "swarm_schedules"]) {
    it(`${table} requires the swarm to be owned by the caller`, () => {
      // Anchor on CREATE POLICY specifically — the DROP POLICY line above it
      // also mentions the table, and slicing from there ends at its own `;`.
      const start = sql.indexOf(`CREATE POLICY "Users manage their own`, 0);
      const create = sql.slice(sql.indexOf(`ON public.${table}\n  FOR ALL`));
      expect(start, "no CREATE POLICY found").toBeGreaterThan(-1);
      const body = create.slice(0, create.indexOf("\n\n"));
      // Both halves matter: USING alone still lets the row be INSERTED.
      expect(body).toContain("USING (");
      expect(body).toContain("WITH CHECK (");
      const clauses = body.split("WITH CHECK");
      expect(clauses.length).toBe(2);
      for (const half of clauses) {
        expect(half).toContain("auth.uid() = user_id");
        expect(half).toMatch(/FROM public\.swarms s/);
        expect(half).toContain("s.user_id = auth.uid()");
      }
    });
  }

  it("removes rows that the hole already allowed", () => {
    // Leaving a credential minted through the vulnerability in place would
    // make the fix cosmetic for exactly the deployments that were exploited.
    expect(sql).toMatch(/DELETE FROM public\.swarm_api_keys/);
    expect(sql).toMatch(/DELETE FROM public\.swarm_schedules/);
    expect(sql).toMatch(/s\.user_id <> k\.user_id/);
  });
});

describe("every headless entry point resolves through the same function", () => {
  // Three loaders reach a deployed run. One of them reading `swarm.nodes`
  // directly would reintroduce the bug for that path only — an API key that
  // isolates drafts while the scheduler does not is arguably worse than
  // neither, because nobody would think to check.
  const paths = [
    "src/routes/api/swarm.run.ts",
    "src/utils/swarmSchedules.server.ts",
    "src/utils/swarmExecute.server.ts",
    // The embed resolver was missed on the first pass: an embed key lives in
    // someone else's web page, which is the surface where an instantly-live
    // save is least acceptable.
    "src/routes/api/embed.ts",
  ];

  for (const p of paths) {
    it(`${p} uses resolveDeployedGraph`, () => {
      const src = readFileSync(resolve(p), "utf-8");
      expect(src).toContain("resolveDeployedGraph");
      expect(src).toContain("published_nodes");
    });
  }

  it("no headless loader passes the raw swarm row to the executor", () => {
    // Found by mutation testing, not by review: the run endpoint resolved the
    // graph into `runGraph` and then called `executeSwarmServer({ swarm, ... })`
    // anyway, so every API-key run still served the draft. The object SHORTHAND
    // is what slipped through — and it is the easier one to write by accident.
    for (const p of paths) {
      const src = readFileSync(resolve(p), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(src, `${p} passes the unresolved row`).not.toMatch(/swarm:\s*swarm\b/);
      expect(src, `${p} passes the unresolved row by shorthand`).not.toMatch(
        /executeSwarmServer\(\{\s*swarm,/,
      );
    }
  });

  it("each loader feeds the executor the graph the resolver returned", () => {
    // Positive control for the check above: avoiding the wrong spelling is not
    // enough, the resolved value has to actually be used.
    for (const p of paths) {
      const src = readFileSync(resolve(p), "utf-8");
      const resolved = [...src.matchAll(/const (\w+) = resolveDeployedGraph\(/g)].map((m) => m[1]);
      expect(resolved.length, `${p} never calls the resolver`).toBeGreaterThan(0);
      for (const name of resolved) {
        // BOTH halves. A mutation that kept the published nodes but restored
        // the draft's edges survived an earlier version of this test, and that
        // combination is not a partial fix — rewiring the graph would go live
        // instantly while the node contents stayed pinned, which is worse than
        // either consistent behaviour because nothing about it looks wrong.
        for (const field of ["nodes", "edges"]) {
          expect(src, `${p}: ${name}.${field} is computed but never used`).toMatch(
            new RegExp(`${name}\\.${field}`),
          );
        }
      }
    }
  });
});

describe("deployment pins the graph in the database", () => {
  const sql = readFileSync(
    resolve("supabase/migrations/20260812000000_swarm_publish_autopin.sql"),
    "utf-8",
  );

  it("fires on both API keys and schedules", () => {
    expect(sql).toMatch(/AFTER INSERT ON public\.swarm_api_keys/);
    expect(sql).toMatch(/AFTER INSERT ON public\.swarm_schedules/);
  });

  it("only pins an unpinned swarm, so a second key cannot roll out the draft", () => {
    expect(sql).toContain("published_nodes IS NULL");
  });

  it("re-checks ownership, because SECURITY DEFINER bypasses RLS", () => {
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("s.user_id = NEW.user_id");
  });

  const embedSql = readFileSync(
    resolve("supabase/migrations/20260814000000_swarm_publish_embed_pin.sql"),
    "utf-8",
  );

  it("embed keys pin the swarm as well", () => {
    expect(embedSql).toMatch(/AFTER INSERT ON public\.embed_keys/);
    expect(embedSql).toContain("published_nodes IS NULL");
    expect(embedSql).toContain("s.user_id = NEW.user_id");
  });

  it("the embed trigger ignores agent and dashboard keys", () => {
    // embed_keys is polymorphic; without this guard an agent embed would
    // resolve resource_id against the swarms table and pin an unrelated row.
    expect(embedSql).toMatch(/NEW\.resource_type <> 'swarm'/);
  });

  it("existing embeds are backfilled, so upgrading changes nothing that day", () => {
    expect(embedSql).toMatch(/UPDATE public\.swarms/);
    expect(embedSql).toMatch(/k\.resource_type = 'swarm'/);
  });
});

describe("publish server functions", () => {
  const src = readFileSync(resolve("src/utils/swarmDeploy.functions.ts"), "utf-8");

  it("both check ownership under the service role", () => {
    const bodies = src.split("export const").filter((b) => /^\s*(publish|unpublish)Swarm/.test(b));
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b).toContain("swarm.user_id !== userId");
    }
  });

  it("publish copies the SAVED draft rather than trusting client-sent nodes", () => {
    const body = src.slice(
      src.indexOf("export const publishSwarm"),
      src.indexOf("export const unpublishSwarm"),
    );
    expect(body).toContain("published_nodes: swarm.nodes");
    expect(body).not.toMatch(/data\.nodes/);
  });
});
