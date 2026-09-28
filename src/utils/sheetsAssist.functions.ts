// The Sheets assistant and Fill with AI, server side: one model call per
// step. The browser holds the workbook as the person sees it (unsaved edits
// included, and for a shared viewer only what their share gives) and runs
// the model's reads against it; this sends the conversation so far, with a
// description of the workbook, through the platform's chat channel, so the
// caller's IAM model rules, budget, traces and cost apply as to any chat.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  assistMessageSchema,
  parseAssistReply,
  parseFillAnswer,
  type AssistMessage,
  type AssistReply,
} from "@/lib/sheets/assist";
import { parseGatewayModel } from "@/utils/gateway/keys";
import { GATEWAY_PROVIDERS } from "@/utils/gateway/providers";
import { internalChatText } from "@/utils/internalChat.server";
import { getPlatformResources } from "@/utils/notebookRuntime/config.server";
import { rateLimitedGlobal } from "@/utils/rateLimit.server";
import { requireAccess } from "@/utils/sheets/access.server";
import { ASSIST_SYSTEM, FILL_SYSTEM } from "@/utils/sheets/assistPrompt.server";

type Fail = { ok: false; error: string };

async function caller(token: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

/** The conversation as one message: the channel takes one question and returns one answer. */
export function transcript(messages: AssistMessage[]): string {
  const label = {
    user: "PERSON",
    assistant: "YOU (earlier)",
    tool: "RESULTS OF YOUR READS",
  } as const;
  return `${messages.map((m) => `${label[m.role]}:\n${m.content}`).join("\n\n")}\n\nReply now with ONE JSON object, as the instructions say.`;
}

async function modelFor(): Promise<
  { ok: true; spec: string; provider: string; model: string; perMinute: number } | Fail
> {
  const settings = await getPlatformResources();
  const spec = settings.sheetsAssistModel;
  const target = parseGatewayModel(spec, GATEWAY_PROVIDERS);
  if (!target || target.kind !== "model") {
    return {
      ok: false,
      error: `The assistant's model "${spec}" is not provider/model (Admin → Developer runtime → Sheets → Assistant model).`,
    };
  }
  return {
    ok: true,
    spec,
    provider: target.provider,
    model: target.model,
    perMinute: settings.sheetsAssistPerMinute,
  };
}

/**
 * One step of a question: the model reads (the browser answers) or answers.
 * Anyone who can open the workbook may ask; what it proposes is applied by
 * the browser only where the person can change the workbook.
 */
export const sheetsAssist = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        workbook_id: z.string().uuid(),
        as_share: z.string().uuid().nullable().optional(),
        context: z.string().max(60_000),
        messages: z.array(assistMessageSchema).min(1).max(80),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; reply: AssistReply; cost: number | null; model: string } | Fail> => {
      const who = await caller(data.access_token);
      if (!who.ok) return who;
      const got = await requireAccess(who.userId, data.workbook_id, "view", {
        asShare: data.as_share,
      });
      if (!got.ok) return got;
      const m = await modelFor();
      if (!m.ok) return m;
      if (await rateLimitedGlobal(`sheets-assist:${who.userId}`, m.perMinute)) {
        return {
          ok: false,
          error: `The assistant has had ${m.perMinute} requests from you this minute (SHEETS_ASSIST_PER_MINUTE). Try again in a moment.`,
        };
      }
      try {
        const { text, cost } = await internalChatText({
          userId: who.userId,
          agentName: "Sheets assistant",
          provider: m.provider,
          model: m.model,
          system: `${ASSIST_SYSTEM}\n\nTHE WORKBOOK NOW:\n${data.context}`,
          user: transcript(data.messages),
          temperature: 0,
          maxTokens: 2500,
          timeoutMs: 90_000,
        });
        return { ok: true, reply: parseAssistReply(text), cost, model: m.spec };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );

/**
 * Fill with AI: an instruction applied to each value of a column (classify,
 * extract, clean, translate). One call answers a batch; the browser sends
 * batches and writes the answers beside the values. It writes the workbook,
 * so it is the owner's and editors'.
 */
export const sheetsAiFill = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        workbook_id: z.string().uuid(),
        instruction: z.string().trim().min(1).max(2000),
        /** Answers the person already typed: value → answer, as guidance. */
        examples: z
          .array(z.object({ input: z.string().max(2000), output: z.string().max(2000) }).strict())
          .max(10)
          .optional(),
        inputs: z.array(z.string().max(4000)).min(1).max(100),
      })
      .parse(input),
  )
  .handler(
    async ({ data }): Promise<{ ok: true; outputs: string[]; cost: number | null } | Fail> => {
      const who = await caller(data.access_token);
      if (!who.ok) return who;
      const got = await requireAccess(who.userId, data.workbook_id, "edit");
      if (!got.ok) return got;
      const m = await modelFor();
      if (!m.ok) return m;
      if (await rateLimitedGlobal(`sheets-assist:${who.userId}`, m.perMinute)) {
        return {
          ok: false,
          error: `The assistant has had ${m.perMinute} requests from you this minute (SHEETS_ASSIST_PER_MINUTE). Try again in a moment.`,
        };
      }
      const user = JSON.stringify({
        instruction: data.instruction,
        examples: data.examples ?? [],
        inputs: data.inputs.map((v, i) => ({ i, v })),
      });
      try {
        const { text, cost } = await internalChatText({
          userId: who.userId,
          agentName: "Sheets fill with AI",
          provider: m.provider,
          model: m.model,
          system: FILL_SYSTEM,
          user,
          temperature: 0,
          maxTokens: Math.min(8000, 200 + data.inputs.length * 80),
          timeoutMs: 120_000,
        });
        const { outputs, read } = parseFillAnswer(text, data.inputs.length);
        // Nothing read is a failure to say, not a column of blanks to write (R135).
        if (!read) {
          return {
            ok: false,
            error:
              "The model's answer could not be read as one answer per value, so nothing was written. Try again, or put the instruction more simply.",
          };
        }
        return { ok: true, outputs, cost };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
