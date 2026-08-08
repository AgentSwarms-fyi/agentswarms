import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  Diagram,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/swarms")({
  head: () => ({
    meta: [
      { title: "Swarm Canvas — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Complete reference for all 18 swarm node kinds, their configuration fields, flow state and templating, error handling, running and exporting.",
      },
      { property: "og:title", content: "Swarm Canvas — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Every node kind and every field, with worked examples.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/swarms" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/swarms" }],
  }),
  component: SwarmsPage,
});

function SwarmsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Swarm Canvas"
        description="A swarm is a directed graph of nodes. Output flows along the edges, shared state flows through all of them. This page documents all eighteen node kinds and every field on each."
      />

      <P>
        Open <strong>Build → Agent Swarms</strong>. Drag a node from the palette, click it to open
        the <strong>inspector</strong> on the right, and configure it there. Connect nodes by
        dragging from one handle to another.
      </P>

      {/* ── FLOW STATE ── */}
      <H2 id="flow-state">Flow state and templating</H2>
      <P>
        Every node can read from and write to a shared key/value <strong>flow state</strong>. This
        is what makes a graph more than a chain.
      </P>
      <Table
        headers={["Field", "Present on", "Meaning"]}
        rows={[
          [
            <C key="a">outputVar</C>,
            "Every node",
            "Name the variable this node writes its result to. Without it, the result is only available to the immediately next node.",
          ],
          [
            <C key="b">inputs</C>,
            "Every node",
            "Names of variables this node reads from state. A merge node uses this to decide what to combine.",
          ],
        ]}
      />
      <P>Anywhere a field accepts a template, these forms resolve:</P>
      <Table
        headers={["Template", "Resolves to"]}
        rows={[
          [<C key="a">{"{{input}}"}</C>, "The value arriving on the incoming edge"],
          [<C key="b">{"{{myVar}}"}</C>, "A named variable from flow state"],
          [<C key="c">{"{{myVar.path.to.field}}"}</C>, "A nested field of a JSON value in state"],
          [
            <C key="d">{"{{secret:NAME}}"}</C>,
            <>
              A stored{" "}
              <DocLink key="s" to="/docs/secrets">
                secret
              </DocLink>
              . Resolved <strong>server-side only</strong> — the value never reaches the browser.
            </>,
          ],
        ]}
      />
      <Callout kind="why">
        <C>{"{{secret:NAME}}"}</C> is deliberately left untouched by the client-side interpolator
        and substituted on the server at call time. That is what lets an HTTP node authenticate to a
        third-party API without the credential ever being sent to, or visible in, the canvas.
      </Callout>

      {/* ── NODE REFERENCE ── */}
      <H2 id="nodes">All eighteen node kinds</H2>

      <H3 id="n-input">input</H3>
      <P>
        The entry point. Optionally renders a typed form in the Run panel instead of one free-text
        box — each field's value is seeded into flow state under its own name.
      </P>
      <Table
        headers={["Field", "Values", "Notes"]}
        rows={[
          [<C key="a">inputFields[].name</C>, "string", "The variable name it writes to state"],
          [<C key="b">inputFields[].label</C>, "string", "Shown above the field"],
          [
            <C key="c">inputFields[].type</C>,
            "text / textarea / number / select",
            <>
              <C key="s">select</C> also needs <C key="o">options</C>
            </>,
          ],
          [<C key="d">inputFields[].options</C>, "string[]", "For select"],
          [<C key="e">inputFields[].placeholder</C>, "string", "—"],
          [<C key="f">inputFields[].required</C>, "boolean", "Blocks the run until filled"],
        ]}
      />

      <H3 id="n-agent">agent</H3>
      <P>The workhorse: one LLM call, with optional tools, knowledge and memory.</P>
      <Table
        headers={["Field", "Values", "Notes"]}
        rows={[
          [
            <C key="a">agentId</C>,
            "saved agent",
            "Link a saved agent to inherit its whole configuration. The fields below then override it.",
          ],
          [<C key="b">systemPrompt</C>, "template", "Supports {{var}} templating"],
          [<C key="c">provider</C>, "provider id", "—"],
          [
            <C key="d">model</C>,
            "model id",
            "Per-node — a router can use a cheap model while a writer uses a strong one",
          ],
          [
            <C key="e">temperature</C>,
            "0 – 2",
            "Same guidance as the agent builder: 0 for anything mechanical",
          ],
          [<C key="f">knowledgeBaseId</C>, "KB id", "Grounds this node's call"],
          [<C key="g">reranker</C>, "{provider, model}", "Optional retrieval re-ranker"],
          [
            <C key="h">enabledTools</C>,
            "tool ids",
            "When set, ONLY these tools are exposed to this node",
          ],
          [<C key="i">skillIds</C>, "skill ids", 'Prepends a "Skills available to you" block'],
          [
            <C key="j">toolConfigs</C>,
            "object",
            "Per-tool config: web provider+key, n8n ids, MCP server names, SQL table allow-list",
          ],
          [
            <C key="k">guardrails</C>,
            "partial",
            "Merged OVER the linked agent's — a node can be stricter, never looser",
          ],
          [<C key="l">memory</C>, "object", "See memory scope below"],
        ]}
      />
      <H3 id="node-memory">Node memory scope</H3>
      <Table
        headers={["ltm_scope", "Behaviour"]}
        rows={[
          [
            <C key="a">agent</C>,
            "Default. Shares long-term memory with the agent's normal sessions.",
          ],
          [
            <C key="b">swarm</C>,
            "Isolated to this swarm run — the run id is the conversation key.",
          ],
          [<C key="c">none</C>, "Long-term memory disabled for this node."],
        ]}
      />

      <H3 id="n-condition">condition</H3>
      <P>Two-way branch. The LLM answers a yes/no question and the matching edge is taken.</P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [
            <C key="a">conditionPrompt</C>,
            "A question whose YES/NO answer chooses the edge. Write it so the answer is unambiguous.",
          ],
        ]}
      />
      <Code lang="conditionPrompt">{`Does the customer's message describe a fault with a physical product
(as opposed to a billing, delivery or account question)?`}</Code>

      <H3 id="n-router">router</H3>
      <P>
        N-way branch. The LLM picks one of the <strong>outgoing edge labels</strong>; the matching
        branch runs and the others are marked skipped.
      </P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [
            <C key="a">routerPrompt</C>,
            "Instruction for choosing. Name the categories exactly as you labelled the edges.",
          ],
        ]}
      />
      <Callout kind="warn" title="Label your edges">
        A router chooses among edge labels. Unlabelled edges give it nothing to pick, and it will
        route arbitrarily. Label every outgoing edge with a short distinct word: <C>billing</C>,{" "}
        <C>technical</C>, <C>other</C>.
      </Callout>

      <H3 id="n-loop">loop</H3>
      <Table
        headers={["Field", "Default", "Notes"]}
        rows={[
          [
            <C key="a">maxIters</C>,
            "—",
            "Hard ceiling on iterations. ALWAYS set this; an unbounded loop is the classic runaway cost.",
          ],
        ]}
      />

      <H3 id="n-foreach">foreach</H3>
      <P>Maps this node's agent body over each element of an array.</P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [<C key="a">foreachInput</C>, "Variable holding the array"],
          [<C key="b">foreachItemVar</C>, "Name each element is exposed under inside the body"],
        ]}
      />

      <H3 id="n-approval">approval</H3>
      <P>Pauses the run until a human decides.</P>
      <Table
        headers={["Field", "Values", "Notes"]}
        rows={[
          [<C key="a">approvalTitle</C>, "string", "What the approver sees"],
          [<C key="b">approvalRisk</C>, "low / medium / high", "Shown to the approver as context"],
          [<C key="c">approvalTimeoutMs</C>, "number", "0 or unset = wait indefinitely"],
          [<C key="d">approverUserIds</C>, "user ids", "Who is notified and may decide"],
          [<C key="e">approverGroupIds</C>, "IAM group ids", "Same, by group"],
        ]}
      />
      <Callout kind="info">
        With both approver lists empty, only the person who started the run can decide it. The
        runner is emailed only if they explicitly appear in the lists — picked individually, or via
        a group they belong to.
      </Callout>

      <H3 id="n-evaluate">evaluate</H3>
      <P>LLM-as-a-judge scoring. Five metrics ship enabled, with these default weights:</P>
      <Table
        headers={["Metric", "Weight", "Checks"]}
        rows={[
          [
            "Faithfulness",
            "0.30",
            "Are all claims grounded in the provided context? Catches hallucinations.",
          ],
          [
            "Answer Relevancy",
            "0.25",
            "Does the answer address the question, or is it tangential?",
          ],
          ["Completeness", "0.20", "Does it cover all parts of the question?"],
          ["Coherence", "0.15", "Is it logically structured and clear?"],
          ["Harmlessness", "0.10", "Free of harmful, biased or toxic content?"],
        ]}
      />
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [<C key="a">evalMetrics</C>, "Enable/disable each and set its weight (0–1)"],
          [<C key="b">evalRubric</C>, "Free-form rubric the judge must follow"],
          [<C key="c">evalCustomInstructions</C>, "Extra instructions for the judge"],
          [
            <C key="d">evalPassThreshold</C>,
            "0–1. The weighted overall score must meet this to pass",
          ],
          [
            <C key="e">evalReferenceInput</C>,
            "Variable holding the original question/context to judge against",
          ],
        ]}
      />

      <H3 id="n-function">function</H3>
      <P>
        Sandboxed JavaScript. Receives <C>ctx</C> = <C>{"{ input, vars }"}</C> and must{" "}
        <C>return</C> a value.
      </P>
      <Code lang="functionCode">{`// Normalise a messy list into the shape the next node expects.
const rows = ctx.input.items ?? [];
return rows
  .filter((r) => r.status === "open")
  .map((r) => ({ id: r.id, owner: r.assignee?.name ?? "unassigned" }));`}</Code>
      <Table
        headers={["Field", "Default", "Notes"]}
        rows={[
          [
            <C key="a">functionTimeoutMs</C>,
            "2000",
            "Hard timeout. The code runs in an isolated Worker with no network or DOM access.",
          ],
        ]}
      />

      <H3 id="n-set-var">set_var</H3>
      <P>
        Writes named keys into flow state. Each value is a template resolved against current state.
      </P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [
            <C key="a">stateAssignments</C>,
            "Array of { key, value } — value supports {{var}} and {{var.path}}",
          ],
        ]}
      />

      <H3 id="n-http">http</H3>
      <P>A deterministic outbound request — no LLM involved.</P>
      <Table
        headers={["Field", "Values", "Notes"]}
        rows={[
          [<C key="a">httpMethod</C>, "GET / POST / PUT / PATCH / DELETE", "—"],
          [<C key="b">httpUrl</C>, "template", "Supports {{var}} and {{secret:NAME}}"],
          [
            <C key="c">httpHeaders</C>,
            "{key, value}[]",
            "Same templating — put tokens in {{secret:…}}",
          ],
          [<C key="d">httpBody</C>, "template", "—"],
          [
            <C key="e">httpResponsePath</C>,
            "JSON path",
            "Extract one field from the response instead of passing the whole body on",
          ],
          [<C key="f">httpTimeoutMs</C>, "number", "—"],
        ]}
      />
      <Code lang="http node — create a ticket">{`Method:  POST
URL:     https://api.example.com/v1/tickets
Headers: Authorization: Bearer {{secret:SUPPORT_API_TOKEN}}
         Content-Type:  application/json
Body:    {"subject": "{{summary}}", "body": "{{input}}", "priority": "{{priority}}"}
Path:    data.id`}</Code>
      <Callout kind="warn">
        Requests to private, loopback and link-local addresses — including cloud metadata endpoints
        — are refused, so a templated URL cannot be steered into your internal network.
      </Callout>

      <H3 id="n-tool">tool</H3>
      <P>Runs one built-in tool deterministically, with arguments you supply — no LLM decides.</P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [
            <C key="a">toolId</C>,
            "One of the ten swarm tool ids (kb_search, sql_query, web_search, …)",
          ],
          [
            <C key="b">toolArgs</C>,
            "Record of argument name → template, resolved against flow state",
          ],
        ]}
      />
      <Callout kind="why">
        Use a <C>tool</C> node instead of an <C>agent</C> node whenever the call is not a judgement
        call. If you always want the same query run, having a model decide to run it is pure cost
        and a source of variance.
      </Callout>

      <H3 id="n-extract">extract</H3>
      <P>LLM structured output. Produces a JSON object matching a schema you declare.</P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [
            <C key="a">extractSchema</C>,
            "Array of { name, type, description }. type is string | number | boolean | array.",
          ],
        ]}
      />
      <Code lang="extractSchema">{`name: customer_name   type: string   "Full name as written"
name: order_id        type: string   "Order reference, e.g. NW-10482"
name: refund_amount   type: number   "Amount in GBP, 0 if none requested"
name: is_urgent       type: boolean  "True if they mention a deadline"`}</Code>

      <H3 id="n-merge">merge</H3>
      <P>
        Combines this node's declared <C>inputs</C> into one value.
      </P>
      <Table
        headers={["mergeMode", "Result"]}
        rows={[
          [
            <C key="a">concat</C>,
            <>
              Joined text, separated by <C key="s">mergeSeparator</C> (default two newlines)
            </>,
          ],
          [<C key="b">array</C>, "A JSON array of the input values"],
          [<C key="c">object</C>, "A JSON object keyed by variable name"],
          [
            <C key="d">first</C>,
            "The first non-empty input — useful after a router where only one branch ran",
          ],
        ]}
      />

      <H3 id="n-retrieve">retrieve</H3>
      <P>Standalone knowledge-base retrieval with no LLM call.</P>
      <Table
        headers={["Field", "Default", "Notes"]}
        rows={[
          [<C key="a">knowledgeBaseId</C>, "—", "Which collection to search"],
          [
            <C key="b">retrieveQuery</C>,
            <C key="i">{"{{input}}"}</C>,
            "Template for the search query",
          ],
          [<C key="c">retrieveTopK</C>, "—", "How many chunks to return"],
        ]}
      />

      <H3 id="n-subswarm">subswarm</H3>
      <P>
        Runs another saved swarm as a single node; its final output becomes this node's output. It
        executes in isolation with the input you gather for it.
      </P>
      <Table
        headers={["Field", "Notes"]}
        rows={[[<C key="a">subSwarmId</C>, "The saved swarm to run"]]}
      />

      <H3 id="n-a2a">a2a_remote</H3>
      <P>Delegates to a remote agent server speaking the A2A protocol.</P>
      <Table
        headers={["Field", "Notes"]}
        rows={[
          [<C key="a">a2aEndpoint</C>, "Remote server URL"],
          [<C key="b">a2aAgentCard</C>, "The fetched agent card describing its skills"],
          [<C key="c">a2aSkillId</C>, "Which advertised skill to invoke"],
          [<C key="d">a2aAuthHeader</C>, "Auth header value — use {{secret:NAME}}"],
          [<C key="e">a2aStreaming</C>, "Stream the remote response"],
        ]}
      />

      <H3 id="n-output">output</H3>
      <P>
        Terminal node. Its value is the swarm's result — what an API run returns and what a callback
        delivers.
      </P>

      {/* ── ERROR HANDLING ── */}
      <H2 id="errors">Error handling</H2>
      <P>
        These apply to <C>agent</C>, <C>http</C>, <C>tool</C>, <C>foreach</C>, <C>extract</C>,{" "}
        <C>evaluate</C>, <C>a2a_remote</C>, <C>function</C> and <C>loop</C>:
      </P>
      <Table
        headers={["Field", "Default", "Effect"]}
        rows={[
          [<C key="a">retryCount</C>, "0", "Retries on transient failure"],
          [<C key="b">retryDelayMs</C>, "—", "Wait between retries"],
          [
            <C key="c">onError</C>,
            <C key="f">fail</C>,
            <>
              <C key="x">fail</C> aborts the run. <C key="y">continue</C> writes{" "}
              <C key="z">errorFallback</C> to the output variable and carries on.
            </>,
          ],
          [<C key="d">errorFallback</C>, "—", "The value used when onError is continue"],
          [<C key="e">nodeTimeoutMs</C>, "0 = default", "Per-node call timeout override"],
        ]}
      />
      <Callout kind="info">
        Use <C>onError: continue</C> with a fallback on enrichment steps — a failed lookup shouldn't
        kill a run that can still produce something useful. Keep <C>fail</C> on anything whose
        result the rest of the graph depends on.
      </Callout>

      {/* ── WORKED EXAMPLE ── */}
      <H2 id="worked-example">Worked example — a support triage swarm</H2>
      <Diagram caption="Router splits by intent; refunds pass a human gate before the API call.">{`input ──▶ extract ──▶ router ─┬─[billing]──▶ agent(billing) ──┐
        (customer,          │                                │
         order_id,          ├─[technical]▶ agent(tech KB) ────┤
         refund_amount)     │                                │
                            └─[refund]───▶ approval ──▶ http ─┤
                                                              ▼
                                                            merge ──▶ output
                                                          (mode: first)`}</Diagram>
      <Steps
        items={[
          {
            title: "input",
            body: (
              <>
                One field: <C>message</C>, type <C>textarea</C>, required.
              </>
            ),
          },
          {
            title: "extract",
            body: (
              <>
                Schema as shown above. <C>outputVar</C> = <C>ticket</C>. Now{" "}
                <C>{"{{ticket.refund_amount}}"}</C> is available downstream.
              </>
            ),
          },
          {
            title: "router",
            body: (
              <>
                Three outgoing edges labelled <C>billing</C>, <C>technical</C>, <C>refund</C>.
                routerPrompt: <em>"Classify this message as billing, technical or refund."</em>{" "}
                Model: a small fast one — this is classification, so temperature 0.
              </>
            ),
          },
          {
            title: "agent nodes",
            body: (
              <>
                Each links a saved agent and sets its own <C>knowledgeBaseId</C>. All write to{" "}
                <C>outputVar</C> = <C>reply</C>.
              </>
            ),
          },
          {
            title: "approval",
            body: (
              <>
                Title "Approve refund", risk <C>high</C>, approverGroupIds = your finance group. No
                timeout, so it waits.
              </>
            ),
          },
          {
            title: "http",
            body: (
              <>
                POST to your refunds API with{" "}
                <C>Authorization: Bearer {"{{secret:REFUND_API_TOKEN}}"}</C>. onError <C>fail</C> —
                a silently failed refund is worse than a stopped run.
              </>
            ),
          },
          {
            title: "merge → output",
            body: (
              <>
                mergeMode <C>first</C>, since exactly one branch ran.
              </>
            ),
          },
        ]}
      />

      {/* ── RUNNING ── */}
      <H2 id="running">Running and observing</H2>
      <UL>
        <li>
          <strong>Run panel</strong> — fills the input form, streams node status live (idle,
          running, done, error, waiting, skipped) and shows each node's last output.
        </li>
        <li>
          <strong>Recent runs</strong> — history with inputs and results.
        </li>
        <li>
          <strong>Traces</strong> — per-node steps with prompts, tool calls, tokens and cost. See{" "}
          <DocLink to="/docs/debugging">Logs &amp; traces</DocLink>.
        </li>
        <li>
          <strong>Versions</strong> — the graph is snapshotted on save; diff and restore.
        </li>
      </UL>

      <H2 id="deploy">Deploying</H2>
      <P>
        <strong>Deploy</strong> gives a swarm an API key so your own systems can run it, and{" "}
        <strong>Chat</strong> exposes it as a conversational surface. A schedule can run it
        unattended. Full detail in <DocLink to="/docs/api">API &amp; webhooks</DocLink> and{" "}
        <DocLink to="/docs/embedding">Web embedding</DocLink>.
      </P>
      <P>
        The canvas edits a <strong>draft</strong>; deployed runs execute the{" "}
        <strong>published</strong> snapshot. Creating the first key or schedule publishes the
        current graph, and after that your saves stay private until you press{" "}
        <strong>Publish</strong> — so you can rewrite a prompt at 3am without changing what a live
        integration receives. The Deploy dialog shows <em>Draft ahead</em> whenever the canvas has
        moved on, and <DocLink to="/docs/api">API &amp; webhooks</DocLink> covers the states.
      </P>

      <H2 id="components">Custom components</H2>
      <P>
        A <strong>Function</strong> node holds a snippet used once. <strong>Components</strong> are
        the reusable form: author a snippet with a declared parameter schema in the palette&rsquo;s{" "}
        <em>My components → Manage</em>, and it appears in the palette of every swarm you build.
      </P>
      <Table
        headers={["Piece", "What it is"]}
        rows={[
          [
            "Parameters",
            'Declared per component (text, number, boolean, select — with labels, defaults and required flags). Each becomes a field on the node and arrives in the code as ctx.params, typed: a number parameter is a number, not "5".',
          ],
          [
            "Code",
            "Runs in the same sandboxed Worker as a Function node — no DOM, no network, no storage, hard timeout. ctx.input is the upstream value, ctx.vars the flow state.",
          ],
          [
            "Test harness",
            "Runs your snippet with the same sandbox and the same parameter coercion the canvas uses, so a passing test means a passing node.",
          ],
          [
            "Versions",
            "Saving bumps the component's version. Nodes carry a SNAPSHOT of the code they were built with, so editing the library never silently changes a swarm that already works — and a deleted component leaves working swarms working.",
          ],
        ]}
      />
      <Callout kind="info">
        <strong>Where custom code runs.</strong> On the canvas it runs in your browser, in a Worker
        with the dangerous globals removed. In <em>deployed</em> (API-key) and <em>scheduled</em>
        runs there is no browser, so it runs in the <strong>JS sandbox</strong> — a separate
        container with no secrets, no filesystem and no route to the internet, giving each call a
        fresh JavaScript realm that is destroyed afterwards. Your snippet sees exactly the same{" "}
        <code className="font-mono">ctx.input</code>, <code className="font-mono">ctx.vars</code>{" "}
        and <code className="font-mono">ctx.params</code> either way.
      </Callout>
      <Callout kind="warn">
        The sandbox is an <strong>opt-in service</strong>:{" "}
        <code className="font-mono">docker compose --profile sandbox up -d --build</code>. Until an
        operator starts it, deployed and scheduled runs refuse custom code rather than executing it
        beside the server&rsquo;s credentials — and the Deploy dialog tells you so, for this
        instance specifically, before you deploy. Custom code never runs in the application process
        either way.
      </Callout>

      <H2 id="file-inputs">File inputs</H2>
      <P>
        A start-form field of type <strong>file</strong> lets whoever runs the swarm attach a PDF,
        DOCX or text document. The file is converted to text in the browser and that text is seeded
        into flow state under the field&rsquo;s name — so downstream nodes read it like any other
        variable, and no document is ever uploaded to the server.
      </P>
      <Table
        headers={["Limit", "Value", "What happens at the edge"]}
        rows={[
          ["File size", "10 MB", "Larger files are refused before parsing"],
          [
            "Extracted text",
            "200,000 characters",
            "Longer documents are truncated, with a visible notice in the field and in the text itself — never silently",
          ],
          [
            "Scanned PDFs",
            "—",
            "A PDF with no text layer yields nothing and is refused with a message pointing at OCR",
          ],
        ]}
      />

      <H2 id="evaluations">Batch evaluations</H2>
      <P>
        A swarm that works on the prompt you tried it with can still regress on the other forty.{" "}
        <strong>Evaluations</strong> (under Experiment in the sidebar) runs a whole dataset of test
        cases through a swarm headlessly and scores every output, so a prompt tweak is measured
        rather than guessed at.
      </P>
      <Table
        headers={["Piece", "What it is"]}
        rows={[
          [
            "Dataset",
            "Named collection of cases. A case is an input, optional typed start-form values, and an optional expected answer. Import a CSV — columns beyond name/input/expected become start-form values.",
          ],
          [
            "Evaluator",
            "How every output in the run is scored: an LLM judge (weighted metrics, 0–1, with a pass threshold), or a deterministic check — contains, exactly equals, or a regex.",
          ],
          [
            "Run",
            "One dataset × one swarm × one evaluator. Cases execute on the same headless engine as a deployed API run, two at a time; progress, pass rate, average score and model spend are recorded.",
          ],
          [
            "Comparison",
            "Pick an earlier run on the same dataset with the same evaluator and every case is paired: improved, regressed or unchanged, with the score delta.",
          ],
        ]}
      />
      <Callout kind="info">
        The judge&rsquo;s verdict is recomputed from its per-metric scores and your weights — the
        model&rsquo;s own &ldquo;pass&rdquo; claim is never trusted. A scorecard that skips a metric
        is rejected rather than counted as zero, so a lazy judge fails loudly instead of quietly
        failing your swarm.
      </Callout>
      <P>
        Runs are resumable and cancellable: cancelling is enforced server-side, and a case that
        already has a verdict is never scored twice, so &ldquo;run remaining&rdquo; picks up exactly
        where it stopped. Approval nodes are auto-rejected by default — leave that on unless the
        swarm is safe to auto-approve in a batch. Each result links to its full execution trace.
      </P>

      <H2 id="export">Export</H2>
      <Table
        headers={["Target", "Fidelity"]}
        rows={[
          ["LangGraph", "Full topology — branches, loops and conditional edges survive"],
          ["Strands", "GraphBuilder with the node graph"],
          ["OpenAI Agents SDK", "Agents plus post-assigned handoffs"],
          ["CrewAI", "Sequential process"],
        ]}
      />
      <Callout kind="info">
        Frameworks that cannot express a node kind get the graph re-wired around it: agent-to-agent
        edges are bridged through the dropped node so the topology still connects, rather than
        emitting a broken graph.
      </Callout>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause", "Fix"]}
        rows={[
          [
            "Router always picks the same branch",
            "Unlabelled or similarly-labelled edges",
            "Give every outgoing edge a short distinct label; set temperature 0 on the router.",
          ],
          [
            "A branch's output is empty at merge",
            "Only one branch ran",
            <>
              Use mergeMode <C key="f">first</C>.
            </>,
          ],
          [
            "Run never finishes",
            "Loop without maxIters, or an approval with no approver",
            "Set maxIters; check approverUserIds/approverGroupIds.",
          ],
          [
            "Variable is empty downstream",
            "outputVar not set on the producing node",
            "Set outputVar, and list it in the consumer's inputs.",
          ],
          [
            "HTTP node 401s",
            "Secret not resolving",
            <>
              Use <C key="s">{"{{secret:NAME}}"}</C> exactly; a raw token in the header is sent as
              literal text.
            </>,
          ],
          [
            "Function node times out",
            "Loop or heavy work in sandbox",
            <>
              Raise <C key="t">functionTimeoutMs</C>, or move the work to an http node.
            </>,
          ],
          [
            "Node ignores its guardrails",
            "Node guardrails only tighten",
            "They merge OVER the linked agent's; they cannot loosen what the agent enforces.",
          ],
        ]}
      />

      <NextPrev current="/docs/swarms" />
    </>
  );
}
