// `?new=1&template=<id>` (R530): start a new one from a template. The id is
// read only together with `new`, only in a shape a template id has, and taken
// out of the address with the rest of the request.
import { describe, expect, it } from "vitest";

import { readPageIntent, withoutPageIntent } from "@/lib/pageIntent";

describe("readPageIntent with a template", () => {
  it("reads the template beside new", () => {
    expect(readPageIntent({ new: 1, template: "web_research" })).toEqual({
      new: 1,
      template: "web_research",
    });
    expect(readPageIntent({ new: "1", template: "sample:sql-explainer" })).toEqual({
      new: 1,
      template: "sample:sql-explainer",
    });
  });

  it("ignores a template without new", () => {
    expect(readPageIntent({ template: "web_research" })).toEqual({});
    expect(readPageIntent({ open: "abc", template: "web_research" })).toEqual({ open: "abc" });
  });

  it("ignores what is not shaped like a template id", () => {
    for (const bad of ["", "../etc", "a b", "<x>", "x".repeat(81), 42, { a: 1 }]) {
      expect(readPageIntent({ new: 1, template: bad }), String(bad)).toEqual({ new: 1 });
    }
  });
});

describe("withoutPageIntent", () => {
  it("takes the template out with the rest, and keeps everything else", () => {
    expect(withoutPageIntent({ new: 1, template: "x", tab: "apps", q: "y" })).toEqual({
      tab: "apps",
      q: "y",
    });
  });
});
