import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
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
        eyebrow="Govern & operate"
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
            body: "Latency, tokens in, tokens out, and cost computed from model pricing — attributed to the user, agent and credential that caused it.",
          },
          {
            name: "Resolved system prompt",
            body: "What the model was ACTUALLY told, after retrieval, memory and routing guidance were folded in — not the template you configured. Usually the most surprising part of the record, and the first thing to read.",
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

      <H2 id="provenance">Where did this answer come from?</H2>
      <P>
        Every trace carries a <strong>decision id</strong>: its own id for a standalone chat turn,
        the run id for a node inside a swarm run. The same id is stamped on every data read a tool
        made on that answer&rsquo;s behalf, so the trace sheet&rsquo;s <strong>Provenance</strong>{" "}
        section can list them: which warehouse, which tables, and whether an agent tool did the
        reading.
      </P>
      <Callout kind="info" title="Reproducible, or only recorded">
        The decision also records which <strong>lakehouse snapshot</strong> was current when it
        began. The lakehouse can re-run a query as of that snapshot, so an answer marked{" "}
        <em>reproducible</em> can be asked again against the data exactly as it was. An answer
        marked <em>recorded, not reproducible</em> touched no lakehouse (or the snapshot could not
        be read) — the chain is still complete, but the numbers cannot be regenerated as of that
        moment. The distinction is shown rather than hidden, because it is exactly what an auditor
        would test.
      </Callout>
      <P>
        <strong>Passport</strong> downloads the whole chain as a portable JSON document — the
        decision and its snapshot, every model turn, every data read with the tables it touched, and
        notes stating what it does and does not establish. Set <C>PROVENANCE_SIGNING_SECRET</C> and
        it is signed with HMAC-SHA256 over canonical bytes (sorted keys, stable output) so a
        recipient can verify it without this instance. Leave it unset and the signature is{" "}
        <C>null</C> and the document says so — an unsigned document that looked signed would be
        worse than none.
      </P>
      <P>
        <strong>Replay reads</strong> re-runs the decision's recorded queries and answers two
        separate questions. Against the snapshot that was in force at the time, the result{" "}
        <em>must</em> match the fingerprint recorded when the answer was given — a mismatch means
        the record and the data disagree. Against today's data, a mismatch simply means the world
        moved on, which is what someone acting on an old answer needs to know. Reads that cannot be
        checked — no query text recorded, or a store with no snapshot history — say so rather than
        passing quietly. A read whose store keeps no snapshot history — an external Postgres, say —
        is re-run against today only and labelled as such: that shows whether the answer still
        holds, without claiming to have verified the record. A read whose fingerprint is missing, or
        recorded in a format this build cannot reproduce, is reported as unknown rather than as
        verified or as tampering — an alarm nobody can substantiate is worse than no alarm.
      </P>
      <P>
        A mismatch is measured, not assumed. If the as-of run differs from the record, the same
        query runs again against the same unchanged snapshot: two runs that disagree with{" "}
        <em>each other</em> prove the query is non-deterministic — <C>random()</C>, <C>now()</C>, an
        unordered <C>LIMIT</C> — and the read is reported as unable to be checked rather than as a
        disagreement. Only a query that answers consistently and still differs from the record is
        called a disagreement.
      </P>
      <P>
        Replays run under your own grants and row policies from a read-only attachment: one can
        never read more than you can, and never writes.
      </P>
      <P>
        <strong>Retention.</strong> A trace or audit row carrying a decision id is evidence, not
        telemetry, and expires on its own clock: it is kept for at least{" "}
        <C>provenance_retention_days</C> (183 by default — the EU AI Act Article 26(6) six-month
        deployer floor) even when the ordinary retention window is shorter. Shortening{" "}
        <C>trace_retention_days</C> therefore trims noise without emptying the provenance behind an
        answer. The floor never shortens retention: where the ordinary window is longer, it wins.
      </P>
      <P>
        This is evidence, not compliance — no tool grants that — and it exists only from the day
        recording began. See <DocLink to="/docs/analytics">Analytics</DocLink> for spend, and{" "}
        <C>docs/PROVENANCE.md</C> in the repository for the schema and a verification command.
      </P>

      <H2 id="playground-inspector">The playground inspector</H2>
      <P>
        While chatting in the <DocLink to="/docs/playground">Playground</DocLink>, the inspector
        panel shows the same information live, in three tabs: the latest request/response exchange,
        the stream of tool events as they happen (with a running call count), and the trace for the
        current conversation. For swarm runs, the{" "}
        <DocLink to="/docs/analytics">observability view</DocLink> adds the per-node timeline.
      </P>

      <Callout kind="why">
        An agent's explanation of its own reasoning is generated text — it is a plausible story
        about what happened, not a record of it. The trace is the record. When the two disagree, the
        trace is right. Debug in that order and you will stop chasing phantom problems.
      </Callout>

      <H2 id="method">Three habits</H2>
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

      <H2 id="symptoms">Symptom to cause</H2>
      <P>
        The same handful of failures account for most of them, and each has a signature in the trace
        that identifies it in seconds. Read the row that matches what you saw:
      </P>
      <Table
        headers={["What you saw", "What the trace shows", "Cause"]}
        rows={[
          [
            "A confident answer that is simply untrue",
            "The resolved system prompt contains no retrieved context, or a retrieval block with zero passages",
            "Retrieval matched nothing and the model answered from training. Fix the collection or the prompt's refusal rule — not the model.",
          ],
          [
            "It ignored a tool you know it has",
            "The request payload's tool list does not contain it",
            "Not enabled on this agent, or not allow-listed. If it IS in the list, the description is too vague to match the question.",
          ],
          [
            "A number that is wrong but plausible",
            <>
              No <C key="a">sql_query</C> call — the answer came from a document
            </>,
            "It read a figure out of prose instead of counting. Attach the table and enable the tool.",
          ],
          [
            "The answer stops mid-sentence",
            "Tokens out sits exactly at the configured maximum",
            "max_tokens truncation. Common cause of JSON that will not parse.",
          ],
          [
            "One run cost 20× its neighbours",
            "Tokens in is enormous while the question is short",
            "Retrieval or conversation history is dominating the prompt — and being paid for every turn.",
          ],
          [
            "It says it did something it did not do",
            "No tool call for the action it described",
            "The model narrated an intention. Only a tool call in the trace is evidence that anything happened.",
          ],
          [
            "It worked yesterday, fails today",
            "A tool call returning an error the answer never mentioned",
            "An upstream change. Models rarely announce a failed tool; they answer around it.",
          ],
        ]}
      />
      <Callout kind="warn" title="An empty result and a failed call look identical in the answer">
        Both produce a fluent reply with no sign anything went wrong, which is why the tool-call
        result — not the answer — is the thing to read. This is the single highest-yield habit on
        the page.
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

      <H3 id="swarm-inspector">Reading a run: three views, then one step</H3>
      <P>
        Open a run from <strong>Observability → Swarm Traces</strong>. The run itself has three
        views, and they answer different questions — reaching for the wrong one is why a trace can
        feel unreadable.
      </P>
      <Table
        headers={["View", "Answers"]}
        rows={[
          [
            "Canvas",
            "Which path did the run actually take? The graph you built, with the nodes that ran marked on it — the fastest way to see a branch not taken or a node skipped.",
          ],
          [
            "Timeline",
            "What happened, in order, and what did each step cost? One row per step. Click a row to open it.",
          ],
          [
            "Data flow",
            "Which edges fired, and what moved along them. The count in the tab label is the number of edges that carried anything; zero means nothing flowed, which is itself the answer when a downstream node saw no input.",
          ],
        ]}
      />
      <P>
        Clicking a step opens it with its status, latency, tokens in/out and cost at the top, then
        seven tabs holding exactly what that step saw and produced:
      </P>
      <Table
        headers={["Tab", "Contents"]}
        rows={[
          [
            "Input",
            "The step's input, as JSON — what it was actually given, not what you intended.",
          ],
          ["Output", "What it returned."],
          ["Thinking", "Reasoning text, where the model emitted any."],
          ["Tools", "Tool calls with their arguments and results."],
          ["Memory", "The memory read into this step."],
          [
            "RAG",
            "The retrieved chunks — the ones in the prompt, so an answer citing nothing shows an empty list here.",
          ],
          ["Error", "The failure message, when the step failed."],
        ]}
      />
      <Callout kind="why" title="Start at Input, not Output">
        A step that produced something wrong is usually a step that was given something wrong, and
        the Input tab settles that in one look. Working backwards from Output invites you to fix the
        prompt of a node whose real problem is upstream — the node before it wrote the wrong thing
        to flow state, and every node after inherits it.
      </Callout>

      <H2 id="prompt-bodies">Retention, and what a regulated tenant can turn off</H2>
      <P>
        Everything on this page rests on storing what people typed and what models replied. That is
        what makes debugging good and what makes the trace store sensitive. Two controls, and they
        do different jobs:
      </P>
      <Table
        headers={["Control", "Where", "Effect"]}
        rows={[
          [
            <C key="a">PERSIST_PROMPT_BODIES</C>,
            "Environment (default ON)",
            <>
              Set it to <C key="b">false</C> and free text is never written: prompts, model
              responses, node inputs and outputs, chain-of-thought.
            </>,
          ],
          [
            <>
              Trace retention (<C key="c">trace_retention_days</C>)
            </>,
            "Admin → IAM → Settings",
            "Deletes traces older than the window. 0 keeps them indefinitely.",
          ],
        ]}
      />
      <Callout kind="info" title="Turning bodies off keeps the skeleton">
        You do not lose observability — model, provider, tokens, cost, latency, status, the node
        graph and the <em>shape</em> of each tool call are all still recorded. What you lose is the
        text inside them. That is usually enough to spot a loop, a cost blow-up or a failing tool,
        and not enough to see what the user actually asked.
      </Callout>
      <Callout kind="warn" title="It is not retroactive">
        The setting drops bodies at <strong>write</strong> time. Turning it off today does nothing
        about what was captured yesterday — that is what the retention window is for. If you are
        switching it off for a compliance reason, set a retention window in the same change, or the
        existing rows sit there indefinitely.
      </Callout>

      <H2 id="use-cases">Use cases</H2>
      <H3 id="use-case-auditor">An auditor asks where a number came from</H3>
      <Steps
        items={[
          {
            title: "Open the trace under Traces",
            body: "Its Provenance section lists the decision id, every data read made for the answer — warehouse, tables, whether an agent tool did the reading — and the lakehouse snapshot that was current.",
          },
          {
            title: "Click Passport",
            body: (
              <>
                One JSON document: the decision, its snapshot, every model turn, every read with its
                result fingerprint, and notes stating what it does and does not establish. The
                auditor verifies the HMAC-SHA256 signature without this instance, using{" "}
                <C>PROVENANCE_SIGNING_SECRET</C>. An instance with no secret produces a passport
                whose signature is <C>null</C> and says so.
              </>
            ),
          },
        ]}
      />
      <H3 id="use-case-old-answer">Someone is about to act on an old answer</H3>
      <Steps
        items={[
          {
            title: "Use the Replay control on the trace",
            body: "Each recorded read runs as of the recorded snapshot, where it must reproduce the recorded fingerprint, and against today, where a difference means the data moved on.",
          },
          {
            title: "A mismatch is measured, not assumed",
            body: (
              <>
                The query runs once more against the same snapshot; two runs that disagree with each
                other prove the query is non-deterministic (<C>random()</C>, <C>now()</C>, an
                unordered <C>LIMIT</C>) and the read is reported as unable to be checked. Reads with
                no query text, no snapshot history, or an unrecognised fingerprint format say so
                rather than passing quietly.
              </>
            ),
          },
        ]}
      />
      <H3 id="use-case-ai-act">Evidence for the EU AI Act</H3>
      <P>
        Set <C>trace_retention_days</C> as low as the noise budget wants and leave{" "}
        <C>provenance_retention_days</C> at 183 or higher: every trace and audit row carrying a
        decision id is kept for at least that long, whatever the ordinary window says, and the floor
        never shortens a longer window. Article 26(6) asks deployers of high-risk systems for six
        months; the default meets it.
      </P>

      <NextPrev current="/docs/debugging" />
    </>
  );
}
