// Connect an external source (Google Drive, Notion, SharePoint, Dropbox) to a
// knowledge base: credentials, what to sync, how often, and who may see the
// result.
//
// Credentials go to /api/kb/sources, which validates the config against the
// real connector, encrypts them server-side, and never returns them. Editing a
// source therefore shows EMPTY credential fields — leaving them empty keeps
// what's stored; typing replaces it.

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Cloud, FileText, Layers, Box } from "lucide-react";

export type ConnectorSourceRow = {
  id: string;
  kind: string;
  label: string | null;
  config: Record<string, unknown>;
  sync_schedule: string;
  access_scope: string;
};

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  /** Textarea whose value becomes a string[] (split on commas/newlines). */
  list?: boolean;
  help?: string;
};

type ProviderDef = {
  kind: "gdrive" | "notion" | "sharepoint" | "dropbox";
  name: string;
  icon: typeof Cloud;
  blurb: string;
  credFields: Field[];
  configFields: Field[];
  /** Whether the provider can mirror per-document sharing into access control. */
  acl: boolean;
};

const PROVIDERS: ProviderDef[] = [
  {
    kind: "gdrive",
    name: "Google Drive",
    icon: Cloud,
    blurb: "Sync a Drive folder — Google Docs, Sheets and text files.",
    credFields: [
      {
        key: "access_token",
        label: "Access token",
        secret: true,
        optional: true,
        help: "Quickest start (expires ~1h). For scheduled syncs use the refresh-token fields instead.",
      },
      { key: "refresh_token", label: "Refresh token", secret: true, optional: true },
      { key: "client_id", label: "OAuth client ID", optional: true },
      { key: "client_secret", label: "OAuth client secret", secret: true, optional: true },
    ],
    configFields: [
      {
        key: "folder_id",
        label: "Folder ID",
        placeholder: "1AbC… (from the folder URL) or root",
        help: "The part of the folder URL after /folders/ — subfolders are included.",
      },
    ],
    acl: true,
  },
  {
    kind: "notion",
    name: "Notion",
    icon: FileText,
    blurb: "Sync pages and databases shared with an internal integration.",
    credFields: [
      {
        key: "token",
        label: "Integration secret",
        secret: true,
        help: "Create one under Settings → Connections → Develop or manage integrations, then share the pages with it.",
      },
    ],
    configFields: [
      {
        key: "page_ids",
        label: "Page IDs",
        list: true,
        optional: true,
        placeholder: "One per line — the 32-char id from each page URL",
      },
      {
        key: "database_ids",
        label: "Database IDs",
        list: true,
        optional: true,
        placeholder: "One per line — every page in the database is synced",
      },
    ],
    acl: false,
  },
  {
    kind: "sharepoint",
    name: "SharePoint",
    icon: Layers,
    blurb: "Sync a document library via Microsoft Graph (app registration).",
    credFields: [
      { key: "tenant_id", label: "Tenant ID" },
      { key: "client_id", label: "Client ID" },
      {
        key: "client_secret",
        label: "Client secret",
        secret: true,
        help: "Entra app registration with admin-consented Files.Read.All application permission.",
      },
    ],
    configFields: [
      {
        key: "site_id",
        label: "Site ID",
        optional: true,
        placeholder: "host,siteCollectionId,siteId",
      },
      { key: "drive_id", label: "Drive ID (overrides site)", optional: true },
      {
        key: "folder_path",
        label: "Folder path",
        optional: true,
        placeholder: "Shared Documents/Policies",
      },
    ],
    acl: true,
  },
  {
    kind: "dropbox",
    name: "Dropbox",
    icon: Box,
    blurb: "Sync a folder — Dropbox's native hashes make change detection exact.",
    credFields: [
      {
        key: "access_token",
        label: "Access token",
        secret: true,
        optional: true,
        help: "App Console → Generate. For scheduled syncs use the refresh-token fields instead.",
      },
      { key: "refresh_token", label: "Refresh token", secret: true, optional: true },
      { key: "app_key", label: "App key", optional: true },
      { key: "app_secret", label: "App secret", secret: true, optional: true },
    ],
    configFields: [
      {
        key: "path",
        label: "Folder path",
        optional: true,
        placeholder: "/Team/Docs (empty = everything)",
      },
    ],
    acl: true,
  },
];

