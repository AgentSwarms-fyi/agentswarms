// "Northwind Outfitters": a sample business to try the ontology on.
//
// One click on the gallery creates a lakehouse schema with six tables and an
// ontology bound to them, so a new user sees every part of the feature on
// real rows in under a minute: a filtered subtype (VIP customers), an
// interface (Party), value types with checks (an e-mail pattern, the order
// status vocabulary), a many-to-many link through a join table, metrics,
// rules and actions.
//
// The data is generated in SQL from `range()` and `hash()`, so it is the same
// on every install and the statements stay small. A few rows are wrong ON
// PURPOSE, so the first rule run finds something to show: two customers with
// e-mails that are not e-mail addresses, an order whose customer does not
// exist, two order lines with a negative quantity and two orders in a status
// the vocabulary does not have.
import { autoLayout } from "@/lib/ontology/layout";
import { ONTOLOGY_SPEC_VERSION, type OntologySpec } from "@/lib/ontology/spec";

export const SAMPLE_NAME = "Northwind Outfitters";
export const SAMPLE_SCHEMA_BASE = "ontology_sample";

const FIRST = [
  "Ava",
  "Liam",
  "Noah",
  "Mia",
  "Zoe",
  "Omar",
  "Ines",
  "Kenji",
  "Priya",
  "Lucas",
  "Sofia",
  "Ethan",
  "Amara",
  "Jonas",
  "Leila",
  "Mateo",
];
const LAST = [
  "Okafor",
  "Lindqvist",
  "Tanaka",
  "Moreau",
  "Haddad",
  "Novak",
  "Reyes",
  "Fischer",
  "Patel",
  "Kowalski",
  "Silva",
  "Byrne",
];

const list = (items: (string | number)[]) =>
  `[${items.map((x) => (typeof x === "number" ? String(x) : `'${x.replace(/'/g, "''")}'`)).join(", ")}]`;

