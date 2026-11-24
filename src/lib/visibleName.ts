// The rules for an agent's, a swarm's and a knowledge base's name.
//
// An input's `required` attribute and a column's NOT NULL both stop an EMPTY
// name, and neither stops one made only of spaces. Agents and swarms saved
// such names, and they then showed as blank rows in every list, picker and
// "Moved “ ” to the trash" toast (20261129000000_agent_swarm_names_not_blank).
//
// Nor did anything bound a name's length: a form took hundreds of characters
// (and a client writing to the table directly, any number), and the Agent
// Chat picker then ran off the screen. 120 is the limit the database already
// holds for the other named objects: dashboards, reports, workflows, data
// monitors, AI analysts (20261130000000_names_max_length).

/** The longest name an agent, a swarm or a knowledge base may have, in characters. */
export const NAME_MAX_LENGTH = 120;

/** True when `name` is a string with at least one non-whitespace character. */
export function hasVisibleName(name: unknown): name is string {
  return typeof name === "string" && name.trim() !== "";
}

/**
 * A name's length as Postgres's char_length counts it: in characters (code
 * points), so an emoji is one, not the two UTF-16 units `.length` counts.
 */
export function nameLength(name: string): number {
  return Array.from(name).length;
}

/** `name` cut to NAME_MAX_LENGTH characters, never through the middle of an emoji. */
export function clampName(name: string): string {
  return nameLength(name) > NAME_MAX_LENGTH
    ? Array.from(name).slice(0, NAME_MAX_LENGTH).join("")
    : name;
}

/**
 * Why `name` cannot be saved, as a sentence to show, or null when it can.
 * `what` names the object: "agent", "swarm", "knowledge base".
 */
export function nameProblem(name: unknown, what: string): string | null {
  if (!hasVisibleName(name)) return `Give the ${what} a name`;
  if (nameLength(name) > NAME_MAX_LENGTH) {
    return `Keep the ${what}'s name to ${NAME_MAX_LENGTH} characters (it has ${nameLength(name)})`;
  }
  return null;
}
