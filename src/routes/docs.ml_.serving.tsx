import { createFileRoute } from "@tanstack/react-router";
import {
  C,
  Callout,
  Code,
  DocLink,
  DocsHeader,
  H2,
  H3,
  NextPrev,
  P,
  Table,
  UL,
} from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/ml_/serving")({
  head: () => ({
    meta: [
      { title: "ML Models · Serving — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Warm endpoints for low-latency prediction: copies and autoscaling, what a copy can and cannot do, trying a version on real traffic as a shadow or a canary, and training past what one container holds.",
      },
      { property: "og:title", content: "ML Models · Serving — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Warm endpoints, copies, shadow and canary versions.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml/serving" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml/serving" }],
  }),
  component: MlServingPage,
});

function MlServingPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models · Serving"
        description="Warm endpoints for low-latency prediction: copies and autoscaling, what a copy can and cannot do, trying a version on real traffic as a shadow or a canary, and training past what one container holds."
      />
      <P>
        Part of the <DocLink to="/docs/ml">ML Models</DocLink> guide. This page covers the warm
        endpoints that answer in milliseconds instead of starting a container per request, the
        copies they scale across, and how a candidate version is tried on real traffic before it is
        promoted.
      </P>

      <H2 id="warm">Warm endpoints</H2>
      <P>
        By default a prediction starts a container, boots Python, imports the ML stack, downloads
        and digest-checks the artifact, scores, posts the answer back and exits — about{" "}
        <strong>twenty seconds before any scoring happens</strong>. That is the right shape for a
        batch job over a million rows and the wrong one for scoring a row behind a web request. A{" "}
        <strong>deployment</strong> holds the version it serves in memory and answers over HTTP
        instead, from <strong>Automation → Warm endpoint</strong> on the model page. While a
        candidate is being shadowed or run as a canary it holds that one too.
      </P>
      <UL>
        <li>
          <strong>The scoring is identical.</strong> The sandbox loads the same program the batch
          path runs and calls the same <C>_predict</C>, so the same fitted pipeline scores the same
          digest-verified artifact. Only the waiting is different.
        </li>
        <li>
          <strong>It pins a version.</strong> Promoting a new one marks the endpoint{" "}
          <strong>stale</strong> and leaves it serving what it was serving. An endpoint that
          silently changed its answers is the opposite of what pinning is for.
        </li>
        <li>
          <strong>A missing endpoint is slower, never wrong.</strong> Down, loading, or serving a
          different version, the prediction falls back to the sandbox. Every reply says which path
          answered, in <C>served</C>.
        </li>
        <li>
          <strong>Measured, one row, end to end:</strong> ~1.3 s warm against ~27 s cold on a laptop
          with a remote database. The scoring itself is <strong>45 ms</strong> either way — that is
          the model, and it does not change. What the endpoint removes is the container start; what
          is left is the platform&apos;s own book-keeping, which on that setup is almost entirely
          round trips to a database in another datacentre.
        </li>
        <li>
          <strong>Recorded exactly like a cold prediction:</strong> the same row, the same drift
          check, the same <C>ml.predict_query</C> audit event. Faster, not less accountable — and
          those writes are part of the number above.
        </li>
        <li>
          <strong>It costs memory while it is up</strong>, so it is off by default, an idle one is
          stopped after its timeout unless <strong>Keep warm</strong> is on, and the instance caps
          how many may be open.
        </li>
      </UL>
      <Callout title="Forecast models have no endpoint">
        A forecast is answered from the stored series with no model in the loop at all, so there is
        nothing to hold warm.
      </Callout>

      <H3 id="replicas">More than one copy</H3>
      <P>
        One sandbox is one Python process scoring one request at a time, so the second caller waits
        for the first — and at that point the twenty seconds a warm endpoint saved are being spent
        again in the queue, somewhere less visible.
      </P>
      <P>
        An endpoint can therefore hold several <strong>copies</strong> of the model, each in its own
        sandbox. Set the range on the deployment panel: the first number is how many are held even
        with no traffic, the second the ceiling. <strong>Both default to 1</strong>, so nothing
        changes until you raise the second — every copy is a container holding the ML stack and a
        fitted pipeline resident on your machine, and starting more because a feature shipped would
        be spending your memory without asking.
      </P>
      <P>
        Requests go to the copy that has gone longest without one. That is the same rule the scaler
        uses to choose what to stop, deliberately: two notions of &ldquo;quietest&rdquo; would have
        the two disagreeing about the same endpoint.
      </P>
      <H3 id="replicas-scaling">When copies are added and removed</H3>
      <P>
        The platform clock measures the endpoint&apos;s request rate — the change in its counter
        between two readings, not a sample — and compares it with{" "}
        <C>ML_SERVE_TARGET_RPM_PER_REPLICA</C> (120), the load one copy is sized for.
      </P>
      <P>
        <strong>Adding is immediate.</strong> A queue is the thing a warm endpoint exists to
        prevent, so there is no cooldown before relieving one. One copy is added per pass however
        far behind the endpoint is: the next pass is a minute away and will add another if it is
        still needed, by which time the first has loaded — so the decision is made knowing what it
        bought. Starting four at once on a burst is how a machine runs out of memory serving a spike
        that ended before they loaded.
      </P>
      <Callout kind="info" title="Removing a copy needs three things at once">
        The load clear of what the smaller number could carry, not merely at it — otherwise the next
        pass adds the copy straight back and the endpoint flaps, paying a cold start every time it
        changes its mind. <C>ML_SERVE_SCALE_COOLDOWN_SECONDS</C> (180) since the last change either
        way. And a copy that has actually been idle that long, because stopping a container takes
        any request still inside it.
      </Callout>
      <P>
        Every decision is recorded on the endpoint in plain words — the panel shows the last one —
        and every change is audited as <C>ml.scale</C> with the rate that caused it.
      </P>
      <H3 id="replicas-limits">What a copy actually is, and how far it gets you</H3>
      <P>
        A copy is a sandbox, started the same way every other sandbox is — so what it lands on
        depends entirely on the runtime backend. Nothing in the scaling code mentions either one: it
        asks the orchestrator for a scoring sandbox and gets back an address.
      </P>
      <Table
        headers={["Backend", "A copy is"]}
        rows={[
          ["Docker", "Another container on this machine."],
          ["Kubernetes", "Another Pod, which the scheduler may place on any node."],
        ]}
      />
      <P>
        <strong>On Kubernetes these are bare Pods the app creates, not a Deployment.</strong> There
        is no ReplicaSet and no Service in front of them: the app holds each Pod&apos;s address and
        picks between them itself. So the HorizontalPodAutoscaler is not involved — the platform
        clock is the control loop — and copies do genuinely spread across nodes, which means an
        endpoint can outlive one of them.
      </P>
      <Callout kind="warn" title="On a single machine the benefit is bounded">
        The scorer is a threading HTTP server, so one copy already accepts concurrent requests — but
        scoring is CPU-bound Python and the GIL serialises most of it, with only the numpy and BLAS
        parts overlapping. A second copy is a second OS process, which is genuine parallelism.
        Copies therefore help up to roughly the machine&apos;s core count; past that they contend
        for the same CPU and each holds the ML stack and a fitted pipeline in memory. And two copies
        on one box die with the box. That is why the maximum defaults to 1.
      </Callout>
      <P>
        Either way the warm-container limits still apply, and they count copies rather than
        endpoints, because the thing being bounded is resident memory.
      </P>

      <H3 id="shadow">Trying a version on real traffic</H3>
      <P>
        A new version is normally adopted by <strong>switching</strong> to it. Which means the first
        evidence that it behaves differently from the old one is production behaving differently —
        noticed, if it is noticed, by whoever the difference landed on.
      </P>
      <P>
        <strong>Shadowing asks the question first.</strong> Pick a version on the deployment panel
        and the endpoint starts a second copy holding it. From then on, every request the endpoint
        answers is mirrored to that candidate, its answer is compared against the one that was
        actually served, and then thrown away.
      </P>
      <Callout kind="info" title="A candidate never answers a caller">
        The scorer asks for copies marked <Code>primary</Code> and never sees the candidate at all,
        so there is no ordering, no flag and no race by which an unapproved version could end up on
        the wire. Two smaller promises follow from it. <strong>Nobody waits for it</strong> — the
        mirror is fired after the served answer is in hand and is not awaited, so the caller&apos;s
        latency is the primary&apos;s latency. And{" "}
        <strong>a mirror that fails cannot reach the caller</strong>: it is caught and counted, so a
        candidate that cannot load shows up as an error rate on the report rather than as a failed
        request for somebody else.
      </Callout>
      <P>
        What <em>agree</em> means is not the same question for every model, and pretending it is
        would make the number meaningless.
      </P>
      <Table
        headers={["Task", "Agreement is"]}
        rows={[
          ["Classification", "The same label. A proportion that reads exactly as it looks."],
          ["Regression", "Within 1%, relative, with an absolute floor near zero."],
        ]}
      />
      <P>
        Counting exact float matches on a regression would report 0% agreement on two models that
        are indistinguishable in practice, so the comparison is a tolerance.{" "}
        <strong>Clustering, anomaly detection and recommendation are not compared</strong> and the
        mirror does not run for them: their labels are arbitrary between fits, so cluster 3 of one
        model has nothing to do with cluster 3 of another, and the comparison would report total
        disagreement between two identical models.
      </P>
      <Callout kind="warn" title="The mirrored input is never stored">
        A mirrored request carries whatever the caller sent, which on a live endpoint is live
        personal data; keeping it would put that data in a debugging table nobody thinks of as a
        data store. What is kept is four running totals on the endpoint — requests, rows, rows
        agreed, errors — plus the two <em>answers</em> from the fifty most recent rows they
        disagreed on. Totals rather than a row per request, because an endpoint at a couple of
        requests a second would write a hundred and fifty thousand rows a day to answer a question
        that is four numbers.
      </Callout>
      <P>
        The panel leads with a sentence rather than a figure, and below a hundred compared rows it
        refuses to give one at all — it says how many more it needs. A percentage on forty rows
        invites a decision nobody has evidence for, which is the opposite of what shadowing is for.
      </P>
      <Table
        headers={["It says", "When"]}
        rows={[
          ["Watching", "Fewer than 100 rows compared so far."],
          ["Answers the same", "90% of rows or more agreed."],
          [
            "Answers differently",
            "Below that — with recent disagreeing answers listed underneath.",
          ],
          ["Failing", "The candidate failed on 5% or more of mirrored calls."],
        ]}
      />
      <P>
        A candidate is a copy, so it is a container, and it counts against the same warm-container
        limits as any other. <strong>One candidate at a time</strong>: choosing another retires the
        first, and the totals reset, because figures gathered against a different candidate answer a
        question nobody asked. Stopping it takes the copy down and leaves nothing behind. Adopting
        it is the ordinary <strong>Redeploy</strong> to that version — shadowing does not promote
        anything by itself, and never will. It measures; a person switches. Both starting and
        stopping are audited, as <Code>ml.shadow.start</Code> and <Code>ml.shadow.stop</Code>.
      </P>

      <H3 id="canary">Giving it a share of real traffic</H3>
      <P>
        Shadowing tells you the candidate answers the same way. It cannot tell you the candidate
        answers <em>at all</em> under real load, on real data, at real concurrency — because nobody
        was ever waiting for one of its answers.
      </P>
      <P>
        A <strong>canary</strong> does. Switch the candidate from <em>Mirror only</em> to{" "}
        <em>Send real traffic</em> and a share of requests are answered by it, for real, and
        returned to whoever asked. The share is a whole number of per cent and the default is 5.
        This is the one place in the platform where a version nobody approved answers a real caller,
        so it is worth being exact about what bounds it.
      </P>
      <Callout kind="info" title="The split is per request, and nobody is refused">
        The roll is taken per request, not per caller: a prediction has no session to be sticky to,
        and a sticky split would let one unlucky caller take every bad answer while the average
        looked fine. A random split lands <em>near</em> the number rather than on it, so the panel
        shows the share actually served next to the share asked for — at 10% on a hundred requests,
        thirteen crossing is ordinary. And if the candidate&apos;s copy is not up when the roll
        picks it, the request goes to production instead: the share slips for a few requests, which
        is a far smaller thing than a failed request.
      </Callout>
      <P>
        A canary <strong>cannot measure agreement</strong>, and no amount of wanting it to will
        help: each row was answered once, by one version, so there is no second answer to compare it
        against. That is what shadowing is for, and why the two are separate steps rather than one
        slider. What a canary measures is failure — on both sides.
      </P>
      <Table
        headers={["", "What is counted"]}
        rows={[
          ["Candidate", "Requests it answered, and how many failed."],
          ["In production", "The same two figures for the version it would replace."],
        ]}
      />
      <P>
        Production&apos;s figures are there because the question is never &ldquo;is the candidate
        failing&rdquo; but &ldquo;is it failing{" "}
        <strong>worse than the thing it would replace</strong>&rdquo;. Without them, a lakehouse
        outage reads as a bad model. And because it measures failure rather than agreement, a canary
        works for <strong>every task</strong> — including clustering, anomaly detection and
        recommendation, where shadowing cannot be offered at all.
      </P>
      <Callout kind="warn" title="It rolls itself back, without being asked">
        Nobody is watching a panel at three in the morning, and this is the one feature where not
        noticing has a cost measured in other people&apos;s answers. The platform takes the
        candidate out of the traffic when all three hold: at least <strong>20 requests</strong> have
        gone through it (every one a real caller, so the number is the smallest that makes a rate
        mean anything); it has failed <strong>10% or more</strong> of them (two in twenty, rather
        than a single transient timeout); and that is at least <strong>5 points worse</strong> than
        production over the same period. The third condition is what stops the canary blaming itself
        for everything — if both sides are failing the endpoint says so and rolls back nothing,
        because reverting to a version failing just as hard fixes nothing. A rollback stops the
        traffic first, then takes the copy down, writes the reason on the endpoint and audits{" "}
        <Code>ml.canary.rollback</Code>. The reason stays after the candidate is gone: somebody
        arriving to find production serving its old version needs to learn why from the endpoint.
      </Callout>
      <P>
        Every prediction records the version that <strong>actually</strong> answered it, not the one
        the endpoint is nominally serving. Under a canary those differ for some share of rows by
        design, and recording the endpoint&apos;s version would attribute a candidate&apos;s
        prediction to production — wrong on the row somebody reads when they ask why, wrong in the
        drift figures, and wrong in exactly the cases anybody is looking into.
      </P>
      <P>
        A candidate already running as a shadow <strong>keeps its warm copy</strong> when it becomes
        a canary: same version, same container, and throwing away a loaded model to change one
        column would cost twenty-five seconds for nothing. The canary figures reset because they
        describe a run and this is a new one; the shadow totals are left alone because they are
        still true. Adopting the candidate is the ordinary <strong>Redeploy</strong> to that version
        — nothing here promotes anything by itself. The only thing the platform does on its own is
        take a failing candidate <em>out</em>.
      </P>

      <H3 id="data-parallel">More rows than one container holds</H3>
      <P>
        A dataset bigger than the row ceiling used to be <strong>sampled</strong>: the trainer took
        a reservoir sample down to <Code>ml_train_max_rows</Code> and fitted on that. The model was
        real, and it had seen a fraction of the evidence. It can now be fitted{" "}
        <strong>across containers</strong> instead — once the search has picked an algorithm,
        workers refit that one algorithm on disjoint slices of the rows and their fits are averaged
        into a single model. This happens by itself, only when the search had to sample, and only
        for classification and regression.
      </P>
      <Callout kind="info" title="What this is, said plainly">
        It is <strong>pasting</strong>: bagging on disjoint partitions. A real ensemble method, and
        NOT the same estimator you would get by fitting once on everything — but that estimator is
        not on offer, because a single fit on all the rows is precisely the thing that does not fit.
        The baseline is the sample fit, and against it the tree models that usually win gain about{" "}
        <strong>+0.011 F1</strong> at eight workers, while linear models neither gain nor lose
        because 25,000 rows was already enough for them to converge.
      </Callout>
      <P>
        Against a single fit on all the rows the same measurement costs a little, and the cost is
        governed by how many rows each worker still gets rather than by how many workers there are.
        There is no cliff, so the floor is a line drawn on a curve: below{" "}
        <strong>25,000 rows per worker</strong> the platform refuses to split and samples the old
        way, because a fast answer that is worse than the slow one is not a feature.
      </P>
      <Table
        headers={["Rows each", "Cost against one fit on all rows"]}
        rows={[
          ["160,000", "-0.0000"],
          ["40,000", "-0.0035"],
          ["20,000", "-0.0082"],
          ["10,000", "-0.0123"],
          ["2,500", "-0.0339"],
        ]}
      />
      <Callout kind="warn" title="The rows are divided by hashing, not by LIMIT and OFFSET">
        Without an <Code>ORDER BY</Code> there is no promised order, and DuckDB parallelises a scan,
        so two containers issuing the same windowed query can overlap on some rows and miss others.
        Nothing downstream would notice: the fit would simply be on the wrong rows and the score
        would look ordinary. Hashing decides who owns a row with no ordering at all, and identical
        rows land together — they are the same evidence. Verified against DuckDB: the partitions
        cover every row exactly once, come out within a per cent of even, and are identical from a
        fresh connection.
      </Callout>
      <P>
        The version records the rows it actually covered and carries a note saying it was split, how
        many containers over, and that pasting is not the same as one fit over everything. If the
        workers between them still cannot hold all the rows, the note says how many were left out.{" "}
        <strong>The metrics are the search&apos;s</strong>, measured on the holdout the search kept
        rather than re-measured on the slices — each worker&apos;s own holdout is a piece of its own
        slice, so a metric averaged over them would be measured on data each fit had seen a
        neighbour of.
      </P>
      <P>
        Nothing here can leave you without a model. If no worker will start, if every slice fails,
        or if no container is free to combine them, the job keeps the model the search already
        produced and says on the version that this is the sampled fit. A job that splits its rows
        takes three phases rather than one — search, refit, assemble — and each hands over to the
        next exactly once, claimed in the database so that of several workers finishing together
        only one moves the job on.
      </P>

      <H3 id="copies">How many copies you can run</H3>
      <P>
        A deployed model is one <strong>scorer replica</strong> per copy: a container holding
        Python, the ML stack and one fitted pipeline, answering requests. Measured on a laptop
        deployment, a loaded scorer that had just answered a prediction sat at{" "}
        <strong>169 MB resident</strong> and 0.02% CPU idle, and served in <strong>0.105 s</strong>.
      </P>
      <P>
        Its memory ceiling is <C>ML_SERVE_MEM_LIMIT_MB</C> (2 GB), and that is a different number
        from the training budget on purpose: training fits a model on up to two million rows;
        serving holds one finished model. They used to share <C>ML_TRAIN_MEM_LIMIT_MB</C> — 8 GB —
        which cost nothing on one host, because a Docker limit reserves nothing.
      </P>
      <Callout title="On Kubernetes it is the ceiling on how many copies you may run">
        A namespace <C>ResourceQuota</C> bounds <C>limits.memory</C>, so every scorer spends its
        ceiling out of the quota whether or not it uses it: at 8 GB apiece, 32 GB of quota buys four
        copies of a model that would fit forty times over, and a <C>LimitRange</C> with a maximum
        refuses the pod outright. The default leaves room for the largest artifact the platform
        accepts (<C>ML_ARTIFACT_MAX_MB</C>, 512 MB) unpickled, and it is a setting under{" "}
        <strong>Admin → Developer runtime</strong> for anyone serving something unusual.
      </Callout>
      <P>
        <strong>When the cluster is full</strong>, a pod stays <C>Pending</C> — which from outside
        looks exactly like an image still pulling. Kubernetes writes the difference into the
        pod&apos;s <C>PodScheduled</C> condition, and the platform repeats it: the deployment
        reports <em>waiting for room in the cluster</em> with the scheduler&apos;s own message,
        instead of ending in &quot;the scorer did not become ready&quot;. It stays <em>starting</em>{" "}
        rather than failing, because a pending pod becomes schedulable the moment a node arrives —
        which is precisely what a cluster autoscaler does when it sees one.
      </P>

      <NextPrev current="/docs/ml/serving" />
    </>
  );
}
