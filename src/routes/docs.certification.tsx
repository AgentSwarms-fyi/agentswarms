import { createFileRoute } from "@tanstack/react-router";
import {
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  NextPrev,
  Note,
  P,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/certification")({
  head: () => ({
    meta: [
      { title: "Certification — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms Agentic AI Practitioner certification: 50-question exam plus an AI-graded review of agents and swarms you built yourself.",
      },
      { property: "og:title", content: "Certification — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The Agentic AI Practitioner certification: a 50-question exam plus a graded review of your own agents and swarms.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/certification" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Certification — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "A 50-question exam plus a graded review of your own agents and swarms.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/certification" }],
  }),
  component: CertificationDoc,
});

function CertificationDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Platform"
        title="Certification"
        description="The AgentSwarms — Agentic AI Practitioner credential at /certification combines a knowledge exam with a graded review of work you actually built. You cannot pass it by reading alone."
      />

      <H2 id="structure">What the exam covers</H2>
      <FieldList
        items={[
          {
            name: "Multiple choice",
            body: "50 questions in 90 minutes, drawn across LLM fundamentals, agentic patterns, guardrails, Responsible AI, memory, multi-agent swarms, SQL agents, and scaling.",
          },
          {
            name: "Hands-on review",
            body: "A graded evaluation of 5 agents and 2 swarms you built yourself — provisioned template demos don't count. An evaluator model scores their configuration: prompts, tools, guardrails, topology.",
          },
        ]}
      />
      <P>
        Pass thresholds: <strong>MCQ ≥ 80%</strong>, <strong>agents ≥ 60%</strong>,{" "}
        <strong>swarms ≥ 40%</strong>. The MCQ section is scored server-side on submission; the
        hands-on review is scored by an evaluator model, and the result is finalized immediately —
        no waiting period for grading.
      </P>

      <H2 id="eligibility">Eligibility</H2>
      <UL>
        <li>
          Pass the track quizzes in the <DocLink to="/learn">curriculum</DocLink> first — the
          certification page shows your quiz progress and which tracks remain.
        </li>
        <li>
          Have at least 5 self-built agents and 2 self-built swarms in your workspace. The page
          counts these for you and links to the builders if you're short.
        </li>
      </UL>

      <H2 id="retakes">Retakes</H2>
      <P>Failed attempts have a 15-day cooldown. The exam questions rotate between attempts.</P>

      <H2 id="certificate">The certificate</H2>
      <P>
        A passing result issues a certificate with a stable public URL you can link from a CV or
        LinkedIn profile, verifiable without an AgentSwarms account.
      </P>

      <Note>
        The <DocLink to="/interview-questions">interview questions</DocLink> page covers much of the
        same ground as the MCQ section — it doubles as a practice bank.
      </Note>

      <NextPrev current="/docs/certification" />
    </>
  );
}
