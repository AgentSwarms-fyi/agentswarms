// POST /api/embed/analyst — an embedded AI Analyst turn, streamed.
//
// Separate from /api/embed (which answers JSON) for the same reason
// /api/embed/chat is: this one holds the connection open for 30–95 seconds
// and emits the reasoning trace as it is produced.
//
// WHY STREAM AT ALL. A turn plans, writes SQL, executes it, self-checks and
// synthesises. Buffered, the visitor watches a spinner for a minute and a
// half and then everything appears at once — which reads as broken long
// before it finishes, and throws away the thing that makes this analyst worth
// embedding: you can watch it reason and stop reading if the approach is
// wrong. Streamed, the stated approach lands in a few seconds and each step
// fills in as it completes.
//
// EVERY SNAPSHOT IS SANITISED, not just the last one. A partial turn carries
// the same step SQL the final one does, so streaming without sanitising each
// frame would reopen exactly the schema leak the buffered path closes.
//
// Auth, rate limit and budget are the same controls the JSON endpoint applies
// — see src/utils/embed.server.ts and the analyze branch of /api/embed.

import { createFileRoute } from "@tanstack/react-router";

import { sanitizePublicTurn, trimTurnForStorage, type AnalystTurn } from "@/lib/aiAnalyst";
import { touchEmbedKey, validateEmbedKey } from "@/utils/embed.server";
import { rateLimitedGlobal } from "@/utils/rateLimit.server";
import { budgetMessage, getBudgetDecision } from "@/utils/budgetGuard.server";
import { clientIp, clientUserAgent } from "@/utils/requestMeta.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

/** One SSE frame. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const Route = createFileRoute("/api/embed/analyst")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { headers: corsHeaders }),
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => ({}))) as {
          key?: string;
          parentOrigin?: string;
          previewToken?: string;
          question?: string;
          priorTurns?: unknown;
        };

        // An analyst turn is several model calls and several queries, so it
        // gets a tighter ceiling than a single-shot dashboard question.
        if (await rateLimitedGlobal(`analyze:${body.key ?? "?"}`, 5)) {
          return json({ error: "Rate limited — please slow down." }, 429);
        }

        const v = await validateEmbedKey({
          key: body.key,
          parentOrigin: body.parentOrigin,
          previewToken: body.previewToken,
          ip: clientIp(request),
          userAgent: clientUserAgent(request),
          request,
        });
        if (!v.ok) return json({ error: v.error }, v.status);
        const keyRow = v.row;

        if (keyRow.resource_type !== "ai_analyst") {
          return json({ error: "This embed key is not for an AI analyst." }, 403);
        }
        const question = (body.question ?? "").trim().slice(0, 2000);
        if (!question) return json({ error: "question required" }, 400);

        // Billed to the owner, triggered by strangers — the per-key cap is
        // the control that bounds it.
        const budget = await getBudgetDecision(keyRow.user_id, {
          type: "embed_key",
          id: keyRow.id,
        });
        if (budget.over) return json({ error: budgetMessage(budget) }, 402);

        // Untrusted: the visitor's own conversation shapes the follow-up
        // prompt and nothing else. The analyst, its model and its data scope
        // are re-read server-side on every call.
        const prior = Array.isArray(body.priorTurns)
          ? (body.priorTurns.slice(-6) as AnalystTurn[])
          : [];

        touchEmbedKey(keyRow, clientIp(request));

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            const send = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(frame(event, data)));
              } catch {
                // The visitor navigated away mid-analysis. Stop writing; the
                // run itself finishes and its spend is already recorded.
                closed = true;
              }
            };

            // Coalesce: the loop calls onUpdate on every internal transition,
            // which is far more often than a reader can perceive. One frame
            // per ~400ms keeps the connection cheap without the trace looking
            // like it stalled.
            let lastSentAt = 0;
            const MIN_FRAME_MS = 400;

            try {
              const { runAnalystTurnServer } = await import("@/utils/analyst/run.server");
              const out = await runAnalystTurnServer({
                analystId: keyRow.resource_id,
                ownerId: keyRow.user_id,
                question,
                priorTurns: prior,
                costScope: { type: "embed_key", id: keyRow.id },
                onUpdate: (turn) => {
                  const now = Date.now();
                  if (now - lastSentAt < MIN_FRAME_MS) return;
                  lastSentAt = now;
                  // Sanitised per FRAME. A partial turn carries the same step
                  // SQL as the final one.
                  send("turn", { turn: sanitizePublicTurn(turn) });
                },
              });
              if (!out.ok) send("failed", { error: out.error, status: out.status });
              else send("done", { turn: sanitizePublicTurn(trimTurnForStorage(out.turn)) });
            } catch (e) {
              send("failed", { error: (e as Error).message.slice(0, 300), status: 502 });
            } finally {
              if (!closed) controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Proxies that buffer would defeat the entire point of this route.
            "X-Accel-Buffering": "no",
            ...corsHeaders,
          },
        });
      },
    },
  },
});
