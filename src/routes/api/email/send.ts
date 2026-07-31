// Transactional email endpoint for the self-hosted build.
// Auth-gated: renders a react-email template from the registry, honors the
// suppression list + unsubscribe tokens, and sends via the configured mailer
// (Resend / SMTP / no-op — see src/lib/email/mailer.server.ts).
import * as React from "react";
import { render } from "@react-email/components";
import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { resolveInternalOrigin } from "@/utils/internalOrigin.server";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { sendMail } from "@/lib/email/mailer.server";

function redactEmail(email: string | null | undefined): string {
  if (!email) return "***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart[0]}***@${domain}`;
}

// Generate a cryptographically random 32-byte hex token
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const Route = createFileRoute("/api/email/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseServiceKey) {
          console.error("Missing required environment variables");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Verify the caller has a valid Supabase auth token.
        const authHeader = request.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const token = authHeader.slice("Bearer ".length).trim();
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser(token);

        if (authError || !user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Parse request body
        let templateName: string;
        let recipientEmail: string;
        let messageId: string;
        let templateData: Record<string, unknown> = {};
        try {
          const body = await request.json();
          templateName = body.templateName || body.template_name;
          recipientEmail = body.recipientEmail || body.recipient_email;
          messageId = crypto.randomUUID();
          if (body.templateData && typeof body.templateData === "object") {
            templateData = body.templateData;
          }
        } catch {
          return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
        }

        if (!templateName) {
          return Response.json({ error: "templateName is required" }, { status: 400 });
        }

        // 1. Look up template from registry
        const template = TEMPLATES[templateName];
        if (!template) {
          console.error("Template not found in registry", { templateName });
          return Response.json(
            {
              error: `Template '${templateName}' not found. Available: ${Object.keys(TEMPLATES).join(", ")}`,
            },
            { status: 404 },
          );
        }

        // Template-level fixed recipient (e.g. admin notifications) wins.
        const effectiveRecipient = template.to || recipientEmail;
        if (!effectiveRecipient) {
          return Response.json(
            { error: "recipientEmail is required (unless the template defines a fixed recipient)" },
            { status: 400 },
          );
        }

        // 2. Suppression check (fail-closed)
        const { data: suppressed, error: suppressionError } = await supabase
          .from("suppressed_emails")
          .select("id")
          .eq("email", effectiveRecipient.toLowerCase())
          .maybeSingle();

        if (suppressionError) {
          console.error("Suppression check failed — refusing to send", {
            error: suppressionError,
            recipient_redacted: redactEmail(effectiveRecipient),
          });
          return Response.json({ error: "Failed to verify suppression status" }, { status: 500 });
        }

        if (suppressed) {
          await supabase.from("email_send_log").insert({
            message_id: messageId,
            template_name: templateName,
            recipient_email: effectiveRecipient,
            status: "suppressed",
          });
          return Response.json({ success: false, reason: "email_suppressed" });
        }

        // 3. Get or create the unsubscribe token (one per email address)
        const normalizedEmail = effectiveRecipient.toLowerCase();
        let unsubscribeToken: string;

        const { data: existingToken, error: tokenLookupError } = await supabase
          .from("email_unsubscribe_tokens")
          .select("token, used_at")
          .eq("email", normalizedEmail)
          .maybeSingle();

        if (tokenLookupError) {
          console.error("Token lookup failed", { error: tokenLookupError });
          return Response.json({ error: "Failed to prepare email" }, { status: 500 });
        }

        if (existingToken && !existingToken.used_at) {
          unsubscribeToken = existingToken.token;
        } else if (!existingToken) {
          unsubscribeToken = generateToken();
          const { error: tokenError } = await supabase
            .from("email_unsubscribe_tokens")
            .upsert(
              { token: unsubscribeToken, email: normalizedEmail },
              { onConflict: "email", ignoreDuplicates: true },
            );
          if (tokenError) {
            console.error("Failed to create unsubscribe token", { error: tokenError });
            return Response.json({ error: "Failed to prepare email" }, { status: 500 });
          }
          const { data: storedToken } = await supabase
            .from("email_unsubscribe_tokens")
            .select("token")
            .eq("email", normalizedEmail)
            .maybeSingle();
          if (!storedToken) {
            return Response.json({ error: "Failed to prepare email" }, { status: 500 });
          }
          unsubscribeToken = storedToken.token;
        } else {
          // Token used but email not suppressed — treat as suppressed.
          await supabase.from("email_send_log").insert({
            message_id: messageId,
            template_name: templateName,
            recipient_email: effectiveRecipient,
            status: "suppressed",
            error_message: "Unsubscribe token used but email missing from suppressed list",
          });
          return Response.json({ success: false, reason: "email_suppressed" });
        }

        // 4. Render the template
        const element = React.createElement(template.component, templateData);
        const html = await render(element);
        const plainText = await render(element, { plainText: true });
        const resolvedSubject =
          typeof template.subject === "function"
            ? template.subject(templateData)
            : template.subject;

        // 5. Send directly via the configured mailer (no queue in the OSS build)
        // Origin comes from config, not the request: a spoofed Host header
        // would otherwise plant an attacker URL in outbound email headers.
        const origin = resolveInternalOrigin();
        const result = await sendMail({
          to: effectiveRecipient,
          subject: resolvedSubject,
          html,
          text: plainText,
          headers: {
            "List-Unsubscribe": `<${origin}/email/unsubscribe?token=${unsubscribeToken}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });

        await supabase.from("email_send_log").insert({
          message_id: messageId,
          template_name: templateName,
          recipient_email: effectiveRecipient,
          status: result.sent
            ? "sent"
            : result.reason === "no_mailer_configured"
              ? "skipped"
              : "failed",
          error_message: result.sent ? null : result.reason,
        });

        if (!result.sent && result.reason !== "no_mailer_configured") {
          console.error("Email send failed", {
            templateName,
            recipient_redacted: redactEmail(effectiveRecipient),
            reason: result.reason,
          });
          return Response.json({ error: "Failed to send email" }, { status: 500 });
        }

        return Response.json({ success: true, sent: result.sent });
      },
    },
  },
});
