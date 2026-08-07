// File input fields on the swarm input node.
//
// A "file" field lets someone attach a document when they run a swarm. The
// file is turned into TEXT at input time (the same parsers the Knowledge Base
// uses) and that text is seeded into flow state under the field's name — so
// every downstream node, the templating syntax and the headless executor all
// keep seeing plain strings. The graph never carries a binary.
//
// Why extract at the edge rather than inside a node:
//   • the runtime stays text-only, so a swarm with a file field behaves the
//     same on the canvas, in a chat swarm and (given the text) over the API;
//   • no file ever reaches the server, so an upload cannot become a
//     server-side parsing surface;
//   • the caps below are enforced once, where the user can see the result.
//
// Caps are deliberate and surfaced in the UI rather than silently applied.
export const FILE_INPUT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const FILE_INPUT_MAX_CHARS = 200_000; // ~50k tokens of extracted text

/** Extensions parseFileToText handles. `.doc` is deliberately absent. */
export const FILE_INPUT_ACCEPT = ".pdf,.docx,.txt,.md,.csv,.json,.log,.yaml,.yml,.html,.xml";

export type FileInputResult = {
  text: string;
  fileName: string;
  bytes: number;
  /** Characters before truncation, when the extract was longer than the cap. */
  originalChars: number;
  truncated: boolean;
};

export function fileTooLarge(bytes: number): boolean {
  return bytes > FILE_INPUT_MAX_BYTES;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Clamp extracted text to the char cap.
 *
 * Truncation is REPORTED, never silent: a swarm that answered from half a
 * contract while the user believed it read all of it is worse than one that
 * says it only read half.
 */
export function clampExtracted(text: string): {
  text: string;
  originalChars: number;
  truncated: boolean;
} {
  const originalChars = text.length;
  if (originalChars <= FILE_INPUT_MAX_CHARS) return { text, originalChars, truncated: false };
  return {
    text:
      text.slice(0, FILE_INPUT_MAX_CHARS) +
      `\n\n[... truncated: ${originalChars - FILE_INPUT_MAX_CHARS} more characters were not included]`,
    originalChars,
    truncated: true,
  };
}

/**
 * Read a file into flow-state text. `parse` is injected so this stays pure and
 * testable; callers pass parseFileToText from lib/fileParsers.
 */
export async function readFileField(
  file: { name: string; size: number },
  parse: () => Promise<string>,
): Promise<FileInputResult> {
  if (fileTooLarge(file.size)) {
    throw new Error(
      `"${file.name}" is ${humanBytes(file.size)} — the limit is ${humanBytes(FILE_INPUT_MAX_BYTES)}.`,
    );
  }
  const raw = await parse();
  const clamped = clampExtracted((raw ?? "").trim());
  if (!clamped.text) {
    throw new Error(
      `No text could be extracted from "${file.name}". Scanned PDFs without a text layer need OCR first.`,
    );
  }
  return {
    text: clamped.text,
    fileName: file.name,
    bytes: file.size,
    originalChars: clamped.originalChars,
    truncated: clamped.truncated,
  };
}
