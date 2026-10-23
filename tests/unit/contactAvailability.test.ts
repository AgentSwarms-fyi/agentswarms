// The contact form says when this instance cannot send it (R358).
//
// FOUND FROM THE UI (R345). On an instance with no CONTACT_ADMIN_EMAIL, the
// contact page took a whole message and then answered 500 "Contact form is not
// configured.", shown as an error toast: a fault, as far as the visitor could
// tell, for what is the operator's setup. The route now answers 503 with a
// sentence that says so, and a GET tells the page beforehand, without
// revealing the address.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/lib/email/mailer.server", () => ({ sendMail: async () => ({ sent: true }) }));

type Handlers = {
  GET: () => Promise<Response>;
  POST: (a: { request: Request }) => Promise<Response>;
};
let handlers: Handlers;
beforeAll(async () => {
  const { Route } = (await import("@/routes/api/contact")) as unknown as {
    Route: { options: { server: { handlers: Handlers } } };
  };
  handlers = Route.options.server.handlers;
}, 120_000);

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});
const configure = (adminEmail: string | undefined) => {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-for-tests";
  if (adminEmail) process.env.CONTACT_ADMIN_EMAIL = adminEmail;
  else delete process.env.CONTACT_ADMIN_EMAIL;
};
const post = () =>
  handlers.POST({
    request: new Request("http://app.test/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ana", email: "r358@example.test", message: "Hello there" }),
    }),
  });

describe("an instance with no contact address", () => {
  it("answers 503, and says the form is not set up here", async () => {
    configure(undefined);
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "The contact form is not set up on this instance, so it cannot send messages.",
      code: "CONTACT_NOT_CONFIGURED",
    });
  });

  it("tells the page beforehand, and nothing about the address", async () => {
    configure(undefined);
    expect(await (await handlers.GET()).json()).toEqual({ available: false });
    configure("owner@example.test");
    const body = await (await handlers.GET()).text();
    expect(JSON.parse(body)).toEqual({ available: true });
    expect(body).not.toContain("owner@example.test");
  });
});

describe("the page", () => {
  const PAGE = readFileSync("src/routes/contact.tsx", "utf8");

  it("asks before anyone types, and holds the button when the form cannot send", () => {
    expect(PAGE).toContain('fetch("/api/contact")');
    expect(PAGE).toContain("{available === false && (");
    expect(PAGE).toContain("disabled={submitting || available === false}");
    expect(PAGE).toContain("The contact form is not set up on this instance");
  });
});
