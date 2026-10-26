// Email endpoints cannot be turned into branded-phishing cannons.
//
// VA-2026-10-25-12. Two surfaces, two shapes of abuse:
//
//   /api/email/send  (authenticated) renders a BRANDED template with
//     caller-controlled templateData (links built from a caller `siteUrl`).
//     Every real caller sends to its own account (the welcome email goes to the
//     user who just signed up), but nothing stopped a signed-in user naming
//     anyone as the recipient. It now refuses a template with no fixed
//     recipient unless the recipient is the caller's own address.
//
//   /api/contact  (public) emails a branded confirmation to the address the
//     visitor typed. It skipped the suppression list and rate-limited only on a
//     spoofable IP header, so it could be made to send branded mail to a chosen
//     victim at volume. The confirmation is now gated on the suppression list
//     and a per-recipient cap; the admin notification and the stored message
//     are unaffected.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

// Record every outbound email (recipient + subject).
const sent: { to: string }[] = [];
vi.mock("@/lib/email/mailer.server", () => ({
  sendMail: async (args: { to: string }) => {
    sent.push({ to: args.to });
    return { sent: true };
  },
}));

// Rendering is not under test; keep it cheap and React-free.
vi.mock("@react-email/components", () => ({ render: async () => "<html>test</html>" }));
vi.mock("@/utils/internalOrigin.server", () => ({
  resolveInternalOrigin: () => "http://app.test",
}));

// A configurable fake Supabase, shared by both route handlers.
const state = {
  userEmail: "owner@example.test" as string | null,
  suppressed: new Set<string>(),
};

function makeClient() {
  const build = (table: string) => {
    let eqEmail = "";
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col === "email") eqEmail = String(val).toLowerCase();
        return b;
      },
      maybeSingle: async () => {
        if (table === "suppressed_emails") {
          return { data: state.suppressed.has(eqEmail) ? { id: "sup" } : null, error: null };
        }
        if (table === "email_unsubscribe_tokens") {
          return { data: { token: "tok", used_at: null }, error: null };
        }
        return { data: null, error: null };
      },
      insert: () => {
        const res: Record<string, unknown> = {
          select: () => ({
            single: async () => ({
              data: { id: "msg-1", created_at: new Date().toISOString() },
              error: null,
            }),
          }),
          then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
        };
        return res;
      },
      upsert: () => ({ then: (r: (v: { error: null }) => void) => r({ error: null }) }),
    });
    return b;
  };
  return {
    auth: {
      // A valid user is always returned; `email` may be null (some providers),
      // which is the case the own-address guard must still refuse.
      getUser: async () => ({ data: { user: { email: state.userEmail } }, error: null }),
    },
    from: (t: string) => build(t),
  };
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeClient() }));

type Handlers = { POST: (a: { request: Request }) => Promise<Response> };
let emailSend: Handlers;
let contact: Handlers;

const savedEnv = { ...process.env };

beforeAll(async () => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
  process.env.CONTACT_ADMIN_EMAIL = "admin@example.test";
  const sendRoute = (await import("@/routes/api/email/send")) as unknown as {
    Route: { options: { server: { handlers: Handlers } } };
  };
  const contactRoute = (await import("@/routes/api/contact")) as unknown as {
    Route: { options: { server: { handlers: Handlers } } };
  };
  emailSend = sendRoute.Route.options.server.handlers;
  contact = contactRoute.Route.options.server.handlers;
}, 120_000);

afterEach(() => {
  process.env = { ...savedEnv };
});
beforeEach(() => {
  sent.length = 0;
  state.userEmail = "owner@example.test";
  state.suppressed = new Set();
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
  process.env.CONTACT_ADMIN_EMAIL = "admin@example.test";
});

function postSend(body: Record<string, unknown>) {
  return emailSend.POST({
    request: new Request("http://app.test/api/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify(body),
    }),
  });
}

function postContact(body: Record<string, unknown>, ip: string) {
  return contact.POST({
    request: new Request("http://app.test/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  });
}

describe("/api/email/send — a branded template cannot be aimed at someone else", () => {
  it("refuses the welcome template sent to another address", async () => {
    const res = await postSend({
      templateName: "welcome",
      recipientEmail: "victim@elsewhere.test",
      templateData: { siteUrl: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(sent).toEqual([]); // nothing left the box
  });

  it("allows the welcome template to the caller's own address", async () => {
    const res = await postSend({
      templateName: "welcome",
      recipientEmail: "Owner@Example.test", // case-insensitive match
      templateData: { siteUrl: "http://app.test" },
    });
    expect(res.status).toBe(200);
    expect(sent.map((s) => s.to)).toContain("Owner@Example.test");
  });

  it("refuses when the caller's account has no email to match against", async () => {
    state.userEmail = null;
    const res = await postSend({ templateName: "welcome", recipientEmail: "owner@example.test" });
    expect(res.status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe("/api/contact — the confirmation is gated, the admin note is not", () => {
  const form = (email: string) => ({ name: "Ana", email, message: "Hello there, a real message" });

  it("emails both the admin and the visitor on a normal submission", async () => {
    const res = await postContact(form("visitor-a@example.test"), "203.0.113.1");
    expect(res.status).toBe(200);
    const tos = sent.map((s) => s.to);
    expect(tos).toContain("admin@example.test");
    expect(tos).toContain("visitor-a@example.test");
  });

  it("skips the confirmation to a suppressed address but still notifies the admin", async () => {
    state.suppressed.add("visitor-b@example.test");
    const res = await postContact(form("visitor-b@example.test"), "203.0.113.2");
    expect(res.status).toBe(200);
    const tos = sent.map((s) => s.to);
    expect(tos).toContain("admin@example.test");
    expect(tos).not.toContain("visitor-b@example.test");
  });

  it("caps how many confirmations one address can be made to receive", async () => {
    const email = "victim-c@example.test";
    for (let i = 0; i < 5; i++) await postContact(form(email), `198.51.100.${i}`);
    const toVictim = sent.filter((s) => s.to === email).length;
    const toAdmin = sent.filter((s) => s.to === "admin@example.test").length;
    expect(toVictim).toBe(3); // CONFIRM_MAX
    expect(toAdmin).toBe(5); // every submission still reaches the admin
  });
});
