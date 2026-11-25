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
          [<C key="g">ML_TRAIN_GPUS</C>, "0", "GPUs a training sandbox that runs XGBoost asks for"],
          [
            <C key="h">ML_DRIFT_ALERT_PSI</C>,
            "0.25",
            "PSI above which a prediction run raises a drift alert",
          ],
        ]}
      />

      <H2 id="ml-operations">ML operations</H2>
      <P>
        <strong>Data science → ML operations</strong> is the view across every model you can see, in
        four parts. Each row opens the model on the tab that holds its detail.
      </P>
      <UL>
        <li>
          <strong>Needs a look</strong> comes first:
          <UL>
            <li>
              training and batch predictions that failed in the last seven days, each with its
              reason;
            </li>
            <li>endpoints that are failing, behind production or rolled back;</li>
            <li>schedules whose last run failed;</li>
            <li>production versions whose inputs drifted or whose accuracy fell.</li>
          </UL>
        </li>
        <li>
          <strong>Running now</strong> lists the training, imports and batch predictions in
          progress. A job waiting for room says so, such as a GPU job waiting for a node.
        </li>
        <li>
          <strong>Coming up</strong> lists the scheduled retraining and batch predictions.
        </li>
        <li>
          <strong>Recently finished</strong> lists the last runs, with how long each took.
        </li>
      </UL>

      <H2 id="operations">Operations</H2>
      <UL>
        <li>
          Training and inference need the notebook runtime services: <C>docker compose up -d</C>.
          The runtime image bakes scikit-learn, LightGBM, XGBoost, statsmodels, DuckDB, pyarrow and
          s3fs; an older image installs them at job start.
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
          <strong>GPUs:</strong> with <C>ML_TRAIN_GPUS</C> (Admin → Developer runtime → Training
          GPUs) above 0, a classification or regression search adds XGBoost and trains it on the
          GPU. Only the sandbox that runs XGBoost asks for one: imports, forecasts, the other
          candidates and predictions never do. The model is saved to answer on a CPU, so serving
          needs no GPU.
        </li>
        <li>
          The sandbox checks what it was given before reading a row: what <C>nvidia-smi</C> lists,
          then a tiny fit on the GPU, since XGBoost falls back to the CPU with only a warning. The
          log names the GPU; the leaderboard marks the XGBoost row GPU or CPU; the Lineage card says
          which candidate trained on it. When the GPU cannot be used, training still runs on the CPU
          and the version says why.
        </li>
        <li>
          Docker needs the NVIDIA driver and the NVIDIA Container Toolkit on the host. Kubernetes
          needs a GPU node pool with the NVIDIA device plugin, named by{" "}
          <C>NOTEBOOK_K8S_GPU_NODE_SELECTOR</C> and <C>NOTEBOOK_K8S_GPU_TOLERATIONS</C>; a pod
          waiting for a GPU node says so in the job&apos;s log. On EKS the Terraform root makes the
          pool, scaling from zero, with <C>gpu_node_max</C>. Fargate has no GPUs.
        </li>
        <li>
          Artifacts live under <C>ml-artifacts/</C> in the lake bucket. <C>npm run backup</C>{" "}
          mirrors the lake data path; add the artifacts prefix to your object-store backup as well.
          An artifact under a customer&apos;s KMS key restores only where the backup&apos;s identity
          may use that key.
        </li>
      </UL>

      <H2 id="troubleshooting">Troubleshooting</H2>
      <Table
        headers={["Symptom", "Cause and fix"]}
        rows={[
          [
            "Cannot reach the Docker socket-proxy",
            'Read the rest of the message: "start the runtime services" means the proxy is down (docker compose up -d); "did not answer" means the Docker daemon is busy or the proxy wedged — retry, then restart notebook-docker-proxy.',
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
