import { createFileRoute } from "@tanstack/react-router";
import { C, DocLink, DocsHeader, H2, NextPrev, P, Table, UL } from "@/components/docs/DocsShell";

export const Route = createFileRoute("/docs/ml_/operations")({
  head: () => ({
    meta: [
      { title: "ML Models · Operations — AgentSwarms Documentation" },
      {
        name: "description",
        content:
          "Sharing and governance, the configurable limits, day-to-day operations, and what to do when something reads wrong.",
      },
      { property: "og:title", content: "ML Models · Operations — AgentSwarms Documentation" },
      { property: "og:description", content: "Sharing, limits, operations, troubleshooting." },
      { property: "og:url", content: "https://agentswarms.fyi/docs/ml/operations" },
      { property: "og:type", content: "article" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/docs/ml/operations" }],
  }),
  component: MlOperationsPage,
});

function MlOperationsPage() {
  return (
    <>
      <DocsHeader
        eyebrow="Data & analytics"
        title="ML Models · Operations"
        description="Sharing and governance, the configurable limits, day-to-day operations, and what to do when something reads wrong."
      />
      <P>
        Part of the <DocLink to="/docs/ml">ML Models</DocLink> guide. This page is for whoever runs
        the registry: sharing, the limits and the settings behind them, day-to-day operations and
        what to do when something reads wrong.
      </P>

      <H2 id="sharing">Sharing and governance</H2>
      <P>
        Share a model from <strong>Admin → IAM → Access</strong> as <strong>ML model</strong>. A
        grantee can predict with it — try-it, batch, and through agents — and read its metrics;
        training, promotion, renaming and deletion stay with the owner. Batch outputs are written to
        a schema the caller owns, never to a shared or mounted one. Creation, renaming, promotion
        and deletion are audited by a database trigger (<C>ml_model.create</C>,{" "}
        <C>ml_model.update</C>, <C>ml_model.delete</C>); training and prediction events are audited
        by the server with the decision id (<C>ml.train.start</C>, <C>ml.train.succeeded</C>,{" "}
        <C>ml.version.promote</C>, <C>ml.predict_query</C>).
      </P>

      <H2 id="limits">Limits</H2>
      <P>
        Every limit resolves settings row → environment variable → default and is edited under{" "}
        <strong>Admin → Developer runtime</strong>; nothing in the code caps them. A large VM or a
        Kubernetes node pool is allowed to use itself.
      </P>
      <Table
        headers={["Setting", "Default", "What it bounds"]}
        rows={[
          [
            <C key="a">ML_TRAIN_MAX_ROWS</C>,
            "2,000,000",
            "Rows one training run reads; larger tables are reservoir-sampled",
          ],
          [<C key="b">ML_TRAIN_TIME_BUDGET_MINUTES</C>, "30", "Default wall-clock budget per run"],
          [<C key="c">ML_TRAIN_MEM_LIMIT_MB</C>, "8192", "Memory ceiling of a training sandbox"],
          [
            <C key="d">ML_MAX_CONCURRENT_TRAININGS_PER_USER</C>,
            "2",
            "Training jobs one user may have live at once",
          ],
          [<C key="e">ML_PREDICT_MAX_ROWS</C>, "5,000,000", "Rows one batch prediction may score"],
          [
            <C key="f">ML_API_RATE_LIMIT_PER_MIN</C>,
            "60",
            "Calls a minute one ML API key may make",
          ],
          [<C key="g">ML_TRAIN_GPUS</C>, "0", "GPUs requested per training sandbox"],
          [
            <C key="h">ML_DRIFT_ALERT_PSI</C>,
            "0.25",
            "PSI above which a prediction run raises a drift alert",
          ],
        ]}
      />

      <H2 id="operations">Operations</H2>
      <UL>
        <li>
          Training and inference need the notebook runtime services:{" "}
          <C>docker compose --profile notebooks up -d</C>. The runtime image bakes scikit-learn,
          LightGBM, statsmodels, DuckDB, pyarrow and s3fs; an older image installs them at job
          start.
        </li>
        <li>
          The sandbox reads Parquet through the egress proxy; its allow-list is brought up to date
          with the lake endpoint automatically before a job starts.
        </li>
        <li>
          <strong>On Kubernetes</strong> training and prediction are batch Jobs in the notebook
          namespace, bounded by its <C>ResourceQuota</C> and <C>LimitRange</C> and scaled by adding
          nodes; the egress ConfigMap must admit the object store. The deployment guide&apos;s{" "}
          <DocLink to="/docs/self-hosting">ML platform on Kubernetes</DocLink> section has the three
          settings that matter.
        </li>
        <li>
          <strong>GPUs:</strong> <C>ML_TRAIN_GPUS</C> (or the Admin setting) requests that many GPUs
          for every training sandbox — a Docker device request on a single host, an{" "}
          <C>nvidia.com/gpu</C> limit on Kubernetes. The baked runtime image is CPU-only; point{" "}
          <C>NOTEBOOK_RUNTIME_IMAGE</C> at a CUDA-capable build when you need one.
        </li>
        <li>
          Artifacts live under <C>ml-artifacts/</C> in the lake bucket. <C>npm run backup</C>{" "}
          mirrors the lake data path; add the artifacts prefix to your object-store backup as well.
        </li>
      </UL>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "Cannot reach the Docker socket-proxy",
            'Read the rest of the message: "start the runtime services" means the proxy is down (docker compose --profile notebooks up -d); "did not answer" means the Docker daemon is busy or the proxy wedged — retry, then restart notebook-docker-proxy.',
          ],
          [
            "egress proxy refused the lake endpoint (HTTP 403)",
            "The allow-list is re-applied at job start; if it persists, save the runtime settings under Admin → Developer runtime and check the egress config mount is writable.",
          ],
          [
            "You already have a model called …",
            "Names are unique per user; the wizard defaults to <table> · <target>.",
          ],
          [
            "A target is greyed out",
            "Identifiers, free text and constant columns cannot be predicted; pick another column or prepare the data.",
          ],
          [
            "Every candidate failed",
            "Open the job's logs on the Jobs tab; the first candidate's error is quoted.",
          ],
          [
            "Possible leakage: … on its own predicts …",
            "A feature is the target in disguise or a key the model memorised. Drop it from the features and train a new version; the score will fall to something real.",
          ],
          [
            "Every group is one customer / every anomaly a date",
            "A many-valued category or a time column was selected explicitly and decided the distance. Let the trainer choose the features, or leave that column out.",
          ],
          [
            "Projected values below 0 were floored at 0",
            "The winning method extrapolated a decline past zero; the floor is the honest answer for a total. A longer history or a coarser period usually steadies the trend.",
          ],
        ]}
      />

      <NextPrev current="/docs/ml/operations" />
    </>
  );
}
