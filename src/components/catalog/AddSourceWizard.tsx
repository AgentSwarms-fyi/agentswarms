// "Add data source" wizard for the Data Catalog.
// Three steps: pick the source type → configure & connect → crawl.
// Warehouse sources reuse connections registered under /integrations;
// object storage covers any S3-compatible bucket (AWS S3, Cloudflare R2,
// MinIO, DigitalOcean Spaces, Backblaze B2, custom endpoints). The
// connection is tested server-side before anything is stored, and the
// first crawl runs inside the wizard so the user leaves with a populated
// catalog or a clear error.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Cloud,
  Database,
  HardDrive,
  Loader2,
  Radar,
  Server,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { catalogCreateSource, catalogCrawlSource } from "@/utils/catalog.functions";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import { WAREHOUSE_LABELS, type WarehouseConnectionSummary } from "@/utils/warehouse/types";

type StorageProvider = "aws" | "gcs" | "r2" | "minio" | "spaces" | "b2" | "custom";

const STORAGE_PRESETS: Record<
  StorageProvider,
  { label: string; endpoint: string; endpointHint?: string; region: string; pathStyle: boolean }
> = {
  aws: { label: "Amazon S3", endpoint: "", region: "us-east-1", pathStyle: false },
  gcs: {
    // GCS's XML interoperability API speaks S3 SigV4 with HMAC keys
    // (Cloud Storage → Settings → Interoperability).
    label: "Google Cloud Storage",
    endpoint: "https://storage.googleapis.com",
    region: "auto",
    pathStyle: true,
  },
  r2: {
    label: "Cloudflare R2",
    endpoint: "",
    endpointHint: "https://<account-id>.r2.cloudflarestorage.com",
    region: "auto",
    pathStyle: true,
  },
  minio: {
    label: "MinIO",
    endpoint: "",
    endpointHint: "https://minio.example.com:9000",
    region: "us-east-1",
    pathStyle: true,
  },
  spaces: {
    label: "DigitalOcean Spaces",
    endpoint: "",
    endpointHint: "https://nyc3.digitaloceanspaces.com",
    region: "us-east-1",
    pathStyle: true,
  },
  b2: {
    label: "Backblaze B2",
    endpoint: "",
    endpointHint: "https://s3.us-west-004.backblazeb2.com",
    region: "us-west-004",
    pathStyle: true,
  },
  custom: {
    label: "Custom S3-compatible",
    endpoint: "",
    endpointHint: "https://storage.example.com",
    region: "us-east-1",
    pathStyle: true,
  },
};

type CrawlResult = { assets: number; columns: number; sampled: number; duration_ms: number };

