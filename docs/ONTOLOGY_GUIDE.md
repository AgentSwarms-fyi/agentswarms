# Enterprise Ontology: a guide

> Part of the [AgentSwarms docs](../README.md#documentation). How it is built, and the reference for
> every setting, is in [ENTERPRISE_ONTOLOGY.md](./ENTERPRISE_ONTOLOGY.md). The same guide is in the
> app at `/docs/ontology/guide` and `/docs/ontology/modelling`.

This guide is for the people who will model a business with the ontology, and the people who will
ask it questions. It explains what an ontology is, walks through the sample, and teaches modelling
with examples. Every expression in it has been run on the sample by
`tests/unit/ontologyDocsExamples.test.ts`, so what you copy works.

## What an ontology is

Your lakehouse holds tables named for how data was loaded: `customers`, `orders`, `order_lines`.
The business does not think in tables. It thinks in **things** (a customer, an order, a product),
in **how things relate** (an order is placed by a customer and contains products), in **what it
measures** (revenue), in **what must hold true** (an order's total is never negative) and in **what
people may do** (move an order to another status, with approval).

An ontology writes that down once, on top of the tables, so every dashboard, sheet, person and agent
uses the same meaning:

```
Tables (how data was loaded)                 Ontology (what the business means)

customers    customer_id, name, segment  →   Customer      key Customer ID, title Name
orders       order_id, customer_id, ...  →   Order ── placed by ──▶ Customer
order_lines  order_id, product_id, ...   →   OrderLine ── order ──▶ Order
                                             OrderLine ── product ──▶ Product
                                             Order ── contains ──▶ Product   (through the lines)
```

Nothing is copied. Every question becomes SQL over the tables as they are now, run as the person
asking, with their permissions:

| You ask                                       | It runs                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| The customers with a delivered order          | `orders` filtered on status, joined to `customers`, distinct customers |
| Revenue by customer segment                   | `SUM(total_amount)` over `orders` joined to `customers`, grouped       |
| Orders that break "a total is never negative" | a count of `orders` where the condition is false, with examples        |
| Move order 1002 to "shipped"                  | an `UPDATE` of that row, after its criteria and an approval            |

## Ontology, semantic layer, knowledge graph

Three tools are often confused. They overlap; they are not the same.

|                                      | Semantic layer         | Knowledge graph                | This ontology                                    |
| ------------------------------------ | ---------------------- | ------------------------------ | ------------------------------------------------ |
| What it is made of                   | metrics and dimensions | nodes and edges (triples)      | object types, links, metrics, rules, actions     |
| "How much?"                          | yes                    | weakly                         | yes, with metrics that cannot double count       |
| "Which ones, and linked to what?"    | no                     | yes                            | yes: object sets, search around, the graph       |
| "What must hold true?"               | no                     | sometimes (shape constraints)  | rules, checked against the data                  |
| "What may change, and who approves?" | no                     | no                             | typed actions, approval, an edit log             |
| Where the data lives                 | your warehouse         | usually copied into a graph DB | stays in your lakehouse tables                   |
| AI on top                            | text to metric         | retrieval over the graph       | plans over the model, never free SQL, with proof |

Use the [Semantic Layer](./SEMANTIC_LAYER.md) when all you need is a few metrics over one model. Use
the ontology when several teams, dashboards and agents ask about the same business things, when AI
answers must be governed, or when changes to data need criteria and approval. For a one-off look at
one table, SQL or a sheet is quicker.

## Your first hour: the Northwind Outfitters sample

**Data & BI → Enterprise Ontology → Add the Northwind Outfitters sample** creates six tables in a
lakehouse schema and a complete model over them: an outdoor-gear retailer's customers, orders,
order lines, products, suppliers and shipments. Some rows are wrong on purpose, so the rules have
something to find.

1. **Read the canvas** (Overview). Each box is an object type, each line a link, labelled from both
   ends. Click a type to see its properties, its key and the table it reads.
2. **Explore customers.** Search, filter (Segment is Enterprise), sort. Each row is an object.
3. **Search around.** From Customers, choose **Search around → orders**, then **contains**: you are
   looking at every product those customers ordered, 40 of them. Up to four steps, and a step
   through a join table (an order contains products through its lines) works like any other. The
   search box and **Filter** narrow whatever is listed, at every step: from Enterprise customers,
   **Search around → orders** (71), filter Status is delivered (18), then **contains** and search
   "gloves": the 2 glove products in Enterprise customers' delivered orders. The trail above the
   table keeps what narrowed each set (_Customers (1 filter) → orders (1 filter) → contains_), and
   stepping back makes the last one editable again.
4. **Open an object.** Click a customer: its properties, its measures, the rules it breaks, every
   object it links to, and the actions you may take on it.
5. **Draw its neighbourhood** (Graph). Start from Ava Byrne; see [Reading the graph](#reading-the-graph).
6. **Measure.** Metrics → Revenue, broken down by the customer's segment (an order has one customer,
   so this is safe). Now try revenue by product: it is refused, and the reason is the most important
   idea in the model: see [the worked example](#a-metric-that-would-double-count).
7. **Check the rules.** Rules → Run all rules. "Every order line has a quantity" reports 2 of 1,500
   breaking it; **Show examples** lists them, with the values the rule read.
8. **Ask.** Try "revenue by month in 2025", "customers in the Enterprise segment with open orders",
   or "units sold by product". Each answer shows how it was produced (its trust envelope). If one is
   right, **Verify** it: it answers again without a model call and joins the evaluation suite.
9. **Publish.** Publishing re-runs the verified questions against the draft and freezes it as a
   version. People you share with, agents and exports always read the published version.
10. **Share and connect.** Admin → IAM shares it, optionally with a row filter (only their region) or
    a hidden property (e-mail). Agent Builder → the Enterprise Ontology tool lets an agent use it.

## Reading the graph

The Graph tab draws one object's neighbourhood. It answers "what is this connected to?" and "how
are these two connected?".

- **Start** from any object, and choose **Steps out**: 1 (its direct links), 2 or 3.
- **Click** an object to select it. Its links and neighbours stay lit, the rest fades, and the panel
  lists its relationships named from its own side: a customer has **orders**, an order is **placed
  by** a customer and has **lines**.
- **Double-click** (or **Expand**) grows the graph from that object. An object drawn with a dashed
  border has not been expanded yet. New objects appear beside the one they came from, and what was
  already drawn stays where it is.
- **Shift-click** a second object for the shortest path between them, read in order: _Canyon
  Hammock → ordered in → Order 1271 → placed by → Ava Byrne → orders → Order 1344 → contains →
  Coastal Gloves_.
- **Every link among the objects shown is drawn**, whichever object was expanded: an order line and
  its product both on screen are joined.
- A **more** badge means an object has more links of some kind than the 8 drawn; the line above the
  graph names them. Open the object to page through all of them.
- **Hide** removes an object and whatever only it connected; **Start here** redraws from it.
- The panel beside the graph shows the selected object; with nothing selected it says how to read
  the graph. The wheel scrolls the page; **Ctrl + scroll**, or a pinch, zooms; drag the background to
  move.
- A graph stops at 150 objects and says so. A link that could not be followed (a table you cannot
  read, a hidden key) is named above the graph, not silently dropped.

A worked question: _which suppliers does Ava Byrne depend on?_ Start from Ava Byrne, choose 3 steps
out: her orders, their products, and those products' suppliers appear. Click a supplier and
Shift-click Ava for the chain from one to the other.

## Modelling guide

### Object types: the nouns

An object type is a kind of thing the business names, counts or acts on, with its own identity.
Good candidates are the nouns in the questions people already ask.

- **One row is one object.** Bind the type to the table whose rows are the things. The key must be
  unique; **Draft from tables** measures it and will not use a key that is not.
- **The title is what people call it**: a name, not an id. An order has no name, so its number is
  its title, and the app shows "Order 1063".
- **A subtype is a filter on the same table**: VIP customer is a Customer where
  `segment = 'Enterprise'`. It inherits the properties and links.
- **An attribute is not a type.** Country is a property of a customer, until it has attributes of
  its own (a region, a tax rate); then it becomes a type with a link.
- **Events can be objects.** A shipment has its own key, dates and status, so it is a type linked to
  its order, not a column on it.

### Properties: what is known about each object

A property is a column, or a value derived from the row's own columns with an expression. Examples
from the sample, each one run by the tests:

| Property             | Expression                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| An order's month     | `date_trunc('month', ordered_on)`                                                                     |
| An order's size band | `CASE WHEN total_amount >= 1000 THEN 'large' WHEN total_amount >= 250 THEN 'medium' ELSE 'small' END` |
| An e-mail's domain   | `lower(regexp_extract(email, '@(.+)$', 1))`                                                           |

An expression reads one row's columns: arithmetic, comparisons, `CASE`, and functions for numbers,
text, dates and patterns. It cannot read another table or another row; that is what links and
metrics are for. Anything else (a sub-query, a comment, an unknown function) is refused when it is
saved. Mark a property **restricted** and only the ontology's owner sees it.

### Value types and interfaces

A **value type** gives a property meaning, and its checks become rules on every property that uses
it: EmailAddress (a pattern), OrderStatus (allowed values: placed, paid, shipped, delivered,
cancelled, returned), Money (a unit, USD), CountryCode (a pattern: two capital letters). An
**interface** is a shape
several types share: Party (a name and an e-mail) is implemented by Customer and Supplier, so "every
party without an e-mail" has one answer.

### Links: how things relate

A link has a name read from each end and a cardinality.

| Cardinality            | Read from the `from` end           | Read from the other end      | Joined through                         |
| ---------------------- | ---------------------------------- | ---------------------------- | -------------------------------------- |
| many to one            | an Order is placed by a Customer   | a Customer's orders          | a key on the order (`customer_id`)     |
| one to one             | a Shipment ships an Order          | an Order's shipment          | a key on the shipment (`order_id`)     |
| many to many           | an Order contains Products         | a Product is ordered in      | a join table (`order_lines`)           |
| many to one, to itself | an Employee reports to an Employee | an Employee's direct reports | a key on the same table (`manager_id`) |

Name a link for the relationship, as a verb or a role, and give it a name for the other direction
too: `placed_by` and `orders`, `reports_to` and `direct_reports`. Those names are what people see in
the graph and the object view, what Search around offers, and what AI reads.

### Metrics: what is measured

A metric is an aggregate over its type's properties, and it belongs to the type it measures.
Examples, each run by the tests:

| Metric on Order               | Expression                                              |
| ----------------------------- | ------------------------------------------------------- |
| Revenue                       | `SUM(total_amount)`                                     |
| Delivered orders              | `count_if(status = 'delivered')`                        |
| Share of orders delivered     | `count_if(status = 'delivered') / COUNT(*)`             |
| Median order value            | `median(total_amount)`                                  |
| Revenue from delivered orders | `SUM(total_amount) FILTER (WHERE status = 'delivered')` |

**Certify** the ones the business has agreed on: they are marked in every answer, and AI prefers
them.

#### A metric that would double count

Revenue is a metric on Order. Order 1271, $1,231.61, contains three products. Group revenue by
product through `contains` and each of the three products would be credited the whole $1,231.61:
$3,694.83 in total, three times what was sold. That is a fan-out: a link with many objects at the
far end repeats the measured object once per match.

So a metric can be grouped by its own type's properties, or by the properties of a type it reaches
**to one** of (an order's one customer, that customer's segment), and nothing else. Revenue by
product is refused with that reason, in the Metrics tab, in Ask and for agents.

The right way is to measure at the grain of what you group by. Each order line has one product, so
the line's revenue, `SUM(quantity * unit_price * (1 - discount))` on OrderLine, grouped through the
line's `product` link, gives revenue by product correctly. The rule of thumb: **put a metric on the
type that has one row per thing you will break it down by.**

### Rules: what must hold true

A rule is written in words (what people read and agents are told) and, where it can be, as a check.

| Kind              | Example                                                         |
| ----------------- | --------------------------------------------------------------- |
| Required          | Every customer has a name                                       |
| Unique            | Every customer has their own Customer ID (implied by the key)   |
| Matches a pattern | An e-mail is an e-mail (implied by the EmailAddress value type) |
| Within a range    | A supplier's rating is 1 to 5                                   |
| One of a list     | An order's status is one OrderStatus allows                     |
| The link resolves | An order's customer exists (implied by the link)                |
| A condition       | `delivered_on >= shipped_on`; `discount BETWEEN 0 AND 0.5`      |

A condition reads like a database CHECK: an object breaks it when it is false. When it cannot be
decided because a value is missing, it is not counted as broken; a **required** rule catches the
missing value itself. Use severity for what happens next: critical for what breaks reports, warning
for what someone should look at, info for what is merely odd.

### Actions: how data changes

Data changes only through action types, so every change has a reason, a check and a record.

- **Update order status** changes one property. Its criteria, `status <> 'cancelled'`, stop it
  being used on a cancelled order; it requires approval; agents may only propose it.
- **Change customer segment** needs no approval, and agents may not use it at all.
- **Add customer** creates an object; its key must be new.

Every request is kept with who asked (a person or an agent), who decided, and each value before and
after.

### Writing for people and AI

The words in the model are what Ask and agents read. Describe each type in a sentence; add synonyms
people use ("client" and "account" for Customer); say in the ontology's description what is _not_
modelled ("Shipping costs and returns are not modelled"), so a question about it is refused rather
than guessed. Verify good answers: verified questions answer without a model call and are re-run
when you publish.

## Patterns

- **Header and lines.** Order and OrderLine: measures that depend on the product live on the line.
- **Many to many through a bridge.** An order contains products through `order_lines`; declare the
  join table on the link and walk it like any other.
- **A hierarchy.** An employee reports to an employee: a link from a type to itself, read as
  `reports_to` one way and `direct_reports` the other. The graph walks it in both directions.
- **A lifecycle.** A status value type with its allowed values, an action that moves it with
  criteria and approval, and a rule for the states that must not happen.
- **A subtype by filter.** VIP customers are customers where the segment is Enterprise: no second
  table.
- **A shared shape.** Customer and Supplier implement Party, so a question about parties has one
  answer.
- **Per-team views.** Share once with a row filter of `{{user.region}}`: each person sees their own
  region's objects, everywhere, in the graph and in Ask included.

## Common mistakes

- **Grouping a header's metric by a line's property.** It is refused; move the metric to the line.
- **A key that is not unique.** Every lookup and link from it is ambiguous. The Model tab lists it as
  a problem, and Draft from tables does not use it.
- **A link that matches few rows.** Draft from tables drops a guessed link below a 60% match and shows
  its rate. Most often the two keys have different types (a text id against a number).
- **Sharing before publishing.** People you share with read the published version; before the first
  publish there is nothing to see.
- **Expecting the graph to show every link.** It draws 8 per link and 150 objects, and says where it
  stopped. Open the object for all of them, or use Search around for whole sets.

## Glossary

| Term               | Meaning                                                                                |
| ------------------ | -------------------------------------------------------------------------------------- |
| Object type        | A kind of thing, bound to a table; each row is an object                               |
| Object set         | A type's objects, filtered and searched; the result of Search around                   |
| Key, title         | What identifies an object; what people call it                                         |
| Derived property   | A value computed from the row's own columns                                            |
| Value type         | A type with meaning: allowed values, a pattern, a range, a unit                        |
| Interface          | Properties several types share                                                         |
| Link type          | How two types relate, named from each end, with a cardinality                          |
| To one, fan-out    | Walking a link to at most one object; to possibly many                                 |
| Search around      | Walking links from a set to the objects at the end                                     |
| Metric, certified  | An aggregate on a type; one the business has agreed on                                 |
| Rule, implied rule | What must hold true; one the model implies without anyone writing it                   |
| Action, criteria   | The governed way data changes; what must hold for it to apply                          |
| Agent mode         | Whether agents may not use an action, may propose it, or may run it                    |
| Draft, version     | What the owner edits; what everyone else reads, frozen at publish                      |
| Trust envelope     | What an answer used and could not see: metric, types, tables, restrictions, open rules |
| Verified question  | A question and plan the owner has checked; re-run as an evaluation                     |
| Apache Ossie       | The open interchange format the ontology imports and exports                           |
