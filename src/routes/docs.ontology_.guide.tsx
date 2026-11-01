import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Diagram,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Steps,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/ontology_/guide")({
  head: () => ({
    meta: [
      { title: "Enterprise Ontology · Guide — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "What an ontology is and how it differs from a semantic layer and a knowledge graph, a first hour with the Northwind Outfitters sample, and how to read the graph: steps out, relationships, paths between objects.",
      },
      {
        property: "og:title",
        content: "Enterprise Ontology · Guide — AgentSwarms Documentation",
      },
      {
        property: "og:description",
        content: "What an ontology is, a first hour with the sample, and reading the graph.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ontology/guide" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ontology/guide" }],
  }),
  component: OntologyGuidePage,
});

function OntologyGuidePage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="A guide to the ontology"
        description="What an ontology is, when to use one, a first hour with the sample business, and how to read the graph of how things connect. For modelling your own business, with examples, see the modelling guide."
      />

      <H2 id="what">What an ontology is</H2>
      <P>
        Your lakehouse holds tables named for how data was loaded: <C>customers</C>, <C>orders</C>,{" "}
        <C>order_lines</C>. The business does not think in tables. It thinks in{" "}
        <strong>things</strong> (a customer, an order, a product), in{" "}
        <strong>how things relate</strong> (an order is placed by a customer and contains products),
        in <strong>what it measures</strong> (revenue), in <strong>what must hold true</strong> (an
        order&apos;s total is never negative) and in <strong>what people may do</strong> (move an
        order to another status, with approval). An ontology writes that down once, on top of the
        tables, so every dashboard, sheet, person and agent uses the same meaning.
      </P>
      <Diagram caption="The same data, as loaded and as the business means it.">{`Tables (how data was loaded)                 Ontology (what the business means)

customers    customer_id, name, segment  →   Customer      key Customer ID, title Name
orders       order_id, customer_id, ...  →   Order ── placed by ──▶ Customer
order_lines  order_id, product_id, ...   →   OrderLine ── order ──▶ Order
                                             OrderLine ── product ──▶ Product
                                             Order ── contains ──▶ Product   (through the lines)`}</Diagram>
      <P>
        Nothing is copied. Every question becomes SQL over the tables as they are now, run as the
        person asking, with their permissions:
      </P>
      <Table
        headers={["You ask", "It runs"]}
        rows={[
          [
            "The customers with a delivered order",
            "orders filtered on status, joined to customers, distinct customers",
          ],
          [
            "Revenue by customer segment",
            <>
              <C>SUM(total_amount)</C> over orders joined to customers, grouped
            </>,
          ],
          [
            "Orders that break “a total is never negative”",
            "a count of orders where the condition is false, with examples",
          ],
          [
            "Move order 1002 to “shipped”",
            "an UPDATE of that row, after its criteria and an approval",
          ],
        ]}
      />

      <H2 id="compare">Ontology, semantic layer, knowledge graph</H2>
      <P>Three tools are often confused. They overlap; they are not the same.</P>
      <Table
        headers={["", "Semantic layer", "Knowledge graph", "This ontology"]}
        rows={[
          [
            "Made of",
            "metrics and dimensions",
            "nodes and edges",
            "object types, links, metrics, rules, actions",
          ],
          ["“How much?”", "yes", "weakly", "yes, with metrics that cannot double count"],
          [
            "“Which ones, linked to what?”",
            "no",
            "yes",
            "yes: object sets, search around, the graph",
          ],
          ["“What must hold true?”", "no", "sometimes", "rules, checked against the data"],
          ["“What may change, who approves?”", "no", "no", "typed actions, approval, an edit log"],
          [
            "Where the data lives",
            "your warehouse",
            "usually copied into a graph store",
            "stays in your lakehouse tables",
          ],
          [
            "AI on top",
            "text to metric",
            "retrieval over the graph",
            "plans over the model, never free SQL, with a trust envelope",
          ],
        ]}
      />
      <P>
        Use the <DocLink to="/docs/semantics">Semantic Layer</DocLink> when all you need is a few
        metrics over one model. Use the ontology when several teams, dashboards and agents ask about
        the same business things, when AI answers must be governed, or when changes to data need
        criteria and approval. For a one-off look at one table, SQL or a sheet is quicker.
      </P>

      <H2 id="first-hour">Your first hour: the Northwind Outfitters sample</H2>
      <P>
        <strong>Data &amp; BI → Enterprise Ontology → Add the Northwind Outfitters sample</strong>{" "}
        creates six tables in a lakehouse schema and a complete model over them: an outdoor-gear
        retailer&apos;s customers, orders, order lines, products, suppliers and shipments. Some rows
        are wrong on purpose, so the rules have something to find.
      </P>
      <Steps
        items={[
          {
            title: "Read the canvas (Overview)",
            body: "Each box is an object type, each line a link, labelled from both ends. Click a type to see its properties, its key and the table it reads.",
          },
          {
            title: "Explore customers",
            body: "Search, filter (Segment is Enterprise) and sort. Each row is an object.",
          },
          {
            title: "Search around",
            body: (
              <>
                From Customers, choose <strong>Search around → orders</strong>, then{" "}
                <strong>contains</strong>: every product those customers ordered, 40 of them. Up to
                four steps; a step through a join table (an order contains products through its
                lines) works like any other.
              </>
            ),
          },
          {
            title: "Open an object",
            body: "Click a customer: its properties, its measures, the rules it breaks, every object it links to, and the actions you may take on it.",
          },
          {
            title: "Draw its neighbourhood (Graph)",
            body: (
              <>
                Start from Ava Byrne; see <a href="#graph">Reading the graph</a> below.
              </>
            ),
          },
          {
            title: "Measure",
            body: (
              <>
                Metrics → Revenue, broken down by the customer&apos;s segment: an order has one
                customer, so this is safe. Now try revenue by product: it is refused, and the reason
                is the most important idea in the model (
                <DocLink to="/docs/ontology/modelling" hash="double-count">
                  the worked example
                </DocLink>
                ).
              </>
            ),
          },
          {
            title: "Check the rules",
            body: "Rules → Run all rules. “Every order line has a quantity” reports 2 of 1,500 breaking it; Show examples lists them, with the values the rule read.",
          },
          {
            title: "Ask",
            body: "Try “revenue by month in 2025”, “customers in the Enterprise segment with open orders” or “units sold by product”. Each answer shows how it was produced. If one is right, Verify it: it answers again without a model call and joins the evaluation suite.",
          },
          {
            title: "Publish",
            body: "Publishing re-runs the verified questions against the draft and freezes it as a version. People you share with, agents and exports always read the published version.",
          },
          {
            title: "Share and connect",
            body: "Admin → IAM shares it, optionally with a row filter (only their region) or a hidden property (e-mail). Agent Builder → the Enterprise Ontology tool lets an agent use it.",
          },
        ]}
      />

      <H2 id="graph">Reading the graph</H2>
      <P>
        The Graph tab draws one object&apos;s neighbourhood. It answers &ldquo;what is this
        connected to?&rdquo; and &ldquo;how are these two connected?&rdquo;.
      </P>
      <UL>
        <li>
          <strong>Start</strong> from any object and choose <strong>Steps out</strong>: 1 (its
          direct links), 2 or 3.
        </li>
        <li>
          <strong>Click</strong> an object to select it. Its links and neighbours stay lit, the rest
          fades, and the panel lists its relationships named from its own side: a customer has{" "}
          <em>orders</em>, an order is <em>placed by</em> a customer and has <em>lines</em>.
        </li>
        <li>
          <strong>Double-click</strong> (or <strong>Expand</strong>) grows the graph from that
          object. A dashed border means it has not been expanded yet. New objects appear beside the
          one they came from; what was already drawn stays where it is.
        </li>
        <li>
          <strong>Shift-click</strong> a second object for the shortest path between them, read in
          order:{" "}
          <em>
            Canyon Hammock → ordered in → Order 1271 → placed by → Ava Byrne → orders → Order 1344 →
            contains → Coastal Gloves
          </em>
          .
        </li>
        <li>
          <strong>Every link among the objects shown is drawn</strong>, whichever object was
          expanded: an order line and its product, both on screen, are joined.
        </li>
        <li>
          A <strong>more</strong> badge means an object has more links of some kind than the 8
          drawn; the line above the graph names them. Open the object to page through all of them.
        </li>
        <li>
          <strong>Hide</strong> removes an object and whatever only it connected;{" "}
          <strong>Start here</strong> redraws from it. <strong>All labels</strong> names every link
          at once.
        </li>
        <li>
          A graph stops at 150 objects and says so. A link that could not be followed (a table you
          cannot read, a hidden key) is named above the graph, not silently dropped.
        </li>
      </UL>
      <Callout kind="info" title="A worked question">
        Which suppliers does Ava Byrne depend on? Start from Ava Byrne and choose 3 steps out: her
        orders, their products and those products&apos; suppliers appear. Click a supplier, then
        Shift-click Ava, for the chain from one to the other.
      </Callout>

      <H3 id="next">Next</H3>
      <UL>
        <li>
          <DocLink to="/docs/ontology/modelling">The modelling guide</DocLink> — types, properties,
          links, metrics, rules and actions, with examples and patterns.
        </li>
        <li>
          <DocLink to="/docs/ontology">Enterprise Ontology</DocLink> — the reference: the workspace,
          sharing, audit, agents, Apache Ossie and limits.
        </li>
      </UL>

      <NextPrev current="/docs/ontology/guide" />
    </>
  );
}
