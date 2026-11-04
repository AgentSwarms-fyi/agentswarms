// R441: generated documents and dataset copies, sealed by the app under their
// owner's key, through the real crypto module and key hierarchy.
//
// The store is an in-memory Supabase Storage (tests/fixtures/fakeStorage.ts),
// the keys an in-memory key store; the dataset rebuild is the one thing
// mocked, since it pages a table's rows. What is checked is what an owner
// relies on: the bucket holds ciphertext under the owner's key and nobody
// else's; moving the owner rewrites nothing; erasing or destroying the key
// leaves the file unreadable, and says so in words; the pass puts every file
// under its owner's key and never touches one under a key that is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  storage: null as null | { client: { from: (b: string) => unknown } },
  audits: [] as Array<Record<string, unknown>>,
  refresh: vi.fn(),
  // The memory pass (R445) runs with the files pass: its own tests are
  // memorySealing.test.ts's; here it says what it was asked and returns this.
  chat: vi.fn(async (_opts: { limit?: number }) => ({
    messages: 0,
    titles: 0,
    swarmChats: 0,
    analystThreads: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [] as string[],
  })),
  runs: vi.fn(async (_opts: { limit?: number }) => ({
    runs: 0,
    steps: 0,
    edges: 0,
    checkpoints: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [] as string[],
  })),
  traces: vi.fn(async (_opts: { limit?: number }) => ({
    traces: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [] as string[],
  })),
  memory: vi.fn(async (_opts: { limit?: number }) => ({
    items: 0,
    summaries: 0,
    scratchpads: 0,
    unreadable: 0,
    left: false,
    failed: 0,
    errors: [] as string[],
  })),
}));

vi.mock("@/utils/audit.server", () => ({
  auditEvent: (e: Record<string, unknown>) => h.audits.push(e),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    get storage() {
      return h.storage!.client;
    },
  },
}));
vi.mock("@/utils/data/parquet.server", () => ({
  refreshDatasetMirror: (args: unknown) => h.refresh(args),
}));
vi.mock("@/utils/observability/sealedRuns.server", () => ({
  sealOlderRuns: (opts: { limit?: number }) => h.runs(opts),
}));
vi.mock("@/utils/observability/sealedTraces.server", () => ({
  sealOlderTraces: (opts: { limit?: number }) => h.traces(opts),
  traceSealPerPass: () => 2000,
}));
vi.mock("@/utils/chat/sealedChat.server", async () => {
  const pass =
    await vi.importActual<typeof import("@/utils/chat/chatPass")>("@/utils/chat/chatPass");
  return {
    sealOlderChats: (opts: { limit?: number }) => h.chat(opts),
    chatSealPerPass: () => 2000,
    chatPassDetail: pass.chatPassDetail,
  };
});
vi.mock("@/utils/memory/sealed.server", async () => {
  const pass = await vi.importActual<typeof import("@/utils/memory/memoryPass")>(
    "@/utils/memory/memoryPass",
  );
  return {
    sealOlderMemory: (opts: { limit?: number }) => h.memory(opts),
    memorySealPerPass: () => 1000,
    memoryPassDetail: pass.memoryPassDetail,
  };
});

import { DataKeyUnavailableError, type CustomerKeyRow } from "@/utils/kms/keyHierarchy.server";
import {
  __setKeyHierarchyForTests,
  keyHierarchy,
  sealStoredFile,
} from "@/utils/providers/crypto.server";
import { isSealed, SealedFileError, sealedKid } from "@/utils/storage/sealedFile";
import { SEALED_CONTENT_TYPE, sealedContentType } from "@/utils/storage/storedFiles";
import {
  describeStoredFileError,
  getStoredFile,
  isNotFound,
  putStoredFile,
  sealOlderStoredFiles,
  storedFilesPerPass,
  sweepStoredFiles,
} from "@/utils/storage/storedFiles.server";
import { fakeStorage, type FakeStorage } from "../fixtures/fakeStorage";
import { memoryKeyStore, type MemoryKeyStore } from "../fixtures/keyStores";

const KEY_A = "a".repeat(64);
const ALICE = "00000000-0000-4000-8000-00000000a11c";
const BOB = "00000000-0000-4000-8000-000000000b0b";
const DOC1 = "11111111-1111-4111-8111-111111111111";
const DOC2 = "22222222-2222-4222-8222-222222222222";
const DOC3 = "33333333-3333-4333-8333-333333333333";
const TABLE = "44444444-4444-4444-8444-444444444444";