const SCHEDULES = [
  { id: "manual", label: "Manual only" },
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

const SCOPES = [
  {
    id: "inherit",
    label: "Everyone with this KB",
    hint: "Documents behave like uploads — visible wherever the knowledge base is visible.",
  },
  {
    id: "private",
    label: "Only me",
    hint: "Retrieval returns these documents only for you, even if the KB is shared.",
  },
  {
    id: "source_acl",
    label: "Match source permissions",
    hint: "Mirrors the provider's sharing per document; people not shared on the original file won't retrieve it.",
  },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledgeBaseId: string;
  /** Present = edit that source (credential fields start empty = keep stored). */
  editing?: ConnectorSourceRow | null;
  onSaved: () => void;
};

export function ConnectSourceDialog({
  open,
  onOpenChange,
  knowledgeBaseId,
  editing,
  onSaved,
}: Props) {
  const [kind, setKind] = useState<ProviderDef["kind"] | null>(null);
  const [label, setLabel] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState("manual");
  const [scope, setScope] = useState("inherit");
  const [saving, setSaving] = useState<"idle" | "save" | "sync">("idle");

  const provider = useMemo(() => PROVIDERS.find((p) => p.kind === kind) ?? null, [kind]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind as ProviderDef["kind"]);
      setLabel(editing.label ?? "");
      setCreds({});
      const cfg: Record<string, string> = {};
      for (const [k, v] of Object.entries(editing.config ?? {})) {
        cfg[k] = Array.isArray(v) ? (v as string[]).join("\n") : String(v ?? "");
      }
      setConfig(cfg);
      setSchedule(editing.sync_schedule ?? "manual");
      setScope(editing.access_scope ?? "inherit");
    } else {
      setKind(null);
      setLabel("");
      setCreds({});
      setConfig({});
      setSchedule("manual");
      setScope("inherit");
    }
  }, [open, editing]);

  async function save(syncNow: boolean) {
    if (!provider) return;
    setSaving(syncNow ? "sync" : "save");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) {
        toast.error("Please sign in again");
        return;
      }

      const configOut: Record<string, unknown> = {};
      for (const f of provider.configFields) {
        const raw = (config[f.key] ?? "").trim();
        if (!raw) continue;
        configOut[f.key] = f.list
          ? raw
              .split(/[\n,]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : raw;
      }
      const credsOut: Record<string, string> = {};
      for (const f of provider.credFields) {
        const raw = (creds[f.key] ?? "").trim();
        if (raw) credsOut[f.key] = raw;
      }

      const res = await fetch("/api/kb/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "upsert",
          source_id: editing?.id,
          knowledge_base_id: knowledgeBaseId,
          kind: provider.kind,
          label: label.trim() || provider.name,
          config: configOut,
          // Empty on edit = keep stored credentials.
          credentials: Object.keys(credsOut).length > 0 ? credsOut : undefined,
          sync_schedule: schedule,
          access_scope: scope,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || `Save failed (${res.status})`);
        return;
      }

      if (syncNow) {
        const syncRes = await fetch("/api/kb/sources/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ source_id: json.source.id }),
        });
        const syncJson = await syncRes.json().catch(() => ({}));
        if (!syncRes.ok && syncRes.status !== 207) {
          toast.error(syncJson.error || `Sync failed (${syncRes.status})`);
        } else {
          const s = syncJson.stats ?? {};
          toast.success(
            `Synced — ${s.added ?? 0} added, ${s.updated ?? 0} updated, ${s.unchanged ?? 0} unchanged` +
              (syncJson.error ? ` · ${syncJson.error}` : ""),
          );
        }
      } else {
        toast.success(editing ? "Source updated" : "Source connected");
      }
      onSaved();
      onOpenChange(false);
    } finally {
      setSaving("idle");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit source" : "Connect a source"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Credential fields start empty — leave them empty to keep what's stored."
              : "Sync documents from an external service into this knowledge base."}
          </DialogDescription>
        </DialogHeader>

        {!provider ? (
          <div className="grid grid-cols-2 gap-2">
            {PROVIDERS.map((p) => (
              <button
                key={p.kind}
                type="button"
                onClick={() => setKind(p.kind)}
                className="glow-card rounded-xl border border-border bg-card p-3.5 text-left"
              >
                <div className="mb-2.5 grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-border/50">
                  <p.icon className="h-4.5 w-4.5" />
                </div>
                <p className="text-sm font-medium">{p.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{p.blurb}</p>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            {!editing && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setKind(null)}
              >
                ← Choose a different provider
              </button>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="src-label">Name</Label>
              <Input
                id="src-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={`${provider.name} source`}
              />
            </div>

            <div className="space-y-3 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium text-muted-foreground">Credentials</p>
              {provider.credFields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`cred-${f.key}`} className="text-xs">
                    {f.label}
                    {f.optional ? " (optional)" : ""}
                  </Label>
                  <Input
                    id={`cred-${f.key}`}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={creds[f.key] ?? ""}
                    onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                    placeholder={editing ? "•••••• (stored)" : f.placeholder}
                  />
                  {f.help && <p className="text-[11px] text-muted-foreground">{f.help}</p>}
                </div>
              ))}
            </div>

            <div className="space-y-3 rounded-md border border-border/60 p-3">
              <p className="text-xs font-medium text-muted-foreground">What to sync</p>
              {provider.configFields.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={`cfg-${f.key}`} className="text-xs">
                    {f.label}
                    {f.optional ? " (optional)" : ""}
                  </Label>
                  {f.list ? (
                    <Textarea
                      id={`cfg-${f.key}`}
                      rows={2}
                      value={config[f.key] ?? ""}
                      onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  ) : (
                    <Input
                      id={`cfg-${f.key}`}
                      value={config[f.key] ?? ""}
                      onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                    />
                  )}
                  {f.help && <p className="text-[11px] text-muted-foreground">{f.help}</p>}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Sync schedule</Label>
                <Select value={schedule} onValueChange={setSchedule}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Unchanged files are skipped — re-syncs cost a listing, not a re-index.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Who can retrieve these documents</Label>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {SCOPES.find((s) => s.id === scope)?.hint}
                  {scope === "source_acl" && !provider.acl
                    ? " This provider doesn't expose sharing info — documents will be visible only to you."
                    : ""}
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" disabled={saving !== "idle"} onClick={() => save(false)}>
                {saving === "save" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Save
              </Button>
              <Button disabled={saving !== "idle"} onClick={() => save(true)}>
                {saving === "sync" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Save & sync now
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
