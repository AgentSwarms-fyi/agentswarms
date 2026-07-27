import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  Diagram,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/guardrails")({
  head: () => ({
    meta: [
      { title: "Guardrails & PII — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Input and output guardrails, topic blocking, citation requirements, and detecting or redacting personal data before it reaches a model.",
      },
      { property: "og:title", content: "Guardrails & PII — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Controls that hold even when the prompt is manipulated.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/guardrails" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/guardrails" }],
  }),
  component: GuardrailsPage,
});

function GuardrailsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Govern & operate"
        title="Guardrails & PII"
        description="Checks that run outside the model, on the way in and on the way out — which is why they still hold when someone talks the agent out of its instructions."
      />

      <P>
        Configure them per agent in the <DocLink to="/docs/agents">Agent Builder</DocLink> under{" "}
        <strong>Guardrails</strong>. Swarm nodes can add their own on top of the agent's.
      </P>

      <Diagram caption="Guardrails sit either side of the model, not inside it.">{`user input
    │
    ▼
[ input guardrails ]  ── blocked? ──▶ refuse, never call the model
    │
    ▼
  model + tools
    │
    ▼
[ output guardrails ] ── blocked? ──▶ replace the answer
    │                  ── redact?  ──▶ rewrite before display
    ▼
 answer to user`}</Diagram>

      <Callout kind="why">
        A system prompt is a <em>request</em> to the model, and a sufficiently clever input can talk
        it into ignoring one. A guardrail is code that runs whether or not the model cooperated —
        which is why "tell it not to discuss X in the prompt" and "block X in guardrails" are not
        the same control, even though they look similar in a demo.
      </Callout>

      <H2 id="input">Input guardrails</H2>
      <FieldList
        items={[
          {
            name: "Blocked topics",
            body: "Refuse messages about subjects this agent must not engage with. Checked before any model call — so it also saves the tokens.",
          },
          {
            name: "Maximum input length",
            body: "Reject very long inputs. Protects context budget and blunts the cheapest denial-of-wallet attack on a public embed.",
          },
          {
            name: "PII handling on input",
            body: "Detect personal data in what the user typed and redact it before it is sent to a model provider or stored.",
          },
        ]}
      />

      <H2 id="output">Output guardrails</H2>
      <FieldList
        items={[
          {
            name: "Blocked topics",
            body: "Suppress an answer that strayed into forbidden territory, replacing it with a refusal.",
          },
          {
            name: "Require citations",
            body: "For retrieval-grounded agents: flag an answer that cites nothing when sources were available. A confident uncited answer is the shape an invented one takes.",
          },
          { name: "Maximum output length", body: "Cap reply length." },
          {
            name: "PII handling on output",
            body: "Catch personal data on the way out — including data the agent legitimately retrieved but shouldn't repeat to this audience.",
          },
        ]}
      />

      <H2 id="pii">Personal data</H2>
      <P>Eight entity types are recognised:</P>
      <Table
        headers={["Type", "Notes"]}
        rows={[
          ["Email address", "Straightforward pattern."],
          ["Phone number", "International and local formats."],
          [
            "Credit card number",
            "Validated with a Luhn checksum, so a random 16-digit order number isn't flagged.",
          ],
          ["National insurance / SSN", "Format-validated."],
          ["IP address", "IPv4 and IPv6."],
          ["Postal address", "Common address shapes."],
          ["Date of birth", "Date patterns in a birth-date context."],
          ["Passport / ID number", "Format-validated."],
        ]}
      />
      <H3 id="modes">Modes</H3>
      <Table
        headers={["Mode", "Behaviour", "Use when"]}
        rows={[
          ["Off", "No detection.", "Nothing personal can reach this agent."],
          [
            "Detect",
            "Flags and records, doesn't alter the text.",
            "You're measuring exposure before enforcing.",
          ],
          [
            "Redact",
            "Replaces matches with placeholders like [REDACTED_EMAIL].",
            "The default for anything public-facing.",
          ],
          [
            "Block",
            "Refuses the message entirely.",
            "Regulated contexts where even a redacted trace is unwanted.",
          ],
        ]}
      />
      <P>
        Choose which entity types to act on and whether the policy applies to input, output or both.
        A support agent typically redacts on input (visitors paste their details) and detects on
        output (so you can see whether it's repeating them).
      </P>
      <Callout kind="warn" title="Detection is patterns, not comprehension">
        Pattern matching catches the common shapes and will miss unusual formats, and occasionally
        flag something innocent. It meaningfully reduces exposure; it is not a compliance guarantee.
        Where the requirement is legal rather than best-effort, keep the data out of the agent's
        reach in the first place.
      </Callout>

      <H2 id="where">Where they apply</H2>
      <P>
        The same guardrail module runs on every path an agent answers through — the playground,
        saved agents, swarm nodes and public embeds. There is no surface where the checks are
        skipped, which matters most for <DocLink to="/docs/embedding">embeds</DocLink>, where the
        visitor is anonymous.
      </P>

      <H2 id="practice">Practical setup</H2>
      <UL>
        <li>
          <strong>Start in detect mode.</strong> Run for a week, look at what it flags, then switch
          to redact. Enforcing blind produces false positives you'll get blamed for.
        </li>
        <li>
          <strong>Guardrails complement the prompt, not replace it.</strong> Keep telling the agent
          what it's for; the guardrail is what holds when the telling fails.
        </li>
        <li>
          <strong>Require citations on retrieval agents.</strong> It's the cheapest hallucination
          detector available.
        </li>
        <li>
          <strong>Test adversarially.</strong> Ask your own agent to ignore its instructions, reveal
          its prompt, and repeat a customer's phone number. Do this before publishing, not after.
        </li>
        <li>
          <strong>Pair with retention.</strong> Guardrails limit what's said; retention limits how
          long it's kept. See <DocLink to="/docs/budgets">retention</DocLink>.
        </li>
      </UL>

      <NextPrev current="/docs/guardrails" />
    </>
  );
}