const docPath = (owner: string, doc = DOC1) => `${owner}/${doc}.docx`;
const copyPath = (owner: string) => `${owner}/${TABLE}.parquet`;
/** An Office document as the browser built it: a ZIP. */
const docx = (text = "Board minutes, draft 3") =>
  new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(text)]);
const parquet = () => new TextEncoder().encode("PAR1 rows of the dataset PAR1");

let mem: MemoryKeyStore;
let store: FakeStorage;

const original = {
  secret: process.env.PROVIDER_CREDS_SECRET,
  cache: process.env.DATA_KEY_CACHE_SECONDS,
};

beforeEach(() => {
  process.env.PROVIDER_CREDS_SECRET = KEY_A;
  // Every read asks the store again, so an erasure is seen at once.
  process.env.DATA_KEY_CACHE_SECONDS = "0";
  mem = memoryKeyStore();
  __setKeyHierarchyForTests(mem.store, null);
  store = fakeStorage();
  h.storage = store;
  h.audits = [];
  h.refresh.mockReset();
});

afterEach(() => {
  __setKeyHierarchyForTests(null);
  vi.useRealTimers();
  if (original.secret) process.env.PROVIDER_CREDS_SECRET = original.secret;
  else delete process.env.PROVIDER_CREDS_SECRET;
  if (original.cache === undefined) delete process.env.DATA_KEY_CACHE_SECONDS;
  else process.env.DATA_KEY_CACHE_SECONDS = original.cache;
});

/** A customer key held by the app, made the way the admin card makes one. */
async function customerKey(name: string): Promise<CustomerKeyRow> {
  const id = crypto.randomUUID();
  const material = await keyHierarchy().makeCustomerKeyMaterial({
    id,
    name,
    provider: "app",
    keyRef: null,
    endpoint: null,
  });
  const row: CustomerKeyRow = {
    id,
    name,
    provider: "app",
    key_ref: null,
    endpoint: null,
    ...material,
    created_at: new Date().toISOString(),
    destroyed_at: null,
  };
  mem.customerKeys.set(id, row);
  return row;
}

const liveKid = (user: string) => mem.userKeys.find((k) => k.user_id === user && !k.erased_at)?.kid;

