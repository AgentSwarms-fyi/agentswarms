// "Add data source" wizard for the Data Catalog.
// Three steps: pick the source type → configure & connect → crawl.
// Warehouse sources reuse connections registered under /integrations;
// object storage covers any S3-compatible bucket (AWS S3, Cloudflare R2,
// MinIO, DigitalOcean Spaces, Backblaze B2, custom endpoints). The
// connection is tested server-side before anything is stored, and the
// first crawl runs inside the wizard so the user leaves with a populated
// catalog or a clear error.
import { useEffect, useState } from "react";
import { parseMetastoreUri } from "@/lib/hiveMetastoreUri";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  Cloud,
  Database,
  HardDrive,
  Hexagon,
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
import { SecretSelect } from "@/components/secrets/SecretSelect";
import { useAuth } from "@/hooks/use-auth";
import { isAwsRegion } from "@/lib/awsRegion";
import { suggestSecretName } from "@/lib/secretRefs";
import { validatorErrorText } from "@/lib/validatorError";
import { catalogCreateSource, catalogCrawlSource } from "@/utils/catalog.functions";
import { sourceNameProblem } from "@/utils/catalog/sourceName";
import { PRIVATE_PATH_HINT } from "@/utils/catalog/storageNetwork";
import { listWarehouseConnections } from "@/utils/warehouse.functions";
import { WAREHOUSE_LABELS, type WarehouseConnectionSummary } from "@/utils/warehouse/types";

type StorageProvider = "aws" | "gcs" | "r2" | "minio" | "spaces" | "b2" | "custom" | "azure";

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
  azure: {
    // Not S3. The endpoint is derived from the account name unless overridden
    // (Azurite, sovereign clouds); region is meaningless and kept only so the
    // shared form validates.
    label: "Azure Blob Storage / ADLS Gen2",
    endpoint: "",
    endpointHint: "https://<account>.blob.core.windows.net (optional)",
    region: "global",
    pathStyle: true,
  },
};

/**
 * The form's labels for the fields catalogCreateSource's validator names by
 * path, so a refusal says which field it means.
 */
function validatorLabels(provider: StorageProvider): Record<string, string> {
  const azure = provider === "azure";
  return {
    name: "Source name",
    "storage.region": "Region",
    "storage.endpoint": "Endpoint URL",
    "storage.bucket": azure ? "Container" : "Bucket",
    "storage.prefix": "Prefix",
    "storage.access_key_id": azure ? "Storage account name" : "Access key ID",
    "storage.secret_access_key": azure ? "Account key or SAS token" : "Secret access key",
    "iceberg.uri": "Catalog URI",
    "iceberg.warehouse": "Warehouse",
    "iceberg.token": "Bearer token",
  };
}

type CrawlResult = {
  assets: number;
  columns: number;
  sampled: number;
  duration_ms: number;
  /** Parts of the catalog the crawl could not read (R369). */
  unread?: number;
  /** A caveat on this crawl, in a sentence. */
  note?: string;
};

type SourceKind = "warehouse" | "object_storage" | "iceberg_rest" | "hive_metastore" | "glue";

/**
 * The origin a bucket's signed requests go to, derived the way
 * objectStore.server.ts (resolveTarget) and azureBlob.server.ts (azureOrigin)
 * derive it, or "" while the form cannot say yet.
 */