/** The statements that create and fill the sample tables in `schema`. */
export function sampleSql(schema: string): string[] {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid schema name");
  const s = schema;
  return [
    `CREATE OR REPLACE TABLE ${s}.suppliers AS
SELECT i AS supplier_id,
  ${list(["Alder & Finch", "Brightwater Co", "Cobalt Textiles", "Dunmore Leather", "Evergreen Gear", "Fjord Outdoor", "Granite Supply", "Harbor Optics"])}[i] AS name,
  ${list(["orders@alderfinch.example", "sales@brightwater.example", "hello@cobalt.example", "trade@dunmore.example", "b2b@evergreen.example", "ordre@fjord.example", "supply@granite.example", "team@harbor.example"])}[i] AS email,
  ${list(["US", "CA", "PT", "GB", "US", "NO", "DE", "JP"])}[i] AS country,
  ${list([4.6, 4.1, 3.8, 4.9, 4.3, 4.7, 3.5, 4.4])}[i] AS rating
FROM range(1, 9) AS r(i)`,
    `CREATE OR REPLACE TABLE ${s}.products AS
SELECT i AS product_id,
  ${list(["Trail", "Summit", "Harbor", "Canyon", "Glacier", "Meadow", "Ridge", "Coastal"])}[1 + (hash(i * 3) % 8)::INTEGER] || ' ' ||
  ${list(["Jacket", "Backpack", "Boots", "Tent", "Lantern", "Bottle", "Gloves", "Sunglasses", "Hammock", "Stove"])}[1 + ((i - 1) % 10)] AS name,
  ${list(["Apparel", "Packs", "Footwear", "Camping", "Lighting", "Hydration", "Apparel", "Optics", "Camping", "Cooking"])}[1 + ((i - 1) % 10)] AS category,
  1 + (i % 8) AS supplier_id,
  round(12 + (hash(i) % 28000) / 100.0, 2) AS unit_price,
  DATE '2022-03-01' + ((hash(i * 5) % 700)::INTEGER) AS launched_on
FROM range(1, 41) AS r(i)`,
    `CREATE OR REPLACE TABLE ${s}.customers AS
SELECT i AS customer_id,
  ${list(FIRST)}[1 + (hash(i) % ${FIRST.length})::INTEGER] || ' ' || ${list(LAST)}[1 + (hash(i * 13) % ${LAST.length})::INTEGER] AS name,
  CASE i WHEN 17 THEN 'n/a' WHEN 58 THEN 'r.silva at example.com'
    ELSE lower(${list(FIRST)}[1 + (hash(i) % ${FIRST.length})::INTEGER]) || '.' || i || '@example.com' END AS email,
  ${list(["Consumer", "Consumer", "Consumer", "Small Business", "Small Business", "Enterprise"])}[1 + (hash(i * 7) % 6)::INTEGER] AS segment,
  ${list(["US", "US", "CA", "GB", "DE", "FR", "JP", "BR", "IN", "AU"])}[1 + (hash(i * 11) % 10)::INTEGER] AS country,
  DATE '2023-01-01' + ((hash(i * 17) % 900)::INTEGER) AS signed_up_on
FROM range(1, 121) AS r(i)`,
    `CREATE OR REPLACE TABLE ${s}.order_lines AS
SELECT i AS line_id,
  1000 + ((i - 1) % 600) + 1 AS order_id,
  p.product_id,
  CASE WHEN i IN (777, 1201) THEN -1 ELSE 1 + (hash(i) % 4)::INTEGER END AS quantity,
  p.unit_price,
  CASE WHEN hash(i * 19) % 10 = 0 THEN 0.1 ELSE 0.0 END AS discount
FROM range(1, 1501) AS r(i)
JOIN ${s}.products AS p ON p.product_id = 1 + (hash(i * 23) % 40)::INTEGER`,
    `CREATE OR REPLACE TABLE ${s}.orders AS
SELECT 1000 + i AS order_id,
  CASE WHEN i = 333 THEN 999 ELSE 1 + (hash(i * 7) % 120)::INTEGER END AS customer_id,
  DATE '2024-01-01' + ((hash(i * 3) % 660)::INTEGER) AS ordered_on,
  CASE WHEN i IN (42, 404) THEN 'pending_review'
    ELSE ${list(["placed", "paid", "paid", "shipped", "shipped", "delivered", "delivered", "delivered", "cancelled", "returned"])}[1 + (hash(i * 29) % 10)::INTEGER] END AS status,
  ${list(["web", "web", "store", "partner"])}[1 + (hash(i * 31) % 4)::INTEGER] AS channel,
  (SELECT round(sum(l.quantity * l.unit_price * (1 - l.discount)), 2)
     FROM ${s}.order_lines AS l WHERE l.order_id = 1000 + i) AS total_amount
FROM range(1, 601) AS r(i)`,
    `CREATE OR REPLACE TABLE ${s}.shipments AS
SELECT o.order_id + 50000 AS shipment_id,
  o.order_id,
  ${list(["UPS", "DHL", "FedEx", "USPS"])}[1 + (hash(o.order_id) % 4)::INTEGER] AS carrier,
  o.ordered_on + (1 + (hash(o.order_id * 3) % 3)::INTEGER) AS shipped_on,
  CASE WHEN o.status = 'delivered'
    THEN o.ordered_on + (3 + (hash(o.order_id * 5) % 8)::INTEGER) END AS delivered_on
FROM ${s}.orders AS o
WHERE o.status IN ('shipped', 'delivered')`,
  ];
}

