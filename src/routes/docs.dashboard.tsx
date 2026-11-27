import { createFileRoute } from "@tanstack/react-router";
import {
  C,
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
import { TRASH_RETENTION_DAYS } from "@/lib/trash";

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
          ["schedules failing", "A swarm schedule whose last run errored", "Agent Swarms"],
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

      <H2 id="recent-runs">Recent model calls</H2>
      <P>
        The last six calls to a model across your workspace, each with the agent name, model,
        latency, cost, and a success/error indicator. <em>View all</em> opens every call at{" "}
        <DocLink to="/traces">/traces</DocLink>, where each can be expanded into its complete trace
        — see <DocLink to="/docs/debugging">Logs &amp; traces</DocLink> for how to read one. For
        what ran rather than what was said, see Runs below.
      </P>

      <H2 id="runs">Runs</H2>
      <P>
        <strong>Overview → Runs</strong> (<strong>G</strong> then <strong>R</strong>) lists
        everything that ran for you, newest first and grouped by day: pipeline runs, workflow runs,
        swarm runs, scheduled emails of reports and dashboards, model training and batch
        predictions, notebook runs, SQL model runs, data monitor checks and evaluations. Each says
        what ran, how it was started (by hand, on a schedule, from the API, or by another run),
        when, how long it took, what it cost where that is known, and, when it failed, why in one
        line. Its name opens the thing that ran.
      </P>
      <Table
        headers={["On the page", "What it does"]}
        rows={[
          [
            "All · Needs a look · Not finished",
            "Needs a look is what failed, partly failed or raised an alert; Not finished is what is queued, running, or waiting for someone to approve a step. While anything has not finished the list looks again every half minute.",
          ],
          ["The kinds", "Show only some kinds of run; each says how many there are."],
          ["In the last", "24 hours, 7, 14, 30 or 90 days."],
          [
            "Ask about this",
            "On a run that needs a look: opens the assistant with the run's kind, name and error, to find what usually causes it and what to check.",
          ],
          [
            "Suggest a fix",
            "On a data monitor check or a pipeline run that needs a look: says why it failed and, when the platform knows the exact change that fixes it, offers to make it (below).",
          ],
        ]}
      />
      <H3 id="fixes">Fixes for what keeps failing</H3>
      <P>
        <strong>Suggest a fix</strong> reads the recent runs of the check or pipeline, and the
        columns of the table a check reads, and says why it failed. Two changes can be offered:
      </P>
      <Table
        headers={["When", "The change"]}
        rows={[
          [
            "A freshness check reads a column whose values are not dates or times",
            "Check the table's date or time column instead, preferring the one that says when a row last changed (updated, then loaded, then created). When the table has none, pause the check.",
          ],
          [
            "A check or pipeline failed the same way at least three runs in a row",
            "Pause its schedule. Running it again will not change the outcome; turn it back on once its cause is fixed.",
          ],
        ]}
      />
      <P>
        Nothing is offered for a failure caused by something unreachable or busy (the lakehouse
        catalog, a connection, the sandbox), because it recovers by itself, nor for a check that
        alerted on the data, because that is the check working. Those say so, and{" "}
        <strong>Ask the assistant</strong> explains the error. A change is made only when you press
        it, and the server checks again that the check or pipeline is yours and, for a column, that
        it is still a date or time column of that table. Every change is audited.
      </P>
      <Callout title="Asked in your approvals">
        A few times a day the scheduler looks at the checks and pipelines whose latest run failed.
        When one has a fix, you get it in the approvals inbox and a notification, with what it rests
        on: &quot;The last 12 runs failed the same way.&quot; Approving makes the change, once;
        rejecting leaves it as it is, and you are not asked about that change again.
      </Callout>
      <P>
        Some scheduled work keeps only its latest result, not a history: data-prep refreshes,
        scheduled analyses and dashboard refreshes. Their latest result is listed, marked{" "}
        <em>Only its latest run is kept</em>. Each kind is read as you, so the page lists your own
        runs and nobody else&apos;s, and a kind that cannot be read just then is named at the foot
        instead of the page failing.
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
            "Where things stand, your work, and where to start",
            "Dashboard, My work, Runs, Trash, Learn, Templates, Documentation",
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
            "Data Catalog, ETL Pipelines, Lakehouse, SQL Models, Workflows, Data monitors, Query history",
          ],
          [
            "Analysis",
            "Say what the data means, then ask it questions",
            "Semantic Layer, Metrics, Enterprise Ontology, Sheets, AI Analyst, BI Workspace",
          ],
          [
            "Data science",
            "Develop, deploy and monitor models on your data",
            "Developer workspace, Feature views, Experiments, ML Models, ML pipelines, Model serving, ML operations",
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

      <H2 id="assistant">The assistant</H2>
      <P>
        <strong>Assistant</strong> in the top bar (<C>Ctrl/⌘ J</C>) opens a panel beside whatever
        page you are on. It knows that page and the thing open on it, and it answers three kinds of
        question: what the page is for, how to do something, and where one of your things is. How-to
        answers come from this handbook, with a link to the section it used, and it says so when the
        handbook does not cover something rather than guess. It finds your things by name, shared
        ones included, and links them. When a piece of work belongs to a page with AI of its own, it
        sends you there: Ask AI in a workbook, the AI analyst tab on a dashboard, the Ask tab in an
        ontology, or the AI Analyst page.
      </P>
      <H3 id="assistant-mentions">Asking about one of your things</H3>
      <P>
        Type <C>@</C> in the panel and a list of your things opens: models, datasets, dashboards,
        workflows, agents and the rest, the same ones search finds. Pick one, and ask about it:{" "}
        <em>is @Churn model healthy?</em>, <em>what does @Sales overview show?</em>. The assistant
        reads it as you, so it sees only what you may open, and answers from a few plain facts:
      </P>
      <Table
        headers={["Thing", "What it reads"]}
        rows={[
          ["Model", "its task and target, the version in production and its score, and its health"],
          ["Dataset", "its columns and types, rows, and when its data was last loaded"],
          ["Dashboard", "its pages and the titles of their visuals (never their queries or data)"],
          ["Workflow", "its steps by name, its schedule and its last run"],
          ["Agent", "its model and tools (never its instructions)"],
          ["Swarm, pipeline", "its nodes, or where and when it runs (never its code or secrets)"],
          ["Anything else", "its name and description, and a link to open it"],
        ]}
      />
      <P>
        The thing open on your page is read the same way when you ask about it. A name or a
        description someone else wrote is read as theirs, never as an instruction to the assistant.
      </P>
      <H3 id="assistant-actions">Asking it to run or pause something</H3>
      <P>
        The assistant changes nothing itself. Ask it to run one of your workflows or pipelines now,
        or to pause or resume its schedule (<em>pause @Nightly revenue</em>), and it puts that in
        your approvals inbox, the tray at the top of the page, with what approving does. Nothing
        happens until you approve it there; reject it and nothing changes.
      </P>
      <Table
        headers={["You ask", "Approving it"]}
        rows={[
          [
            "Run it now",
            "Starts one run, as Run now on its page does; its schedule is not changed",
          ],
          [
            "Pause its schedule",
            "Stops its scheduled runs; a run already going is not stopped, and you can still run it by hand",
          ],
          [
            "Resume its schedule",
            "Starts its scheduled runs again from its next scheduled time, not from a run missed while it was paused",
          ],
        ]}
      />
      <P>
        Only your own workflows and pipelines: one shared with you is its owner&apos;s to run or
        pause, and the assistant says so. Pausing needs a schedule that is running, resuming one
        that is paused. Approving carries it out once, as you, after checking the thing again as it
        is then, so a workflow you paused by hand in the meantime is left as it is. The approval is
        worded from fixed words and the thing&apos;s name, not from what the assistant wrote, and
        both the proposal and what was done are in the audit log.
      </P>
      <Table
        headers={["In the panel", "What it does"]}
        rows={[
          [
            "A link to a page or one of your things",
            "Opens it in this tab; the panel and the conversation stay beside it.",
          ],
          ["A link to the handbook", "Opens in a new tab, so the conversation stays in view."],
          ["New conversation", "Starts again with nothing asked."],
          ["Stop", "Ends the answer being written; what it said so far stays."],
          ["@", "Lists your things to ask about; ↑ ↓ to move, Enter or Tab to choose."],
          ["Esc", "Closes the @ list if it is open, otherwise the panel."],
        ]}
      />
      <P>
        It reads and explains, and changes nothing itself (it can{" "}
        <a href="#assistant-actions">ask for a run or a pause</a>, which waits for your yes). It
        runs on the workspace&apos;s default model (Admin → Developer runtime → AI services →
        Default model), under your role&apos;s model rules and your AI budget, as every other AI
        feature does, and each answer is recorded like any other model call, named{" "}
        <em>Assistant</em>, with what it looked up sealed under your key. The conversation follows
        you from page to page and is kept in this browser tab only: closing the tab forgets it, and
        someone else signing in on the same browser does not see it. In search (<C>Ctrl/⌘ K</C>),
        anything you type can be handed to the assistant with <strong>Ask the assistant</strong>,
        which is the way to go when what you typed is a question rather than a name.
      </P>

      <H2 id="trash">Trash</H2>
      <P>
        Deleting an agent, swarm, dashboard, report, workbook, notebook, workflow, prompt, skill,
        evaluation set, semantic model, SQL model, data monitor, AI analyst or embed moves it to{" "}
        <strong>Overview → Trash</strong>, with everything that belonged to it: its versions, its
        schedules, its run history, its shares. Nothing else changes while it is there; a trashed
        workflow does not run and a trashed embed does not serve. The message that says it was moved
        has an <em>Undo</em>, and the Trash page restores it for {TRASH_RETENTION_DAYS} days, with
        the same address, so links to it work again.
      </P>
      <Table
        headers={["On the Trash page", "What it does"]}
        rows={[
          [
            "Restore",
            "Puts it back as it was. Something that belonged to it and pointed at something deleted since (a promotion to a dashboard that is gone) stays out, and the message says how many.",
          ],
          ["Delete for good", "Deletes that one now. It asks first, and it cannot be undone."],
          ["Empty trash", "Deletes everything in your trash now. It asks first."],
        ]}
      />
      <P>
        After {TRASH_RETENTION_DAYS} days an entry is deleted for good by itself. If something with
        the same unique name or link has been made since, Restore says so and leaves the entry in
        the trash until that one is renamed or removed.
      </P>
      <Note>
        Datasets, knowledge bases, ML models, MCP projects and connections, ETL pipelines and
        lakehouse tables are deleted for good at once and do not come here: deleting each also
        removes something outside the database (stored files, search vectors, a running service, a
        replication slot on the source), which a copy of its rows could not bring back. Each of
        those asks first and says what goes.
      </Note>
      <P>
        Only you see your trash and only you can restore from it. What it keeps is a copy of the
        rows, held where no page can read it; the Trash page shows names and dates and nothing more.
        Something you shared goes out of sight for the people you shared it with while it is in the
        trash, and comes back to them when you restore it.
      </P>

      <H2 id="learn">Learn: tutorials, and what is new</H2>
      <P>
        <strong>Overview → Learn</strong> has short tutorials done in the app itself, on the sample
        data every workspace has. Starting one opens the page its first step is done on, and from
        then on a guide sits in the corner of every page: the next step, in the words that page
        uses, and a button that goes there. A step ticks when what it asks for exists, worked out
        from what you made since you started the tutorial: an analyst that reads the sample sales, a
        check on a lakehouse table, a swarm run whose question you answered. Nothing can be ticked
        by hand, so the list is never ahead of you, and what you make is yours to keep.
      </P>
      <Table
        headers={["Tutorial", "What you have at the end", "Needs"]}
        rows={[
          [
            "Ask your data a question",
            "An analyst on the sample sales, an answer it checked, and the question asked again every week.",
            "A model",
          ],
          [
            "Build a dashboard that comes to you",
            "A dashboard on the sample sales with a KPI and a chart, emailed to you as a PDF every week.",
            "Nothing",
          ],
          [
            "Bring in data from an API",
            "An Any REST API source from the GitHub template, a dataset of its releases refreshed every day, and a chart of them.",
            "Nothing",
          ],
          [
            "Watch a table for problems",
            "The sample shipments as a lakehouse table, a data monitor on it, and its first result.",
            "The lakehouse",
          ],
          [
            "Forecast next quarter's orders",
            "A weekly forecast of order value from the sample shipments, its best version in production.",
            "The lakehouse",
          ],
          [
            "Run a swarm that asks before it acts",
            "Your own Support Copilot, a run of it, and its drafted reply approved or rejected by you.",
            "A model",
          ],
        ]}
      />
      <P>
        The guide looks again when you change page, when you come back to the window, and every half
        minute while the tab is showing. Fold it to a small pill, or close it: closing puts the
        tutorial away, and <em>Resume</em> on Learn brings it back where it was.{" "}
        <em>Start again</em> measures from that moment, so what you made before stops counting; it
        stays yours. A tutorial that needs a model says whether one was found for you (your own key,
        one shared with you, or the server's), and one that needs the lakehouse cannot be started
        where the lakehouse is not switched on. Only you see which tutorials you started.
      </P>
      <H3 id="whats-new">What&rsquo;s new</H3>
      <P>
        Below the tutorials, What&rsquo;s new lists what changed in the app, newest first, each with
        a link to where it is and, when there is one, the tutorial that walks through it. A dot
        beside <strong>Learn</strong> in the menu means something was added since the page was last
        opened in this browser.
      </P>
      <Note>
        Tutorials need migration <C>20261126000000</C> on the database. Until it is applied, Learn
        says so and nothing else changes.
      </Note>

      <H2 id="templates">Templates</H2>
      <P>
        <strong>Overview → Templates</strong> lists every ready-made starting point in the app, of
        every kind, with a search and a filter by kind. The same list is at the foot of the{" "}
        <strong>New</strong> menu. Each card says what the template is for, what it needs, and what
        pressing <em>Use template</em> does. The template opens on its own page, and nothing is made
        until you say so there: a draft to save, a dialog to press <em>Create</em> in, or a question
        to answer first.
      </P>
      <Table
        headers={["Kind", "Where it opens", "What Use does"]}
        rows={[
          ["Swarms", "Agent Swarms", "Opens on the canvas as a draft; saved when you save it."],
          [
            "Agents",
            "Agent Builder",
            "Asks first, then makes the agent and its knowledge base and opens it to chat. A template used before opens the agent it made, as you left it.",
          ],
          ["MCP servers", "MCP Builder", "Opens New MCP server with it chosen."],
          ["Skills", "Skill Library", "Shows its skill.md; Duplicate makes your own copy."],
          ["Pipelines", "ETL Pipelines", "Opens New pipeline with it chosen."],
          [
            "API connectors",
            "Integrations → Apps",
            "Opens Any REST API with it chosen; saved when you connect.",
          ],
          ["Workbooks", "Sheets", "Opens the import; the workbook is made when you import it."],
          [
            "Ontology",
            "Enterprise Ontology",
            "Asks first, then makes six lakehouse tables and an ontology bound to them.",
          ],
          ["Notebooks", "Developer workspace", "Opens to read; Fork makes a copy you can run."],
        ]}
      />
      <P>
        A template that needs a model says whether one was found for you, and one that needs the
        lakehouse cannot be used where it is not switched on. Templates are written beside the page
        that uses them, so one added to a page appears here too. A link of the form{" "}
        <C>?new=1&amp;template=&lt;id&gt;</C> on any of these pages starts that template, the way
        the gallery does.
      </P>

      <H2 id="first-run">What to do on a new workspace</H2>
      <P>
        A deployment with nothing built and nothing run gets a different page: an ordered checklist
        instead of a console full of zeroes, with each step ticked from real state rather than from
        a flag. Only the next unfinished step carries a button. The order below is the same one, and
        it is dependency order rather than feature order. A line under the checklist points to{" "}
        <a href="#learn">Learn</a> for anyone who would rather follow a tutorial on the sample data.
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
