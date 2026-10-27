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

      <H3 id="providers">Supported providers — all 15</H3>
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
          [
            <C key="ca">claude_aws</C>,
            "Claude Platform on AWS",
            "Workspace region and ID, and an API key from the AWS console or AWS access keys. Claude models billed through your AWS account.",
          ],
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
        Most of the fifteen need nothing but an API key. Five ask for real cloud credentials, and
        two more take an optional endpoint override; the exact fields are worth having in front of
        you, because most failed connections are one of these values in the wrong box. The two
        self-hosted providers are covered separately below — they take a base URL instead of a key.
      </P>
      <Table
        headers={["Provider", "Fields", "Notes"]}
        rows={[
          [
            <C key="a">bedrock</C>,
            <>
              <C key="b">region</C>, <C key="c">accessKeyId</C>, <C key="d">secretAccessKey</C>, and
              optionally <C key="e">sessionToken</C>, <C key="pe1">endpoint</C>,{" "}
              <C key="pe2">requirePrivate</C>
            </>,
            <>
              The session token is only for temporary STS credentials — leave it blank for a
              long-lived IAM user. <C key="pe3">endpoint</C> is an optional private endpoint, e.g. a
              PrivateLink <C key="pe4">vpce-….bedrock-runtime.us-east-1.vpce.amazonaws.com</C>{" "}
              address; see <a href="#private-connectivity">private connectivity</a>.
            </>,
          ],
          [
            <C key="f">vertex</C>,
            <>
              <C key="g">projectId</C>, <C key="h">location</C>, <C key="i">serviceAccountJson</C>,
              and optionally <C key="pe5">endpoint</C>, <C key="pe6">requirePrivate</C>
            </>,
            <>
              Paste the whole service-account JSON file. It is parsed on save, so a truncated paste
              fails immediately rather than at first use. <C key="pe7">endpoint</C> is an optional
              Private Service Connect address such as{" "}
              <C key="pe8">https://aiplatform-myendpoint.p.googleapis.com</C>; the OAuth token is
              then fetched through the same endpoint.
            </>,
          ],
          [
            <C key="j">azure_openai</C>,
            <>
              <C key="k">endpoint</C>, <C key="l">apiKey</C>, and optionally{" "}
              <C key="m">apiVersion</C>, <C key="pe9">requirePrivate</C>
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
              <C key="t">userOcid</C>, <C key="u">fingerprint</C>, <C key="v">privateKeyPem</C>, and
              optionally <C key="pe10">endpoint</C>, <C key="pe11">requirePrivate</C>
            </>,
            <>
              Six fields, all from your OCI API-key config file. <C key="w">style</C> selects the
              GENERIC or COHERE request shape. <C key="pe12">endpoint</C> is an optional private
              endpoint, the <C key="pe13">*.pe.inference.generativeai.…oci.oraclecloud.com</C> name
              OCI gives it.
            </>,
          ],
          [
            <C key="ca1">claude_aws</C>,
            <>
              <C key="ca2">region</C>, <C key="ca3">workspaceId</C>, then either{" "}
              <C key="ca4">apiKey</C> or <C key="ca5">accessKeyId</C> +{" "}
              <C key="ca6">secretAccessKey</C> (optionally <C key="ca7">sessionToken</C>), and
              optionally <C key="ca8">endpoint</C>, <C key="ca9">requirePrivate</C>
            </>,
            <>
              The region is the workspace&apos;s own — there is no default, and a request signed for
              another region is rejected. The workspace ID looks like{" "}
              <C key="ca10">wrkspc_01AbCdEf23GhIj</C>. Model ids are the plain Claude ids, e.g.{" "}
              <C key="ca11">claude-sonnet-5-5</C>. AWS PrivateLink is supported:{" "}
              <C key="ca12">endpoint</C> takes the private endpoint&apos;s address.
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

      <H3 id="private-connectivity">Private connectivity</H3>
      <P>
        Reaching a provider over a private network is a choice, never a requirement. Each
        provider&apos;s dialog has a <strong>Network</strong> section. <em>Public</em>, the default,
        uses the provider&apos;s public hostname. <em>Private DNS</em> saves exactly the same thing:
        it is for when a private DNS zone, or a VPN / Direct Connect / ExpressRoute / Interconnect
        link, already makes that public hostname resolve to a private address. Choose{" "}
        <em>Private endpoint URL</em> only when your private endpoint has a name of its own.
      </P>
      <Table
        headers={["Need", "What to set"]}
        rows={[
          [
            "A proxy is the only way out of your network",
            <>
              <C key="p1">HTTPS_PROXY</C> / <C key="p2">NO_PROXY</C> on the server. Every model call
              and connection test uses it, as the connectors do.
            </>,
          ],
          [
            "A private endpoint with its own name",
            "Private endpoint URL, under Network, on Bedrock, Vertex AI, OCI or Claude Platform on AWS. The dialog lists the hosts it accepts: an https address on the provider's own domain, with no path. Requests are signed for it.",
          ],
          [
            "Proof of which path a call takes",
            "Check network path on Bedrock, Vertex AI, OCI, Azure and Claude Platform on AWS — no credentials, no request to the provider — or the result of Test & Connect for the others. Each says via the proxy, or direct to a private or public address, and names the TLS certificate the endpoint presents, flagged when it is not valid for that name.",
          ],
          [
            "A missing DNS zone must fail, not fall back to the internet",
            <>
              Require a private network path on the provider. Its calls are then refused, and
              audited, unless the endpoint resolves to private addresses here or goes through the
              proxy. Off by default; <C key="p3">GENAI_REQUIRE_PRIVATE</C> sets the starting value
              for new integrations only.
            </>,
          ],
          [
            "A private CA, or a proxy that inspects TLS",
            <>
              <C key="p4">NODE_EXTRA_CA_CERTS</C> on the server: a PEM file of the extra CA
              certificates, read at startup. Check network path shows which issuer the endpoint
              presents.
            </>,
          ],
        ]}
      />
      <P>
        The route-all LLM gateway does not cover Bedrock, Vertex AI, Azure OpenAI, OCI Generative AI
        or Claude Platform on AWS — they sign each request with their own credentials, so they are
        always called directly. With route-all on, their cards say so.
      </P>

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
        <C>BLOCK_PRIVATE_NETWORK_FETCH</C> does not cover provider base URLs, because a model server
        on a private address is the entire point of these two — with it set, an Ollama or vLLM on
        your network still works. What does apply is the block nothing can lift: a base URL, or a
        name that resolves to one, or a redirect that leads to one, is refused if it is a cloud
        metadata or link-local address. Every signed-in user sets their own base URL, so whoever can
        sign in can make the app call any other address on its network — keep model servers and
        anything sensitive apart if your users are not all trusted.
      </Callout>

      <H2 id="registry">Model registry</H2>
      <P>
        <strong>Integrations → Model Registry</strong> curates which models appear in pickers across
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
