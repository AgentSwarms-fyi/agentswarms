// Render an analyst answer as Slack Block Kit.
//
// The constraint that shapes this: Slack truncates. A text block over 3000
// characters is REJECTED, and a message over 50 blocks is rejected too — so a
// long answer has to be cut somewhere, and the only question is whether the
// reader is told. An answer that silently loses its last three findings is
// worse than one that says "3 more, open in AgentSwarms", because the first
// looks complete.
//
// The second rule is the one this whole codebase runs on: Slack shows a
// SUMMARY, never a substitute for the numbers. Every message links back, and a
// result that was truncated, estimated or ungoverned says so in Slack too —
// the properties do not stop being true because the surface changed.

/** Slack rejects a section's text over this; we cut earlier and say so. */
export const SLACK_TEXT_LIMIT = 2900;
/** Slack rejects a message with more blocks than this. */
export const SLACK_BLOCK_LIMIT = 45;

export type SlackBlock = Record<string, unknown>;

/** One step of an analyst answer, as far as Slack cares. */
export type SlackAnswerStep = {
  title: string;
  /** Prose summary. Numbers stay in the app; this is the sentence. */
  summary?: string;
  /** True when the compiler wrote the SQL from a governed model. */
  governed?: boolean;
  /** Set when the step's result was capped, so the reader is not misled. */
  truncatedRows?: number;
};

/**
 * Cut to a limit and SAY the cut happened.
 *
 * Returns the marker inline rather than dropping characters silently, because
 * a paragraph that just stops reads as a complete thought that happened to be
 * short.
 */
export function truncateForSlack(text: string, limit = SLACK_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const marker = "… (truncated — open in AgentSwarms for the full answer)";
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/** Slack's mrkdwn needs three characters escaped, and only these three. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The message for an answered question.
 *
 * `url` is a deep link back to the thread. It is not decoration: everything
 * here is a summary, and the reader needs one click to the thing that has the
 * actual rows, the SQL and the lineage.
 */
export function analystAnswerBlocks(args: {
  question: string;
  answer: string;
  steps?: SlackAnswerStep[];
  url?: string;
  /** Model that answered, so a Slack reader can see it like everyone else. */
  model?: string;
}): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*${escapeSlackText(truncateForSlack(args.question, 200))}*` },
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncateForSlack(escapeSlackText(args.answer)) },
  });

  const steps = args.steps ?? [];
  // Reserve room for the header, the answer, the context line and the divider
  // — otherwise a long step list pushes the LINK off the message, which is the
  // one element that must survive.
  const roomForSteps = Math.max(0, SLACK_BLOCK_LIMIT - 4);
  const shown = steps.slice(0, roomForSteps);

  for (const s of shown) {
    const marks: string[] = [];
    // GOVERNED IS NOT DECORATION. It is the difference between a number the
    // semantic layer compiled and one the model wrote, and it is shown
    // everywhere else — omitting it in Slack would make Slack the one place
    // the distinction disappears.
    if (s.governed) marks.push("governed");
    if (typeof s.truncatedRows === "number")
      marks.push(`first ${s.truncatedRows.toLocaleString()} rows only`);
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `• *${escapeSlackText(truncateForSlack(s.title, 150))}*` +
            (s.summary ? ` — ${escapeSlackText(truncateForSlack(s.summary, 300))}` : "") +
            (marks.length ? `  _(${marks.join(", ")})_` : ""),
        },
      ],
    });
  }

  if (steps.length > shown.length) {
    // Named, not hidden. "and 6 more" is the difference between a summary and
    // a misleading one.
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${steps.length - shown.length} more step${steps.length - shown.length === 1 ? "" : "s"} not shown here._`,
        },
      ],
    });
  }

  const footer: string[] = [];
  if (args.model) footer.push(escapeSlackText(args.model));
  footer.push(
    args.url
      ? `<${args.url}|Open in AgentSwarms>`
      : "Open AgentSwarms for the rows, the SQL and the lineage",
  );
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: footer.join("  ·  ") }] });

  return blocks;
}

/**
 * The message for a question that could not be answered.
 *
 * Says what actually happened. "Something went wrong" in a channel is how a
 * broken integration goes unreported for a week, because nobody can tell it
 * from a bad question.
 */
export function analystErrorBlocks(args: {
  question: string;
  error: string;
  url?: string;
}): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Could not answer:* ${escapeSlackText(truncateForSlack(args.question, 200))}\n` +
          `\`\`\`${escapeSlackText(truncateForSlack(args.error, 1500))}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: args.url
            ? `<${args.url}|Open in AgentSwarms>`
            : "Open AgentSwarms to retry with more context",
        },
      ],
    },
  ];
}

/** The immediate ack. Slack shows an error if nothing arrives within 3s. */
export function ackBlocks(question: string): SlackBlock[] {
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Working on *${escapeSlackText(truncateForSlack(question, 150))}* — the answer will land here.`,
        },
      ],
    },
  ];
}
