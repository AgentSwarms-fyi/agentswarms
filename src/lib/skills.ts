import {
  SAMPLE_SKILLS,
  SAMPLE_SKILL_BY_ID,
  isSampleSkillId,
  type SampleSkill,
} from "./sampleSkills";

export type Skill = {
  id: string;
  name: string;
  description: string | null;
  body: string;
  tags: string[];
  isSample: boolean;
};

export { SAMPLE_SKILLS, isSampleSkillId };
export type { SampleSkill };

export function sampleSkillToSkill(s: SampleSkill): Skill {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    body: s.body,
    tags: s.tags,
    isSample: true,
  };
}

/**
 * Total skill-body characters an agent may carry before the prompt switches
 * from inlining every body to an index + on-demand loading (see
 * buildSkillsIndexBlock). The default is chosen from measurement: all six
 * bundled sample skills together are ~6.7k characters, so every configuration
 * that exists today stays on the inline path and nothing observable changes.
 * Deferral is for the setups the inline path punishes — many skills, or a few
 * very long playbooks — where most of what is resent every single turn is
 * instructions for situations that are not happening this turn.
 *
 * Callers pass the limit in (the server reads SKILLS_INLINE_MAX_CHARS); this
 * module stays environment-free so the browser can import it.
 */
export const SKILLS_INLINE_MAX_CHARS_DEFAULT = 8000;

/** Which prompt strategy a set of skills gets, given the inline budget. */
export function skillsPromptMode(
  skills: Pick<Skill, "body">[],
  maxInlineChars: number,
): "inline" | "deferred" {
  const total = skills.reduce((n, s) => n + s.body.length, 0);
  return total <= maxInlineChars ? "inline" : "deferred";
}

/**
 * One line that tells the model when a skill applies, without its body.
 *
 * Prefer the skill's own description. A skill without one falls back to its
 * first non-heading paragraph, which by convention is the "when to use"
 * summary — and is truncated hard, because the whole point of the index is
 * that it stays small when the bodies do not.
 */
export function skillIndexEntry(skill: Pick<Skill, "name" | "description" | "body">): string {
  const summary =
    skill.description?.trim() ||
    skill.body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#")) ||
    "";
  const clipped = summary.length > 240 ? summary.slice(0, 237).trimEnd() + "…" : summary;
  return clipped ? `- **${skill.name}** — ${clipped}` : `- **${skill.name}**`;
}

/**
 * The deferred counterpart to buildSkillsPromptBlock: names and one-line
 * summaries only, with instructions to load a body before applying it. The
 * full markdown is served by the use_skill tool the server registers whenever
 * this block is used — the two ship together or not at all.
 */
export function buildSkillsIndexBlock(
  skills: Pick<Skill, "name" | "description" | "body">[],
): string {
  if (!skills.length) return "";
  return [
    "## Skills available to you",
    "",
    "You have been equipped with the named skills below. Only their summaries are listed here. " +
      "When the current request matches one, call the `use_skill` tool with that skill's exact " +
      "name to load its full instructions BEFORE applying it — do not guess at what a skill says. " +
      "Load only the skills that match; more than one may apply to a single turn.",
    "",
    ...skills.map(skillIndexEntry),
    "",
    "---",
    "",
    "(End of skill index.)",
  ].join("\n");
}

/** Build a markdown block to inject into the agent's system prompt. */
export function buildSkillsPromptBlock(skills: Pick<Skill, "name" | "body">[]): string {
  if (!skills.length) return "";
  const sections = skills
    .map((s) => `### Skill: ${s.name}\n\n${s.body.trim()}`)
    .join("\n\n---\n\n");
  return [
    "## Skills available to you",
    "",
    "You have been equipped with the following named skills. Each skill is a focused playbook describing **when to apply it** and **how to apply it**. When the current user request matches a skill's *When to use* section, follow that skill's *Instructions* and respect its *Constraints*. Skills compose: more than one may apply to a single turn.",
    "",
    sections,
    "",
    "---",
    "",
    "(End of skills.)",
  ].join("\n");
}

/**
 * Resolve an array of skill ids into Skill objects.
 * Sample skills are looked up in code; user skills are passed in (already
 * fetched from the agent_skills table by the caller, e.g. server-side).
 */
export function resolveSkills(
  skillIds: string[] | undefined | null,
  userSkills: Pick<Skill, "id" | "name" | "description" | "body" | "tags">[],
): Skill[] {
  if (!Array.isArray(skillIds) || skillIds.length === 0) return [];
  const userById = new Map(userSkills.map((s) => [s.id, s]));
  const out: Skill[] = [];
  for (const id of skillIds) {
    if (typeof id !== "string" || !id) continue;
    if (isSampleSkillId(id)) {
      const s = SAMPLE_SKILL_BY_ID[id];
      if (s) out.push(sampleSkillToSkill(s));
    } else {
      const s = userById.get(id);
      if (s) {
        out.push({
          id: s.id,
          name: s.name,
          description: s.description ?? null,
          body: s.body,
          tags: s.tags ?? [],
          isSample: false,
        });
      }
    }
  }
  return out;
}