export function AddSourceWizard({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after a successful create+crawl so the catalog refreshes. */
  onDone: () => void;
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const createFn = useServerFn(catalogCreateSource);
  const crawlFn = useServerFn(catalogCrawlSource);
  const listWhFn = useServerFn(listWarehouseConnections);

  const [step, setStep] = useState<"type" | "configure" | "crawl">("type");
  const [kind, setKind] = useState<"warehouse" | "object_storage" | "iceberg_rest">("warehouse");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "crawling" | "done">("idle");
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [crawlError, setCrawlError] = useState<string | null>(null);

  // Warehouse config
  const [connections, setConnections] = useState<WarehouseConnectionSummary[] | null>(null);
  const [connectionId, setConnectionId] = useState("");

  // Object storage config
  const [provider, setProvider] = useState<StorageProvider>("aws");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [pathStyle, setPathStyle] = useState(false);

  // Iceberg REST catalog config
  const [icebergUri, setIcebergUri] = useState("");
  const [icebergWarehouse, setIcebergWarehouse] = useState("");
  const [icebergToken, setIcebergToken] = useState("");

  useEffect(() => {
    if (!open) return;
    setStep("type");
    setPhase("idle");
    setResult(null);
    setCrawlError(null);
    setName("");
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || !token || connections !== null) return;
    listWhFn({ data: { access_token: token } }).then((res) => {
      if (res.ok) setConnections(res.connections.filter((c) => c.is_active));
      else setConnections([]);
    });
  }, [open, token, connections, listWhFn]);

  function pickProvider(p: StorageProvider) {
    const preset = STORAGE_PRESETS[p];
    setProvider(p);
    setRegion(preset.region);
    setPathStyle(preset.pathStyle);
    setEndpoint(preset.endpoint); // fixed for GCS, empty prompt otherwise
  }

  const configValid =
    name.trim().length > 0 &&
    (kind === "warehouse"
      ? connectionId !== ""
      : kind === "iceberg_rest"
        ? /^https?:\/\//.test(icebergUri.trim())
        : bucket.trim() !== "" &&
          region.trim() !== "" &&
          accessKey.trim() !== "" &&
          secretKey !== "" &&
          (provider === "aws" || endpoint.trim() !== ""));

  async function connectAndCrawl() {
    setBusy(true);
    setPhase("connecting");
    try {
      const created = await createFn({
        data: {
          access_token: token,
          name: name.trim(),
          kind,
          connection_id: kind === "warehouse" ? connectionId : undefined,
          storage:
            kind === "object_storage"
              ? {
                  provider,
                  endpoint: endpoint.trim() || undefined,
                  region: region.trim(),
                  bucket: bucket.trim(),
                  prefix: prefix.trim() || undefined,
                  path_style: pathStyle,
                  access_key_id: accessKey.trim(),
                  secret_access_key: secretKey,
                }
              : undefined,
          iceberg:
            kind === "iceberg_rest"
              ? {
                  uri: icebergUri.trim(),
                  warehouse: icebergWarehouse.trim() || undefined,
                  token: icebergToken.trim() || undefined,
                }
              : undefined,
        },
      });
      if (!created.ok) throw new Error(created.error);
      setPhase("crawling");
      const crawled = await crawlFn({
        data: { access_token: token, source_id: created.source_id },
      });
      if (!crawled.ok) {
        // The source exists — surface the crawl error but let them finish;
        // they can fix the issue and hit Re-crawl from the sources rail.
        setCrawlError(crawled.error);
        setPhase("done");
        setResult(null);
        onDone();
        return;
      }
      setCrawlError(null);
      setResult(crawled.stats);
      setPhase("done");
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }

  const typeCard = (
    k: "warehouse" | "object_storage" | "iceberg_rest",
    icon: React.ReactNode,
    title: string,
    desc: string,
  ) => (
    <button
      type="button"
      onClick={() => setKind(k)}
      className={`flex flex-1 flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${
        kind === k ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
      }`}
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-xs text-muted-foreground">{desc}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Radar className="h-4 w-4 text-primary" /> Add data source
          </DialogTitle>
          <DialogDescription className="text-xs">
            {step === "type" &&
              "Pick what you want to catalog. Local tables are cataloged automatically."}
            {step === "configure" &&
              "Connection details are encrypted server-side and never sent back."}
            {step === "crawl" &&
              "The crawler lists every table or object, infers schemas and flags likely-PII columns."}
          </DialogDescription>
        </DialogHeader>

        {step === "type" && (
          <div className="space-y-3">
            <div className="flex flex-col gap-2.5">
              {typeCard(
                "warehouse",
                <Server className="h-4 w-4" />,
                "Warehouse / database",
                "PostgreSQL, MySQL, Snowflake, BigQuery, Redshift, Databricks, Synapse — via a connection from Integrations.",
              )}
              {typeCard(
                "object_storage",
                <Cloud className="h-4 w-4" />,
                "Object storage bucket",
                "Amazon S3 or any S3-compatible store (R2, MinIO, Spaces, B2). CSV/JSON schemas are inferred by sampling.",
              )}
              {typeCard(
                "iceberg_rest",
                <Database className="h-4 w-4" />,
                "Iceberg REST catalog",
                "Apache Iceberg REST catalog (Polaris, Unity, Nessie, Lakekeeper…). Namespaces, tables and schemas — query via Trino/Athena.",
              )}
            </div>
            <div className="flex justify-end">
              <Button size="sm" className="gap-1.5" onClick={() => setStep("configure")}>
                Continue <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {step === "configure" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Source name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "warehouse" ? "Production warehouse" : "Data lake (raw)"}
                className="h-9 text-sm"
              />
            </div>

            {kind === "warehouse" ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Connection</Label>
                <Select value={connectionId} onValueChange={setConnectionId}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue
                      placeholder={
                        connections === null
                          ? "Loading connections…"
                          : connections.length === 0
                            ? "No active connections"
                            : "Pick a connection…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(connections ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-sm">
                        {c.name} · {WAREHOUSE_LABELS[c.provider]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Connections are managed under{" "}
                  <Link
                    to="/integrations"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Integrations → Data Warehouses
                  </Link>
                  .
                </p>
              </div>
            ) : kind === "iceberg_rest" ? (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <Label className="text-xs">Catalog URI</Label>
                  <Input
                    value={icebergUri}
                    onChange={(e) => setIcebergUri(e.target.value)}
                    className="h-9 font-mono text-xs"
                    placeholder="https://catalog.example.com"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    The REST catalog base URL (the crawler calls its <code>/v1</code> endpoints).
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Warehouse (optional)</Label>
                  <Input
                    value={icebergWarehouse}
                    onChange={(e) => setIcebergWarehouse(e.target.value)}
                    className="h-9 text-sm"
                    placeholder="e.g. s3://bucket/warehouse or a catalog name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Bearer token (optional)</Label>
                  <Input
                    type="password"
                    value={icebergToken}
                    onChange={(e) => setIcebergToken(e.target.value)}
                    className="h-9 text-sm"
                    placeholder="OAuth2 / bearer token, if the catalog requires auth"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted server-side. Metadata-only — query the tables via a Trino or
                    Athena connection.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Provider</Label>
                    <Select
                      value={provider}
                      onValueChange={(v) => pickProvider(v as StorageProvider)}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(STORAGE_PRESETS) as StorageProvider[]).map((p) => (
                          <SelectItem key={p} value={p} className="text-sm">
                            {STORAGE_PRESETS[p].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Region</Label>
                    <Input
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                      className="h-9 text-sm"
                      placeholder="us-east-1"
                    />
                  </div>
                </div>
                {provider !== "aws" && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">Endpoint URL</Label>
                    <Input
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      className="h-9 font-mono text-xs"
                      placeholder={STORAGE_PRESETS[provider].endpointHint}
                    />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Bucket</Label>
                    <Input
                      value={bucket}
                      onChange={(e) => {
                        setBucket(e.target.value);
                        if (!name.trim()) setName(e.target.value);
                      }}
                      className="h-9 text-sm"
                      placeholder="my-data-lake"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Prefix (optional)</Label>
                    <Input
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      className="h-9 text-sm"
                      placeholder="raw/sales/"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Access key ID</Label>
                    <Input
                      value={accessKey}
                      onChange={(e) => setAccessKey(e.target.value)}
                      className="h-9 font-mono text-xs"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Secret access key</Label>
                    <Input
                      type="password"
                      value={secretKey}
                      onChange={(e) => setSecretKey(e.target.value)}
                      className="h-9 font-mono text-xs"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={pathStyle} onCheckedChange={(v) => setPathStyle(v === true)} />
                  Path-style addressing (endpoint/bucket/key — required by MinIO, default for custom
                  endpoints)
                </label>
                <p className="text-[11px] text-muted-foreground">
                  Tip: fields accept{" "}
                  <code className="rounded bg-muted px-1">{"{{secret:NAME}}"}</code> references from
                  the Secrets Manager.
                </p>
              </>
            )}

            <div className="flex justify-between">
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setStep("type")}>
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={!configValid}
                onClick={() => setStep("crawl")}
              >
                Continue <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}

        {step === "crawl" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
              <p className="flex items-center gap-2 font-medium">
                {kind === "warehouse" ? (
                  <Database className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <HardDrive className="h-3.5 w-3.5 text-primary" />
                )}
                {name}
              </p>
              <p className="mt-1 text-muted-foreground">
                {kind === "warehouse"
                  ? `${connections?.find((c) => c.id === connectionId)?.name ?? "Connection"} — every schema and table will be cataloged with column types and row estimates.`
                  : `s3://${bucket}/${prefix} — objects are listed (up to 2,000), partitioned folders are grouped into datasets, and CSV/JSON files are sampled to infer columns.`}
              </p>
            </div>

            {phase === "done" ? (
              <div className="space-y-3">
                {crawlError ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                      <Check className="h-4 w-4" /> Source saved — but the first crawl failed
                    </div>
                    <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]">
                      {crawlError}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Fix the issue, then use Re-crawl on the source in the Catalog.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-4 w-4" /> Source connected
                      {result ? ` — ${result.assets} assets cataloged` : ""}
                    </div>
                    {result && (
                      <p className="text-xs text-muted-foreground">
                        {result.columns.toLocaleString()} columns
                        {result.sampled > 0 ? ` · ${result.sampled} files sampled` : ""} ·{" "}
                        {(result.duration_ms / 1000).toFixed(1)}s
                      </p>
                    )}
                  </>
                )}
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => setStep("configure")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </Button>
                <Button size="sm" className="gap-1.5" disabled={busy} onClick={connectAndCrawl}>
                  {busy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {phase === "connecting" ? "Testing connection…" : "Crawling…"}
                    </>
                  ) : (
                    <>
                      <Radar className="h-3.5 w-3.5" /> Connect & crawl
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
