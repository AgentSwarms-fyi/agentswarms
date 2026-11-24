// A name a person can see.
//
// An input's `required` attribute and a column's NOT NULL both stop an EMPTY
// name, and neither stops one made only of spaces. Agents and swarms saved
// such names, and they then showed as blank rows in every list, picker and
// "Moved “ ” to the trash" toast. Every place that writes an agent's or a
// swarm's name asks this first; the database enforces the same rule
// (20261129000000_agent_swarm_names_not_blank.sql).

/** True when `name` is a string with at least one non-whitespace character. */
export function hasVisibleName(name: unknown): name is string {
  return typeof name === "string" && name.trim() !== "";
}
