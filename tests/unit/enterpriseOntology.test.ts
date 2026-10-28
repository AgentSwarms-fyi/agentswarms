// Enterprise Ontology: the pure modules, without a database.
//
// The expression language is the fence between an ontology's text and the
// lakehouse, so its tests are adversarial: every way out it refuses is
// pinned. The compiler's guards (no fan-out totals, nothing hidden can be
// filtered, sorted, grouped or summed, policies fail closed) are pinned on
// the SQL they produce. The engine test (enterpriseOntologyEngine.test.ts)
// runs the same SQL for real.
import { describe, expect, it } from "vitest";
import { checkExpr, compileExpr, ExprError, tokenize } from "@/lib/ontology/expr";
import {
  compileMetric,
  compileObjectSet,
  compileRule,
  CompileError,
  impliedRules,
  isMasked,
  typedLiteral,
  type CompileOpts,
} from "@/lib/ontology/compile";
import {
  aiCatalog,
  askPlanSchema,
  normaliseQuestion,
  questionSimilarity,
} from "@/lib/ontology/catalog";
import { diffSpecs } from "@/lib/ontology/diff";
import { removeType, renameProperty, renameType } from "@/lib/ontology/edit";
import { inferFromTables } from "@/lib/ontology/infer";
import { autoLayout } from "@/lib/ontology/layout";
import { toTurtle } from "@/lib/ontology/owl";
import { describeOntologyPolicy, ontologyPolicyFrom } from "@/lib/ontology/policy";
import { sampleSpec } from "@/lib/ontology/sample";
import {
  baseTypeFromSql,
  conceptNameFrom,
  memberNameFrom,
  ontologySpecSchema,
  type OntologySpec,
} from "@/lib/ontology/spec";
import { modelCompleteness, validateSpec } from "@/lib/ontology/validate";

const spec = sampleSpec("ontology_sample");
const owner: CompileOpts = { seeRestricted: true };
const guest: CompileOpts = { seeRestricted: false };
const clone = (): OntologySpec => JSON.parse(JSON.stringify(spec));

describe("the expression language refuses every way out", () => {
  it.each([
    ["a second statement", "amount; DROP TABLE x"],
    ["a line comment", "amount -- hide the rest"],
    ["a block comment", "amount /* x */"],
    ["a function that reads files", "read_csv('/etc/passwd')"],
    ["a function that reads the environment", "getenv('HOME')"],
    ["an unlisted function", "pg_sleep(10)"],
    ["a parameter", "amount = $1"],
    ["a dotted name", "other.secret"],
    ["an unclosed string", "status = 'open"],
    ["an unbalanced parenthesis", "(amount + 1"],
    ["a cast to something that is not a type", "CAST(x AS pg_catalog)"],
  ])("refuses %s", (_, src) => {
    expect(() => tokenize(src)).toThrow(ExprError);
  });

  it("says why a second statement is refused", () => {
    expect(() => tokenize("amount; DROP TABLE x")).toThrow(/an expression is one value/);
  });

  it("turns a smuggled subquery into quoted names the engine cannot run", () => {
    const sql = compileExpr("(SELECT secret FROM users)", (n) => `t0."${n}"`);
    expect(sql).toBe('(t0."SELECT" t0."secret" FROM t0."users")'.replace("FROM", 't0."FROM"'));
    expect(sql).not.toMatch(/\bSELECT\s+t0/);
  });

  it("doubles quotes inside a string, so a string cannot end early", () => {
    expect(compileExpr("name = 'O''Brien'", (n) => n)).toBe("name = 'O''Brien'");
    expect(compileExpr("x = 'a'' OR 1=1 --'", (n) => n)).toBe("x = 'a'' OR 1=1 --'");
  });

  it("keeps a property called date, year or time a property", () => {
    const t = tokenize("date > year AND time IS NOT NULL");
    expect(t.filter((x) => x.t === "name").map((x) => (x as { v: string }).v)).toEqual([
      "date",
      "year",
      "time",
    ]);
  });

  it("reads type and unit words as keywords only where SQL puts them", () => {
    expect(compileExpr("CAST(amount AS DECIMAL(10, 2))", (n) => n)).toBe(
      "CAST(amount AS DECIMAL(10, 2))",
    );
    expect(compileExpr("ordered_on + INTERVAL 3 DAY", (n) => n)).toBe(
      "ordered_on + INTERVAL 3 DAY",
    );
    expect(compileExpr("amount::double", (n) => n)).toBe("amount::DOUBLE");
  });

  it("keeps IN, NOT and AND as keywords before a parenthesis", () => {
    expect(compileExpr("status IN ('a', 'b') AND NOT (x = 1)", (n) => n)).toBe(
      "status IN ('a', 'b') AND NOT (x = 1)",
    );
  });

  it("says which name it does not know, and suggests the near one", () => {
    const c = checkExpr("SUM(amout)", "aggregate", ["amount", "quantity"]);
    expect(c.ok).toBe(false);
    expect(c.error).toMatch(/amout.*did you mean `amount`/);
  });

  it("puts aggregates in metrics and nowhere else", () => {
    expect(checkExpr("amount", "aggregate", ["amount"]).ok).toBe(false);
    expect(checkExpr("SUM(amount) > 0", "predicate", ["amount"]).ok).toBe(false);
    expect(checkExpr("COUNT(DISTINCT customer_id)", "aggregate", ["customer_id"]).ok).toBe(true);
  });
});

