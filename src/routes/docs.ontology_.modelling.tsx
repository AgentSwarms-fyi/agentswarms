import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

// Every expression on this page is run on the sample by
// tests/unit/ontologyDocsExamples.test.ts, and must appear here as printed.

export const Route = createFileRoute("/docs/ontology_/modelling")({
  head: () => ({
    meta: [
      { title: "Enterprise Ontology · Modelling — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "How to model a business: choosing object types, derived properties, value types, links and their cardinality, metrics that cannot double count, rules, actions and the words AI reads — with worked examples, patterns, common mistakes and a glossary.",
      },
      {
        property: "og:title",
        content: "Enterprise Ontology · Modelling — AgentSwarms Documentation",
      },
      {
        property: "og:description",
        content: "Model a business, with worked examples and patterns.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ontology/modelling" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ontology/modelling" }],
  }),
  component: OntologyModellingPage,
});

function OntologyModellingPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Modelling a business"
        description="How to choose object types, properties, links, metrics, rules and actions, with examples from the Northwind Outfitters sample. Every expression here has been run on the sample, so what you copy works."
      />

      <H2 id="types">Object types: the nouns</H2>
      <P>
        An object type is a kind of thing the business names, counts or acts on, with its own
        identity. Good candidates are the nouns in the questions people already ask.
      </P>
      <UL>
        <li>
          <strong>One row is one object.</strong> Bind the type to the table whose rows are the
          things. The key must be unique; <strong>Draft from tables</strong> measures it and will
          not use a key that is not.
        </li>
        <li>
          <strong>The title is what people call it</strong>: a name, not an id. An order has no
          name, so its number is its title, and the app shows &ldquo;Order 1063&rdquo;.
        </li>
        <li>
          <strong>A subtype is a filter on the same table</strong>: VIP customer is a Customer where{" "}
          <C>{"segment = 'Enterprise'"}</C>. It inherits the properties and links.
        </li>
        <li>
          <strong>An attribute is not a type.</strong> Country is a property of a customer, until it
          has attributes of its own (a region, a tax rate); then it becomes a type with a link.
        </li>
        <li>
          <strong>Events can be objects.</strong> A shipment has its own key, dates and status, so
          it is a type linked to its order, not a column on it.
        </li>
      </UL>

      <H2 id="properties">Properties: what is known about each object</H2>
      <P>
        A property is a column, or a value derived from the row&apos;s own columns with an
        expression:
      </P>
      <Table
        headers={["Property", "Expression"]}
        rows={[
          ["An order's month", <C key="m">{"date_trunc('month', ordered_on)"}</C>],
          [
            "An order's size band",
            <C key="b">
              {
                "CASE WHEN total_amount >= 1000 THEN 'large' WHEN total_amount >= 250 THEN 'medium' ELSE 'small' END"
              }
            </C>,
          ],
          ["An e-mail's domain", <C key="d">{"lower(regexp_extract(email, '@(.+)$', 1))"}</C>],
        ]}
      />
      <P>
        An expression reads one row&apos;s columns: arithmetic, comparisons, <C>CASE</C>, and
        functions for numbers, text, dates and patterns. It cannot read another table or another
        row; that is what links and metrics are for. Anything else (a sub-query, a comment, an
        unknown function) is refused when it is saved. Mark a property <strong>restricted</strong>{" "}
        and only the ontology&apos;s owner sees it.
      </P>

      <H2 id="value-types">Value types and interfaces</H2>
      <P>
        A <strong>value type</strong> gives a property meaning, and its checks become rules on every
        property that uses it: EmailAddress (a pattern), OrderStatus (allowed values: placed, paid,
        shipped, delivered, cancelled, returned), Money (a unit, USD), CountryCode (a pattern: two
        capital letters). An <strong>interface</strong> is a shape several types share: Party (a
        name and an e-mail) is implemented by Customer and Supplier, so &ldquo;every party without
        an e-mail&rdquo; has one answer.
      </P>

      <H2 id="links">Links: how things relate</H2>
      <P>A link has a name read from each end and a cardinality.</P>
      <Table
        headers={["Cardinality", "Read one way", "Read the other way", "Joined through"]}
        rows={[
          [
            "many to one",
            "an Order is placed by a Customer",
            "a Customer's orders",
            <>
              a key on the order (<C>customer_id</C>)
            </>,
          ],
          [
            "one to one",
            "a Shipment ships an Order",
            "an Order's shipment",
            <>
              a key on the shipment (<C>order_id</C>)
            </>,
          ],
          [
            "many to many",
            "an Order contains Products",
            "a Product is ordered in Orders",
            <>
              a join table (<C>order_lines</C>)
            </>,
          ],
          [
            "many to one, to itself",
            "an Employee reports to an Employee",
            "an Employee's direct reports",
            <>
              a key on the same table (<C>manager_id</C>)
            </>,
          ],
        ]}
      />
      <P>
        Name a link for the relationship, as a verb or a role, and give it a name for the other
        direction too: <C>placed_by</C> and <C>orders</C>, <C>reports_to</C> and{" "}
        <C>direct_reports</C>. Those names are what people see in the graph and the object view,
        what Search around offers, and what AI reads.
      </P>

      <H2 id="metrics">Metrics: what is measured</H2>
      <P>A metric is an aggregate over its type&apos;s properties, on the type it measures:</P>
      <Table
        headers={["Metric on Order", "Expression"]}
        rows={[
          ["Revenue", <C key="r">{"SUM(total_amount)"}</C>],
          ["Delivered orders", <C key="d">{"count_if(status = 'delivered')"}</C>],
          [
            "Share of orders delivered",
            <C key="s">{"count_if(status = 'delivered') / COUNT(*)"}</C>,
          ],
          ["Median order value", <C key="m">{"median(total_amount)"}</C>],
          [
            "Revenue from delivered orders",
            <C key="v">{"SUM(total_amount) FILTER (WHERE status = 'delivered')"}</C>,
          ],
        ]}
      />
      <P>
        <strong>Certify</strong> the ones the business has agreed on: they are marked in every
        answer, and AI prefers them.
      </P>

      <H3 id="double-count">A metric that would double count</H3>
      <P>
        Revenue is a metric on Order. Order 1271, $1,231.61, contains three products. Group revenue
        by product through <C>contains</C> and each of the three products would be credited the
        whole $1,231.61: $3,694.83 in total, three times what was sold. That is a{" "}
        <strong>fan-out</strong>: a link with many objects at the far end repeats the measured
        object once per match.
      </P>
      <P>
        So a metric can be grouped by its own type&apos;s properties, or by the properties of a type
        it reaches <strong>to one</strong> of (an order&apos;s one customer, that customer&apos;s
        segment), and nothing else. Revenue by product is refused with that reason, in the Metrics
        tab, in Ask and for agents.
      </P>
      <Callout kind="why" title="Measure at the grain you group by">
        Each order line has one product, so the line&apos;s revenue,{" "}
        <C>{"SUM(quantity * unit_price * (1 - discount))"}</C> on OrderLine, grouped through the
        line&apos;s <C>product</C> link, gives revenue by product correctly. Put a metric on the
        type that has one row per thing you will break it down by.
      </Callout>

      <H2 id="rules">Rules: what must hold true</H2>
      <P>
        A rule is written in words (what people read and agents are told) and, where it can be, as a
        check:
      </P>
      <Table
        headers={["Kind", "Example"]}
        rows={[
          ["Required", "Every customer has a name"],
          ["Unique", "Every customer has their own Customer ID (implied by the key)"],
          ["Matches a pattern", "An e-mail is an e-mail (implied by the EmailAddress value type)"],
          ["Within a range", "A supplier's rating is 1 to 5"],
          ["One of a list", "An order's status is one OrderStatus allows"],
          ["The link resolves", "An order's customer exists (implied by the link)"],
          [
            "A condition",
            <>
              <C>{"delivered_on >= shipped_on"}</C>; <C>{"discount BETWEEN 0 AND 0.5"}</C>
            </>,
          ],
        ]}
      />
      <P>
        A condition reads like a database CHECK: an object breaks it when it is false. When it
        cannot be decided because a value is missing, it is not counted as broken; a{" "}
        <strong>required</strong> rule catches the missing value itself. Use severity for what
        happens next: critical for what breaks reports, warning for what someone should look at,
        info for what is merely odd.
      </P>

      <H2 id="actions">Actions: how data changes</H2>
      <P>
        Data changes only through action types, so every change has a reason, a check and a record.
      </P>
      <UL>
        <li>
          <strong>Update order status</strong> changes one property. Its criteria,{" "}
          <C>{"status <> 'cancelled'"}</C>, stop it being used on a cancelled order; it requires
          approval; agents may only propose it.
        </li>
        <li>
          <strong>Change customer segment</strong> needs no approval, and agents may not use it at
          all.
        </li>
        <li>
          <strong>Add customer</strong> creates an object; its key must be new.
        </li>
      </UL>
      <P>
        Every request is kept with who asked (a person or an agent), who decided, and each value
        before and after.
      </P>

      <H2 id="words">Writing for people and AI</H2>
      <P>
        The words in the model are what Ask and agents read. Describe each type in a sentence; add
        synonyms people use (&ldquo;client&rdquo; and &ldquo;account&rdquo; for Customer); say in
        the ontology&apos;s description what is <em>not</em> modelled (&ldquo;Shipping costs and
        returns are not modelled&rdquo;), so a question about it is refused rather than guessed.
        Verify good answers: verified questions answer without a model call and are re-run when you
        publish.
      </P>

      <H2 id="patterns">Patterns</H2>
      <Table
        headers={["Pattern", "How"]}
        rows={[
          [
            "Header and lines",
            "Order and OrderLine: measures that depend on the product live on the line.",
          ],
          [
            "Many to many through a bridge",
            "An order contains products through order_lines; declare the join table on the link and walk it like any other.",
          ],
          [
            "A hierarchy",
            "An employee reports to an employee: a link from a type to itself, read as reports_to one way and direct_reports the other. The graph walks it in both directions.",
          ],
          [
            "A lifecycle",
            "A status value type with its allowed values, an action that moves it with criteria and approval, and a rule for the states that must not happen.",
          ],
          [
            "A subtype by filter",
            "VIP customers are customers where the segment is Enterprise: no second table.",
          ],
          [
            "A shared shape",
            "Customer and Supplier implement Party, so a question about parties has one answer.",
          ],
          [
            "Per-team views",
            <>
              Share once with a row filter of <C>{"{{user.region}}"}</C>: each person sees their own
              region&apos;s objects everywhere, the graph and Ask included.
            </>,
          ],
        ]}
      />

      <H2 id="mistakes">Common mistakes</H2>
      <UL>
        <li>
          <strong>Grouping a header&apos;s metric by a line&apos;s property.</strong> It is refused;
          move the metric to the line.
        </li>
        <li>
          <strong>A key that is not unique.</strong> Every lookup and link from it is ambiguous. The
          Model tab lists it as a problem, and Draft from tables does not use it.
        </li>
        <li>
          <strong>A link that matches few rows.</strong> Draft from tables drops a guessed link
          below a 60% match and shows its rate. Most often the two keys have different types (a text
          id against a number).
        </li>
        <li>
          <strong>Sharing before publishing.</strong> People you share with read the published
          version; before the first publish there is nothing to see.
        </li>
        <li>
          <strong>Expecting the graph to show every link.</strong> It draws 8 per link and 150
          objects, and says where it stopped. Open the object for all of them, or use Search around
          for whole sets.
        </li>
      </UL>

      <H2 id="glossary">Glossary</H2>
      <Table
        headers={["Term", "Meaning"]}
        rows={[
          ["Object type", "A kind of thing, bound to a table; each row is an object"],
          ["Object set", "A type's objects, filtered and searched; the result of Search around"],
          ["Key, title", "What identifies an object; what people call it"],
          ["Derived property", "A value computed from the row's own columns"],
          ["Value type", "A type with meaning: allowed values, a pattern, a range, a unit"],
          ["Interface", "Properties several types share"],
          ["Link type", "How two types relate, named from each end, with a cardinality"],
          ["To one, fan-out", "Walking a link to at most one object; to possibly many"],
          ["Search around", "Walking links from a set to the objects at the end"],
          ["Metric, certified", "An aggregate on a type; one the business has agreed on"],
          [
            "Rule, implied rule",
            "What must hold true; one the model implies without anyone writing it",
          ],
          ["Action, criteria", "The governed way data changes; what must hold for it to apply"],
          ["Agent mode", "Whether agents may not use an action, may propose it, or may run it"],
          ["Draft, version", "What the owner edits; what everyone else reads, frozen at publish"],
          [
            "Trust envelope",
            "What an answer used and could not see: metric, types, tables, restrictions, open rules",
          ],
          [
            "Verified question",
            "A question and plan the owner has checked; re-run as an evaluation",
          ],
          ["Apache Ossie", "The open interchange format the ontology imports and exports"],
        ]}
      />

      <H3 id="related">Related</H3>
      <UL>
        <li>
          <DocLink to="/docs/ontology/guide">The guide</DocLink> — what an ontology is, a first hour
          with the sample, reading the graph.
        </li>
        <li>
          <DocLink to="/docs/ontology">Enterprise Ontology</DocLink> — the reference.
        </li>
      </UL>

      <NextPrev current="/docs/ontology/modelling" />
    </>
  );
}
