// The Add Source wizard outlives its dialog, so every field has to be reset by
// hand, and a field somebody adds later is one nobody will remember to reset.
// Found in the UI: reopening the dialog kept the last source's URI, and with it
// any S3 secret or Glue key, ready for the next source to inherit.
//
// This reads the component's source, because the invariant is about all of its
// fields, present and future, not about one rendered value.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const WIZARD = readFileSync("src/components/catalog/AddSourceWizard.tsx", "utf8");

/** The body of the effect that runs when the dialog opens or closes. */
const resetEffect = (() => {
  const end = WIZARD.indexOf("}, [open]);");
  const start = WIZARD.lastIndexOf("useEffect(", end);
  expect(start).toBeGreaterThan(-1);
  return WIZARD.slice(start, end);
})();

/** Everything before the effect's `if (!open) return`, which runs on close too. */
const onClose = resetEffect.slice(0, resetEffect.indexOf("if (!open) return"));

const textFields = [...WIZARD.matchAll(/const \[\w+, (set\w+)\] = useState(?:<[^>]+>)?\("/g)].map(
  (m) => m[1],
);

describe("opening the Add Source wizard", () => {
  it("finds the fields it is checking", () => {
    expect(textFields).toEqual(
      expect.arrayContaining(["setSecretKey", "setGlueSecret", "setIcebergToken", "setHiveUri"]),
    );
  });

  it("resets every text field", () => {
    const missed = textFields.filter((setter) => !resetEffect.includes(`${setter}(`));
    expect(missed).toEqual([]);
  });

  it("drops a secret as soon as the dialog closes, not when it next opens", () => {
    const secrets = [...WIZARD.matchAll(/const \[\w+, (set\w+)\] = useState\(""\)/g)]
      .map((m) => m[1])
      .filter((setter) => /secret|token|password/i.test(setter));
    expect(secrets.length).toBeGreaterThanOrEqual(3);
    for (const setter of secrets) expect(onClose).toContain(`${setter}("")`);
  });
});
