import { createFileRoute } from "@tanstack/react-router";
import { DocLink, DocsHeader, H2, NextPrev, Note, P, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/skills")({
  head: () => ({
    meta: [
      { title: "Skills & Prompt Library — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "AgentSwarms skills (Anthropic-style skill.md playbooks), the Prompt Library, and the Prompt Compare harness for racing models on the same prompt.",
      },
      { property: "og:title", content: "Skills & Prompt Library — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Skills (skill.md playbooks), the Prompt Library, and the Prompt Compare harness.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/skills" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Skills & Prompt Library — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content: "Skills (skill.md playbooks), the Prompt Library, and the Prompt Compare harness.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/skills" }],
  }),
  component: SkillsDoc,
});

function SkillsDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Build"
        title="Skills & Prompt Library"
        description="Two small libraries of reusable text: skills are focused playbooks composed into an agent's system prompt at run time; prompts are complete starter system prompts. Both exist so good instructions get written once and reused everywhere."
      />

      <H2 id="skills">Skill Library</H2>
      <P>
        Skills at <DocLink to="/skills">/skills</DocLink> follow the Anthropic-style{" "}
        <code>skill.md</code> pattern: a skill is a focused, reusable playbook — "how to write a
        structured code review", "how to cite sources from a knowledge base" — that you attach to
        any agent or swarm node. At run time every selected skill is composed into the agent's
        effective system prompt, so the same agent can be specialized for different jobs just by
        swapping skills.
      </P>
      <UL>
        <li>
          <strong>My skills</strong> — skills you write yourself in the editor, or generate with AI
          from a plain-English description and then edit.
        </li>
        <li>
          <strong>Sample skills</strong> — a curated set you can copy into your own library with one
          click and adapt.
        </li>
        <li>
          <strong>Attaching</strong> — open an agent in the{" "}
          <DocLink to="/docs/agents">Agent Builder</DocLink> (or a swarm node inspector) and select
          skills from the picker. Deleting a skill is safe: agents that referenced it simply drop
          it.
        </li>
      </UL>

      <H2 id="prompt-library">Prompt Library</H2>
      <P>
        The Prompt Library at <DocLink to="/prompts">/prompts</DocLink> is a searchable collection
        of complete system prompts, filtered by category — support, sales, engineering, research,
        data, writing, creative, operations, productivity, and education. Each entry has a preview
        so you can read the full prompt before using it, and you can save your own prompts to the
        library for reuse across agents.
      </P>

      <H2 id="prompt-compare">Prompt Compare</H2>
      <P>
        <DocLink to="/prompt-compare">/prompt-compare</DocLink> answers the most practical question
        in prompt engineering: given this exact prompt, how do different models behave? It runs the
        same prompt against two or three models side by side, streaming the outputs next to each
        other with per-panel latency, token counts, and real cost. Preset experiments are included —
        constraint-following, JSON-only output, and similar discriminating tasks — each with a note
        on what to watch for.
      </P>

      <Note>
        Rule of thumb: if the reusable thing is a complete identity ("you are a support agent
        for…"), it belongs in the Prompt Library. If it is a technique an agent should apply on top
        of its identity ("when reviewing code, always…"), it is a skill.
      </Note>

      <NextPrev current="/docs/skills" />
    </>
  );
}