describe("validation", () => {
  it("passes the sample with no errors", () => {
    expect(validateSpec(spec).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("refuses a link to a type that does not exist", () => {
    const s = clone();
    s.linkTypes[0].to = "Nobody";
    expect(
      validateSpec(s).issues.some(
        (i) => i.level === "error" && /Unknown object type `Nobody`/.test(i.message),
      ),
    ).toBe(true);
  });

  it("refuses an inheritance cycle", () => {
    const s = clone();
    s.objectTypes.find((t) => t.name === "Customer")!.extends = "VipCustomer";
    expect(validateSpec(s).issues.some((i) => /cycle/.test(i.message))).toBe(true);
  });

  it("refuses a type that breaks its interface", () => {
    const s = clone();
    s.objectTypes
      .find((t) => t.name === "Supplier")!
      .properties.find((p) => p.name === "email")!.type = "string";
    expect(validateSpec(s).issues.some((i) => /Party\.email is EmailAddress/.test(i.message))).toBe(
      true,
    );
  });

  it("refuses a restricted key and a SQL word as a property name", () => {
    const s = clone();
    const c = s.objectTypes.find((t) => t.name === "Customer")!;
    c.properties.find((p) => p.name === "customer_id")!.sensitivity = "restricted";
    c.properties.push({ name: "end", type: "string", column: "x" });
    const msgs = validateSpec(s).issues.map((i) => i.message);
    expect(msgs.some((m) => /key cannot be restricted/.test(m))).toBe(true);
    expect(msgs.some((m) => /`end` is a SQL word/.test(m))).toBe(true);
  });

  it("refuses many-to-many through a key, and an action that sets a derived property", () => {
    const s = clone();
    s.linkTypes.find((l) => l.name === "placed_by")!.cardinality = "many_to_many";
    s.actionTypes.push({
      name: "set_open",
      objectType: "Order",
      kind: "modify",
      parameters: [{ name: "is_open", property: "is_open" }],
      requiresApproval: false,
      agentMode: "none",
    });
    const msgs = validateSpec(s).issues.map((i) => i.message);
    expect(msgs.some((m) => /Many-to-many needs a join table/.test(m))).toBe(true);
    expect(msgs.some((m) => /`is_open` is derived/.test(m))).toBe(true);
  });

  it("scores completeness from what a reviewer checks", () => {
    const c = modelCompleteness(spec);
    expect(c.score).toBeGreaterThan(40);
    expect(c.parts.map((p) => p.label)).toContain("Metrics certified");
  });
});

describe("the compiler's guards", () => {
  it("refuses a total that would fan out through a many link", () => {
    expect(() =>
      compileMetric(
        spec,
        {
          objectType: "Order",
          metric: "revenue",
          groupBy: [{ property: "category", path: [{ link: "contains", direction: "forward" }] }],
        },
        owner,
      ),
    ).toThrow(/count each Order once per Product/);
  });

  it("emits NULL for a restricted property to a guest, and refuses to filter, sort, group or sum it", () => {
    const s = clone();
    s.objectTypes
      .find((t) => t.name === "Order")!
      .properties.find((p) => p.name === "total_amount")!.sensitivity = "restricted";
    const c = compileObjectSet(s, { objectType: "Order" }, guest);
    expect(c.columns.find((x) => x.property === "total_amount")!.masked).toBe(true);
    expect(c.sql).toContain('NULL AS "total_amount"');
    expect(() =>
      compileObjectSet(
        s,
        { objectType: "Order", filters: [{ property: "total_amount", op: "gt", value: 1 }] },
        guest,
      ),
    ).toThrow(CompileError);
    expect(() =>
      compileObjectSet(
        s,
        { objectType: "Order", orderBy: { property: "total_amount", direction: "desc" } },
        guest,
      ),
    ).toThrow(CompileError);
    expect(() => compileMetric(s, { objectType: "Order", metric: "revenue" }, guest)).toThrow(
      /aggregated/,
    );
    // The owner still sees and uses it.
    expect(compileMetric(s, { objectType: "Order", metric: "revenue" }, owner).sql).toContain(
      "SUM",
    );
  });

  it("leaves a hidden property out of search", () => {
    const opts: CompileOpts = { seeRestricted: false, policy: { maskedProperties: ["*.name"] } };
    const c = compileObjectSet(spec, { objectType: "Customer", search: "ava" }, opts);
    expect(c.sql).not.toMatch(/t0\."name"\s+AS VARCHAR/);
  });

  it("fails a policy closed when it names a property the type lacks", () => {
    const opts: CompileOpts = {
      seeRestricted: false,
      policy: { rowFilters: [{ objectType: "Customer", property: "nonexistent", values: ["x"] }] },
    };
    expect(compileObjectSet(spec, { objectType: "Customer" }, opts).sql).toContain("FALSE");
  });

  it("applies a bare-property filter only to types that have it", () => {
    const opts: CompileOpts = {
      seeRestricted: false,
      policy: { rowFilters: [{ objectType: "*", property: "country", values: ["US"] }] },
    };
    expect(compileObjectSet(spec, { objectType: "Customer" }, opts).sql).toContain(`IN ('US')`);
    expect(compileObjectSet(spec, { objectType: "Product" }, opts).sql).not.toContain("FALSE");
  });

  it("masks through a supertype: hiding Customer.email hides it on VIP customers", () => {
    const t = spec.objectTypes.find((x) => x.name === "VipCustomer")!;
    expect(
      isMasked(spec, t, "email", {
        seeRestricted: false,
        policy: { maskedProperties: ["Customer.email"] },
      }),
    ).toBe(true);
  });

  it("checks literals against the property's type", () => {
    expect(typedLiteral("integer", "42")).toBe("42");
    expect(() => typedLiteral("integer", "4.2")).toThrow(/whole number/);
    expect(() => typedLiteral("date", "yesterday")).toThrow(/date/);
    expect(typedLiteral("boolean", "yes")).toBe("TRUE");
    expect(typedLiteral("string", "O'Brien")).toBe("'O''Brien'");
  });

  it("limits rows and paths", () => {
    expect(
      compileObjectSet(
        spec,
        { objectType: "Order", limit: 999_999 },
        { seeRestricted: true, maxRows: 500 },
      ).sql,
    ).toMatch(/LIMIT 500$/);
    const long = Array.from({ length: 5 }, () => ({
      link: "placed_by",
      direction: "forward" as const,
    }));
    expect(() => compileObjectSet(spec, { objectType: "Order", path: long }, owner)).toThrow(
      /at most four/,
    );
  });

  it("derives rules from the model: keys, value types and links", () => {
    const ids = impliedRules(spec).map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "auto-order-order_id-key",
        "auto-customer-email-pattern",
        "auto-order-status-values",
        "auto-order-placed_by-exists",
      ]),
    );
    // A many-to-many link implies no referential check (its target is through a table).
    expect(ids).not.toContain("auto-order-contains-exists");
  });

  it("reads a predicate rule as a CHECK does: unknown is not a violation", () => {
    const rule = spec.rules.find((r) => r.id === "delivered-after-shipped")!;
    expect(compileRule(spec, rule, owner).checkSql).toContain("NOT COALESCE(");
  });
});

