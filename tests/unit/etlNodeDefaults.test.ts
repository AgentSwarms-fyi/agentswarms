// A node added from the menu must start as a node of the type the menu
// named. The editor once answered "Custom Python" for the lakehouse,
// platform-dataset and streamed-rows sources - their cases sat in a switch
// the source branch never reached - so a "Lakehouse table" source was a
// Python node wearing the lakehouse's label, and no schema picker could
// ever appear on it. This holds the menus and the defaults together.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SOURCE_TYPES,
  TARGET_TYPES,
  TRANSFORM_TYPES,
  defaultNodeConfig,
  typeLabel,
} from "@/utils/etl/nodeDefaults";
import type { EtlNode } from "@/utils/etl/codegen";
import { nodeTypeIcon } from "@/components/etl/nodeIcons";

const REPO = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(REPO, p), "utf8");

describe("a node starts as the type the menu named", () => {
  it("every source type", () => {
    for (const { type } of SOURCE_TYPES) {
      expect(defaultNodeConfig("source", type).type, type).toBe(type);
    }
  });
  it("every transform type", () => {
    for (const { type } of TRANSFORM_TYPES) {
      expect(defaultNodeConfig("transform", type).type, type).toBe(type);
    }
  });
  it("every target type", () => {
    for (const { type } of TARGET_TYPES) {
      expect(defaultNodeConfig("target", type).type, type).toBe(type);
    }
  });
  it("names are left for the pickers; only what the author must type carries a placeholder", () => {
    expect(defaultNodeConfig("source", "lakehouse")).toEqual({
      type: "lakehouse",
      schema: "",
      mode: "table",
      table: "",
    });
    expect(defaultNodeConfig("source", "object_storage")).toEqual({
      type: "object_storage",
      path: "",
      format: "csv",
    });
    expect(defaultNodeConfig("target", "object_storage")).toMatchObject({ dataset: "", table: "" });
    expect(defaultNodeConfig("target", "database")).toMatchObject({ dataset: "", table: "" });
    expect(defaultNodeConfig("source", "http_api")).toMatchObject({ url: "https://" });
    expect(defaultNodeConfig("transform", "filter")).toMatchObject({ expr: "amount > 0" });
  });
  it("labels a node by its type, falling back to the raw type", () => {
    const node = (type: string): EtlNode =>
      ({ id: "n1", kind: "source", config: { type } }) as unknown as EtlNode;
    expect(typeLabel(node("lakehouse"))).toBe("Lakehouse table");
    expect(typeLabel(node("catalog_asset"))).toBe("Data Catalog asset");
    expect(typeLabel(node("mystery"))).toBe("mystery");
    // A type two kinds share takes the label of the node's own kind.
    const target = { id: "n2", kind: "target", config: { type: "http_api" } } as unknown as EtlNode;
    expect(typeLabel(target)).toBe("HTTP API (reverse ETL)");
    expect(typeLabel(node("http_api"))).toBe("HTTP API (JSON)");
    // And the HTTP source's own fields are the source's alone.
    expect(rd("src/routes/_authenticated/etl.tsx")).toContain(
      '{c.type === "http_api" && node.kind === "source" && (',
    );
  });
  it("every menu entry has an icon, and the menus render it", () => {
    for (const { type } of SOURCE_TYPES) expect(nodeTypeIcon("source", type), type).toBeDefined();
    for (const { type } of TRANSFORM_TYPES) {
      expect(nodeTypeIcon("transform", type), type).toBeDefined();
    }
    for (const { type } of TARGET_TYPES) expect(nodeTypeIcon("target", type), type).toBeDefined();
    expect(nodeTypeIcon("source", "mystery")).toBeUndefined();
    const ui = rd("src/routes/_authenticated/etl.tsx").replace(/\s+/g, " ");
    expect(ui).toContain("const Icon = nodeTypeIcon(kind, it.type);");
    expect(ui).toContain('<AddMenu kind="source"');
    expect(ui).toContain('<AddMenu kind="transform"');
    expect(ui).toContain('<AddMenu kind="target"');
  });
  it("the editor takes its menus and defaults from here", () => {
    const ui = rd("src/routes/_authenticated/etl.tsx");
    expect(ui).toContain('from "@/utils/etl/nodeDefaults"');
    expect(ui).not.toContain("function defaultNodeConfig(");
    expect(ui).not.toContain("const SOURCE_TYPES = [");
  });
});