function objectStoreDestination(f: {
  provider: StorageProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  pathStyle: boolean;
}): string {
  try {
    const endpoint = f.endpoint.trim();
    if (f.provider === "azure") {
      if (endpoint) return new URL(endpoint).origin;
      const account = f.accessKey.trim();
      return /^[a-z0-9]{3,24}$/.test(account) ? `https://${account}.blob.core.windows.net` : "";
    }
    const bucket = f.bucket.trim();
    if (!bucket) return "";
    if (endpoint) {
      const u = new URL(endpoint);
      return f.pathStyle ? u.origin : `${u.protocol}//${bucket}.${u.host}`;
    }
    if (!f.region.trim()) return "";
    const regionHost = `s3.${f.region.trim()}.amazonaws.com`;
    return f.pathStyle ? `https://${regionHost}` : `https://${bucket}.${regionHost}`;
  } catch {
    return "";
  }
}

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
  const [kind, setKind] = useState<SourceKind>("warehouse");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"idle" | "connecting" | "crawling" | "done">("idle");
  const [result, setResult] = useState<CrawlResult | null>(null);
  const [crawlError, setCrawlError] = useState<string | null>(null);
  // The path the store's requests took when it was tested (R422).
  const [reachedVia, setReachedVia] = useState<string | null>(null);
  // Why the source could not be saved, kept in the dialog (R368): a toast is
  // gone in seconds, and the dialog then showed nothing at all.
  const [connectError, setConnectError] = useState<string | null>(null);

  // Warehouse config
  const [connections, setConnections] = useState<WarehouseConnectionSummary[] | null>(null);
  const [connectionId, setConnectionId] = useState("");

  // Hive Metastore config
  const [hiveUri, setHiveUri] = useState("");
  const [hiveRequirePrivate, setHiveRequirePrivate] = useState(false);

  // AWS Glue config
  const [glueRegion, setGlueRegion] = useState("us-east-1");
  const [glueKey, setGlueKey] = useState("");
  const [glueSecret, setGlueSecret] = useState("");
  const [glueEndpoint, setGlueEndpoint] = useState("");
  const [glueCatalogId, setGlueCatalogId] = useState("");

  // Object storage config
  const [provider, setProvider] = useState<StorageProvider>("aws");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [pathStyle, setPathStyle] = useState(false);
  const [requirePrivate, setRequirePrivate] = useState(false);

  // Iceberg REST catalog config
  const [icebergUri, setIcebergUri] = useState("");
  const [icebergWarehouse, setIcebergWarehouse] = useState("");
  const [icebergToken, setIcebergToken] = useState("");

  // This component outlives the dialog, and so do its fields. A secret left in
  // one would be in memory after the dialog closed and sitting in the next
  // source's form, so secrets go as soon as it closes and the rest on opening.
  useEffect(() => {
    setSecretKey("");
    setGlueSecret("");
    setIcebergToken("");
    if (!open) return;
    setStep("type");
    setKind("warehouse");
    setPhase("idle");
    setResult(null);
    setCrawlError(null);
    setReachedVia(null);
    setConnectError(null);
    setName("");
    setBusy(false);
    setConnectionId("");
    setHiveUri("");
    setHiveRequirePrivate(false);
    setGlueRegion("us-east-1");
    setGlueKey("");
    setGlueEndpoint("");
    setGlueCatalogId("");
    setProvider("aws");
    setEndpoint("");
    setRegion("us-east-1");
    setBucket("");
    setPrefix("");
    setAccessKey("");
    setPathStyle(false);
    setRequirePrivate(false);
    setIcebergUri("");
    setIcebergWarehouse("");
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
    // Azure's first field is an account name typed in; everyone else's is a
    // secret picked by name. Neither means anything to the other.
    if ((p === "azure") !== (provider === "azure")) setAccessKey("");
    setProvider(p);
    setRegion(preset.region);
    setPathStyle(preset.pathStyle);
    setEndpoint(preset.endpoint); // fixed for GCS, empty prompt otherwise
  }

  // Where each kind's keys are sent, built as the server builds it, so a key
  // picker can say when a secret shared with you is not allowed there (R493).
  const glueDestination = glueEndpoint.trim()
    ? glueEndpoint.trim()
    : isAwsRegion(glueRegion.trim())
      ? `https://glue.${glueRegion.trim()}.${glueRegion.trim().startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`
      : "";
  const storageDestination = objectStoreDestination({
    provider,
    endpoint,
    region,
    bucket,
    accessKey,
    pathStyle,
  });

  // The server's rule, checked here so it is read beside the field (sourceName.ts).
  const nameProblem = sourceNameProblem(name);
  const hiveAddress = parseMetastoreUri(hiveUri);
  const glueRegionOk = isAwsRegion(glueRegion.trim());
  const configValid =
    name.trim().length > 0 &&
    nameProblem === null &&
    (kind === "warehouse"
      ? connectionId !== ""
      : kind === "iceberg_rest"
        ? /^https?:\/\//.test(icebergUri.trim())
        : kind === "hive_metastore"
          ? hiveAddress.ok
          : kind === "glue"
            ? glueRegionOk && glueKey.trim() !== "" && glueSecret !== ""
            : bucket.trim() !== "" &&
              region.trim() !== "" &&
              accessKey.trim() !== "" &&
              secretKey !== "" &&
              (provider === "aws" || endpoint.trim() !== ""));

  async function connectAndCrawl() {
    setBusy(true);
    setConnectError(null);
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
                  require_private: requirePrivate || undefined,
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
          hive:
            kind === "hive_metastore"
              ? { uri: hiveUri.trim(), require_private: hiveRequirePrivate || undefined }
              : undefined,
          glue:
            kind === "glue"
              ? {
                  region: glueRegion.trim(),
                  access_key_id: glueKey.trim(),
                  secret_access_key: glueSecret,
                  endpoint: glueEndpoint.trim() || undefined,
                  catalog_id: glueCatalogId.trim() || undefined,
                }
              : undefined,
        },
      });
      if (!created.ok) throw new Error(created.error);
      setReachedVia(created.path ?? null);
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
      // A validator's refusal arrives as its issue JSON; show its sentence.
      const message = validatorErrorText(e, validatorLabels(provider));
      toast.error(message);
      setConnectError(message);
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }

  const typeCard = (k: SourceKind, icon: React.ReactNode, title: string, desc: string) => (
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
                "Amazon S3 or any S3-compatible store (R2, MinIO, Spaces, B2). Understands partitioned folders and Delta, Iceberg and Hudi tables.",
              )}
              {typeCard(
                "iceberg_rest",
                <Database className="h-4 w-4" />,
                "Iceberg REST catalog",
                "Apache Iceberg REST catalog (Polaris, Unity, Nessie, Lakekeeper…). Namespaces, tables and schemas — query via Trino/Athena.",
              )}
              {typeCard(
                "hive_metastore",
                <Hexagon className="h-4 w-4" />,
                "Hive Metastore",
                "Any Hive Metastore, the catalog behind Spark, Trino and Flink on a lake. Databases, tables, partitions, locations and views are read over Thrift. Metadata only.",
              )}
              {typeCard(
                "glue",
                <Boxes className="h-4 w-4" />,
                "AWS Glue Data Catalog",
                "The catalog behind Athena, EMR and Redshift Spectrum. Databases, tables and partitions are read with a read-only key. Metadata only.",
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
              <Label className="text-xs" htmlFor="source-name">
                Source name
              </Label>
              <Input
                id="source-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "warehouse" ? "Production warehouse" : "Data lake raw"}
                className="h-9 text-sm"
                aria-invalid={nameProblem !== null}
                aria-describedby={nameProblem ? "source-name-problem" : undefined}
              />
              {nameProblem ? (
                <p id="source-name-problem" role="alert" className="text-[11px] text-destructive">
                  {nameProblem}
                </p>
              ) : null}
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
                    Integrations → Data sources
                  </Link>
                  .
                </p>
              </div>
            ) : kind === "glue" ? (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="glue-region">
                    Region
                  </Label>
                  <Input
                    id="glue-region"
                    value={glueRegion}
                    onChange={(e) => setGlueRegion(e.target.value)}
                    className="h-9 font-mono text-xs"
                    placeholder="us-east-1"
                    aria-invalid={glueRegion.trim() !== "" && !glueRegionOk}
                  />
                  {glueRegion.trim() !== "" && !glueRegionOk ? (
                    <p className="text-[11px] text-destructive">
                      That is not an AWS region. For example: eu-west-1.
                    </p>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="glue-key">
                      Access key id
                    </Label>
                    <SecretSelect
                      id="glue-key"
                      value={glueKey}
                      onChange={setGlueKey}
                      destination={glueDestination || undefined}
                      suggestedName="AWS_GLUE_ACCESS_KEY_ID"
                      purpose="For the Glue source's access key id."
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="glue-secret">
                      Secret access key
                    </Label>
                    <SecretSelect
                      id="glue-secret"
                      value={glueSecret}
                      onChange={setGlueSecret}
                      destination={glueDestination || undefined}
                      suggestedName="AWS_GLUE_SECRET_ACCESS_KEY"
                      purpose="For the Glue source's secret access key."
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Each key is a secret, picked by name: stored encrypted in Secrets and sent only to
                  Glue. The key needs only <code>glue:GetDatabases</code>,{" "}
                  <code>glue:GetTables</code> and <code>glue:GetPartitions</code>. This
                  server&rsquo;s own AWS role is never used here.
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="glue-endpoint">
                      VPC endpoint (optional)
                    </Label>
                    <Input
                      id="glue-endpoint"
                      value={glueEndpoint}
                      onChange={(e) => setGlueEndpoint(e.target.value)}
                      className="h-9 font-mono text-xs"
                      placeholder="https://vpce-….glue…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="glue-catalog">
                      Catalog id (optional)
                    </Label>
                    <Input
                      id="glue-catalog"
                      value={glueCatalogId}
                      onChange={(e) => setGlueCatalogId(e.target.value)}
                      className="h-9 font-mono text-xs"
                      placeholder="Another account's id"
                    />
                  </div>
                </div>
              </div>
            ) : kind === "hive_metastore" ? (
              <div className="space-y-2.5">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="hive-uri">
                    Metastore URI
                  </Label>
                  <Input
                    id="hive-uri"
                    value={hiveUri}
                    onChange={(e) => setHiveUri(e.target.value)}
                    className="h-9 font-mono text-xs"
                    placeholder="thrift://hms.internal:9083"
                    aria-invalid={hiveUri.trim() !== "" && !hiveAddress.ok}
                  />
                  {hiveUri.trim() !== "" && !hiveAddress.ok ? (
                    <p className="text-[11px] text-destructive">{hiveAddress.error}</p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      The value of <code>hive.metastore.uris</code> in hive-site.xml. A crawl only
                      reads: it sends no call that could change the metastore. Kerberos-secured
                      metastores are not supported.
                    </p>
                  )}
                </div>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    className="mt-0.5"
                    checked={hiveRequirePrivate}
                    onCheckedChange={(v) => setHiveRequirePrivate(v === true)}
                  />
                  <span>
                    <span className="font-medium">Require a private network path</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Refuse every call unless the host resolves only to private addresses from this
                      server.
                    </span>
                  </span>
                </label>
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
                  <Label className="text-xs" htmlFor="iceberg-rest-token">
                    Bearer token (optional)
                  </Label>
                  <SecretSelect
                    id="iceberg-rest-token"
                    optional
                    value={icebergToken}
                    onChange={setIcebergToken}
                    destination={icebergUri.trim() || undefined}
                    placeholder="None: the catalog needs no auth"
                    suggestedName="ICEBERG_CATALOG_TOKEN"
                    purpose="For the Iceberg REST catalog's bearer token."
                  />
                  <p className="text-[11px] text-muted-foreground">
                    A secret holding the OAuth2 or bearer token, if the catalog requires auth; sent
                    only to the catalog URI. Metadata-only — query the tables via a Trino or Athena
                    connection.
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
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="storage-endpoint">
                    {provider === "aws" ? "Endpoint URL (optional)" : "Endpoint URL"}
                  </Label>
                  <Input
                    id="storage-endpoint"
                    value={endpoint}
                    onChange={(e) => setEndpoint(e.target.value)}
                    className="h-9 font-mono text-xs"
                    placeholder={
                      provider === "aws"
                        ? "empty = s3.<region>.amazonaws.com, or an S3 interface endpoint"
                        : STORAGE_PRESETS[provider].endpointHint
                    }
                  />
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {provider === "azure" ? "Container" : "Bucket"}
                    </Label>
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
                    <Label className="text-xs" htmlFor="storage-access-key">
                      {provider === "azure" ? "Storage account name" : "Access key ID"}
                    </Label>
                    {provider === "azure" ? (
                      // The account is a name, not a key: it becomes the host.
                      <Input
                        id="storage-access-key"
                        value={accessKey}
                        onChange={(e) => setAccessKey(e.target.value)}
                        className="h-9 font-mono text-xs"
                        placeholder="mystorageaccount"
                        autoComplete="off"
                      />
                    ) : (
                      <SecretSelect
                        id="storage-access-key"
                        value={accessKey}
                        onChange={setAccessKey}
                        destination={storageDestination || undefined}
                        suggestedName={suggestSecretName(`${provider}_access_key_id`)}
                        purpose="For the bucket's access key ID."
                      />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="storage-secret-key">
                      {provider === "azure" ? "Account key or SAS token" : "Secret access key"}
                    </Label>
                    <SecretSelect
                      id="storage-secret-key"
                      value={secretKey}
                      onChange={setSecretKey}
                      destination={storageDestination || undefined}
                      suggestedName={suggestSecretName(
                        provider === "azure"
                          ? "azure_storage_key"
                          : `${provider}_secret_access_key`,
                      )}
                      purpose={
                        provider === "azure"
                          ? "For the storage account's key or SAS token."
                          : "For the bucket's secret access key."
                      }
                    />
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={pathStyle} onCheckedChange={(v) => setPathStyle(v === true)} />
                  Path-style addressing (endpoint/bucket/key — required by MinIO, default for custom
                  endpoints)
                </label>
                <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs font-medium">Network</p>
                  <p className="text-[11px] text-muted-foreground">
                    Public is the default. {PRIVATE_PATH_HINT[provider]} The test shows which
                    address it was reached at.
                  </p>
                  <label className="flex cursor-pointer items-start gap-2 text-xs">
                    <Checkbox
                      checked={requirePrivate}
                      onCheckedChange={(v) => setRequirePrivate(v === true)}
                      aria-label="Require a private network path"
                    />
                    <span>
                      Require a private network path
                      <span className="block text-[11px] text-muted-foreground">
                        Every read is refused, before it is sent, unless the store resolves to a
                        private address from this server — so a broken DNS zone fails loudly instead
                        of reading over the internet.
                      </span>
                    </span>
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Keys are secrets, picked by name from Secrets (New secret creates one in place):
                  stored encrypted and sent only to the store.
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
                {kind === "object_storage" ? (
                  <HardDrive className="h-3.5 w-3.5 text-primary" />
                ) : kind === "hive_metastore" ? (
                  <Hexagon className="h-3.5 w-3.5 text-primary" />
                ) : kind === "glue" ? (
                  <Boxes className="h-3.5 w-3.5 text-primary" />
                ) : (
                  <Database className="h-3.5 w-3.5 text-primary" />
                )}
                {name}
              </p>
              <p className="mt-1 text-muted-foreground">
                {kind === "warehouse"
                  ? `${connections?.find((c) => c.id === connectionId)?.name ?? "Connection"} — every schema and table will be cataloged with column types and row estimates.`
                  : kind === "hive_metastore"
                    ? `${hiveAddress.ok ? `${hiveAddress.host}:${hiveAddress.port}` : hiveUri.trim()} — its databases, tables and partitions are read. Nothing is changed.`
                    : kind === "glue"
                      ? `The Glue Data Catalog in ${glueRegion.trim()} — its databases, tables and partitions are read. Nothing is changed.`
                      : kind === "iceberg_rest"
                        ? // It described an S3 bucket here, with an empty path (R368).
                          `${icebergUri.trim()} — its namespaces and tables are listed (up to 300 namespaces and 1,000 tables), each with the columns of its current schema.`
                        : `${provider === "azure" ? "az" : "s3"}://${bucket}/${prefix} — objects are listed (up to 50,000), a partitioned folder becomes one table, Delta, Iceberg and Hudi tables are read from their own metadata, and data files are sampled to infer columns.`}
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
                    {reachedVia ? (
                      <p className="text-xs text-muted-foreground">Reached {reachedVia}.</p>
                    ) : null}
                    {result?.unread ? (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {result.note ??
                          `${result.unread} part(s) of the catalog could not be read and are not listed yet. Re-crawl the source once they can be.`}
                      </p>
                    ) : null}
                  </>
                )}
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => onOpenChange(false)}>
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {connectError ? (
                  <p
                    role="alert"
                    className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive"
                  >
                    Not saved: {connectError}
                  </p>
                ) : null}
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
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
