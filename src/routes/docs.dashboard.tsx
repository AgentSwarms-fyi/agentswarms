import { createFileRoute } from "@tanstack/react-router";
import {
  Callout,
  DocLink,
  DocsHeader,
  FieldList,
  H2,
  H3,
  NextPrev,
  Note,
  P,
  Steps,
  Table,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "The AgentSwarms dashboard: platform status, the four figures that matter, 24-hour activity, what this deployment is running, spend by person or team, and recent runs.",
      },
      { property: "og:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        property: "og:description",
        content:
          "The AgentSwarms dashboard: platform status, key figures, activity, what you are running, and recent runs.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/dashboard" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Dashboard — AgentSwarms Documentation" },
      {
        name: "twitter:description",
        content:
          "The AgentSwarms dashboard: platform status, key figures, activity, what you are running, and recent runs.",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/dashboard" }],
  }),
  component: DashboardDoc,
});

function DashboardDoc() {
  return (
    <>
      <DocsHeader
        eyebrow="Getting started"
        title="Dashboard"
        description="The dashboard at /dashboard is the screen you land on after signing in. It answers one question first — is this deployment healthy, and what is it costing — and then shows what you are running and what has happened in the last day."
      />

      <H2 id="status">Platform status</H2>
      <P>
        The first thing on the page is a single sentence: <strong>Everything is running</strong>, or
        the number of things that need attention with a chip for each one. Every status behind it
        was already being recorded somewhere — by the SaaS sync, the warehouse connection test, the
        swarm scheduler, the pipeline run, the data monitor — and each chip links to the page that
        can fix it. A check that could not be read is a chip of its own (&ldquo;? sources not
        syncing — could not be read&rdquo;), never a zero: the sentence says &ldquo;Everything is
        running&rdquo; only when every check answered and none found anything.
      </P>
      <Table
        headers={["Chip", "Where it comes from", "Where it takes you"]}
        rows={[
          [
            "sources not syncing",
            "A SaaS connection whose last sync errored or was partial",
            "Integrations",
          ],
          [
            "warehouses unreachable",
            "A warehouse whose last connection test failed",
            "Integrations",
          ],
          ["schedules failing", "A swarm schedule whose last run errored", "Swarms"],
          [
            "pipeline runs failed today",
            "An ETL run that failed in the last 24 hours",
            "ETL Pipelines",
          ],
          [
            "open data incidents",
            "A data monitor that raised an incident nobody has closed",
            "Data monitors",
          ],
          ["workflows failed", "A workflow whose last run failed", "Workflows"],
          ["SQL models failing", "A SQL model whose last build errored", "SQL models"],
          [
            "of the monthly budget used",
            "Month-to-date spend at 80% of the cap or above",
            "Budgets",
          ],
        ]}
      />
      <Callout kind="why" title="It says so when nothing is wrong">
        A band that appears only on failure teaches nobody that it exists, and its absence then
        reads as &ldquo;not loaded yet&rdquo; rather than &ldquo;nothing to report&rdquo;. It also
        carries the time it checked, because a dashboard with no timestamp cannot be told apart from
        a stale tab left open overnight.
      </Callout>

      <H2 id="figures">The four figures</H2>
      <P>
        Below the band are the numbers that change a decision, each measured against something
        rather than standing alone.
      </P>
      <FieldList
        items={[
          {
            name: "Runs (24h)",
            body: (
              <>
                Model calls in the last 24 hours. Shown as <strong>&ge;n</strong> when the read hit
                its limit, so a busy day reports a floor rather than describing a prefix as if it
                were the whole day.
              </>
            ),
          },
          {
            name: "Spend (month to date)",
            body: (
              <>
                Against your monthly cap, with a bar that turns amber at 80% and red past 100%. The
                figure is the same one <DocLink to="/docs/budgets">budget caps</DocLink> enforce, so
                the two can never disagree. With no cap set it falls back to the 24-hour total and
                says so.
              </>
            ),
          },
          {
            name: "Success rate (24h)",
            body: (
              <>
                Of runs that reached a verdict. Cancelled runs leave the denominator entirely — a
                person pressing Stop is not a failure. With nothing decided it reads
                &ldquo;&mdash;&rdquo; rather than congratulating you on 100%.
              </>
            ),
          },
          {
            name: "Avg latency (24h)",
            body: "Mean wall-clock time per model call, over the runs that recorded one.",
          },
        ]}
      />

      <H2 id="activity">Activity and model mix</H2>
      <P>
        <strong>Activity</strong> charts hourly run volume for the last 24 hours across every agent
        and swarm. <strong>Model mix</strong> beside it ranks models by tokens, so you can see where
        the spend went before opening anything.
      </P>

      <H2 id="running">What you&rsquo;re running</H2>
      <P>
        A grid counted from this deployment&rsquo;s own tables, covering both halves of the
        platform: agents, swarms and knowledge bases on one side; ETL pipelines, the lakehouse, SQL
        models, ML models, dashboards, workflows, data monitors, metrics and integrations on the
        other. A capability with something in it shows the count and, when relevant, what is wrong
        with it — &ldquo;5 watching &middot; 1 open&rdquo;. A capability with nothing in it says so
        and offers the way in, rather than showing a zero.
      </P>
      <Callout kind="why" title="Counted, not advertised">
        This replaced a grid of twelve static feature tiles that read the same whether you had one
        agent or a thousand pipelines. The sidebar already lists every feature; what a dashboard can
        say that the sidebar cannot is which ones <em>you</em> are using and whether they are
        working.
      </Callout>

      <H2 id="spend">Spend &amp; usage — by person, team or organisation</H2>
      <P>
        The <strong>Spend &amp; usage</strong> panel attributes model cost, so it can be charged
        back rather than only totalled. Two pickers control it.
      </P>
      <Table
        headers={["Scope", "Who can pick it", "What it covers"]}
        rows={[
          ["Just me", "Everyone", "Your own runs. The default."],
          [
            "My teams",
            "Anyone in at least one IAM group",
            "Everyone in the groups you belong to — resolved from your membership, not chosen by you.",
          ],
          [
            "Whole organisation",
            "Superadmins only",
            "Every user. Also the only scope that shows people outside your teams.",
          ],
        ]}
      />
      <P>
        The picker offers <strong>only the scopes you may actually use</strong>. If you are in no
        team, &ldquo;My teams&rdquo; is absent rather than present-and-broken — and a scope you are
        not entitled to is <em>refused</em>, never quietly answered with your own numbers under
        someone else&rsquo;s label.
      </P>
      <P>
        The time range covers the last 24 hours through year to date. Windows are half-open and in
        UTC, so a run landing exactly on a boundary is counted once and the same dashboard reads the
        same from any timezone.
      </P>
      <Callout kind="why" title="Team totals overlap on purpose">
        Someone in two teams contributes their spend to <em>both</em>, so the team rows do not add
        up to the total. That is the right answer to &ldquo;what did this team cost&rdquo; — the
        alternative is splitting one person's spend arbitrarily between teams, which is a worse lie
        than an overlap you can see.
      </Callout>
      <P>
        Cost comes from the same column the <DocLink to="/docs/budgets">budget caps</DocLink> read,
        so a figure here and a budget alert can never disagree about what someone spent.
      </P>

      <H2 id="recent-runs">Recent runs</H2>
      <P>
        The last six executions across your workspace, each with the agent name, model, latency,
        cost, and a success/error indicator. <em>View all</em> opens the full run history at{" "}
        <DocLink to="/traces">/traces</DocLink>, where every run can be expanded into its complete
        trace — see <DocLink to="/docs/debugging">Logs &amp; traces</DocLink> for how to read one.
      </P>

      <H2 id="search">Finding your work, and starting something new</H2>
      <P>
        The search box in the middle of the top bar is on every page; <strong>Ctrl K</strong> (
        <strong>⌘ K</strong> on a Mac) opens it from the keyboard. Type part of a name and it lists
        your own work first — agents, swarms, knowledge bases, datasets, lakehouse tables,
        pipelines, semantic models and their metrics, dashboards, reports, workbooks, notebooks, ML
        models, workflows, analysts and their saved analyses, and the rest — then the things you
        could start, then the pages. Choosing a result opens that object, not just the page it lives
        on.
      </P>
      <P>
        Words match where a name is split: <em>sales</em> finds <code>saas_sales</code>,{" "}
        <code>SalesByRegion</code> and &ldquo;Q3 sales review&rdquo;. Every word typed has to be
        found, in the name or failing that in the description; a name that is the query comes first,
        then names that start with it, and among equals whatever changed most recently. Search reads
        names and descriptions only, never what is inside an object, and it lists exactly what each
        page would show you: your own work, what was shared with you (marked{" "}
        <em>Shared with you</em>) and the bundled samples. Lakehouse tables are listed by their own
        engine and can arrive a moment after everything else, longer just after a restart; until
        they do, search says it is still reading them instead of saying nothing matches.
      </P>
      <P>
        <em>See all results</em> opens the search page at <DocLink to="/search">/search</DocLink>,
        which groups matches by kind, filters to one kind, and can be bookmarked or sent to a
        colleague. With nothing typed it is an overview of everything you have, one tile per kind.
      </P>
      <P>
        <strong>New</strong>, beside the search box, lists everything that can be started — an
        agent, a dataset, a dashboard, a report, a pipeline, a workflow and so on — grouped by what
        it is for. The same list is in search: type <em>new report</em> and press Enter.
      </P>

      <H2 id="menu">The menu, grouped by job</H2>
      <P>
        The menu on the left has one group for each kind of work, so the page you want is in the
        group named for what you came to do. Inside a group the pages are in the order the work
        goes: under Data engineering you find a table, move it, store it, shape it, run it on a
        schedule and watch it.
      </P>
      <Table
        headers={["Group", "What it is for", "Pages"]}
        rows={[
          [
            "Overview",
            "Where things stand, your own work, and the handbook",
            "Dashboard, My work, Documentation",
          ],
          [
            "Build",
            "Make agents and what they work with",
            "Agent Builder, Knowledge Base, Agent Chat, Agent Swarms, MCP Builder",
          ],
          ["Library", "Prompts and skills to reuse", "Prompt Library, Skill Library"],
          [
            "Experiment",
            "Try prompts and models, and score the answers",
            "Prompt Compare, Evaluations, Image Playground",
          ],
          [
            "Data engineering",
            "Bring data in, shape it, run it on a schedule, watch it",
            "Data Catalog, ETL Pipelines, Lakehouse, SQL Models, Workflows, Data monitors",
          ],
          [
            "Analysis",
            "Say what the data means, then ask it questions",
            "Semantic Layer, Metrics, Enterprise Ontology, Sheets, AI Analyst, BI Workspace",
          ],
          [
            "Data science",
            "Train models and write code against your data",
            "ML Models, Developer workspace",
          ],
          [
            "Integrations",
            "Connect models, tools and other systems",
            "Integrations, MCP Servers, AI Model Catalog, Secrets, Web Embedding",
          ],
          [
            "Observability",
            "See what ran, what it cost and who did what",
            "Analytics, Traces & Logs, Swarm Traces, AI Budgets, Audit Log",
          ],
          [
            "Admin (superadmins only)",
            "People, access and the machines this runs on",
            "IAM, Monitoring, Developer runtime",
          ],
        ]}
      />
      <P>
        A group opens and closes when you press its name, and this browser remembers which ones you
        left open. A closed group shows how many pages it holds, and pointing at it says what it is
        for. The group holding the page you are on opens by itself and that page is scrolled into
        view, however you got there; once you scroll the menu yourself it stays where you put it.
        Each page prints the name of its group above its title.
      </P>
      <P>
        In search, a page named in full goes first, so typing <em>Lakehouse</em> and pressing Enter
        opens the Lakehouse page even when some of your work mentions a lakehouse. Something of
        yours with that exact name still comes before the page. A page that has been renamed is
        still found, and opened the same way, by its old name: the AI Model Catalog, the list of
        models other people host, was called the Model Registry.
      </P>

      <H2 id="my-work">My work: recent, favourites and shared with you</H2>
      <P>
        <strong>Overview → My work</strong> lists your things from every page in one place. An
        agent, a dataset, a dashboard and a notebook live on four different pages; here they are one
        list, and a row opens the thing itself.
      </P>
      <Table
        headers={["Tab", "What it lists"]}
        rows={[
          [
            "Recent",
            "What you opened, newest first, with when. Your own work that you have not opened yet is listed among it by when it last changed, and says so: opened two hours ago, or changed three days ago. The fifty most recent.",
          ],
          ["Favourites", "Everything you starred, the most recently starred first."],
          [
            "Shared with me",
            "What other people shared with you, whichever page it lives on. Bundled samples are not listed: nobody shared those.",
          ],
        ]}
      />
      <P>
        Each tab counts what it holds, and the chips under the tabs narrow it to one kind. A link to
        a tab can be kept or sent: the address carries the tab and the kind. Pressing G and then M
        opens the page from anywhere.
      </P>
      <H3 id="favourites">Favourites</H3>
      <P>
        Press the star beside a name to keep it at hand, and press it again to take it off. The star
        is on My work, in search results, on the rows and cards of the list pages, and beside the
        title of an open dashboard, report, workbook, model, notebook, ontology or MCP project. It
        is the same star everywhere: something starred on its own page is a favourite here.
      </P>
      <P>
        Once something on a page of cards or a table is starred, that page shows a{" "}
        <em>Favourites</em> chip with how many there are. Pressing it narrows the list to them;
        pressing it again shows everything. Pages that keep their list in a narrow side rail, such
        as Knowledge Base, SQL Models and Workflows, have the star and no chip. Favourites are yours
        alone. Starring something changes nothing for the people it is shared with, and they do not
        see your star.
      </P>
      <H3 id="where-you-were">Search opens on where you were</H3>
      <P>
        Before you type anything, search (Ctrl K, or ⌘ K) lists up to five favourites and then the
        five things you opened last, so going back to yesterday's dashboard is two keys. Once you
        type, a favourite goes ahead of another result that matches just as well. It never goes
        ahead of a better match: a star settles a tie and nothing more.
      </P>
      <H3 id="what-is-kept">What is kept, and who can read it</H3>
      <P>
        To draw these lists the app keeps, for each thing you starred or opened, which thing it was
        and when. It keeps no names. A name is looked up when the list is drawn, among what you may
        see at that moment, so a favourite that was deleted, or is no longer shared with you, stops
        being listed without anyone tidying up.
      </P>
      <P>
        No page shows what you opened to anyone else, and the database returns each person their own
        rows only. <em>Clear what I opened</em>, under the Recent tab, forgets all of it. Your
        favourites stay, and your own work is listed by when it last changed again.
      </P>

      <H2 id="first-run">What to do on a new workspace</H2>
      <P>
        A deployment with nothing built and nothing run gets a different page: an ordered checklist
        instead of a console full of zeroes, with each step ticked from real state rather than from
        a flag. Only the next unfinished step carries a button. The order below is the same one, and
        it is dependency order rather than feature order.
      </P>
      <Steps
        items={[
          {
            title: "Connect a model provider",
            body: (
              <>
                <strong>Integrations</strong>. Until you do, calls run on the operator's shared
                fallback key — fine for a first look, wrong for anything real. See{" "}
                <DocLink to="/docs/models">Models &amp; providers</DocLink>.
              </>
            ),
          },
          {
            title: "Add data or documents",
            body: (
              <>
                <DocLink to="/docs/data">Data Catalog</DocLink> for rows,{" "}
                <DocLink to="/docs/knowledge">Knowledge Base</DocLink> for prose. An agent with
                neither is just a chatbot.
              </>
            ),
          },
          {
            title: "Build one agent",
            body: (
              <>
                <DocLink to="/docs/agents">Agent Builder</DocLink> — name, prompt, model, one or two
                tools.
              </>
            ),
          },
          {
            title: "Run it and read the trace",
            body: (
              <>
                <DocLink to="/docs/debugging">Logs &amp; traces</DocLink>. This is the habit worth
                forming early.
              </>
            ),
          },
          {
            title: "Before anyone else joins",
            body: (
              <>
                Turn off public signup and set budget caps —{" "}
                <DocLink to="/docs/iam">Access control</DocLink> and{" "}
                <DocLink to="/docs/budgets">Budgets</DocLink>.
              </>
            ),
          },
        ]}
      />

      <NextPrev current="/docs/dashboard" />
    </>
  );
}
