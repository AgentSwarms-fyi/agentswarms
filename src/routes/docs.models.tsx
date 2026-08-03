import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
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

      <H3 id="providers">Supported providers — all 14</H3>
      <P>
        These are the provider ids the chat route accepts. Anything else is rejected before a call
        is made.
      </P>
      <Table
        headers={["Provider id", "Name", "What you configure"]}
        rows={[
          [<C key="a">openai</C>, "OpenAI", "API key; optional organization id"],
          [<C key="b">anthropic</C>, "Anthropic", "API key"],
          [<C key="c">gemini</C>, "Google Gemini", "API key"],
          [
            <C key="d">vertex</C>,
            "Google Vertex AI",
            "Service-account credentials + project and region",
          ],
          [
            <C key="e">bedrock</C>,
            "Amazon Bedrock",
            "AWS credentials + region. Use when data must stay in your AWS account.",
          ],
          [<C key="f">azure_openai</C>, "Azure OpenAI", "Endpoint + deployment name + key"],
          [<C key="g">oci_genai</C>, "OCI Generative AI", "Oracle Cloud tenancy credentials"],
          [<C key="h">grok</C>, "Grok (xAI)", "API key"],
          [<C key="i">qwen</C>, "Qwen", "API key"],
          [<C key="j">groq</C>, "Groq", "API key — fast inference for small models"],
          [<C key="k">nvidia</C>, "NVIDIA NIM", "API key"],
          [
            <C key="l">openrouter</C>,
            "OpenRouter",
            "One key, many models — the simplest way to try several",
          ],
          [
            <C key="m">ollama</C>,
            "Ollama",
            "Base URL of your Ollama host. Local models, nothing leaves your machine.",
          ],
          [
            <C key="n">vllm</C>,
            "vLLM",
            "Base URL of your vLLM server. Self-hosted open-weight models at scale.",
          ],
        ]}
      />
      <Callout kind="info">
        <C>ollama</C> and <C>vllm</C> are the two that keep inference entirely on infrastructure you
        control — worth knowing about if the reason you are self-hosting is that prompts must not
        leave your network at all.
      </Callout>

      <P>
        Keys are encrypted at rest. Prefer storing them in{" "}
        <DocLink to="/docs/secrets">Secrets</DocLink> and referencing them, so a rotation is one
        edit rather than a hunt through every connector.
      </P>

      <H3 id="cloud-config">Configuring the cloud providers</H3>
      <P>
        Eight of the fourteen need nothing but an API key. These six ask for more, and the exact
        fields are worth having in front of you — most failed connections are one of these values in
        the wrong box.
      </P>
      <Table
        headers={["Provider", "Fields", "Notes"]}
        rows={[
          [
            <C key="a">bedrock</C>,
            <>
              <C key="b">region</C>, <C key="c">accessKeyId</C>, <C key="d">secretAccessKey</C>, and
              optionally <C key="e">sessionToken</C>
            </>,
            "The session token is only for temporary STS credentials — leave it blank for a long-lived IAM user.",
          ],
          [
            <C key="f">vertex</C>,
            <>
              <C key="g">projectId</C>, <C key="h">location</C>, <C key="i">serviceAccountJson</C>
            </>,
            "Paste the whole service-account JSON file. It is parsed on save, so a truncated paste fails immediately rather than at first use.",
          ],
          [
            <C key="j">azure_openai</C>,
            <>
              <C key="k">endpoint</C>, <C key="l">apiKey</C>, and optionally{" "}
              <C key="m">apiVersion</C>
            </>,
            <>
              Endpoint is the resource root, e.g.{" "}
              <C key="n">https://my-resource.openai.azure.com</C>. Defaults to API version{" "}
              <C key="o">2024-08-01-preview</C>.
            </>,
          ],
          [
            <C key="p">oci_genai</C>,
            <>
              <C key="q">region</C>, <C key="r">compartmentId</C>, <C key="s">tenancyOcid</C>,{" "}
              <C key="t">userOcid</C>, <C key="u">fingerprint</C>, <C key="v">privateKeyPem</C>
            </>,
            <>
              Six fields, all from your OCI API-key config file. <C key="w">style</C> selects the
              GENERIC or COHERE request shape.
            </>,
          ],
          [
            <C key="x">anthropic</C>,
            <C key="y">apiKey</C>,
            "Listed here because it also supports a stored cloud credential, not just a workspace key.",
          ],
          [
            <C key="z">qwen</C>,
            <>
              <C key="aa">apiKey</C>, optional <C key="ab">baseUrl</C>
            </>,
            "Set the base URL if you are pointed at a regional or self-managed endpoint.",
          ],
        ]}
      />
      <Callout kind="warn" title="On Azure, the model name IS the deployment name">
        There is no separate deployment field, and this catches nearly everyone. The request is
        built as <C>{"<endpoint>/openai/deployments/<model>/chat/completions"}</C> — so whatever you
        type as the model must be the name you gave the deployment in the Azure portal, not the
        underlying model name. If you deployed <C>gpt-4o</C> under the name <C>prod-chat</C>, the
        model is <C>prod-chat</C>. A wrong value here comes back as a 404 from Azure, which reads
        like the endpoint is wrong.
      </Callout>

      <H3 id="local-config">Keeping inference on your own machines</H3>
      <P>
        <C>ollama</C> and <C>vllm</C> take a base URL and nothing else. Both are OpenAI-compatible,
        so the model id is whatever the server itself reports.
      </P>
      <Code lang="text">{`ollama    http://localhost:11434
vllm      http://vllm.internal:8000/v1`}</Code>
      <Callout kind="warn" title="A local URL still has to be reachable from the app">
        The app calls these, not your browser, so <C>localhost</C> means localhost{" "}
        <em>on the server</em>. Running the app in Docker with Ollama on the host means{" "}
        <C>http://host.docker.internal:11434</C>, not <C>http://localhost:11434</C> — the single
        most common reason a local model "isn't found" when it is running perfectly well.
      </Callout>
      <Callout kind="info" title="The private-network block does not apply here">
        <C>BLOCK_PRIVATE_NETWORK_FETCH</C> guards the places a URL can arrive from a{" "}
        <em>user or a model</em> — MCP endpoints, swarm HTTP nodes, page fetching. Provider base
        URLs are operator configuration and are called directly, because a model server on a private
        address is the entire point of these two. Treat the base URL as trusted input: whoever can
        set it can make the app call it.
      </Callout>

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
