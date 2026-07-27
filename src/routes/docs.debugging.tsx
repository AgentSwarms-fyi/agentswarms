import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/debugging")({
  head: () => ({
    meta: [
      { title: "Logs & traces — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Debugging on AgentSwarms: the traces table, per-run detail with prompt, tool calls, raw request/response payloads, tokens, cost, and latency.",
      },
      { property: "og:title", content: "Logs & traces — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The traces table and per-run detail: prompt, tool calls, raw payloads, tokens, cost, latency.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/debugging" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Logs & traces — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "The traces table and per-run detail: prompt, tool calls, raw payloads, tokens, cost, latency.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/debugging" }],
  }),
  component: DebuggingDoc,
});

function DebuggingDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Run & observe"
        title="Logs & traces"
        description="Every run on the platform — playground chats, swarm nodes, notebook calls — is recorded as a trace. Reading traces is the core debugging skill in agentic systems, and the one course environments almost never let you practice."
      />

      <H2 id="traces-table">The traces table</H2>
      <P>
        <DocLink to="/traces">/traces</DocLink> lists every run with the agent name, provider and
        model, latency, tokens in and out, dollar cost, status, and timestamp. Sort or scan for the
        rows that look wrong — the red statuses, the latency outliers, the runs that cost ten times
        their neighbours.
      </P>

      <H2 id="trace-detail">What a trace contains</H2>
      <P>Selecting a run opens the full record:</P>
      <FieldList
        items={[
          {
            name: "Metrics",
            body: "Latency, tokens in, tokens out, and cost computed from model pricing.",
          },
          {
            name: "Prompt",
            body: "The prompt for the run, with the agent and model that handled it.",
          },
          {
            name: "Tool calls",
            body: "Each tool the model called, with the arguments it chose and the result it got back. If a tool you expected is never called, check the request payload to confirm it was offered at all.",
          },
          {
            name: "Request / response payloads",
            body: "The raw provider request and response. This is the ground truth: the exact message array, parameters, and tool definitions the model actually received, and exactly what it returned.",
          },
          {
            name: "Error",
            body: "For failed runs, the error message the runtime captured.",
          },
        ]}
      />

      <H2 id="playground-inspector">The playground inspector</H2>
      <P>
        While chatting in the <DocLink to="/docs/playground">Playground</DocLink>, the inspector
        panel shows the same information live, in three tabs: the latest request/response exchange,
        the stream of tool events as they happen (with a running call count), and the trace for the
        current conversation. For swarm runs, the{" "}
        <DocLink to="/docs/analytics">observability view</DocLink> adds the per-node timeline.
      </P>

      <H2 id="method">A debugging method that works</H2>
      <UL>
        <li>
          <strong>Reproduce, then read.</strong> Re-run the failing input, open the trace, and read
          the request payload before forming a theory. Most "the model is broken" reports turn out
          to be "the model was sent something other than what I assumed".
        </li>
        <li>
          <strong>Change one thing.</strong> Adjust a single line of prompt, one parameter, or the
          model — then run the same input and compare the two traces. Keeping the old trace open in
          a second tab is the closest thing prompt engineering has to a scientific method.
        </li>
        <li>
          <strong>Watch cost as a signal.</strong> A run whose cost jumps an order of magnitude
          usually means a loop, a context blow-up, or a tool feeding the model far more text than
          intended — the trace shows which.
        </li>
      </UL>

      <Note>
        The <DocLink to="/notebooks">Failure Modes Lab notebook</DocLink> is guided practice for
        exactly this skill: it produces a broken trace and asks you to find the cause.
      </Note>

      <H2 id="what-a-trace-holds">What a trace records</H2>
      <Table
        headers={["Field", "Why it matters"]}
        rows={[
          [
            "Resolved system prompt",
            "What the model was ACTUALLY told, after retrieval, memory and routing guidance were folded in. Usually not what you think you configured.",
          ],
          [
            "Each tool call",
            "Name, arguments and the raw result — including errors the model then papered over.",
          ],
          [
            "Tokens in / out",
            "Where the cost went; a huge input usually means retrieval or history, not the question.",
          ],
          ["Latency", "Per call, so you can see which step is slow."],
          ["Cost", "Attributed to the user, agent and credential that caused it."],
          ["Status", "completed / error, with the error message."],
        ]}
      />
      <Callout kind="why">
        An agent's explanation of its own reasoning is generated text — it is a plausible story
        about what happened, not a record of it. The trace is the record. When the two disagree, the
        trace is right. Debug in that order and you will stop chasing phantom problems.
      </Callout>

      <H2 id="reading">A debugging order that works</H2>
      <Steps
        items={[
          {
            title: "Read the resolved system prompt first",
            body: "Half of all surprises are here — a retrieval block that came back empty, memory that recalled something stale, or routing guidance that pushed the model at the wrong tool.",
          },
          {
            title: "Then the tool calls, in order",
            body: "Look for a call that returned an error or an empty result. Models rarely announce that a tool failed; they answer anyway.",
          },
          {
            title: "Then the token counts",
            body: "A large input with a small question means retrieval or conversation history is dominating — and paying for it every turn.",
          },
          {
            title: "Only then change the prompt",
            body: "Most prompt edits made before reading the trace fix the wrong thing.",
          },
        ]}
      />

      <H2 id="swarm-traces">Swarm traces</H2>
      <P>
        A swarm run records per-node steps, so you can see which branch a router chose, which nodes
        were skipped, where an approval waited, and what each node wrote to flow state. Runs
        triggered through the API are traced identically and attributed to the key that started
        them.
      </P>

      <H2 id="prompt-bodies">Prompt bodies</H2>
      <P>
        Whether full prompt and response bodies are stored is controlled by{" "}
        <C>PERSIST_PROMPT_BODIES</C>. Storing them makes debugging far easier and makes the trace
        store larger and more sensitive — it will contain whatever your users typed. Decide it
        deliberately, and pair it with a trace retention window.
      </P>

      <NextPrev current="/docs/debugging" />
    </>
  );
}
