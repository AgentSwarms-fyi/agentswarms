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

export const Route = createFileRoute("/docs/ontology")({
  head: () => ({
    meta: [
      { title: "Enterprise Ontology — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Model the business once — object types, links, certified metrics, rules and governed actions — on lakehouse tables, and explore, measure, check, ask and change data in those terms. Shared through IAM with property masks and row filters, audited, usable by agents, and exchanged as Apache Ossie.",
      },
      { property: "og:title", content: "Enterprise Ontology — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "One model of the business, under every answer.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ontology" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ontology" }],
  }),
  component: OntologyDocsPage,
});

function OntologyDocsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="Enterprise Ontology"
        description="Describe the business once — the things it deals in, how they connect, what is measured, what must hold true and what may be changed — on top of your lakehouse tables. People, dashboards and agents then ask in business words and get governed answers."
      />

      <H2 id="why">The problem it solves</H2>
      <P>
        Tables are named for how data was loaded, not for what it means. Every dashboard, sheet and
        agent re-derives &ldquo;a customer&rdquo;, &ldquo;revenue&rdquo; and &ldquo;an order&rsquo;s
        customer&rdquo; from columns and joins, and the answers drift apart. AI makes it worse:
        text-to-SQL over raw tables picks a plausible join and returns a confident wrong number. An
        ontology fixes the meaning in one place — and here it is not a diagram beside the data but
        the way to the data: an object set is a query, a link is a join, a metric is an aggregate, a
        rule is a check and an action is a governed write, all compiled from the model and run
        through the lakehouse as the person asking.
      </P>
      <P>
        Find it under <strong>Data &amp; BI → Enterprise Ontology</strong>. Start from the{" "}
        <strong>Northwind Outfitters</strong> sample (six tables and a full model, created in one
        click), draft a model from tables you already have, import Apache Ossie documents, or start
        blank.
      </P>

      <H2 id="concepts">What a model holds</H2>
      <Table
        headers={["Part", "What it is", "Example"]}
        rows={[
          [
            "Object type",
            "A kind of thing the business deals in, bound to a lakehouse table (one row is one object). A filter makes a subtype of the same table.",
            <>
              Customer on <C>sales.customers</C>; VIP customer where{" "}
              <C>segment = &apos;Enterprise&apos;</C>
            </>,
          ],
          [
            "Property",
            "What is known about each object: a column, or a value derived with a SQL expression. One or more properties are the key; one is the title.",
            <>
              <C>total_amount</C>; <C>is_open</C> ={" "}
              <C>status IN (&apos;placed&apos;, &apos;paid&apos;)</C>
            </>,
          ],
          [
            "Value type",
            "A type with meaning — allowed values, a pattern, a range, a unit. Its checks become rules on every property that uses it.",
            <>EmailAddress (pattern), OrderStatus (allowed values), Money (USD)</>,
          ],
          [
            "Interface",
            "Properties several types share, so a question about every implementer has one answer.",
            <>Party = name + email, implemented by Customer and Supplier</>,
          ],
          [
            "Link type",
            "How two types relate, read both ways, with its cardinality — through a key, or through a join table for many-to-many.",
            <>
              An Order is <C>placed_by</C> a Customer; a Customer&apos;s <C>orders</C>
            </>,
          ],
          [
            "Metric",
            "An aggregate over a type's properties. Certify the ones the business agrees on; agents prefer them.",
            <>
              <C>revenue = SUM(total_amount)</C>, certified
            </>,
          ],
          [
            "Rule",
            "What must hold true, in words and as a check that runs against the data.",
            <>
              An order&apos;s total is never negative: <C>total_amount &gt;= 0</C>
            </>,
          ],
          [
            "Action type",
            "The governed way data changes: which properties, under which criteria, whether a person approves, what agents may do.",
            <>Update order status — approval required, agents may only propose</>,
          ],
        ]}
      />
      <P>
        Names follow two rules because expressions, links and exports use them: types (and value
        types and interfaces) are PascalCase like <C>OrderLine</C>; properties, metrics, links and
        actions are snake_case like <C>order_id</C>.
      </P>

      <H2 id="workspace">The workspace</H2>
      <Table
        headers={["Tab", "What you do there"]}
        rows={[
          [
            "Overview",
            "The model as a canvas, how complete it is, how well it fits the data (rows, key uniqueness, link match rates — measured) and rule health.",
          ],
          [
            "Model",
            "Every type, link, value type and interface in a tree; an editor for each; the canvas; and the problems that stop a publish, each a link to its field.",
          ],
          [
            "Explore",
            "A type's objects: search, filters, sorting, and search around (the customers of these orders). Each object opens with its properties, the rules it breaks, its metrics, what it links to and its actions.",
          ],
          ["Graph", "One object's neighbourhood, drawn; click a node to grow the graph from it."],
          [
            "Metrics",
            "A metric broken down by its own properties or by those of types it reaches through to-one links, by day to year; chart, table and the compiled SQL.",
          ],
          [
            "Rules",
            "Written and implied rules, run against the data: how many objects break each and which ones.",
          ],
          [
            "Ask",
            "Questions in words, answered from the model with a trust envelope; verified questions and their evaluation.",
          ],
          ["Actions", "Action types, the approval queue and the edit log."],
          ["Versions", "Published versions with what each changed; proposals to review."],
          ["Export", "Apache Ossie, OWL (Turtle) and JSON; replace the draft from a document."],
        ]}
      />
      <P>
        The owner edits a <strong>draft</strong> that saves itself a moment after each change. A
        save made from a stale tab is refused rather than written over newer work. Publishing
        freezes the draft into a numbered version — what people you share with, agents and exports
        use — after showing exactly what changed and which changes are breaking.
      </P>

      <H2 id="binding">Binding to the lakehouse</H2>
      <P>
        Pick a table for each type and map properties to its columns (
        <strong>Add a property per unmapped column</strong> does it in one click), then choose the
        key and the title. <strong>Preview rows</strong> shows what the binding reads. Nothing is
        copied: every query reads the table as it is now. <strong>Draft from tables</strong> does
        this for many tables at once, guessing keys and links from names and <em>measuring</em> each
        guess — a key that is not unique is not used, and a link only some rows match is dropped
        with its match rate shown — before an optional AI pass adds descriptions, labels and
        synonyms (never structure).
      </P>

      <H2 id="explore">Exploring and searching around</H2>
      <P>
        An object set is one type&apos;s objects, filtered and searched.{" "}
        <strong>Search around</strong> walks links from that set — up to four steps — and shows the
        objects at the end: start at delivered Orders, walk <C>placed_by</C>, and you have the
        customers with a delivered order. A link through a join table works the same way.
      </P>

      <H2 id="metrics">Metrics that cannot double count</H2>
      <P>
        A metric belongs to the type it measures and can be grouped by that type&apos;s properties
        or by those of a type it walks <em>to one</em> of — an Order&apos;s Customer&apos;s segment.
        Grouping through a link that fans out (an order&apos;s many products) would count each order
        once per product and give a confident wrong total, so it is refused with the reason, in the
        Metrics tab and in Ask alike.
      </P>

      <H2 id="rules">Rules</H2>
      <P>
        A rule is written in words (what people read and agents are told) and, where it can be, as a
        check: required, unique, matches a pattern, within a range, one of a list, a link that must
        point at something, or any condition over the type&apos;s properties. The model also implies
        rules nobody has to write: keys are present and unique, required properties are filled,
        value types hold, and links through a key resolve. <strong>Run all rules</strong> counts the
        objects breaking each and keeps examples you can open; the result shows on the gallery card
        and in every answer that uses those types.
      </P>
      <Callout kind="info" title="A condition reads like a database CHECK">
        An object breaks a condition when it is false. When it cannot be decided (a value is
        missing), it does not count as broken — use a <em>required</em> rule to catch the missing
        value itself.
      </Callout>

      <H2 id="ask">Ask, with a trust envelope</H2>
      <P>
        A question is planned by AI over the ontology&apos;s own catalog — types, properties, links,
        certified metrics and the words people use for them — and the plan is compiled and run as
        you. The model never writes SQL. A question the ontology cannot answer is refused with the
        reason. Every answer carries a <strong>trust envelope</strong>: the metric it used and
        whether it is certified, the types, links and tables it read, what your share hid or
        limited, rules the data currently breaks on those types, and whether a person verified the
        question.
      </P>
      <P>
        The owner can verify a good answer. A verified question answers again without a model call
        and joins an evaluation suite: <strong>Evaluate</strong> re-runs them all and marks each
        unchanged, changed (new data or a new definition) or broken (the model no longer supports
        it).
      </P>

      <H2 id="actions">Actions and the edit log</H2>
      <P>
        Data changes through action types only. A request checks that the object exists and is
        visible to the person asking, that no parameter sets a property hidden from them, and that
        the action&apos;s criteria hold right now. Then it is applied as them — or, when the type
        requires approval, it waits in the owner&apos;s queue and is applied as the owner when
        approved, after the criteria are checked again. Every request is kept in the edit log with
        who asked (a person or an agent), who decided, and each property&apos;s value before and
        after. Writes go through the lakehouse, so your schema permissions decide what you can
        change.
      </P>

      <H2 id="sharing">Sharing and access control</H2>
      <P>
        Share an ontology under <strong>Admin → IAM</strong> with the <strong>Ontology</strong>{" "}
        resource type. A grantee reads the published version, explores, asks, proposes changes and
        requests actions; editing, publishing and approving stay with the owner. A share can carry
        the same restrictions dashboard and semantic-model shares do:
      </P>
      <UL>
        <li>
          a <strong>row filter</strong> naming <C>Type.property</C> (or just a property, for every
          type that has it) and the values the grantee may see — a value like{" "}
          <C>{"{{user.region}}"}</C> becomes each viewer&apos;s own attribute;
        </li>
        <li>
          <strong>hidden properties</strong>, as <C>Customer.email</C> or <C>email</C>.
        </li>
      </UL>
      <P>
        Both are applied in every query the grantee runs — exploring, the object view, the graph,
        metrics, Ask and the agent tool. A hidden property reads as &ldquo;hidden&rdquo;, cannot be
        filtered, sorted, grouped or summed, and is left out of what AI is shown. A property marked{" "}
        <strong>restricted</strong> in the model is hidden from everyone but the owner. And because
        every query runs as the grantee, their own lakehouse grants and the tables&apos; tag
        policies apply on top.
      </P>

      <H2 id="audit">Audit and query history</H2>
      <P>
        Creating, publishing, restoring and deleting an ontology, proposals and their decisions,
        rule runs, drafts, questions asked (with the plan that answered), verified questions,
        evaluations and every action requested, approved, rejected or failed are recorded in{" "}
        <strong>Observability → Audit Log</strong>. Every query the ontology runs is also in the
        asker&apos;s <strong>Lakehouse → History</strong>, marked with where it came from — for
        example <C>ontology:explore</C>, <C>ontology:rule</C>, <C>ontology:ask</C> or{" "}
        <C>ontology:action</C>.
      </P>

      <H2 id="agents">Agents</H2>
      <P>
        Give an agent the <strong>Enterprise Ontology</strong> tool (<C>ontology_query</C>) in the
        Agent Builder and pick which ontologies it may use — none until you do. The agent reads the
        catalog of those ontologies and queries objects, metrics and single objects by name; its
        answers carry the same trust envelope. It runs as the person chatting (on a scheduled or API
        run, as the agent&apos;s owner) with their share restrictions. It may request an action only
        where the action type allows agents, and by default that request waits for a person. Model
        calls made for Ask and drafting use your provider credentials and model rules, count toward
        your budget and appear in Traces.
      </P>

      <H2 id="ossie">Apache Ossie, OWL and JSON</H2>
      <P>
        <strong>Export</strong> writes the model as the three Apache Ossie (incubating) documents —
        a semantic model (datasets, fields, relationships, metrics), an ontology (concepts and their
        relationships) and the mapping between them — so Snowflake, Databricks, dbt and other tools
        that read Ossie get the same definitions. What Ossie has no word for (a join-table link, a
        restricted property, rules, actions) travels in an <C>AGENTSWARMS</C> vendor extension, so
        exporting and importing again loses nothing. Other vendors&apos; extensions are kept through
        a round trip. <strong>Import</strong> reads Ossie (a semantic model alone, or all three
        documents) or this app&apos;s JSON, and says what it could not carry. OWL (Turtle) is a
        one-way bridge for knowledge-graph tools.
      </P>

      <H2 id="limits">Limits</H2>
      <Table
        headers={["Setting", "Default", "What it limits"]}
        rows={[
          [
            <C key="r">ONTOLOGY_MAX_ROWS</C>,
            "5000",
            "Rows one ontology query returns (explore pages are 50).",
          ],
          [<C key="s">ONTOLOGY_MAX_SPEC_KB</C>, "4096", "The size of one ontology document."],
        ]}
      />
      <P>
        A search around walks at most four links; a metric groups by at most four things; the graph
        shows at most 120 objects and says when it was capped.
      </P>

      <H3 id="related">Related</H3>
      <UL>
        <li>
          <DocLink to="/docs/lakehouse">Lakehouse</DocLink> — the tables an ontology is bound to.
        </li>
        <li>
          <DocLink to="/docs/semantics">Semantic Layer</DocLink> — metrics over one model; the
          ontology adds objects, links, rules and actions.
        </li>
        <li>
          <DocLink to="/docs/iam">Access control</DocLink> — sharing, groups and user attributes.
        </li>
      </UL>

      <NextPrev current="/docs/ontology" />
    </>
  );
}
