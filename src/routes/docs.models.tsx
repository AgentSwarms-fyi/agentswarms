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
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/models")({
  head: () => ({
    meta: [
      { title: "Models & providers — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Connect your own model providers, understand BYOK, curate the model registry, and choose the right model for each job.",
      },
      { property: "og:title", content: "Models & providers — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Bring your own keys, curate what's available, pick the right model.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/models" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/models" }],
  }),
  component: ModelsPage,
});

function ModelsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Integrate & ship"
        title="Models & providers"
        description="Which models your workspace can reach, whose account pays for them, and how to pick sensibly between them."
      />

      <H2 id="byok">Bring your own key</H2>
      <P>
        Connect provider credentials under <strong>Integrations</strong> and every call runs against
        your account: your rates, your quota, your data agreement with that provider. The operator's
        shared key exists only so a brand-new workspace works before anything is connected.
      </P>
      <Callout kind="why">
        BYOK is a data-governance property, not a billing convenience. Your prompts, documents and
        query results travel to a provider <em>you</em> chose and hold the contract with — including
        whatever that contract says about training on your data. Connecting your own key is the
        difference between "some vendor sees this" and "the vendor we approved sees this".
      </Callout>

      <H3 id="providers">Supported providers</H3>
      <Table
        headers={["Provider", "Notes"]}
        rows={[
          ["OpenAI", "Direct API key; optional organization id."],
          ["Anthropic", "Direct API key."],
          [
            "Amazon Bedrock",
            "AWS credentials + region. Good when data must stay in your AWS account.",
          ],
          ["Google Vertex AI", "Service-account credentials + project/region."],
          ["Azure OpenAI", "Endpoint + deployment name + key."],
          ["OCI Generative AI", "Oracle Cloud tenancy credentials."],
          ["Grok (xAI), Qwen", "Direct API keys."],
          ["OpenRouter", "One key, many models — the simplest way to try several."],
          [
            "Any OpenAI-compatible endpoint",
            "Point at a self-hosted or third-party gateway that speaks the OpenAI chat API.",
          ],
        ]}
      />
      <P>
        Keys are encrypted at rest. Prefer storing them in{" "}
        <DocLink to="/docs/secrets">Secrets</DocLink> and referencing them, so a rotation is one
        edit rather than a hunt through every connector.
      </P>

      <H2 id="registry">Model registry</H2>
      <P>
        <strong>Configure → Model Registry</strong> curates which models appear in pickers across
        the app. Left alone, every model your connected providers expose is offered — which is
        rarely what you want on a shared instance, where a handful of sensible defaults beats a list
        of two hundred.
      </P>
      <UL>
        <li>Enable or hide models per provider.</li>
        <li>
          Record context window and cost so pickers can show the trade-off at the point of choice.
        </li>
        <li>Set the workspace default for new agents.</li>
      </UL>
      <P>
        The registry is about <em>visibility</em>. To control what a particular person is{" "}
        <em>allowed</em> to run, use model rules in <DocLink to="/docs/iam">Access control</DocLink>{" "}
        — those are enforced server-side on every request, not just hidden in the UI.
      </P>

      <H2 id="choosing">Choosing a model</H2>
      <P>
        There is no single best model; there is a fit per job. A rough guide that holds up in
        practice:
      </P>
      <Table
        headers={["Job", "What to favour"]}
        rows={[
          [
            "Classification, routing, extraction",
            "The smallest capable model. Cheap and fast; the task is mechanical.",
          ],
          [
            "Retrieval-grounded Q&A",
            "Mid-tier with a large context window — the work is reading, not reasoning.",
          ],
          [
            "Multi-step tool use / swarm orchestration",
            "A strong model. Weak models pick the wrong tool and loop.",
          ],
          ["Long-form drafting", "A strong model, higher temperature."],
          ["Code generation", "A code-tuned model where your provider offers one."],
          ["Vision (screenshots, scans)", "A vision-capable model — check the registry entry."],
        ]}
      />
      <Callout kind="info">
        Start smaller than you think and upgrade when you can point at a specific failure. Most "the
        model isn't good enough" turns out to be a thin prompt, a missing tool, or retrieval that
        returned nothing — all visible in <DocLink to="/docs/debugging">the trace</DocLink>, and
        none fixed by a bigger model.
      </Callout>

      <H3 id="params">Temperature and tokens</H3>
      <FieldList
        items={[
          {
            name: "Temperature",
            body: "How much randomness. Near 0 for extraction, classification and anything you'll parse; 0.5–0.8 for writing. High temperature on a tool-using agent makes it erratic about which tool it calls.",
          },
          {
            name: "Max tokens",
            body: "A cap on the reply length. Too low truncates mid-sentence — a common cause of a JSON response that won't parse.",
          },
          {
            name: "Context window",
            body: "Total budget for prompt plus reply. Long retrieved context plus long history is what exhausts it; the oldest turns fall out first.",
          },
        ]}
      />

      <H2 id="fallback">Overrides and fallback</H2>
      <P>
        An agent has a saved model, which you can override per session in{" "}
        <DocLink to="/docs/playground">Agent Chat</DocLink> — the fastest A/B test available. If a
        provider errors or a model is disallowed, the platform surfaces the reason and offers to
        retry with an allowed model rather than failing silently.
      </P>

      <H2 id="cost">Cost</H2>
      <P>
        Every call records tokens in/out, latency and cost against the user who made it. Spend is
        visible in <DocLink to="/docs/analytics">Analytics</DocLink>, and can be capped per user,
        group or credential in <DocLink to="/docs/budgets">Budgets</DocLink>. On a shared instance,
        set a cap before handing out access rather than after the first surprise.
      </P>

      <NextPrev current="/docs/models" />
    </>
  );
}
