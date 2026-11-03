// R441: /api/chat-docs, the one way a generated document is kept and fetched
// back. The route runs for real over an in-memory Storage and the real key
// hierarchy; the session check and the rate limiter are the stand-ins.
//
// What a user relies on: what is stored is sealed under their own key, in
// their own folder, whatever the request says; they get it back as it was;
// nobody gets another user's; and a document a key no longer opens says why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  storage: null as null | { client: unknown },
  users: new Map<string, string>(),
  limited: false,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/utils/audit.server", () => ({ auditEvent: () => {} }));
vi.mock("@/utils/rateLimit.server", () => ({
  envInt: (_name: string, fallback: number) => fallback,
  rateLimitedGlobal: async () => h.limited,
}));
vi.mock("@/integrations/supabase/client.server", async () => {
  // The auth server's own refusal, so the route's 401-or-503 rule sees what it would.
  const { AuthApiError } = await import("@supabase/supabase-js");
  return {
    supabaseAdmin: {
      get storage() {
        return h.storage!.client;
      },
      auth: {
        getUser: async (token: string) => {
          const id = h.users.get(token);
          return id
            ? { data: { user: { id } }, error: null }
            : { data: { user: null }, error: new AuthApiError("invalid JWT", 401, "bad_jwt") };
        },
      },
    },
  };
});

import { __setKeyHierarchyForTests } from "@/utils/providers/crypto.server";
import { isSealed, sealedKid } from "@/utils/storage/sealedFile";
import { attachmentName, chatDocMaxBytes } from "@/routes/api/chat-docs";
import { fakeStorage, type FakeStorage } from "../fixtures/fakeStorage";
import { memoryKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

type Handler = (a: { request: Request }) => Promise<Response>;
const { Route } = (await import("@/routes/api/chat-docs")) as unknown as {
  Route: { options: { server: { handlers: { POST: Handler; GET: Handler } } } };
};

const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const DOC = "11111111-1111-4111-8111-111111111111";
const FILE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("Q3 plan")]);

