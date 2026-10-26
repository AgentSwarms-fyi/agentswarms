// One kind of key this instance issues, listed across everything you own, with
// a revoke. R385: these keys could reach your data but had no place in the API
// keys hub — each lived only on the page of the one app, notebook, share,
// workflow or pipeline it belongs to, so "every key I have issued" had no
// answer anywhere.
//
// Reads go through the browser client, so RLS scopes them to the caller (and,
// for SCIM tokens, to superadmins). Only display columns are selected — never a
// hash. Revoking calls the SAME server function the key's own page calls, so
// the audit trail and every rule that page enforces still apply; afterwards the
// list is read again rather than edited in place, so what you see is what the
// server now holds.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { mcpAppKeyRevoke } from "@/utils/mcpApps.functions";
import { nbApiKeyRevoke } from "@/utils/notebookApiKeys.functions";
import { revokeLakehouseShareToken } from "@/utils/lakehouse/shares.functions";
import { workflowRevokeToken } from "@/utils/workflows.functions";
import { revokeEtlTriggerToken } from "@/utils/etl.functions";
import { iamRevokeScimToken } from "@/utils/iam.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ArrowRight, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export type IssuedKind =
  | "mcp_app_keys"
  | "notebook_keys"
  | "share_tokens"
  | "workflow_triggers"
  | "etl_triggers"
  | "scim_tokens";

type IssuedRow = {
  /** The key's id — or, for a trigger token, its workflow/pipeline's id. */
  id: string;
  /** The app/notebook a key belongs to, where its revoke needs it. */
  parentId: string | null;
  name: string;
  /** What the key belongs to, said in words. */
  parent: string | null;
  prefix: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

/** Copy for each kind: what one is called, and where new ones are made. */
const KIND_COPY: Record<
  IssuedKind,
  { noun: string; plural: string; home: string; homeLabel: string }
> = {
  mcp_app_keys: {
    noun: "key",
    plural: "MCP app keys",
    home: "/mcp-builder",
    homeLabel: "MCP Builder",
  },
  notebook_keys: {
    noun: "key",
    plural: "notebook API keys",
    home: "/notebooks",
    homeLabel: "Notebooks",
  },
  share_tokens: {
    noun: "token",
    plural: "share tokens",
    home: "/lakehouse",
    homeLabel: "Lakehouse",
  },
  workflow_triggers: {
    noun: "token",
    plural: "workflow trigger tokens",
    home: "/workflows",
    homeLabel: "Workflows",
  },
  etl_triggers: {
    noun: "token",
    plural: "ETL trigger tokens",
    home: "/etl",
    homeLabel: "ETL Pipelines",
  },
  scim_tokens: {
    noun: "token",
    plural: "SCIM tokens",
    home: "/admin/iam",
    homeLabel: "Admin → IAM",
  },
};

/** id → display name for a parent table. A failed read leaves names unknown, not the keys. */
async function namesOf(table: string, column: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from(table as never) as any)
    .select(`id, ${column}`)
    .in("id", unique);
  if (error || !data) return new Map();
  return new Map((data as Record<string, string>[]).map((r) => [r.id, r[column]]));
}

async function loadRows(kind: IssuedKind): Promise<IssuedRow[]> {
  // The typed client cannot see a table chosen at run time; each branch below
  // names its table and columns literally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const from = (t: string): any => supabase.from(t as never);
  switch (kind) {
    case "mcp_app_keys": {
      const { data, error } = await from("mcp_app_keys")
        .select("id, app_id, name, key_prefix, created_at, last_used_at, expires_at")
        .eq("is_active", true)
        // The platform's own key for your agents is not one you issued.
        .eq("is_internal", false)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const names = await namesOf(
        "mcp_apps",
        "name",
        data.map((r: { app_id: string }) => r.app_id),
      );
      return data.map(
        (r: {
          id: string;
          app_id: string;
          name: string;
          key_prefix: string;
          created_at: string;
          last_used_at: string | null;
          expires_at: string | null;
        }) => ({
          id: r.id,
          parentId: r.app_id,
          name: r.name,
          parent: names.get(r.app_id) ?? null,
          prefix: r.key_prefix,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          expiresAt: r.expires_at,
        }),
      );
    }
    case "notebook_keys": {
      const { data, error } = await from("notebook_api_keys")
        .select("id, notebook_id, name, key_prefix, created_at, last_used_at, expires_at")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const names = await namesOf(
        "user_python_notebooks",
        "title",
        data.map((r: { notebook_id: string }) => r.notebook_id),
      );
      return data.map(
        (r: {
          id: string;
          notebook_id: string;
          name: string;
          key_prefix: string;
          created_at: string;
          last_used_at: string | null;
          expires_at: string | null;
        }) => ({
          id: r.id,
          parentId: r.notebook_id,
          name: r.name,
          parent: names.get(r.notebook_id) ?? null,
          prefix: r.key_prefix,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          expiresAt: r.expires_at,
        }),
      );
    }
    case "share_tokens": {
      const { data, error } = await from("lakehouse_share_tokens")
        .select("id, share_id, label, token_prefix, created_at, last_used_at, expires_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      const names = await namesOf(
        "lakehouse_shares",
        "name",
        data.map((r: { share_id: string }) => r.share_id),
      );
      return data.map(
        (r: {
          id: string;
          share_id: string;
          label: string | null;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
          expires_at: string | null;
        }) => ({
          id: r.id,
          parentId: r.share_id,
          name: r.label || "Unlabelled token",
          parent: names.get(r.share_id) ?? null,
          prefix: r.token_prefix,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          expiresAt: r.expires_at,
        }),
      );
    }
    case "workflow_triggers":
    case "etl_triggers": {
      // The token itself lives only as a hash on the row; whether one exists is
      // all a list may say.
      const table = kind === "workflow_triggers" ? "workflows" : "etl_pipelines";
      const { data, error } = await from(table)
        .select("id, name, updated_at")
        .not("trigger_token_hash", "is", null)
        .order("updated_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data.map((r: { id: string; name: string; updated_at: string | null }) => ({
        id: r.id,
        parentId: null,
        name: r.name,
        parent: kind === "workflow_triggers" ? "Workflow" : "ETL pipeline",
        prefix: null,
        createdAt: null,
        lastUsedAt: null,
        expiresAt: null,
      }));
    }
    case "scim_tokens": {
      const { data, error } = await from("iam_scim_tokens")
        .select("id, label, token_prefix, created_at, last_used_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data.map(
        (r: {
          id: string;
          label: string | null;
          token_prefix: string;
          created_at: string;
          last_used_at: string | null;
        }) => ({
          id: r.id,
          parentId: null,
          name: r.label || "Unlabelled token",
          parent: "Identity provider",
          prefix: r.token_prefix,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
          expiresAt: null,
        }),
      );
    }
  }
}

