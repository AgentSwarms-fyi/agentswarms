// confirmAsk and promptAsk reach the one mounted host, or refuse (R346).
//
// R346 split the host component (confirm-host.tsx) from the asking functions
// (confirm-dialog.ts), so the host now connects through connectConfirmHost
// instead of assigning a module variable. The tests that pinned this read the
// source text; these drive the functions: a question with no host rejects, a
// connected host answers it, and disconnecting an old host cannot cut off a
// newer one (a remount connects the new host before the old one's cleanup).
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmAsk,
  connectConfirmHost,
  promptAsk,
  type Pending,
} from "@/components/ui/confirm-dialog";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A host that answers every question with `answer`, and records what it was asked. */
const hostAnswering = (answer: boolean | string | null) => {
  const asked: Pending["req"][] = [];
  cleanups.push(
    connectConfirmHost((p) => {
      asked.push(p.req);
      p.resolve(answer);
    }),
  );
  return asked;
};

describe("with no host", () => {
  it("a confirmation rejects rather than answering no", async () => {
    await expect(confirmAsk({ title: "Drop table?" })).rejects.toThrow(/not mounted/);
  });

  it("a prompt rejects too", async () => {
    await expect(promptAsk({ title: "Rename", input: {} })).rejects.toThrow(/not mounted/);
  });
});

describe("with a host connected", () => {
  it("the host is asked the question, and its answer comes back as a yes or no", async () => {
    const asked = hostAnswering(true);
    await expect(confirmAsk({ title: "Delete X?", actionLabel: "Delete" })).resolves.toBe(true);
    expect(asked).toEqual([{ title: "Delete X?", actionLabel: "Delete" }]);
  });

  it("a dismissed confirmation is false, and a typed answer to one counts as yes", async () => {
    hostAnswering(false);
    await expect(confirmAsk({ title: "Delete X?" })).resolves.toBe(false);
    cleanups.pop()?.();
    hostAnswering("typed");
    await expect(confirmAsk({ title: "Delete X?" })).resolves.toBe(true);
  });

  it("a prompt gets the text, and null when the host gives no text", async () => {
    hostAnswering("Q3 plan");
    await expect(promptAsk({ title: "Rename", input: {} })).resolves.toBe("Q3 plan");
    cleanups.pop()?.();
    hostAnswering(false);
    await expect(promptAsk({ title: "Rename", input: {} })).resolves.toBeNull();
  });
});

describe("disconnecting", () => {
  it("leaves no host behind, so questions reject again", async () => {
    const disconnect = connectConfirmHost((p) => p.resolve(true));
    disconnect();
    await expect(confirmAsk({ title: "Delete X?" })).rejects.toThrow(/not mounted/);
  });

  it("an old host's disconnect does not cut off the host that replaced it", async () => {
    const disconnectOld = connectConfirmHost((p) => p.resolve(false));
    const asked = hostAnswering(true);
    disconnectOld();
    await expect(confirmAsk({ title: "Delete X?" })).resolves.toBe(true);
    expect(asked).toHaveLength(1);
  });
});
