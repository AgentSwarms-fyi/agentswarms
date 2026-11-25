// MLflow import and export on a model's Versions tab (R533).
//
// Export downloads one version as the folder MLflow loads, zipped. Import
// sends a zipped MLflow model to become the next version: the app checks the
// MLmodel file and starts a job that opens the model in a sandbox, so the
// version appears on the Jobs tab like a training run and is ready when the
// job is.
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, Server, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { reportFailure } from "@/lib/silentFailureNet";
import { MlflowServerImportDialog } from "@/components/ml/MlflowServerImport";

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `The server answered ${res.status}`;
}

/** The strip above the versions table: what MLflow does here, and Import. */
export function MlflowImport({
  token,
  modelId,
  onStarted,
}: {
  token: string;
  modelId: string;
  onStarted: (version: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fromServer, setFromServer] = useState(false);

  async function send(file: File) {
    setBusy(true);
    try {
      const q = new URLSearchParams({ model_id: modelId, file_name: file.name });
      const res = await fetch(`/api/ml/import/mlflow?${q}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/zip" },
        body: file,
      });
      if (!res.ok) {
        toast.error(await errorOf(res));
        return;
      }
      const body = (await res.json()) as { version: number };
      toast.success(`Importing it as v${body.version}. It is ready when its job finishes.`);
      onStarted(body.version);
    } catch (e) {
      reportFailure("import the MLflow model", e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">MLflow.</span> Export a ready version as an
        MLflow model, to load anywhere MLflow models load. Or import one, a scikit-learn model
        logged with MLflow or a model exported from here, as the next version: a zip, or straight
        from a registered model on your MLflow server.
      </p>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setFromServer(true)}>
          <Server className="mr-1 h-3.5 w-3.5" />
          From an MLflow server
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="mr-1 h-3.5 w-3.5" />
          )}
          Import MLflow model
        </Button>
      </div>
      <MlflowServerImportDialog
        open={fromServer}
        onOpenChange={setFromServer}
        token={token}
        modelId={modelId}
        onStarted={onStarted}
      />
    </div>
  );
}

/** A version's MLflow export, as an icon button in its Actions cell. */
export function MlflowExportButton({
  token,
  modelId,
  versionId,
  version,
}: {
  token: string;
  modelId: string;
  versionId: string;
  version: number;
}) {
  const [busy, setBusy] = useState(false);
  const label = `Export v${version} as an MLflow model`;

  async function download() {
    setBusy(true);
    try {
      const res = await fetch("/api/ml/export/mlflow", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: modelId, version_id: versionId }),
      });
      if (!res.ok) {
        toast.error(await errorOf(res));
        return;
      }
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ??
        `model-v${version}-mlflow.zip`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      reportFailure("export the MLflow model", e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-1 h-8 w-8 p-0"
      disabled={busy}
      aria-label={label}
      title={label}
      onClick={() => void download()}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