let mem: MemoryKeyStore;
let store: FakeStorage;
const original = {
  secret: process.env.PROVIDER_CREDS_SECRET,
  cache: process.env.DATA_KEY_CACHE_SECONDS,
  max: process.env.CHAT_DOC_MAX_BYTES,
};

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = "a".repeat(64);
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  delete process.env.CHAT_DOC_MAX_BYTES;
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store, null);
  store = fakeStorage();
  h.storage = store;
  h.users = new Map([
    ["alice-token", ALICE],
    ["bob-token", BOB],
  ]);
  h.limited = false;
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  for (const [k, v] of [
    ["PROVIDER_CREDS_SECRET", original.secret],
    ["DATA_KEY_CACHE_SECONDS", original.cache],
    ["CHAT_DOC_MAX_BYTES", original.max],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function put(
  query: string,
  body: BodyInit | null = FILE as BodyInit,
  token: string | null = "alice-token",
) {
  const res = await Route.options.server.handlers.POST({
    request: new Request(`http://app/api/chat-docs?${query}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body,
    }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { ok?: boolean; path?: string; error?: string },
  };
}

async function get(query: string, token: string | null = "alice-token") {
  return Route.options.server.handlers.GET({
    request: new Request(`http://app/api/chat-docs?${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  });
}

describe("storing a document", () => {
  it("seals it under the caller's key, in the caller's folder", async () => {
    const r = await put(`doc=${DOC}&format=docx`);
    expect(r).toEqual({ status: 200, body: { ok: true, path: `${ALICE}/${DOC}.docx` } });
    const obj = store.get("chat-docs", `${ALICE}/${DOC}.docx`)!;
    expect(isSealed(obj.bytes)).toBe(true);
    expect(sealedKid(obj.bytes)).toBe(mem.userKeys.find((k) => k.user_id === ALICE)!.kid);
  });

  it.each([
    ["no session", `doc=${DOC}&format=docx`, null, 401],
    ["a session that does not check out", `doc=${DOC}&format=docx`, "forged", 401],
    ["no document id", "format=docx", "alice-token", 400],
    ["a path for a document id", `doc=../${DOC}&format=docx`, "alice-token", 400],
    ["another format", `doc=${DOC}&format=pdf`, "alice-token", 400],
  ])("refuses %s", async (_label, query, token, status) => {
    expect((await put(query, FILE as BodyInit, token)).status).toBe(status);
    expect(store.calls.upload).toBe(0);
  });

  it("refuses an empty document", async () => {
    expect((await put(`doc=${DOC}&format=docx`, new Uint8Array() as BodyInit)).status).toBe(400);
  });

  it("refuses one above CHAT_DOC_MAX_BYTES and says the limit", async () => {
    process.env.CHAT_DOC_MAX_BYTES = String(4);
    const r = await put(`doc=${DOC}&format=docx`);
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/CHAT_DOC_MAX_BYTES/);
    expect(store.calls.upload).toBe(0);
  });

  it("says so when the caller is storing too fast", async () => {
    h.limited = true;
    expect((await put(`doc=${DOC}&format=docx`)).status).toBe(429);
  });

  it("a store that refuses is a 502 with its reason", async () => {
    store.failures["chat-docs"] = { upload: "quota exceeded" };
    const r = await put(`doc=${DOC}&format=docx`);
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("This document could not be stored: quota exceeded.");
  });
});

describe("fetching a document", () => {
  it("gives the owner back what was stored, as an attachment", async () => {
    await put(`doc=${DOC}&format=docx`);
    const res = await get(`path=${ALICE}/${DOC}.docx&filename=Q3%20plan.docx`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
    expect(res.headers.get("Content-Type")).toMatch(/wordprocessingml/);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Q3 plan.docx"');
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
  });

  it("serves a document stored before R441 as it is", async () => {
    store.put("chat-docs", `${ALICE}/${DOC}.docx`, FILE);
    const res = await get(`path=${ALICE}/${DOC}.docx`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
  });

  it("never gives one user another's document", async () => {
    await put(`doc=${DOC}&format=docx`);
    const res = await get(`path=${ALICE}/${DOC}.docx`, "bob-token");
    expect(res.status).toBe(404);
    expect(store.calls.download).toBe(0);
  });

  it.each([
    ["a path outside the bucket's layout", `path=${ALICE}/../x.docx`],
    ["another extension", `path=${ALICE}/${DOC}.pdf`],
    ["no path", ""],
  ])("refuses %s", async (_label, query) => {
    expect((await get(query)).status).toBe(404);
  });

  it("a document that is gone says it expired", async () => {
    const res = await get(`path=${ALICE}/${DOC}.docx`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/expired/);
  });

  it("a document under an erased key says so, not that it expired", async () => {
    await put(`doc=${DOC}&format=docx`);
    mem.erase(ALICE);
    const res = await get(`path=${ALICE}/${DOC}.docx`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /^This document was stored under a user key that was erased on \d{4}-\d{2}-\d{2}; it cannot be read\.$/,
    );
  });
});

describe("the route's small rules", () => {
  it.each([
    [undefined, 50 * 1024 * 1024],
    ["", 50 * 1024 * 1024],
    ["1048576", 1048576],
    ["0", 50 * 1024 * 1024],
    ["lots", 50 * 1024 * 1024],
  ])("CHAT_DOC_MAX_BYTES=%s is %d", (raw, want) => {
    expect(chatDocMaxBytes(raw === undefined ? {} : { CHAT_DOC_MAX_BYTES: raw })).toBe(want);
  });

  it.each([
    ["Q3 plan.docx", "docx", "Q3 plan.docx"],
    ["Q3 plan", "docx", "Q3 plan.docx"],
    ['evil".docx\r\nX-Header: 1', "docx", "evil.docxX-Header: 1.docx"],
    ["Zürich deck", "pptx", "Z_rich deck.pptx"],
    ["../../etc/passwd", "xlsx", "....etcpasswd.xlsx"],
    [null, "xlsx", "document.xlsx"],
  ] as const)("names %j as %j", (raw, format, want) => {
    expect(attachmentName(raw, format)).toBe(want);
  });
});
