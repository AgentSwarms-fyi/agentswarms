// The columns a stream preview shows first (R528, found from the UI test:
// the first six columns of a GitHub release were all links).
import { describe, expect, it } from "vitest";

import { previewColumns } from "@/lib/previewColumns";

describe("a preview's columns", () => {
  it("well-known names first, links last, the rest in the record's order", () => {
    const columns = [
      "url",
      "assets_url",
      "id",
      "author_login",
      "tag_name",
      "name",
      "published_at",
      "body",
    ];
    const rows = [
      {
        url: "https://api.github.com/repos/cli/cli/releases/1",
        assets_url: "https://api.github.com/x",
        id: 1,
        author_login: "bot",
        tag_name: "v2.105.0",
        name: "GitHub CLI 2.105.0",
        published_at: "2026-11-20T10:00:00Z",
        body: "notes",
      },
    ];
    expect(previewColumns({ columns, rows })).toEqual([
      "id",
      "name",
      "tag_name",
      "published_at",
      "author_login",
      "body",
      "url",
      "assets_url",
    ]);
  });

  it("a column holding links is a link even when its name does not say so", () => {
    expect(
      previewColumns({
        columns: ["homepage", "label"],
        rows: [{ homepage: "https://a.example", label: "x" }],
      }),
    ).toEqual(["label", "homepage"]);
  });
});
