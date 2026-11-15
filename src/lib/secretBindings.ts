// Environment bindings: `ENV_NAME={{secret:NAME}}`, one per line.
//
// An ETL pipeline's Settings bind secrets into the environment its code runs
// with. The run reads each line with SECRET_BINDING_RE (the same pattern as
// src/utils/etl/service.server.ts and src/routes/api/notebook.runtime.source.ts;
// secretBindings.test.ts holds the three together) and skipped a line that did
// not match without a word, so a typo bound nothing and the code found its
// variable missing. The editor now builds the lines from rows, and a save
// refuses a line the run would skip (R493).
//
// PURE: no server or React imports.
import { parseSecretRef, secretRef } from "./secretRefs";

/** One binding line, as the run reads it: ENV_NAME, then exactly one reference. */
export const SECRET_BINDING_RE =
  /^([A-Za-z_][A-Za-z0-9_]*)=(\{\{\s*secret:[A-Za-z][A-Za-z0-9_]*\s*\}\})$/;

/** An environment variable's name: a letter or `_`, then letters, digits and `_`. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * One line, split for editing: the name before the first `=` and what follows
 * it. `secret` is the secret that follows, when what follows is one reference.
 */
export type SecretBindingRow = { env: string; value: string; secret: string | null };

/** The non-blank lines of a bindings text, trimmed, in order. */
function bindingLines(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function rowOf(line: string): SecretBindingRow {
  const eq = line.indexOf("=");
  const env = (eq === -1 ? line : line.slice(0, eq)).trim();
  const value = eq === -1 ? "" : line.slice(eq + 1).trim();
  return { env, value, secret: parseSecretRef(value) };
}

/** Every non-blank line as a row, in order. Nothing is dropped, however it is spelled. */
export function parseSecretBindings(text: string | null | undefined): SecretBindingRow[] {
  return bindingLines(text).map(rowOf);
}

/** Rows back to lines. A row with a secret is written the one way the run reads. */
export function serializeSecretBindings(
  rows: readonly { env: string; value?: string; secret?: string | null }[],
): string {
  return rows
    .map((r) => {
      const env = r.env.trim();
      const value = r.secret ? secretRef(r.secret) : (r.value ?? "").trim();
      return `${env}=${value}`;
    })
    .join("\n");
}

/** What is wrong with one line, in the words the editor shows beside it, or null. */
export function secretBindingLineProblem(line: string): string | null {
  const t = line.trim();
  if (SECRET_BINDING_RE.test(t)) return null;
  const row = rowOf(t);
  const env = row.env;
  if (!env) return "Name the environment variable.";
  if (!ENV_NAME_RE.test(env)) {
    return `"${env}" is not an environment variable name: start with a letter or _, then letters, digits and _.`;
  }
  if (!row.value) return `Pick the secret ${env} is set to.`;
  if (!row.secret) return `${env} is set to text, not a secret: pick a secret for it.`;
  return `Write it as ${env}=${secretRef(row.secret)}.`;
}

/**
 * Every problem with a bindings text, by the row it is on (the n-th non-blank
 * line, from 0), or [] when the run would bind every line. The run's own test,
 * so a text that passes here binds everything it holds.
 */
export function secretBindingsProblems(
  text: string | null | undefined,
): { row: number; message: string }[] {
  const problems: { row: number; message: string }[] = [];
  const seen = new Map<string, number>();
  bindingLines(text).forEach((line, i) => {
    const problem = secretBindingLineProblem(line);
    if (problem) {
      problems.push({ row: i, message: problem });
      return;
    }
    const env = rowOf(line).env;
    const first = seen.get(env);
    if (first !== undefined) {
      problems.push({ row: i, message: `${env} is already bound by binding ${first + 1}.` });
    } else {
      seen.set(env, i);
    }
  });
  return problems;
}

/** The first problem with a bindings text as one sentence for a refused save, or null. */
export function secretBindingsError(text: string | null | undefined): string | null {
  const [first, ...rest] = secretBindingsProblems(text);
  if (!first) return null;
  const more = rest.length ? ` (and ${rest.length} more)` : "";
  return `Secret binding ${first.row + 1}: ${first.message}${more}`;
}
