// Taking the model elsewhere, and bringing one in.
//
// Apache Ossie is the open standard for semantic metadata (Snowflake,
// Databricks, dbt, Salesforce and others read and write it): a semantic model
// (tables, fields, joins, metrics), an ontology (concepts and their
// relationships) and a mapping between them. OWL/Turtle is for knowledge-
// graph tools. JSON is this app's own format, exact. What each format cannot
// carry is said, not silently dropped.
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Copy, Download, FileUp, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { useOntology } from "@/components/ontology/OntologyContext";
import { exportOssie, importOssie } from "@/lib/ontology/ossie";
import { toTurtle } from "@/lib/ontology/owl";
import { ontologySpecSchema } from "@/lib/ontology/spec";
import { cn } from "@/lib/utils";

type Doc = { id: string; label: string; file: string; text: string; mime: string };

function slug(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "ontology"
  );
}

function download(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportTab() {
  const o = useOntology();
  const base = slug(o.spec.name);
  const built = useMemo((): { docs: Doc[]; warnings: string[]; ossieError: string | null } => {
    const docs: Doc[] = [];
    let warnings: string[] = [];
    let ossieError: string | null = null;
    try {
      const x = exportOssie(o.spec);
      warnings = x.warnings;
      docs.push(
        {
          id: "sm",
          label: "Ossie semantic model",
          file: `${base}.semantic_model.yaml`,
          text: x.yaml.semanticModel,
          mime: "text/yaml",
        },
        {
          id: "on",
          label: "Ossie ontology",
          file: `${base}.ontology.yaml`,
          text: x.yaml.ontology,
          mime: "text/yaml",
        },
        {
          id: "mp",
          label: "Ossie mapping",
          file: `${base}.mapping.yaml`,
          text: x.yaml.mapping,
          mime: "text/yaml",
        },
      );
    } catch (e) {
      ossieError = (e as Error).message;
    }
    docs.push({
      id: "owl",
      label: "OWL (Turtle)",
      file: `${base}.ttl`,
      text: toTurtle(o.spec),
      mime: "text/turtle",
    });
    docs.push({
      id: "json",
      label: "AgentSwarms JSON",
      file: `${base}.ontology.json`,
      text: JSON.stringify(o.spec, null, 2),
      mime: "application/json",
    });
    return { docs, warnings, ossieError };
  }, [o.spec, base]);
  const [active, setActive] = useState(built.docs[0]?.id ?? "json");
  const [copied, setCopied] = useState(false);
  const [paste, setPaste] = useState("");
  const doc = built.docs.find((d) => d.id === active) ?? built.docs[0];

  const replaceDraft = async () => {
    let spec;
    let warnings: string[] = [];
    try {
      const native = ontologySpecSchema.safeParse(JSON.parse(paste));
      if (native.success) spec = native.data;
    } catch {
      /* not our JSON */
    }
    if (!spec) {
      try {
        const r = importOssie([paste]);
        spec = r.spec;
        warnings = r.warnings;
      } catch (e) {
        toast.error((e as Error).message);
        return;
      }
    }
    const ok = await confirmAsk({
      title: `Replace the draft with ${spec.name}?`,
      body: `${spec.objectTypes.length} types and ${spec.linkTypes.length} links replace the draft. Published versions stay as they are.${warnings.length ? ` ${warnings.length} note(s) from the import.` : ""}`,
      actionLabel: "Replace the draft",
    });
    if (!ok) return;
    o.setSpec({ ...spec, name: o.spec.name });
    setPaste("");
    toast.success("Draft replaced — review it under Model, then publish");
  };

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card">
        <div
          className="flex flex-wrap items-center gap-1 border-b border-border p-2"
          role="tablist"
          aria-label="Formats"
        >
          {built.docs.map((d) => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={d.id === doc?.id}
              onClick={() => setActive(d.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                d.id === doc?.id
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              {d.label}
            </button>
          ))}
          <div className="ml-auto flex gap-2">
            {doc && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(doc.text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? (
                    <Check className="mr-1 h-3.5 w-3.5" />
                  ) : (
                    <Copy className="mr-1 h-3.5 w-3.5" />
                  )}{" "}
                  Copy
                </Button>
                <Button size="sm" onClick={() => download(doc.file, doc.text, doc.mime)}>
                  <Download className="mr-1 h-3.5 w-3.5" /> {doc.file}
                </Button>
              </>
            )}
            {!built.ossieError && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  built.docs
                    .filter((d) => ["sm", "on", "mp"].includes(d.id))
                    .forEach((d) => download(d.file, d.text, d.mime))
                }
              >
                <Download className="mr-1 h-3.5 w-3.5" /> All three Ossie files
              </Button>
            )}
          </div>
        </div>
        {built.ossieError && (
          <p className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-4 py-2 text-xs text-amber-900 dark:text-amber-200">
            <Info className="mt-0.5 h-3.5 w-3.5" /> Apache Ossie export needs at least one type
            bound to a table: {built.ossieError}
          </p>
        )}
        {doc?.id !== "json" && doc?.id !== "owl" && built.warnings.length > 0 && (
          <ul className="space-y-0.5 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            {built.warnings.slice(0, 8).map((w) => (
              <li key={w}>• {w}</li>
            ))}
          </ul>
        )}
        <pre className="max-h-[60vh] overflow-auto p-4 font-mono text-[11px] leading-relaxed">
          {doc?.text}
        </pre>
      </section>

      {o.canEdit && (
        <section className="rounded-xl border border-border bg-card p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileUp className="h-4 w-4 text-primary" /> Replace the draft from a document
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Paste an Apache Ossie semantic model (YAML or JSON) or an AgentSwarms JSON export. To
            start a new ontology from files instead, use Import on the Enterprise Ontology page.
          </p>
          <Textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={6}
            className="mt-3 font-mono text-xs"
            aria-label="Document to import"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" onClick={() => void replaceDraft()} disabled={!paste.trim()}>
              Replace the draft
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
