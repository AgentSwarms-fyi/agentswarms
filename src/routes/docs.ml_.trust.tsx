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

export const Route = createFileRoute("/docs/ml_/trust")({
  head: () => ({
    meta: [
      { title: "ML Models · Trust — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Whether a model can be believed today: drift, per-row explanations and reason codes, accuracy against outcomes that arrived later, calibration, the decision threshold, and how groups are treated.",
      },
      { property: "og:title", content: "ML Models · Trust — AgentSwarms Documentation" },
      {
        property: "og:description",
        content: "Drift, explanations, accuracy over time, calibration, thresholds, fairness.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml/trust" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml/trust" }],
  }),
  component: MlTrustPage,
});

function MlTrustPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models · Trust"
        description="Whether a model can be believed today: drift, per-row explanations and reason codes, accuracy against outcomes that arrived later, calibration, the decision threshold, and how groups are treated."
      />
      <P>
        Part of the <DocLink to="/docs/ml">ML Models</DocLink> guide. This page is the evidence for
        believing a model today: drift, per-row explanations, accuracy against outcomes that arrived
        later, calibration, the decision threshold and how groups are treated.
      </P>

      <H2 id="drift">Drift</H2>
      <P>
        Training records the distribution of every feature — decile bins for numbers, the top
        categories for categoricals. Every batch prediction (and any direct prediction of ten rows
        or more) bins the new rows the same way and reports a{" "}
        <strong>population stability index</strong> per feature; the run&apos;s{" "}
        <strong>Drift</strong> badge shows the highest one: below 0.1 stable, 0.1–0.25 moderate,
        above 0.25 the population has moved. A run above <C>ML_DRIFT_ALERT_PSI</C> (0.25 by default)
        is audited as <C>ml.drift.alert</C> and notifies the model&apos;s owner with the three most
        drifted features — the cue to retrain, or to schedule retraining. The public API returns the
        same numbers in <C>/api/ml/predict/status</C>.
      </P>

      <H2 id="explain">Why this row got this answer</H2>
      <P>
        The model page shows what a model relies on <em>overall</em> — permutation importance over
        the raw input columns, measured once when the version trained. That answers &ldquo;what does
        this model key on&rdquo;. It does not answer &ldquo;why was this customer declined&rdquo;,
        which is the question a person asks when the answer is about them, and in credit, insurance
        or hiring it is one you may be obliged to answer.
      </P>
      <P>
        Tick <strong>Explain this answer</strong> under <strong>Try it</strong> on the Predictions
        tab. Each feature comes back with how far the answer moved when its value was replaced with
        the one a typical training row carried: bars to the right pushed the answer up, bars to the
        left pushed it down, in probability for a classification and in the target&apos;s own units
        for a regression.
      </P>
      <Callout kind="why" title="This is an ablation, and it is not SHAP">
        Nothing in the product calls it that, because a Shapley value has properties this does not:
        these contributions are not additive and they do not sum to the prediction. What they are is
        the <strong>local twin of the permutation importance</strong> already shown for the whole
        model — that shuffles a column across every row, this replaces one cell in one row — which
        is why the two can be read side by side and mean compatible things. The typical row comes
        from the same feature distribution drift already records inside the artifact: the middle
        quantile for a number, the commonest value for a category.
      </Callout>
      <P>
        It works on <strong>any</strong> model, including one registered from a notebook, because it
        only ever calls <C>predict</C>. The one case it declines is a classifier with no{" "}
        <C>predict_proba</C>: without probabilities the only measurable move is that the label
        flipped, which is a yes/no rather than a contribution, so it returns nothing rather than
        dressing a coin flip as a number.
      </P>
      <P>
        It costs one extra prediction per feature per row, so it is opt-in and bounded —{" "}
        <C>ML_EXPLAIN_MAX_ROWS</C> rows per request, <C>ML_EXPLAIN_TOP_K</C> features back for each
        — and an explained call{" "}
        <strong>takes the sandbox path even when a warm endpoint is up</strong>, because the
        endpoint&apos;s serving program would need its own copy of the ablation and a second
        implementation of &ldquo;what moved this answer&rdquo; is a second definition of it. An
        explanation that fails never costs you the prediction: the answer comes back with a warning
        attached.
      </P>

      <H3 id="reason-codes">Reason codes on every scored row</H3>
      <P>
        The explanation above answers for one row you are looking at. A batch answers for all of
        them: tick <strong>Write reason codes beside every row</strong> on the batch prediction
        dialog and the scored table gains the drivers as columns.
      </P>
      <Table
        headers={["Column", "What it holds"]}
        rows={[
          [
            <C key="r">reason_1 … reason_3</C>,
            "The features that moved this row's answer most, strongest first.",
          ],
          [<C key="e">reason_1_effect … reason_3_effect</C>, "How far each moved it, signed."],
        ]}
      />
      <P>
        Flat columns rather than a JSON blob, because the point is that{" "}
        <C>WHERE reason_1 = &apos;support_tickets&apos;</C> works in plain SQL and a dashboard can
        group by it. The value that drove the answer is not repeated — it is already in the row, in
        the column the reason names. A row with fewer features that moved anything than there are
        slots gets nulls, not blanks.
      </P>
      <Callout kind="info" title="The same measurement, not a cheaper twin">
        Reason codes are the same ablation against the same typical row as the single-row
        explanation, run over every row instead of one. That is the expensive choice and it is
        deliberate: an approximation used only for batches would be a second answer to the same
        question wearing the same name, free to disagree with what the row&apos;s own page shows. A
        reason code that contradicts the explanation is worse than no reason code.
      </Callout>
      <P>
        They cost one extra prediction per feature per row, so a hundred thousand rows with twenty
        features is two million predictions. The work is chunked so memory stays flat however large
        the batch is, but the time does not. A batch above <C>ML_EXPLAIN_BATCH_MAX_ROWS</C> (50,000)
        is therefore <strong>refused before the sandbox starts</strong> — the row count is already
        known from the check that enforces the prediction limit, so the answer names the real number
        and the way out.
      </P>
      <P>
        Refused rather than truncated, on purpose: a scored table where the first fifty thousand
        rows carry reasons and the rest are null looks complete and is not, and nothing downstream
        would know. Narrow the rows with a filter, score without reason codes, or raise the ceiling.{" "}
        <C>ML_EXPLAIN_BATCH_TOP_K</C> (3) sets how many are written, and each one costs two columns.
      </P>

      <H2 id="ground-truth">Was it right?</H2>
      <P>
        Drift and this are different questions, and treating the first as an answer to the second is
        the most common way a model quietly stops working. Drift says the rows arriving now do not{" "}
        <em>look like</em> the rows the model trained on. Inputs can shift while accuracy holds, and
        inputs can sit perfectly still while the world changes underneath the label. The only way to
        know whether a model is still right is to wait for the real answer and compare.
      </P>
      <P>
        So a model may name an <strong>outcome source</strong> — the table where the real answers
        land, and the key that lets a scored row find its own. Set it on the model page under{" "}
        <strong>Accuracy</strong>: a schema and table, one to eight key columns present in both that
        table and the scored one, and the column holding what actually happened. Rows where that
        column is still null are skipped.
      </P>
      <P>
        An evaluation joins one prediction run&apos;s output table to it and recomputes{" "}
        <strong>the model&apos;s own primary metric</strong> — <C>f1_macro</C> for a classification,{" "}
        <C>rmse</C> for a regression or forecast — on the rows that have an answer, then compares it
        to the same metric on the validation split when that version trained. A run more than{" "}
        <C>ML_DECAY_ALERT_RATIO</C> worse (0.10, ten per cent) is audited as <C>ml.decay.alert</C>{" "}
        and notifies the owner. A ratio rather than a metric value, so it reads the same way for a
        metric that should rise and one that should fall.
      </P>
      <P>
        It runs on the platform clock: answers arrive over hours or weeks, so each successful batch
        run is re-measured once a day while it is less than a month old (
        <C>ML_EVALUATIONS_PER_SWEEP</C> bounds one pass). <strong>Measure now</strong> does one
        immediately.
      </P>
      <Callout kind="why" title="Three things it deliberately does not do">
        <strong>A missing answer is not a wrong one.</strong> The join is an INNER join — counting a
        prediction whose outcome has not arrived as a mistake would make every model look worse the
        fresher its predictions are. <strong>A metric never appears without its coverage</strong>:
        every evaluation carries how many rows it matched out of how many were scored, because an f1
        of 0.9 over 6% of the rows belongs to whoever answered first, and they are rarely a random
        sample — and a join matching nothing is an error naming the key columns to check, not a
        score of zero. <strong>An improvement is not celebrated</strong>: a model scoring markedly
        better than its own validation score is usually the outcome column leaking into the
        features, so that verdict reads &ldquo;Better than training&rdquo; in a neutral badge.
      </Callout>
      <P>
        The metric is recomputed exactly as scikit-learn computes it, because the baseline came out
        of that same call at training time — two defensible definitions of one metric would fire a
        decay alert the first time every model was measured, which teaches everyone to ignore decay
        alerts. Evaluating costs no sandbox: a confusion matrix and five sums are a <C>GROUP BY</C>,
        so one statement runs through the governed lakehouse chokepoint as the model&apos;s owner
        and the arithmetic happens in the app.
      </P>

      <H2 id="calibration">Is 0.8 really 80%?</H2>
      <P>
        Every classification carries a probability, and this interface has always printed it beside
        the word <strong>confidence</strong>. For a tree ensemble that number is usually a{" "}
        <em>rank</em> rather than a frequency: a forest that votes 9 trees to 1 reports 0.9 whatever
        the real rate turns out to be. Good enough for sorting a queue, wrong for a rule that says
        &ldquo;auto-approve above 80%&rdquo;.
      </P>
      <P>
        So the trainer measures it, and the model page shows the measurement under{" "}
        <strong>Accuracy → Confidence and the decision line</strong>.
      </P>
      <H3 id="reliability">The reliability curve</H3>
      <P>
        Holdout rows are binned by what the model said, and each bin reports what actually happened.
        A point on the diagonal means the model&apos;s 70% really was 70%; above it the model is
        under-selling itself, below it over-selling. Bins are drawn in proportion to how many rows
        they hold, because four rows landing far off the line is noise and four hundred is a
        problem.
      </P>
      <Table
        headers={["Figure", "What it means"]}
        rows={[
          [
            <strong key="e">Calibration error</strong>,
            "The average gap between what was said and what happened. 0.04 is “typically within four points”.",
          ],
          [
            <strong key="b">Brier score</strong>,
            "Mean squared error of the probabilities themselves. Lower is better; it moves when a model is confidently wrong, which accuracy never sees.",
          ],
        ]}
      />
      <P>
        The page bands the calibration error rather than leaving a bare decimal: at or under 0.05 it
        is safe to write a rule against, under 0.15 it is fine for ranking and loose for a rule, and
        above that the numbers should be read as ranks.
      </P>
      <H3 id="calibration-trainer">What the trainer does about it</H3>
      <P>
        After the algorithm search picks a winner and <strong>before</strong> any metric is
        recorded, classification models get a calibration pass — <C>CalibratedClassifierCV</C>,
        isotonic regression on 1000 training rows or more and Platt scaling below that, since
        isotonic needs data to fit its step function and overfits badly without it.
      </P>
      <Callout kind="info" title="It is checked, and discarded if it did not help">
        The calibrated model is scored on the same holdout and kept only when <strong>both</strong>{" "}
        the Brier score and the calibration error improve. Requiring both is not belt and braces:
        Brier is calibration and sharpness added together, so a model can win on Brier by growing
        more confident while drifting further from the truth. A 90-row probe did exactly that —
        Brier 0.1701 → 0.1572 while the calibration error went 0.1917 → 0.2220 — and on the Brier
        test alone it would have shipped.
      </Callout>
      <P>
        When the pass is discarded the run log says so and the page says <em>left uncalibrated</em>.
        That is not a failure: a model already well calibrated lands there, and so does one whose
        holdout was too small to fit a reliable mapping. Because metrics are recorded after this
        step, every number on the version describes the model that was actually saved. Versions
        trained before this shipped have no curve and read as <em>not measured</em>, which is the
        truth — retrain to get one.
      </P>

      <H2 id="threshold">Where the line is drawn</H2>
      <P>
        A classifier decides by <C>argmax</C>, which is a threshold of 0.5 that nobody chose. It is
        the right default and the wrong one for most real decisions: declining a good customer and
        missing a fraudulent order do not cost the same, and the person who knows the ratio is the
        operator, not the trainer.
      </P>
      <P>
        So the trainer <strong>measures every operating point</strong> and the model page lets you
        pick one. For a two-class model the holdout is scored at thresholds from 0.05 to 0.95 in
        steps of 0.05, and every row of the table is a real measurement:
      </P>
      <Table
        headers={["Column", "What it is"]}
        rows={[
          ["Line at", "The probability at or above which the model acts."],
          ["Rows acted on", "How many holdout rows it would have acted on."],
          ["Right when it acts", "Precision at that line."],
          ["Caught", "Recall at that line."],
        ]}
      />
      <P>
        The sweep is always expressed from one side — the second class, named on the page — and that
        loses nothing: with two classes the probabilities sum to one, so a line at 0.70 on{" "}
        <C>retained</C> is the same rule as a line at 0.30 on <C>churned</C>. Every operating point
        either class could have is already in the table, read from one end.
      </P>
      <P>
        The best-F1 row is marked <strong>balanced</strong> and offered as a starting position, not
        a recommendation — F1 weights the two mistakes equally, which is the exact assumption this
        screen exists to let you reject. Choosing a row shows what would change against the line
        currently in use, and saving it asks first. The picker only offers thresholds the trainer
        actually measured: interpolating to 0.437 would present a number the platform never checked
        with the same authority as one it did.
      </P>
      <H3 id="threshold-setting">A setting, not a retrain</H3>
      <P>
        The threshold lives on the <strong>version</strong>, not inside the artifact. Prediction
        reads it at run time, so moving the line takes effect on the next prediction and the model
        is untouched. Every change is audited as <C>ml.threshold.set</C> with the value, because
        &ldquo;who decided to approve 12% more applications, and when&rdquo; is a question that gets
        asked.
      </P>
      <UL>
        <li>
          <strong>The probability shown is the probability of the answer given.</strong> A row
          declined at 0.45 reports 0.55 against the class it was actually assigned, not 0.55
          confidence in a decision nobody made.
        </li>
        <li>
          <strong>Scored tables record the line that produced them.</strong> A batch run with a
          threshold set writes <C>threshold_applied</C> on every row, so six months later &ldquo;why
          was this one declined&rdquo; is answerable from the row rather than from whatever the
          setting happens to be by then.
        </li>
      </UL>
      <H3 id="threshold-retrain">A retrain does not carry the line forward</H3>
      <P>
        Because the threshold lives on the version, a new version arrives without one and decides by{" "}
        <C>argmax</C> again. That is deliberate: a line only means the same thing across two
        versions whose probabilities mean the same thing, and copying it forward silently would be
        the platform making a business decision on your behalf.
      </P>
      <P>
        It is also the sort of change nobody notices until approval volume shifts, so it is not left
        silent either. When the production version has no line and an earlier version of the same
        model did, the panel says so — naming the version and the value, with a button to draw it
        there again. Scheduled retraining with <strong>promote when better</strong> is exactly the
        case this is for.
      </P>
      <P>
        Multiclass models get no threshold and no sweep: there is no single line to draw, so each
        prediction is simply whichever class scores highest. Regression and forecasting have none
        either.
      </P>

      <H2 id="fairness">How groups are treated</H2>
      <P>
        Two questions, and each hides the other. <strong>Selection rate</strong> asks how often each
        group gets the favourable answer — it needs no outcomes at all, so it can be checked the
        moment a batch runs, and it is the one employment and lending law is written about.{" "}
        <strong>Error rates</strong> ask whether the model is <em>wrong</em> more often for one
        group, which needs the real answers and so rides on the same join an evaluation makes. A
        model can have near-identical selection rates and still be far worse at one group, which is
        why both are reported.
      </P>
      <P>
        Set it on the model page under <strong>Accuracy → How groups are treated</strong>: up to
        eight columns present in the scored table, and the predicted label that counts as the good
        outcome. Each column is compared separately and recorded as its own check — two columns are
        two comparisons, and averaging them would hide the one that matters.
      </P>
      <Callout kind="why" title="The lines it will not cross">
        <strong>The favourable answer is named by you, never inferred</strong> — which label is the
        good one is a fact about the world, and a guess would end up in a compliance report.{" "}
        <strong>The verdict is &ldquo;worth a review&rdquo;, never &ldquo;unfair&rdquo;</strong>:
        nothing computable decides whether a model is fair, so what a ratio can say is that groups
        came out far enough apart to deserve attention. <strong>Four fifths is a default</strong> (
        <C>ML_FAIRNESS_MIN_RATIO</C>) taken from the US EEOC&apos;s Uniform Guidelines — a rule of
        thumb with no statistical claim behind it, not the standard everywhere.{" "}
        <strong>A group too small to judge is still shown</strong>: under 30 rows it is greyed and
        excluded from the verdict, because a rate over five people swings 20% when one changes — but
        hiding it is how a real problem stays invisible for a quarter. A value nobody recorded
        becomes its own group.
      </Callout>

      <H3 id="fairness-agent">Where the agent layer helps, and where it does not</H3>
      <P>
        This is the first place in the platform where a language model touches a number somebody may
        have to defend, so the boundary is explicit and tested:{" "}
        <strong>
          the platform measures, the model proposes and narrates, and a number never comes from the
          language model.
        </strong>
      </P>
      <P>
        <strong>Suggest columns</strong> asks the assistant to nominate what to compare by — both
        directly sensitive attributes and <em>proxies</em>, the columns that are not themselves
        sensitive but stand in for one: a postcode for ethnicity, a first name for gender, a school
        for class. Proxies are the valuable half, because they are what careful people miss. Each
        suggestion comes with a reason you can disagree with, and you tick what applies; nothing is
        enabled by the suggestion itself, because which attributes are protected is a legal question
        about your context rather than one this platform can answer.
      </P>
      <P>
        <strong>Only column names, types and cardinalities are sent.</strong> Never values — a
        column of ethnicities is sensitive data, and posting a sample of it to an inference endpoint
        to ask whether it is sensitive would answer its own question. The suggestion path never
        queries the lake at all, and a test enforces that. Any column the assistant names that is
        not in the schema is dropped rather than shown.
      </P>
      <P>
        <strong>Explain this in words</strong> passes the already computed figures to the assistant
        and asks for two or three sentences. The prompt forbids it from computing, estimating,
        rounding differently or introducing any figure it was not given, and the narration is stored{" "}
        <em>beside</em> the numbers rather than instead of them — so one that drifts is visibly
        contradicted by the table above it.
      </P>
      <P>
        Both calls go through the same governed door as every other model call, so IAM model rules,
        budgets and audit apply; they are recorded as <C>ml.fairness.suggest</C> and{" "}
        <C>ml.fairness.narrate</C>, and the assistant model is <C>ML_ASSIST_MODEL</C>. A check is
        audited as <C>ml.fairness.check</C>, or <C>ml.fairness.review</C> when the ratio falls below
        the line, which also notifies the model&apos;s owner.
      </P>

      <NextPrev current="/docs/ml/trust" />
    </>
  );
}
