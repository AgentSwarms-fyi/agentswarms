// R441: what the app reads off a stored file without opening it: whose it is
// (its folder), which key its content type names, and the pass line.
import { describe, expect, it } from "vitest";

import {
  kidOfContentType,
  ownerOfPath,
  SEALED_CONTENT_TYPE,
  sealedContentType,
  storedFilesPassLine,
} from "@/utils/storage/storedFiles";

const ALICE = "00000000-0000-4000-8000-00000000a11c";

describe("whose file it is", () => {
  it("the user named by the first folder", () => {
    expect(ownerOfPath(`${ALICE}/doc.docx`)).toBe(ALICE);
    expect(ownerOfPath(`${ALICE.toUpperCase()}/doc.docx`)).toBe(ALICE);
  });

  it.each([
    ["a file at the root", "doc.docx"],
    ["a folder that is not a user id", "shared/doc.docx"],
    ["a user's folder and no file", `${ALICE}/`],
    ["a climb out of the folder", `${ALICE}/../other/doc.docx`],
    ["an empty segment", `${ALICE}//doc.docx`],
  ])("nobody's: %s", (_label, path) => {
    expect(ownerOfPath(path)).toBeNull();
  });
});

describe("the key a content type names", () => {
  it("round-trips a fingerprint", () => {
    expect(kidOfContentType(sealedContentType("3fa9c01b22de"))).toBe("3fa9c01b22de");
  });

  it("reads a quoted parameter and any case of the type", () => {
    expect(kidOfContentType(`${SEALED_CONTENT_TYPE.toUpperCase()}; kid="ab12"`)).toBe("ab12");
  });

  it("is null for a sealed type naming none, so the caller opens the file", () => {
    expect(kidOfContentType(SEALED_CONTENT_TYPE)).toBeNull();
    expect(kidOfContentType(`${SEALED_CONTENT_TYPE}; kid=a b`)).toBeNull();
  });

  it("is undefined for any other type: a file from before, or not ours", () => {
    expect(kidOfContentType("application/vnd.apache.parquet")).toBeUndefined();
    expect(kidOfContentType("application/octet-stream; kid=ab12")).toBeUndefined();
    expect(kidOfContentType(null)).toBeUndefined();
  });

  it("leaves out a fingerprint a parameter cannot carry", () => {
    expect(sealedContentType("not ok;")).toBe(SEALED_CONTENT_TYPE);
  });
});

describe("the pass line", () => {
  it("accounts for every file", () => {
    expect(
      storedFilesPassLine({
        files: 12,
        documents: 9,
        copies: 3,
        files_sealed_now: 4,
        copies_rebuilt: 2,
        files_already_right: 3,
        files_unreadable: 1,
        copies_not_rebuilt: 1,
        files_not_owned: 1,
        files_vanished: 0,
        files_left: 0,
        files_failed: 0,
      }),
    ).toBe(
      "12 files checked (9 documents, 3 dataset copies) · 4 encrypted under their owner's key · 2 dataset copies rebuilt under it · 3 already under it · 1 under a key that is gone, left as they are · 1 dataset copy not rebuilt (its dataset answers from its rows meanwhile) · 1 outside an owner's folder, left",
    );
  });

  it("says what was left for the next pass, what failed, and why nothing ran", () => {
    expect(
      storedFilesPassLine({
        files: 1,
        documents: 1,
        copies: 0,
        files_vanished: 2,
        files_left: 5,
        files_failed: 1,
        copies_not_rebuilt: 2,
        skipped: "No bucket",
      }),
    ).toBe(
      "1 file checked (1 document, 0 dataset copies) · 2 dataset copies not rebuilt (their datasets answer from their rows meanwhile) · 2 deleted while the pass ran · 5 left for the next pass · 1 failed · No bucket",
    );
  });

  it("says what chat history the same pass encrypted, and what it left (R446, R447)", () => {
    expect(
      storedFilesPassLine({
        files: 0,
        documents: 0,
        copies: 0,
        messages_sealed: 20,
        titles_sealed: 1,
        swarm_chats_sealed: 2,
        analyst_threads_sealed: 3,
        chat_unreadable: 1,
        chat_left: true,
        chat_failed: 1,
      }),
    ).toBe(
      "0 files checked (0 documents, 0 dataset copies) · 20 chat messages, 1 chat title, 2 swarm chats, 3 AI Analyst threads encrypted under their owner's key · 1 of chat history whose owner's key cannot be had now, left as they are · more chat history left for the next pass · 1 of chat history failed",
    );
  });

  it("says what agent memory the same pass encrypted, and what it left (R445)", () => {
    expect(
      storedFilesPassLine({
        files: 0,
        documents: 0,
        copies: 0,
        memory_items_sealed: 3,
        summaries_sealed: 1,
        scratchpads_sealed: 2,
        memory_unreadable: 1,
        memory_left: true,
        memory_failed: 1,
      }),
    ).toBe(
      "0 files checked (0 documents, 0 dataset copies) · 3 memory items, 1 conversation summary, 2 scratchpads of agent memory encrypted under their owner's key · 1 of agent memory whose owner's key cannot be had now, left as they are · more agent memory left for the next pass · 1 of agent memory failed",
    );
  });
});