describe("share policies", () => {
  it("reads a merged grant policy in ontology terms", () => {
    const p = ontologyPolicyFrom({
      rowFilters: [
        { column: "Customer.country", values: ["US"] },
        { column: "region", values: ["EU"] },
      ],
      maskedFields: ["customer.email"],
    });
    expect(p.rowFilters).toEqual([
      { objectType: "Customer", property: "country", values: ["US"] },
      { objectType: "*", property: "region", values: ["EU"] },
    ]);
    expect(describeOntologyPolicy(p).join(" · ")).toMatch(
      /Only Customer\.country in US.*Hidden: customer\.email/,
    );
  });

  it("is unrestricted when any grant has no filter", () => {
    expect(ontologyPolicyFrom({ rowFilters: null, maskedFields: [] }).rowFilters).toEqual([]);
  });
});

describe("editing keeps references whole", () => {
  it("renames a type in links, rules, actions and subtypes", () => {
    const s = renameType(spec, "Customer", "Client");
    expect(s.linkTypes.find((l) => l.name === "placed_by")!.to).toBe("Client");
    expect(s.objectTypes.find((t) => t.name === "VipCustomer")!.extends).toBe("Client");
    expect(s.actionTypes.find((a) => a.name === "add_customer")!.objectType).toBe("Client");
    expect(validateSpec(s).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("renames a property in keys, joins, metrics, rules and actions", () => {
    const s = renameProperty(spec, "Order", "total_amount", "order_total");
    const o = s.objectTypes.find((t) => t.name === "Order")!;
    expect(o.metrics.find((m) => m.name === "revenue")!.expression).toBe("SUM(order_total)");
    expect(s.rules.find((r) => r.id === "order-total-not-negative")!.predicate).toBe(
      "order_total >= 0",
    );
    expect(validateSpec(s).issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("removes a type with what only made sense with it", () => {
    const s = removeType(spec, "Shipment");
    expect(s.linkTypes.some((l) => l.from === "Shipment" || l.to === "Shipment")).toBe(false);
    expect(s.rules.some((r) => r.objectType === "Shipment")).toBe(false);
    expect(validateSpec(s).issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("diff", () => {
  it("marks removals and key changes as breaking, with what still uses them", () => {
    const after = clone();
    const o = after.objectTypes.find((t) => t.name === "Order")!;
    o.properties = o.properties.filter((p) => p.name !== "status");
    const d = diffSpecs(spec, after);
    const removed = d.changes.find((c) => c.path === "Order.status")!;
    expect(removed.kind).toBe("removed");
    expect(removed.breaking).toBe(true);
    expect(removed.usedBy).toEqual(expect.arrayContaining(["action update_status"]));
  });

  it("does not call a description change breaking", () => {
    const after = clone();
    after.objectTypes[0].description = "Someone who buys";
    const d = diffSpecs(spec, after);
    expect(d.changes).toHaveLength(1);
    expect(d.breaking).toBe(0);
  });
});

describe("drafting from tables", () => {
  it("makes types, keys and links from names", () => {
    const d = inferFromTables("Shop", [
      {
        table: "shop.customers",
        columns: [
          { name: "id", type: "BIGINT" },
          { name: "full_name", type: "VARCHAR" },
        ],
      },
      {
        table: "shop.orders",
        columns: [
          { name: "order_id", type: "BIGINT" },
          { name: "customer_id", type: "BIGINT" },
          { name: "Total Amount", type: "DECIMAL(18,2)" },
        ],
      },
    ]);
    const names = d.spec.objectTypes.map((t) => t.name);
    expect(names).toEqual(["Customer", "Order"]);
    expect(d.spec.objectTypes[1].primaryKey).toEqual(["order_id"]);
    expect(d.spec.objectTypes[1].properties.map((p) => p.name)).toContain("total_amount");
    expect(d.spec.linkTypes[0]).toMatchObject({
      from: "Order",
      to: "Customer",
      cardinality: "many_to_one",
    });
    expect(ontologySpecSchema.safeParse(d.spec).success).toBe(true);
    expect(d.spec.objectTypes.every((t) => t.position)).toBe(true);
  });

  it("names things the way the model wants", () => {
    expect(conceptNameFrom("sales_order_lines")).toBe("SalesOrderLine");
    expect(conceptNameFrom("categories")).toBe("Category");
    expect(memberNameFrom("Customer ID")).toBe("customer_id");
    expect(memberNameFrom("2nd")).toBe("c_2nd");
    expect(baseTypeFromSql("TIMESTAMP WITH TIME ZONE")).toBe("timestamp");
    expect(baseTypeFromSql("DECIMAL(10,2)")).toBe("decimal");
  });
});

describe("the canvas layout", () => {
  it("is deterministic and puts the hub first", () => {
    const a = autoLayout(spec);
    const b = autoLayout(spec);
    expect([...a]).toEqual([...b]);
    const xs = [...a.values()].map((p) => p.x);
    expect(Math.min(...xs)).toBe(0);
    expect(a.get("Order")!.x).toBe(0);
  });
});

describe("OWL export", () => {
  it("declares classes, properties, keys and inverses", () => {
    const ttl = toTurtle(spec);
    expect(ttl).toContain(":Customer a owl:Class");
    expect(ttl).toContain("rdfs:subClassOf :Customer");
    expect(ttl).toContain(":Order_placed_by a owl:ObjectProperty");
    expect(ttl).toContain("owl:inverseOf :Order_placed_by");
    expect(ttl).toContain("owl:hasKey ( :Order_order_id )");
    expect(ttl).toContain('owl:oneOf ( "placed" "paid"');
  });
});

describe("what the AI sees and may answer with", () => {
  it("leaves hidden properties out of the catalog", () => {
    const cat = aiCatalog(spec, {
      seeRestricted: false,
      policy: { maskedProperties: ["Customer.email"] },
    });
    const customer = cat.split("TYPE Customer")[1].split("TYPE ")[0];
    expect(customer).not.toMatch(/- email:/);
    expect(cat).toContain("metric revenue = SUM(total_amount) (CERTIFIED");
    expect(cat).toMatch(/link placed_by \(forward\) → Customer, each Order has at most one/);
  });

  it("accepts a plan in the ontology's terms and nothing else", () => {
    expect(
      askPlanSchema.safeParse({
        kind: "metric",
        explanation: "x",
        query: { objectType: "Order", metric: "revenue" },
      }).success,
    ).toBe(true);
    expect(askPlanSchema.safeParse({ kind: "sql", sql: "SELECT 1" }).success).toBe(false);
    expect(askPlanSchema.safeParse({ kind: "refuse", reason: "no shipping cost" }).success).toBe(
      true,
    );
  });

  it("matches a verified question by meaning, not wording", () => {
    expect(normaliseQuestion("What is the revenue by segment?")).toBe("revenue segment");
    expect(
      questionSimilarity(
        "Revenue by customer segment",
        "what's our revenue by segment of customer",
      ),
    ).toBeGreaterThan(0.6);
    expect(questionSimilarity("Revenue by segment", "Orders by month")).toBeLessThan(0.3);
  });
});