/** A server function's `{ ok: false }` answer, as a thrown error like the ones that throw. */
function raiseIfFailed(result: unknown): void {
  if (result && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
    throw new Error((result as { error?: string }).error ?? "The server refused the revoke.");
  }
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : "—");
const isExpired = (iso: string | null) => !!iso && Date.parse(iso) <= Date.now();

export function IssuedKeysPanel({ kind }: { kind: IssuedKind }) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const copy = KIND_COPY[kind];

  const mcpRevoke = useServerFn(mcpAppKeyRevoke);
  const nbRevoke = useServerFn(nbApiKeyRevoke);
  const shareRevoke = useServerFn(revokeLakehouseShareToken);
  const wfRevoke = useServerFn(workflowRevokeToken);
  const etlRevoke = useServerFn(revokeEtlTriggerToken);
  const scimRevoke = useServerFn(iamRevokeScimToken);

  const [rows, setRows] = useState<IssuedRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await loadRows(kind));
    } catch (e) {
      // A failed read is not an empty list: say so, and keep nothing that looks like an answer.
      setRows(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(row: IssuedRow) {
    setRevoking(row.id);
    try {
      switch (kind) {
        case "mcp_app_keys":
          raiseIfFailed(await mcpRevoke({ data: { id: row.parentId ?? "", key_id: row.id } }));
          break;
        case "notebook_keys":
          raiseIfFailed(
            await nbRevoke({
              data: { access_token: token, notebook_id: row.parentId ?? "", id: row.id },
            }),
          );
          break;
        case "share_tokens":
          raiseIfFailed(await shareRevoke({ data: { access_token: token, token_id: row.id } }));
          break;
        case "workflow_triggers":
          raiseIfFailed(await wfRevoke({ data: { accessToken: token, id: row.id } }));
          break;
        case "etl_triggers":
          raiseIfFailed(await etlRevoke({ data: { access_token: token, id: row.id } }));
          break;
        case "scim_tokens":
          raiseIfFailed(await scimRevoke({ data: { access_token: token, token_id: row.id } }));
          break;
      }
      // Re-read first: a toast saying "revoked" over a list still showing the
      // key reads as a revoke that did not take.
      await load();
      toast.success(`Revoked "${row.name}".`);
    } catch (e) {
      toast.error(`Could not revoke "${row.name}": ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRevoking(null);
    }
  }

  const live = rows?.filter((r) => !isExpired(r.expiresAt)).length ?? 0;
  const expired = (rows?.length ?? 0) - live;

  return (
    <div className="space-y-3" data-testid={`issued-keys-${kind}`}>
      {error !== null ? (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
          role="alert"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Could not load your {copy.plural}: {error}
          </span>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void load()}>
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        </div>
      ) : rows === null ? (
        <div className="space-y-2" aria-label={`Loading ${copy.plural}`}>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">You have no active {copy.plural}.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="issued-keys-summary">
            {live} live
            {expired > 0 ? ` · ${expired} expired (refused already; revoke to tidy up)` : ""}
          </p>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Belongs to</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.parent ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.prefix ? `${r.prefix}…` : "—"}
                    </TableCell>
                    <TableCell className="text-xs">{fmt(r.lastUsedAt)}</TableCell>
                    <TableCell className="text-xs">
                      {isExpired(r.expiresAt) ? (
                        <Badge variant="outline" className="text-[10px]">
                          Expired
                        </Badge>
                      ) : (
                        fmt(r.expiresAt)
                      )}
                    </TableCell>
                    <TableCell>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-destructive hover:text-destructive"
                            disabled={revoking !== null}
                          >
                            <Trash2 className="h-3 w-3" />
                            {revoking === r.id ? "Revoking…" : "Revoke"}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Revoke &quot;{r.name}&quot;?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Anything still using this {copy.noun} stops working immediately. This
                              cannot be undone — you would issue a new {copy.noun} instead.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void revoke(r)}>
                              Revoke
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        New {copy.plural} are created where they are used —{" "}
        <Link
          to={copy.home}
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          open {copy.homeLabel} <ArrowRight className="h-3 w-3" />
        </Link>
      </p>
    </div>
  );
}
