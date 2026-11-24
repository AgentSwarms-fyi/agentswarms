// How long the free text in the agent and knowledge-base forms may be.
// Names have their own rule (NAME_MAX_LENGTH in visibleName.ts); these bound
// the rest, counted in characters as nameLength counts them.
import { nameLength } from "@/lib/visibleName";

/** An agent's or a knowledge base's description. */
export const DESCRIPTION_MAX_LENGTH = 120;
/** An agent's system prompt, and its custom output-filter prompt. */
export const PROMPT_MAX_LENGTH = 2000;
/** A one-entry-per-line guardrail list: blocked patterns, allowed or restricted topics. */
export const LIST_MAX_LENGTH = 2000;
/** A URL, an endpoint or an API key typed into the form. */
export const URL_MAX_LENGTH = 2048;
/** A model id or a short setting such as stop sequences. */
export const SHORT_TEXT_MAX_LENGTH = 200;

/**
 * Why `value` cannot be saved because it is too long, as a sentence to show,
 * or null when it fits. `label` names the field: "description", "system prompt".
 */
export function lengthProblem(value: unknown, max: number, label: string): string | null {
  if (typeof value !== "string") return null;
  const n = nameLength(value);
  return n > max ? `Keep the ${label} to ${max} characters (it has ${n})` : null;
}
