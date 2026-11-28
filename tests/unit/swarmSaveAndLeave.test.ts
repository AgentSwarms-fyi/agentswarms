// Leaving the swarm canvas with unsaved edits offers to save them.
//
// The question offered only "Discard changes" or Cancel, so keeping the edits
// meant cancelling, finding the Save button and leaving again. It now offers
// "Save and leave" too, and leads with it; a save that fails keeps you on the
// canvas.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALTERNATIVE,
  chooseAsk,
  confirmAsk,
  connectConfirmHost,
  type Pending,
} from "@/components/ui/confirm-dialog";

describe("a question with two ways forward", () => {
  let disconnect: () => void = () => {};
  afterEach(() => disconnect());
  /** A host that answers every question with `answer`. */
  const answering = (answer: Parameters<Pending["resolve"]>[0]) => {
    const asked: Pending["req"][] = [];
    disconnect = connectConfirmHost((p) => {
      asked.push(p.req);
      p.resolve(answer);
    });
    return asked;
  };
  const req = {
    title: "Save the changes?",
    actionLabel: "Discard changes",
    alternativeLabel: "Save and leave",
  };

  it("says the alternative was picked", async () => {
    const asked = answering(ALTERNATIVE);
    expect(await chooseAsk(req)).toBe("alternative");
    expect(asked[0]).toMatchObject({ alternativeLabel: "Save and leave" });
  });

  it("says the action was picked", async () => {
    answering(true);
    expect(await chooseAsk(req)).toBe("action");
  });

  it("is neither when dismissed (Cancel, Escape, a click outside)", async () => {
    answering(false);
    expect(await chooseAsk(req)).toBe("cancel");
    answering(null);
    expect(await chooseAsk(req)).toBe("cancel");
  });

  it("rejects rather than answering when no dialog is mounted", async () => {
    disconnect();
    await expect(chooseAsk(req)).rejects.toThrow("not mounted");
  });

  it("leaves a plain yes/no question as it was", async () => {
    answering(true);
    expect(await confirmAsk({ title: "Delete?" })).toBe(true);
    answering(false);
    expect(await confirmAsk({ title: "Delete?" })).toBe(false);
    answering(ALTERNATIVE);
    expect(await confirmAsk({ title: "Delete?" })).toBe(false);
  });
});

describe("the dialog", () => {
  const host = readFileSync("src/components/ui/confirm-host.tsx", "utf8");

  it("shows the alternative only when there is one, and leads with it", () => {
    expect(host).toMatch(
      /\{alternativeLabel && \(\s*<AlertDialogAction onClick=\{\(\) => settle\(ALTERNATIVE\)\}>\s*\{alternativeLabel\}/,
    );
    // text-foreground: AlertDialogAction keeps the filled button's light text
    // colour, and the outline style sets none, so without it the text was
    // light on a light button, visible only on hover.
    expect(host).toMatch(
      /alternativeLabel\s*\?\s*`\$\{buttonVariants\(\{ variant: "outline" \}\)\} text-foreground`\s*:\s*undefined/,
    );
  });
});

describe("the canvas", () => {
  const canvas = readFileSync("src/routes/_authenticated/swarms.tsx", "utf8");
  const ask = canvas.slice(
    canvas.indexOf("async function mayDiscard(what: string)"),
    canvas.indexOf("useBlocker({"),
  );
  const save = canvas.slice(
    canvas.indexOf("const handleSave = async (overwrite = false): Promise<boolean> => {"),
    canvas.indexOf("const handleRestoreVersion = async ("),
  );

  it("offers Save and leave beside Discard changes", () => {
    expect(ask).toMatch(
      /const choice = await chooseAsk\(\{[\s\S]*?actionLabel: "Discard changes",\s*alternativeLabel: "Save and leave",\s*\}\);/,
    );
  });

  it("leaves only once the save succeeded, and stays on the canvas when it failed", () => {
    expect(ask).toContain('if (choice === "alternative") return handleSave();');
    expect(ask).toContain('return choice === "action";');
  });

  it("says from every way out of a save whether it saved", () => {
    expect(save).not.toMatch(/return;/);
    expect(save.match(/return true;/g)).toHaveLength(2); // a first save, and an update
    expect(save.match(/return false;/g)).toHaveLength(6);
    expect(save).toMatch(/toast\.success\("Swarm saved to your library"\);\s*return true;/);
    expect(save).toMatch(/toast\.success\("Swarm saved"\);\s*return true;/);
  });
});
