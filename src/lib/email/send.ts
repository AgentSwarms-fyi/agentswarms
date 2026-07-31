// Thin client-side wrapper around the transactional-email server route.
// All triggers (1:1, action-driven) go through this single helper.
import { supabase } from "@/integrations/supabase/client";

interface SendTransactionalEmailParams {
  templateName: string;
  recipientEmail: string;
  idempotencyKey?: string;
  templateData?: Record<string, unknown>;
}

export async function sendTransactionalEmail(params: SendTransactionalEmailParams) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not authenticated");

  const response = await fetch("/api/email/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      templateName: params.templateName,
      recipientEmail: params.recipientEmail,
      idempotencyKey: params.idempotencyKey,
      templateData: params.templateData,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send email: ${response.statusText}`);
  }
  return response.json();
}
