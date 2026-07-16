import { createFileRoute } from "@tanstack/react-router";
import {
  DocLink,
  DocsHeader,
  Diagram,
  FieldList,
  H2,
  NextPrev,
  P,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/swarms")({
  head: () => ({
    meta: [
      { title: "Swarm Canvas — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms Swarm Canvas: node types (agent, condition, router, loop, approval, function, evaluate), live runs, failure labs, and code export.",
      },
      { property: "og:title", content: "Swarm Canvas — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The visual editor for multi-agent graphs: node types, live runs, failure labs, and code export.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/swarms" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Swarm Canvas — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "The visual editor for multi-agent graphs: node types, live runs, failure labs, and code export.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/swarms" }],
  }),
  component: SwarmsDoc,
});

function SwarmsDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Swarm Canvas"
        description="The canvas at /swarms is where single agents become systems. Each node is an agent or a control-flow primitive, each edge is a data route, and the runtime executes the whole graph live — streaming every node's output, cost, and decisions as it runs."
      />

      <P>
        The shape of a multi-agent system is its most important property, and shapes are easier to
        reason about visually than as nested code. A glance at the canvas shows which agents are
        involved, where work fans out in parallel, and where the human checkpoints sit. When you
        want the code instead, every swarm exports to LangGraph, CrewAI, OpenAI Agents SDK, or
        Strands.
      </P>

      <H2 id="node-types">Node types</H2>
      <P>The palette has ten node kinds:</P>
      <FieldList
        items={[
          {
            name: "Input",
            body: "The entry point — the seed value for the run, supplied in the run panel.",
          },
          {
            name: "Agent",
            body: "An LLM call with its own provider, model, temperature, system prompt, tools, and memory scope. The workhorse node.",
          },
          {
            name: "Condition",
            body: "A YES/NO router. A small model evaluates a condition prompt against the input and the run follows the YES or NO edge. Unlabeled condition edges raise a validation warning before the run starts.",
          },
          {
            name: "Router Agent",
            body: "Picks one of N downstream routes. The routing rubric is an editable prompt and the decision is recorded in the run log.",
          },
          {
            name: "Loop",
            body: "Re-runs its prompt until the model signals DONE or the configured maximum iterations is reached — the primitive behind reflection and self-correction.",
          },
          {
            name: "Approval",
            body: "Pauses the run and posts a card to your approvals inbox with a title and risk level. The run resumes when you decide. Pending approvals time out rather than hanging forever.",
          },
          {
            name: "A2A Remote",
            body: "Delegates a step to a remote agent over the A2A protocol — point it at an endpoint, optionally with streaming.",
          },
          {
            name: "Function (JS)",
            body: "A sandboxed JavaScript transform with a 2-second timeout. Deterministic glue between model steps: parse, reshape, filter — no LLM involved.",
          },
          {
            name: "Evaluate",
            body: "LLM-as-a-judge scoring against weighted metrics (faithfulness, answer relevancy, completeness, coherence, harmlessness) with a pass threshold — a quality gate inside the graph.",
          },
          {
            name: "Output",
            body: "The terminal value of the run.",
          },
        ]}
      />
      <P>
        Fan-out is expressed with edges rather than a special node: connect one node to several
        downstream nodes and the runtime executes the branches in parallel; connect several nodes
        into one and that node waits for all of its inputs.
      </P>

      <H2 id="running">Running a swarm</H2>
      <UL>
        <li>
          <strong>Live execution</strong> — each node lights up as it runs, and the run panel
          streams per-node output alongside a live cost and token meter.
        </li>
        <li>
          <strong>Pre-run validation</strong> — the canvas checks the graph before starting (cycles
          outside Loop nodes, unlabeled condition edges, disconnected nodes) and warns instead of
          failing midway.
        </li>
        <li>
          <strong>Approvals</strong> — when a run hits an Approval node it shows as{" "}
          <em>awaiting approval</em> in the run panel until you decide from the inbox.
        </li>
        <li>
          <strong>Traces</strong> — every node execution is recorded with tokens, cost, and latency,
          and feeds <DocLink to="/docs/analytics">analytics</DocLink> and the{" "}
          <DocLink to="/docs/debugging">trace viewer</DocLink>.
        </li>
      </UL>

      <H2 id="agents-on-canvas">Agents on the canvas</H2>
      <P>
        Agent nodes are configured in a side inspector: pick the provider and model (the same
        provider list as the <DocLink to="/docs/agents">Agent Builder</DocLink>, from the built-in
        AgentSwarms AI through OpenAI, Anthropic, Gemini, Bedrock, Vertex, Azure, and self-hosted
        options), edit the system prompt in place, and choose a long-term memory scope per node —
        share with the agent's normal memory, isolate to this swarm run, or none.
      </P>

      <H2 id="templates-and-labs">Templates, tours, and failure labs</H2>
      <UL>
        <li>
          <strong>Templates</strong> — 30+ pre-built swarms load directly onto the canvas, most with
          a guided tour that follows the run node by node. The gallery shows a thumbnail of each
          template's actual graph.
        </li>
        <li>
          <strong>Failure labs</strong> — deliberately broken swarms (infinite tool loop, JSON
          wrapper crash, context-window collapse) that you run, watch fail, then fix. The lab checks
          your fix and tracks which labs you have passed.
        </li>
      </UL>

      <H2 id="export-and-publish">Export and publish</H2>
      <UL>
        <li>
          <strong>Export</strong> produces portable JSON, LangGraph (Python or TypeScript), CrewAI,
          OpenAI Agents SDK, or Strands code — the graph you drew becomes a runnable project in the
          framework of your choice.
        </li>
      </UL>

      <H2 id="workflow">A workflow that works</H2>
      <UL>
        <li>
          Start from a template, run it unmodified with the tour open, and read the run log end to
          end before changing anything.
        </li>
        <li>
          Change one thing at a time — a prompt, a model, a route — and rerun with the same input to
          see what actually moved.
        </li>
        <li>
          Put an Evaluate node before the Output early; a quality gate shapes the rest of the
          design.
        </li>
        <li>
          Wrap anything that writes to the outside world in an Approval node before sharing the
          swarm with anyone.
        </li>
      </UL>

      <Diagram caption="A canonical swarm: routed intake, parallel specialists, a quality gate, and a human checkpoint">{`[input] ──▶ [router] ──▶ [specialist A] ──┐
               │                          ├──▶ [evaluate] ──▶ [approval] ──▶ [output]
               └──────▶ [specialist B] ───┘        │
                              ▲ ◀──── fail ────────┘`}</Diagram>

      <NextPrev current="/docs/swarms" />
    </>
  );
}
