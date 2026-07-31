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
