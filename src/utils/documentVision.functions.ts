// Server function behind the knowledge-base upload: read a batch of a
// scanned document's pages with the instance's vision model, as the caller.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { PAGES_PER_REQUEST } from "@/lib/documentVision";

type Fail = { ok: false; error: string };

async function resolveCaller(accessToken: string): Promise<{ ok: true; userId: string } | Fail> {
  const { data, error } = await supabaseAdmin.auth.getUser(accessToken);
  if (error || !data?.user) return { ok: false, error: "Not signed in" };
  return { ok: true, userId: data.user.id };
}

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export const documentVisionExtract = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({
        access_token: z.string().min(1),
        name: z.string().min(1).max(300),
        pages: z
          .array(z.string().regex(DATA_URL, "a page must be a PNG, JPEG, WebP or GIF data URL"))
          .min(1)
          .max(PAGES_PER_REQUEST),
        page_offset: z.number().int().min(0),
        total_pages: z.number().int().min(1),
        model: z.string().trim().max(160).optional(),
      })
      .parse(input),
  )
  .handler(
    async ({
      data,
    }): Promise<{ ok: true; texts: string[]; model: string; cost_usd: number | null } | Fail> => {
      const caller = await resolveCaller(data.access_token);
      if (!caller.ok) return caller;
      if (data.page_offset + data.pages.length > data.total_pages) {
        return { ok: false, error: "The batch runs past the document's page count." };
      }
      try {
        const { readPagesWithVision } = await import("@/utils/documents/vision.server");
        const res = await readPagesWithVision({
          userId: caller.userId,
          name: data.name,
          pages: data.pages,
          pageOffset: data.page_offset,
          totalPages: data.total_pages,
          model: data.model ?? null,
        });
        return { ok: true, ...res };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