describe("a stored file is sealed under its owner's key", () => {
  it("the bucket holds ciphertext, named by its key, and the app opens it", async () => {
    const plain = docx();
    const { kid } = await putStoredFile("chat-docs", docPath(ALICE), plain);
    const obj = store.get("chat-docs", docPath(ALICE))!;
    expect(isSealed(obj.bytes)).toBe(true);
    expect(kid).toBe(liveKid(ALICE));
    expect(sealedKid(obj.bytes)).toBe(kid);
    expect(obj.contentType).toBe(sealedContentType(kid));
    expect(new TextDecoder("latin1").decode(obj.bytes)).not.toContain("Board minutes");
    const opened = await getStoredFile("chat-docs", docPath(ALICE));
    expect(opened).toEqual({ bytes: plain, kid });
  });

  it("refuses a path that is in nobody's folder, and stores nothing", async () => {
    await expect(putStoredFile("chat-docs", "shared/doc.docx", docx())).rejects.toThrow(
      /not in an owner's folder/,
    );
    expect(store.calls.upload).toBe(0);
  });

  it("a file from before R441 is read as it is", async () => {
    store.put("chat-docs", docPath(ALICE), docx(), "application/vnd.openxmlformats");
    expect(await getStoredFile("chat-docs", docPath(ALICE))).toEqual({ bytes: docx(), kid: null });
  });

  it("no file is null; a store that fails is an error, not a missing file", async () => {
    expect(await getStoredFile("chat-docs", docPath(ALICE))).toBeNull();
    store.put("chat-docs", docPath(ALICE), docx());
    store.failures["chat-docs"] = { download: "storage is down" };
    await expect(getStoredFile("chat-docs", docPath(ALICE))).rejects.toThrow("storage is down");
  });

  it("copied into another user's folder, it does not open", async () => {
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    const obj = store.get("chat-docs", docPath(ALICE))!;
    store.put("chat-docs", docPath(BOB), obj.bytes, obj.contentType);
    await expect(getStoredFile("chat-docs", docPath(BOB))).rejects.toBeInstanceOf(SealedFileError);
  });

  it("moving the owner under a customer key rewrites no file", async () => {
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    const uploads = store.calls.upload;
    const acme = await customerKey("Acme");
    mem.assignUser(acme.id, ALICE);
    expect(await keyHierarchy().reconcile(ALICE)).toBe("moved");
    expect(mem.userKeys.find((k) => k.user_id === ALICE)!.customer_key_id).toBe(acme.id);
    expect((await getStoredFile("chat-docs", docPath(ALICE)))!.bytes).toEqual(docx());
    expect(store.calls.upload).toBe(uploads);
  });

  it("an erased user key leaves the file unreadable, said in words", async () => {
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    mem.erase(ALICE);
    const err = await getStoredFile("chat-docs", docPath(ALICE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataKeyUnavailableError);
    expect((err as DataKeyUnavailableError).reason).toBe("erased");
    expect(describeStoredFileError(err, "This document")).toMatch(
      /^This document was stored under a user key that was erased on \d{4}-\d{2}-\d{2}; it cannot be read\.$/,
    );
  });

  it("a destroyed customer key leaves its members' files unreadable", async () => {
    const acme = await customerKey("Acme");
    mem.assignUser(acme.id, ALICE);
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    await putStoredFile("chat-docs", docPath(BOB), docx("Bob's"));
    mem.destroy(acme.id);
    keyHierarchy().forgetCustomer(acme.id);
    // Destroying a customer key erases the user keys it wraps, in the same step.
    const err = await getStoredFile("chat-docs", docPath(ALICE)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataKeyUnavailableError);
    expect(describeStoredFileError(err, "This document")).toMatch(
      /^This document was stored under a user key that was erased on \d{4}-\d{2}-\d{2}; it cannot be read\.$/,
    );
    // Nobody else's.
    expect((await getStoredFile("chat-docs", docPath(BOB)))!.bytes).toEqual(docx("Bob's"));
  });

  it("an owner whose key cannot be chosen stores nothing, and the reason reads as one sentence", async () => {
    const acme = await customerKey("Acme");
    const globex = await customerKey("Globex");
    mem.group("g1", "acme-staff", [ALICE]);
    mem.group("g2", "globex-staff", [ALICE]);
    mem.assignGroup(acme.id, "g1");
    mem.assignGroup(globex.id, "g2");
    const err = await putStoredFile("chat-docs", docPath(ALICE), docx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataKeyUnavailableError);
    expect(store.calls.upload).toBe(0);
    const said = describeStoredFileError(err, "This document", "stored");
    expect(said).toMatch(/^This document cannot be stored: This user is in groups/);
    expect(said).not.toMatch(/\.\.$/);
  });

  it("knows a missing object by storage-js's shapes", () => {
    expect(isNotFound({ message: "Object not found", status: 400, statusCode: "404" })).toBe(true);
    expect(isNotFound({ message: "x", code: "NoSuchKey" })).toBe(true);
    expect(isNotFound({ message: "Internal error", status: 500 })).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe("the pass puts every file under its owner's key", () => {
  it("seals a document from before R441 in place", async () => {
    store.put("chat-docs", docPath(ALICE), docx(), "application/vnd.openxmlformats");
    const r = await sealOlderStoredFiles();
    expect(r).toMatchObject({ files: 1, documents: 1, sealedNow: 1, failed: 0 });
    const obj = store.get("chat-docs", docPath(ALICE))!;
    expect(sealedKid(obj.bytes)).toBe(liveKid(ALICE));
    expect((await getStoredFile("chat-docs", docPath(ALICE)))!.bytes).toEqual(docx());
  });

  it("counts a file already under its key from the listing, without downloading it", async () => {
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    const r = await sealOlderStoredFiles();
    expect(r).toMatchObject({ files: 1, alreadyRight: 1, sealedNow: 0 });
    expect(store.calls.download).toBe(0);
  });

  it("moves a document sealed under the deployment's key onto the owner's", async () => {
    const where = `chat-docs/${docPath(ALICE)}`;
    const { sealed, kid } = await sealStoredFile(docx(), { owner: null, where });
    store.put("chat-docs", docPath(ALICE), sealed, sealedContentType(kid));
    const r = await sealOlderStoredFiles();
    expect(r.sealedNow).toBe(1);
    expect(sealedKid(store.get("chat-docs", docPath(ALICE))!.bytes)).toBe(liveKid(ALICE));
    expect(liveKid(ALICE)).not.toBe(kid);
  });

  it("leaves a document under an erased key exactly as it is", async () => {
    await putStoredFile("chat-docs", docPath(ALICE), docx());
    const before = store.get("chat-docs", docPath(ALICE))!.bytes;
    mem.erase(ALICE);
    const r = await sealOlderStoredFiles();
    expect(r).toMatchObject({ unreadable: 1, sealedNow: 0, failed: 0 });
    expect(store.get("chat-docs", docPath(ALICE))!.bytes).toEqual(before);
  });

  it("leaves a file in nobody's folder, and counts it", async () => {
    store.put("chat-docs", "loose.docx", docx());
    const r = await sealOlderStoredFiles();
    expect(r).toMatchObject({ files: 1, notOwned: 1, sealedNow: 0 });
    expect(isSealed(store.get("chat-docs", "loose.docx")!.bytes)).toBe(false);
  });

  it("changes at most `limit` files and counts the rest as left", async () => {
    for (const d of [DOC1, DOC2, DOC3]) store.put("chat-docs", docPath(ALICE, d), docx());
    expect(await sealOlderStoredFiles({ limit: 2 })).toMatchObject({ sealedNow: 2, left: 1 });
    expect(await sealOlderStoredFiles()).toMatchObject({ sealedNow: 1, alreadyRight: 2, left: 0 });
  });

  it("rebuilds a dataset copy from before R441 from its rows, not in place", async () => {
    store.put("datasets", copyPath(ALICE), parquet(), "application/vnd.apache.parquet");
    h.refresh.mockResolvedValue({ rows: 10, bytes: 99 });
    const r = await sealOlderStoredFiles();
    expect(r).toMatchObject({ copies: 1, rebuilt: 1, sealedNow: 0 });
    expect(h.refresh).toHaveBeenCalledWith({ userId: ALICE, tableId: TABLE });
    expect(store.calls.upload).toBe(0);
  });

  it("counts a copy its rebuild could not make", async () => {
    store.put("datasets", copyPath(ALICE), parquet(), "application/vnd.apache.parquet");
    h.refresh.mockResolvedValue(null);
    expect(await sealOlderStoredFiles()).toMatchObject({ rebuilt: 0, notRebuilt: 1, failed: 0 });
  });

  it("leaves a dataset copy under an erased key, and does not rebuild it", async () => {
    await putStoredFile("datasets", copyPath(ALICE), parquet());
    mem.erase(ALICE);
    expect(await sealOlderStoredFiles()).toMatchObject({ unreadable: 1, rebuilt: 0 });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("reads the key from the header when the listed type names none", async () => {
    await putStoredFile("datasets", copyPath(ALICE), parquet());
    const obj = store.get("datasets", copyPath(ALICE))!;
    store.put("datasets", copyPath(ALICE), obj.bytes, SEALED_CONTENT_TYPE);
    expect(await sealOlderStoredFiles()).toMatchObject({ alreadyRight: 1, rebuilt: 0 });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a bucket it cannot list is a failure, and the other bucket still runs", async () => {
    store.put("datasets", copyPath(ALICE), parquet(), "application/vnd.apache.parquet");
    h.refresh.mockResolvedValue({ rows: 1, bytes: 1 });
    store.failures["chat-docs"] = { list: "permission denied" };
    const r = await sealOlderStoredFiles();
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toBe("chat-docs: chat-docs: permission denied");
    expect(r.rebuilt).toBe(1);
  });

  it("counts a document deleted while the pass ran", async () => {
    store.put("chat-docs", docPath(ALICE), docx());
    const from = store.client.from;
    store.client.from = (bucket: string) => {
      const b = from(bucket);
      return {
        ...b,
        download: async (path: string) => {
          store.objects.get(bucket)!.delete(path);
          return b.download(path);
        },
      };
    };
    expect(await sealOlderStoredFiles()).toMatchObject({ files: 1, vanished: 1, sealedNow: 0 });
  });
});

describe("the background pass", () => {
  it("runs at most hourly, changes a bounded number, and is audited only when it did something", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.UTC(2026, 10, 3, 12);
    vi.setSystemTime(t0);
    process.env.STORED_FILES_PER_PASS = "1";
    try {
      store.put("chat-docs", docPath(ALICE, DOC1), docx());
      store.put("chat-docs", docPath(ALICE, DOC2), docx());
      const first = await sweepStoredFiles();
      expect(first).toMatchObject({ sealedNow: 1, left: 1 });
      expect(h.audits).toHaveLength(1);
      expect(h.audits[0]).toMatchObject({
        action: "security.stored_files.seal",
        actorEmail: "system:kms",
        detail: { trigger: "scheduled", files_sealed_now: 1, files_left: 1 },
      });
      vi.setSystemTime(t0 + 30 * 60_000);
      expect(await sweepStoredFiles()).toBeNull();
      vi.setSystemTime(t0 + 61 * 60_000);
      expect(await sweepStoredFiles()).toMatchObject({ sealedNow: 1, left: 0 });
      vi.setSystemTime(t0 + 122 * 60_000);
      expect(await sweepStoredFiles()).toMatchObject({ sealedNow: 0, alreadyRight: 2 });
      expect(h.audits).toHaveLength(2);
      // R445: every pass also seals agent memory stored before, bounded, and
      // a pass that sealed only memory is audited, its counts in the same row.
      expect(h.memory).toHaveBeenCalledWith({ limit: 1000 });
      // R446: and Agent Chat history, bounded too.
      expect(h.chat).toHaveBeenCalledWith({ limit: 2000 });
      h.memory.mockResolvedValueOnce({
        items: 3,
        summaries: 1,
        scratchpads: 0,
        unreadable: 0,
        left: false,
        failed: 0,
        errors: [],
      });
      expect(await sweepStoredFiles(true)).not.toBeNull();
      expect(h.audits).toHaveLength(3);
      expect(h.audits[2]).toMatchObject({
        detail: {
          trigger: "scheduled",
          files_sealed_now: 0,
          memory_items_sealed: 3,
          summaries_sealed: 1,
        },
      });
      // A pass that sealed only chat history is audited too, in the same row.
      h.chat.mockResolvedValueOnce({
        messages: 12,
        titles: 2,
        swarmChats: 1,
        analystThreads: 3,
        unreadable: 0,
        left: false,
        failed: 0,
        errors: [],
      });
      expect(await sweepStoredFiles(true)).not.toBeNull();
      expect(h.audits).toHaveLength(4);
      expect(h.audits[3]).toMatchObject({
        detail: {
          trigger: "scheduled",
          messages_sealed: 12,
          titles_sealed: 2,
          swarm_chats_sealed: 1,
          analyst_threads_sealed: 3,
        },
      });
      // And one that sealed only model call traces, with their own limit.
      expect(h.traces).toHaveBeenCalledWith({ limit: 2000 });
      h.traces.mockResolvedValueOnce({
        traces: 40,
        unreadable: 0,
        left: true,
        failed: 0,
        errors: [],
      });
      expect(await sweepStoredFiles(true)).not.toBeNull();
      expect(h.audits).toHaveLength(5);
      expect(h.audits[4]).toMatchObject({
        detail: { trigger: "scheduled", traces_sealed: 40, traces_left: true },
      });
      // And one that sealed only swarm run traces, under the same limit.
      expect(h.runs).toHaveBeenCalledWith({ limit: 2000 });
      h.runs.mockResolvedValueOnce({
        runs: 2,
        steps: 6,
        edges: 0,
        checkpoints: 0,
        unreadable: 0,
        left: false,
        failed: 0,
        errors: [],
      });
      expect(await sweepStoredFiles(true)).not.toBeNull();
      expect(h.audits).toHaveLength(6);
      expect(h.audits[5]).toMatchObject({
        detail: { trigger: "scheduled", swarm_runs_sealed: 2, run_steps_sealed: 6 },
      });
    } finally {
      delete process.env.STORED_FILES_PER_PASS;
    }
  });

  it.each([
    [undefined, 25],
    ["", 25],
    ["3", 3],
    ["0", 25],
    ["-2", 25],
    ["1.5", 25],
    ["many", 25],
  ])("STORED_FILES_PER_PASS=%s is %d", (raw, want) => {
    expect(storedFilesPerPass(raw === undefined ? {} : { STORED_FILES_PER_PASS: raw })).toBe(want);
  });
});