/** The sample ontology, bound to the tables in `schema`. */
export function sampleSpec(schema: string): OntologySpec {
  const t = (name: string) => `${schema}.${name}`;
  const spec: OntologySpec = {
    specVersion: ONTOLOGY_SPEC_VERSION,
    name: SAMPLE_NAME,
    description:
      "An outdoor-gear retailer: who buys, what they order, which supplier makes it and how it ships. " +
      "A sample to explore the ontology with; its tables live in the lakehouse schema " +
      `\`${schema}\`.`,
    valueTypes: [
      {
        name: "EmailAddress",
        base: "string",
        description: "An e-mail address someone can be reached at.",
        pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      },
      {
        name: "OrderStatus",
        base: "string",
        description: "Where an order is in its life, from placed to delivered (or not).",
        enum: ["placed", "paid", "shipped", "delivered", "cancelled", "returned"],
      },
      {
        name: "Money",
        base: "decimal",
        description: "An amount in US dollars.",
        unit: "USD",
      },
      {
        name: "CountryCode",
        base: "string",
        description: "ISO 3166-1 alpha-2.",
        pattern: "^[A-Z]{2}$",
      },
    ],
    interfaces: [
      {
        name: "Party",
        description: "Someone the business deals with, who has a name and can be e-mailed.",
        properties: [
          { name: "name", type: "string" },
          { name: "email", type: "EmailAddress" },
        ],
      },
    ],
    objectTypes: [
      {
        name: "Customer",
        description: "A person or company that has bought from us at least once, or signed up to.",
        synonyms: ["client", "buyer", "account"],
        icon: "user",
        color: "teal",
        status: "certified",
        domain: "Sales",
        interfaces: ["Party"],
        source: { table: t("customers") },
        primaryKey: ["customer_id"],
        titleProperty: "name",
        properties: [
          {
            name: "customer_id",
            label: "Customer ID",
            type: "integer",
            column: "customer_id",
            required: true,
          },
          { name: "name", type: "string", column: "name", required: true },
          { name: "email", type: "EmailAddress", column: "email", sensitivity: "confidential" },
          {
            name: "segment",
            type: "string",
            column: "segment",
            description: "Consumer, Small Business or Enterprise.",
          },
          { name: "country", type: "CountryCode", column: "country" },
          { name: "signed_up_on", type: "date", column: "signed_up_on" },
        ],
        metrics: [
          {
            name: "customer_count",
            label: "Customers",
            expression: "COUNT(*)",
            format: "integer",
            certified: true,
          },
        ],
      },
      {
        name: "VipCustomer",
        label: "VIP customer",
        description: "An Enterprise-segment customer, looked after by an account manager.",
        icon: "users",
        color: "violet",
        domain: "Sales",
        extends: "Customer",
        source: { table: t("customers"), filter: "segment = 'Enterprise'" },
        primaryKey: ["customer_id"],
        titleProperty: "name",
        properties: [],
        metrics: [
          { name: "vip_count", label: "VIP customers", expression: "COUNT(*)", format: "integer" },
        ],
      },
      {
        name: "Supplier",
        description: "A company that makes the products we sell.",
        synonyms: ["vendor", "maker"],
        icon: "factory",
        color: "amber",
        domain: "Supply",
        interfaces: ["Party"],
        source: { table: t("suppliers") },
        primaryKey: ["supplier_id"],
        titleProperty: "name",
        properties: [
          { name: "supplier_id", label: "Supplier ID", type: "integer", column: "supplier_id" },
          { name: "name", type: "string", column: "name" },
          { name: "email", type: "EmailAddress", column: "email" },
          { name: "country", type: "CountryCode", column: "country" },
          {
            name: "rating",
            type: "decimal",
            column: "rating",
            description: "Quality score from 1 to 5, from the last supplier review.",
          },
        ],
        metrics: [
          { name: "supplier_count", label: "Suppliers", expression: "COUNT(*)", format: "integer" },
          {
            name: "avg_rating",
            label: "Average rating",
            expression: "AVG(rating)",
            format: "number",
          },
        ],
      },
      {
        name: "Product",
        description: "Something in the catalogue that a customer can order.",
        synonyms: ["item", "sku", "article"],
        icon: "package",
        color: "sky",
        domain: "Catalogue",
        source: { table: t("products") },
        primaryKey: ["product_id"],
        titleProperty: "name",
        properties: [
          { name: "product_id", label: "Product ID", type: "integer", column: "product_id" },
          { name: "name", type: "string", column: "name" },
          { name: "category", type: "string", column: "category" },
          { name: "supplier_id", label: "Supplier ID", type: "integer", column: "supplier_id" },
          { name: "unit_price", label: "List price", type: "Money", column: "unit_price" },
          { name: "launched_on", type: "date", column: "launched_on" },
        ],
        metrics: [
          { name: "product_count", label: "Products", expression: "COUNT(*)", format: "integer" },
          {
            name: "avg_list_price",
            label: "Average list price",
            expression: "AVG(unit_price)",
            format: "currency",
          },
        ],
      },
      {
        name: "Order",
        description: "A customer's purchase: one checkout, one or more lines.",
        synonyms: ["purchase", "sale", "transaction"],
        aiInstructions:
          "Revenue means the certified `revenue` metric. Cancelled and returned orders still count as orders; " +
          "exclude them only when the question says so.",
        icon: "shopping-cart",
        color: "indigo",
        status: "certified",
        domain: "Sales",
        source: { table: t("orders") },
        primaryKey: ["order_id"],
        titleProperty: "order_id",
        properties: [
          { name: "order_id", label: "Order number", type: "integer", column: "order_id" },
          { name: "customer_id", label: "Customer ID", type: "integer", column: "customer_id" },
          { name: "ordered_on", type: "date", column: "ordered_on", required: true },
          { name: "status", type: "OrderStatus", column: "status", required: true },
          {
            name: "channel",
            type: "string",
            column: "channel",
            description: "web, store or partner.",
          },
          { name: "total_amount", label: "Order total", type: "Money", column: "total_amount" },
          {
            name: "is_open",
            label: "Still open",
            type: "boolean",
            expression: "status IN ('placed', 'paid', 'shipped')",
            description: "Not yet delivered, cancelled or returned.",
          },
        ],
        metrics: [
          {
            name: "order_count",
            label: "Orders",
            expression: "COUNT(*)",
            format: "integer",
            certified: true,
          },
          {
            name: "revenue",
            label: "Revenue",
            expression: "SUM(total_amount)",
            format: "currency",
            certified: true,
            synonyms: ["sales", "turnover", "gmv"],
          },
          {
            name: "avg_order_value",
            label: "Average order value",
            expression: "AVG(total_amount)",
            format: "currency",
          },
        ],
      },
      {
        name: "OrderLine",
        label: "Order line",
        description: "One product on an order, with the quantity and the price charged.",
        icon: "file-text",
        color: "slate",
        domain: "Sales",
        source: { table: t("order_lines") },
        primaryKey: ["line_id"],
        properties: [
          { name: "line_id", label: "Line ID", type: "integer", column: "line_id" },
          { name: "order_id", type: "integer", column: "order_id" },
          { name: "product_id", type: "integer", column: "product_id" },
          { name: "quantity", type: "integer", column: "quantity" },
          { name: "unit_price", type: "Money", column: "unit_price" },
          {
            name: "discount",
            type: "decimal",
            column: "discount",
            description: "0.1 is ten percent off.",
          },
          {
            name: "line_total",
            type: "Money",
            expression: "round(quantity * unit_price * (1 - discount), 2)",
          },
        ],
        metrics: [
          { name: "units", label: "Units sold", expression: "SUM(quantity)", format: "integer" },
          {
            name: "line_revenue",
            label: "Line revenue",
            expression: "SUM(quantity * unit_price * (1 - discount))",
            format: "currency",
          },
        ],
      },
      {
        name: "Shipment",
        description: "The parcel that takes an order to its customer.",
        icon: "truck",
        color: "emerald",
        domain: "Fulfilment",
        source: { table: t("shipments") },
        primaryKey: ["shipment_id"],
        titleProperty: "carrier",
        properties: [
          { name: "shipment_id", label: "Shipment ID", type: "integer", column: "shipment_id" },
          { name: "order_id", type: "integer", column: "order_id" },
          { name: "carrier", type: "string", column: "carrier" },
          { name: "shipped_on", type: "date", column: "shipped_on" },
          { name: "delivered_on", type: "date", column: "delivered_on" },
          {
            name: "days_in_transit",
            type: "integer",
            expression: "date_diff('day', shipped_on, delivered_on)",
          },
        ],
        metrics: [
          { name: "shipment_count", label: "Shipments", expression: "COUNT(*)", format: "integer" },
          {
            name: "avg_days_in_transit",
            label: "Average days in transit",
            expression: "AVG(date_diff('day', shipped_on, delivered_on))",
            format: "number",
          },
        ],
      },
    ],
    linkTypes: [
      {
        name: "placed_by",
        from: "Order",
        to: "Customer",
        label: "placed by",
        inverseName: "orders",
        inverseLabel: "orders",
        cardinality: "many_to_one",
        verbalization: "{Order} is placed by {Customer}",
        join: {
          kind: "foreign_key",
          fromProperties: ["customer_id"],
          toProperties: ["customer_id"],
        },
      },
      {
        name: "order",
        from: "OrderLine",
        to: "Order",
        inverseName: "lines",
        cardinality: "many_to_one",
        verbalization: "{OrderLine} is part of {Order}",
        join: { kind: "foreign_key", fromProperties: ["order_id"], toProperties: ["order_id"] },
      },
      {
        name: "product",
        from: "OrderLine",
        to: "Product",
        inverseName: "order_lines",
        cardinality: "many_to_one",
        verbalization: "{OrderLine} is for {Product}",
        join: { kind: "foreign_key", fromProperties: ["product_id"], toProperties: ["product_id"] },
      },
      {
        name: "contains",
        from: "Order",
        to: "Product",
        inverseName: "ordered_in",
        inverseLabel: "ordered in",
        cardinality: "many_to_many",
        verbalization: "{Order} contains {Product}",
        join: {
          kind: "join_table",
          table: t("order_lines"),
          fromColumns: ["order_id"],
          fromProperties: ["order_id"],
          toColumns: ["product_id"],
          toProperties: ["product_id"],
        },
      },
      {
        name: "supplied_by",
        from: "Product",
        to: "Supplier",
        label: "supplied by",
        inverseName: "products",
        cardinality: "many_to_one",
        verbalization: "{Product} is supplied by {Supplier}",
        join: {
          kind: "foreign_key",
          fromProperties: ["supplier_id"],
          toProperties: ["supplier_id"],
        },
      },
      {
        name: "ships",
        from: "Shipment",
        to: "Order",
        inverseName: "shipment",
        cardinality: "one_to_one",
        verbalization: "{Shipment} ships {Order}",
        join: { kind: "foreign_key", fromProperties: ["order_id"], toProperties: ["order_id"] },
      },
    ],
    rules: [
      {
        id: "order-total-not-negative",
        name: "Order totals are not negative",
        statement: "An order's total is zero or more; a refund is a return, not a negative order.",
        objectType: "Order",
        kind: "predicate",
        predicate: "total_amount >= 0",
        severity: "critical",
        enabled: true,
      },
      {
        id: "line-quantity-positive",
        name: "Every order line has a quantity",
        statement: "An order line orders at least one unit.",
        objectType: "OrderLine",
        kind: "predicate",
        predicate: "quantity > 0",
        severity: "critical",
        enabled: true,
      },
      {
        id: "delivered-after-shipped",
        name: "Deliveries come after shipping",
        statement: "A shipment cannot be delivered before it was shipped.",
        objectType: "Shipment",
        kind: "predicate",
        predicate: "delivered_on >= shipped_on",
        severity: "warning",
        enabled: true,
      },
      {
        id: "supplier-rating-scale",
        name: "Supplier ratings are 1 to 5",
        statement: "A supplier's rating is on the 1–5 review scale.",
        objectType: "Supplier",
        kind: "range",
        property: "rating",
        min: 1,
        max: 5,
        severity: "info",
        enabled: true,
      },
    ],
    actionTypes: [
      {
        name: "update_status",
        label: "Update order status",
        description: "Move an order to another status. A person approves every change.",
        objectType: "Order",
        kind: "modify",
        parameters: [{ name: "status", property: "status", label: "New status", required: true }],
        criteria: "status <> 'cancelled'",
        requiresApproval: true,
        agentMode: "propose",
      },
      {
        name: "change_segment",
        label: "Change customer segment",
        objectType: "Customer",
        kind: "modify",
        parameters: [{ name: "segment", property: "segment", label: "Segment", required: true }],
        requiresApproval: false,
        agentMode: "none",
      },
      {
        name: "add_customer",
        label: "Add customer",
        objectType: "Customer",
        kind: "create",
        parameters: [
          { name: "customer_id", property: "customer_id", label: "Customer ID", required: true },
          { name: "name", property: "name", label: "Name", required: true },
          { name: "email", property: "email", label: "E-mail" },
          { name: "segment", property: "segment", label: "Segment" },
          { name: "country", property: "country", label: "Country" },
        ],
        requiresApproval: false,
        agentMode: "propose",
      },
    ],
  };
  const positions = autoLayout(spec);
  for (const ot of spec.objectTypes) ot.position = positions.get(ot.name);
  return spec;
}
