// Pure verification harness for Failure-Mode Labs.
//
// evaluateLab() takes a lab and a snapshot of a completed run (final output,
// the event stream, and the current graph) and reports, per assertion, whether
// it passed plus a human-readable detail. No I/O, no LLM — fully deterministic
// and unit-testable.

import type { Node, Edge } from "@xyflow/react";
import type { SwarmNodeData, SwarmRunEvent, SwarmToolId } from "./swarmRuntime";
import type { FailureLab, LabAssertion } from "./failureLabs";

export type LabAssertionResult = {
  assertion: LabAssertion;
  passed: boolean;
  detail: string;
};

export type LabEvaluation = {
  passed: boolean; // true only if every assertion passed
  results: LabAssertionResult[];
};

export type LabRunContext = {
  finalOutput: string;
  events: SwarmRunEvent[];
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
};

function norm(s: string, caseInsensitive?: boolean): string {
  return caseInsensitive ? s.toLowerCase() : s;
}

function checkOne(a: LabAssertion, ctx: LabRunContext): LabAssertionResult {
  const pass = (passed: boolean, detail: string): LabAssertionResult => ({
    assertion: a,
    passed,
    detail,
  });

  switch (a.kind) {
    case "final_contains": {
      const hit = norm(ctx.finalOutput, a.caseInsensitive).includes(
        norm(a.value, a.caseInsensitive),
      );
      return pass(
        hit,
        hit ? `Output contains "${a.value}".` : `Output should contain "${a.value}" but doesn't.`,
      );
    }
    case "final_not_contains": {
      const hit = norm(ctx.finalOutput, a.caseInsensitive).includes(
        norm(a.value, a.caseInsensitive),
      );
      return pass(
        !hit,
        !hit
          ? `Output correctly omits "${a.value}".`
          : `Output should NOT contain "${a.value}" but does.`,
      );
    }
    case "final_matches": {
      let re: RegExp | null = null;
      try {
        re = new RegExp(a.pattern);
      } catch {
        return pass(false, `Invalid pattern: ${a.pattern}`);
      }
      const hit = re.test(ctx.finalOutput);
      return pass(
        hit,
        hit ? `Output matches /${a.pattern}/.` : `Output should match /${a.pattern}/ but doesn't.`,
      );
    }
    case "no_node_errors": {
      const errs = ctx.events.filter((e) => e.type === "node_error");
      return pass(
        errs.length === 0,
        errs.length === 0 ? "No node errored during the run." : `${errs.length} node(s) errored.`,
      );
    }
    case "node_output_contains": {
      const ev = [...ctx.events]
        .reverse()
        .find(
          (e): e is Extract<SwarmRunEvent, { type: "node_done" }> =>
            e.type === "node_done" && e.nodeId === a.nodeId,
        );
      if (!ev) return pass(false, `Node "${a.nodeId}" produced no output this run.`);
      const hit = norm(ev.output, a.caseInsensitive).includes(norm(a.value, a.caseInsensitive));
      return pass(
        hit,
        hit
          ? `Node "${a.nodeId}" output contains "${a.value}".`
          : `Node "${a.nodeId}" output should contain "${a.value}".`,
      );
    }
    case "graph_kb_attached": {
      const n = ctx.nodes.find((x) => x.id === a.nodeId);
      if (!n) return pass(false, `Node "${a.nodeId}" not found.`);
      const hasKb = !!n.data.knowledgeBaseId;
      const hasKbTool = (n.data.enabledTools ?? []).includes("kb_search" as SwarmToolId);
      const ok = hasKb || hasKbTool;
      return pass(
        ok,
        ok
          ? "A knowledge base is attached (or kb_search is enabled)."
          : "No knowledge base attached and kb_search isn't enabled — the agent can't retrieve anything.",
      );
    }
    case "graph_tool_enabled": {
      const n = ctx.nodes.find((x) => x.id === a.nodeId);
      if (!n) return pass(false, `Node "${a.nodeId}" not found.`);
      const ok = (n.data.enabledTools ?? []).includes(a.tool as SwarmToolId);
      return pass(
        ok,
        ok
          ? `The "${a.tool}" tool is enabled on this node.`
          : `The "${a.tool}" tool is not enabled on this node.`,
      );
    }
    case "graph_edges_labeled": {
      const outs = ctx.edges.filter((e) => e.source === a.nodeId);
      if (outs.length === 0) return pass(false, `Node "${a.nodeId}" has no outgoing edges.`);
      const unlabeled = outs.filter((e) => !(typeof e.label === "string" && e.label.trim()));
      const ok = unlabeled.length === 0;
      return pass(
        ok,
        ok
          ? "Every outgoing edge of this node has a label."
          : `${unlabeled.length} outgoing edge(s) are still unlabeled.`,
      );
    }
    case "graph_loop_bounded": {
      const n = ctx.nodes.find((x) => x.id === a.nodeId);
      if (!n) return pass(false, `Node "${a.nodeId}" not found.`);
      const iters = n.data.maxIters ?? 3;
      const ok = iters <= a.maxIters;
      return pass(
        ok,
        ok
          ? `Loop is bounded to ${iters} iteration(s).`
          : `Loop max iterations is ${iters}; bring it to ${a.maxIters} or fewer.`,
      );
    }
    default: {
      // Exhaustiveness guard — if a new assertion kind is added, fail loudly.
      const _never: never = a;
      return { assertion: _never, passed: false, detail: "Unknown assertion kind." };
    }
  }
}

export function evaluateLab(lab: FailureLab, ctx: LabRunContext): LabEvaluation {
  const results = lab.assertions.map((a) => checkOne(a, ctx));
  return { passed: results.every((r) => r.passed), results };
}
