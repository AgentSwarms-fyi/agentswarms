// Shares: lakehouse tables handed to people outside the platform over the
// Delta Sharing protocol. An owner bundles tables into a named share, mints
// a token per recipient (shown once, as the profile file their client
// loads), and sees when each token was last used. A row filter or masked
// columns on a shared table apply on top of the table's own policy.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, Download, KeyRound, Plus, Share2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { shareProfile, shareSlug } from "@/lib/deltaSharing";
import {
  addLakehouseShareTable,
  createLakehouseShare,
  createLakehouseShareToken,
  deleteLakehouseShare,
  listLakehouseShares,
  removeLakehouseShareTable,
  revokeLakehouseShareToken,
  type LakehouseShare,
} from "@/utils/lakehouse/shares.functions";

export type ShareableTable = { schema: string; name: string };

export function SharesDialog({
  tables,
  ownedSchemas,
}: {
  tables: ShareableTable[];
  ownedSchemas: string[];
}) {
  const { session } = useAuth();
  const token = session?.access_token ?? "";
  const listFn = useServerFn(listLakehouseShares);
  const createFn = useServerFn(createLakehouseShare);
  const deleteFn = useServerFn(deleteLakehouseShare);
  const addTableFn = useServerFn(addLakehouseShareTable);
  const removeTableFn = useServerFn(removeLakehouseShareTable);
  const mintFn = useServerFn(createLakehouseShareToken);
  const revokeFn = useServerFn(revokeLakehouseShareToken);

  const [open, setOpen] = useState(false);
  const [shares, setShares] = useState<LakehouseShare[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [tableKey, setTableKey] = useState<string>("");
  const [sharedAs, setSharedAs] = useState("");
  const [rowFilter, setRowFilter] = useState("");
  const [masked, setMasked] = useState("");
  const [maskStyle, setMaskStyle] = useState<"null" | "hash">("null");
  const [tokenLabel, setTokenLabel] = useState("");
  const [recipient, setRecipient] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [minted, setMinted] = useState<{ label: string; profile: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const owned = tables.filter((t) => ownedSchemas.includes(t.schema));
  const endpoint =
    typeof window === "undefined"
      ? "/api/delta-sharing"
      : `${window.location.origin}/api/delta-sharing`;

  const load = async () => {
    try {
      const rows = await listFn({ data: { access_token: token } });
      setShares(rows);
      if (!selected && rows.length) setSelected(rows[0].id);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      if (label) toast.success(label);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createShare = () =>
    run(`Share "${shareSlug(newName)}" created`, async () => {
      const res = await createFn({
        data: {
          access_token: token,
          name: shareSlug(newName),
          description: newDescription.trim() || undefined,
        },
      });
      setSelected(res.id);
      setNewName("");
      setNewDescription("");
    });

  const addTable = () => {
    const [schema, name] = tableKey.split(".", 2);
    if (!schema || !name) return toast.error("Pick a table");
    return run(`${schema}.${name} added to the share`, async () => {
      await addTableFn({
        data: {
          access_token: token,
          share_id: selected,
          schema,
          table: name,
          shared_as: sharedAs.trim() || undefined,
          row_filter: rowFilter.trim() || undefined,
          masked_columns: masked
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          mask_style: maskStyle,
        },
      });
      setTableKey("");
      setSharedAs("");
      setRowFilter("");
      setMasked("");
    });
  };

  const mint = () =>
    run("", async () => {
      const res = await mintFn({
        data: {
          access_token: token,
          share_id: selected,
          label: tokenLabel.trim(),
          recipient_email: recipient.trim() || undefined,
          expires_in_days: expiresDays ? Number(expiresDays) : undefined,
        },
      });
      setMinted({
        label: tokenLabel.trim(),
        profile: JSON.stringify(shareProfile(endpoint, res.token, res.expires_at), null, 2),
      });
      setTokenLabel("");
      setRecipient("");
      setExpiresDays("");
    });

  const current = shares?.find((s) => s.id === selected) ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          title="Share tables with people outside the platform, over Delta Sharing"
        >
          <Share2 className="h-3.5 w-3.5" /> Shares
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Shares</DialogTitle>
          <DialogDescription>
            Hand tables to people outside the platform over the Delta Sharing protocol — the
            delta-sharing Python client, Spark, Power BI. Each recipient gets a token bound to one
            share and reads a governed snapshot: the table&apos;s policy, plus any rule you set
            here, with nothing that was deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2 rounded-md border border-border/60 p-3">
            <p className="text-sm font-medium">New share</p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1 space-y-1">
                <Label className="text-xs">Name (in the recipient&apos;s URL)</Label>
                <Input
                  value={newName}
                  placeholder="finance-q3"
                  onChange={(e) => setNewName(e.target.value)}
                  aria-label="New share name"
                />
              </div>
              <div className="min-w-40 flex-[2] space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={newDescription}
                  placeholder="Quarterly revenue for the auditors"
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                disabled={busy || !shareSlug(newName)}
                onClick={() => void createShare()}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" /> Create share
              </Button>
            </div>
          </div>

          {shares === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shares yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Label className="text-xs">Share</Label>
                <Select value={selected} onValueChange={setSelected}>
                  <SelectTrigger className="h-8 w-64" aria-label="Which share">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {shares.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {current ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    title="Delete this share"
                    aria-label={`Delete share ${current.name}`}
                    disabled={busy}
                    onClick={async () => {
                      if (
                        !(await confirmAsk({
                          title: `Delete share "${current.name}"?`,
                          body: "Every recipient token stops working and the snapshots written for them are removed. Your tables are untouched.",
                          actionLabel: "Delete",
                        }))
                      )
                        return;
                      await run(`Share "${current.name}" deleted`, async () => {
                        await deleteFn({ data: { access_token: token, share_id: current.id } });
                        setSelected("");
                      });
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>

              {current ? (
                <>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Tables in {current.name}</p>
                    {current.tables.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No tables yet.</p>
                    ) : (
                      <div className="divide-y divide-border/60 rounded-md border border-border/60">
                        {current.tables.map((t) => (
                          <div
                            key={t.id}
                            className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                          >
                            <code className="font-mono text-xs">
                              {t.schema_name}.{t.table_name}
                            </code>
                            {t.shared_as !== t.table_name ? (
                              <span className="text-xs text-muted-foreground">
                                as {t.shared_as}
                              </span>
                            ) : null}
                            {t.row_filter ? (
                              <Badge variant="outline" className="font-mono text-[10px]">
                                rows: {t.row_filter}
                              </Badge>
                            ) : null}
                            {t.masked_columns.length ? (
                              <Badge variant="outline" className="text-[10px]">
                                masked: {t.masked_columns.join(", ")} (
                                {t.mask_style === "hash" ? "scrambled" : "blank"})
                              </Badge>
                            ) : null}
                            <span className="ml-auto text-xs text-muted-foreground">
                              {t.snapshot
                                ? `snapshot v${t.snapshot.version} · ${t.snapshot.rows} rows`
                                : "not read yet"}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              aria-label={`Remove ${t.schema_name}.${t.table_name} from the share`}
                              disabled={busy}
                              onClick={() =>
                                void run("Table removed from the share", () =>
                                  removeTableFn({
                                    data: { access_token: token, share_table_id: t.id },
                                  }),
                                )
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-2">
                      <div className="space-y-1 sm:col-span-2">
                        <Label className="text-xs">Add a table you own</Label>
                        <Select value={tableKey} onValueChange={setTableKey}>
                          <SelectTrigger className="h-8" aria-label="Table to share">
                            <SelectValue placeholder="schema.table" />
                          </SelectTrigger>
                          <SelectContent>
                            {owned.map((t) => (
                              <SelectItem
                                key={`${t.schema}.${t.name}`}
                                value={`${t.schema}.${t.name}`}
                              >
                                {t.schema}.{t.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Shared as (optional)</Label>
                        <Input
                          value={sharedAs}
                          placeholder="same name"
                          onChange={(e) => setSharedAs(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Rows they can see (optional)</Label>
                        <Input
                          value={rowFilter}
                          placeholder="region = 'east'"
                          className="font-mono text-xs"
                          onChange={(e) => setRowFilter(e.target.value)}
                          aria-label="Row filter for the shared table"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">
                          Masked columns (optional, comma-separated)
                        </Label>
                        <Input
                          value={masked}
                          placeholder="email, phone"
                          onChange={(e) => setMasked(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">How masked</Label>
                        <Select
                          value={maskStyle}
                          onValueChange={(v) => setMaskStyle(v as "null" | "hash")}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="null">Blank — empties the value</SelectItem>
                            <SelectItem value="hash">Scramble — a stable hash</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="sm:col-span-2">
                        <Button
                          size="sm"
                          disabled={busy || !tableKey}
                          onClick={() => void addTable()}
                        >
                          <Plus className="mr-1.5 h-3.5 w-3.5" /> Add table
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-sm font-medium">Recipients of {current.name}</p>
                    {minted ? (
                      <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
                        <p className="text-sm">
                          Profile for <span className="font-medium">{minted.label}</span> — copy or
                          download it now; the token in it is not shown again.
                        </p>
                        <pre className="max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
                          {minted.profile}
                        </pre>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void navigator.clipboard.writeText(minted.profile);
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1500);
                            }}
                          >
                            {copied ? (
                              <Check className="mr-1.5 h-3.5 w-3.5" />
                            ) : (
                              <Copy className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Copy profile
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const blob = new Blob([minted.profile], { type: "application/json" });
                              const a = document.createElement("a");
                              a.href = URL.createObjectURL(blob);
                              a.download = `${current.name}.share`;
                              a.click();
                              URL.revokeObjectURL(a.href);
                            }}
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" /> Download .share
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setMinted(null)}
                          >
                            Done
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {current.tokens.filter((t) => !t.revoked_at).length === 0 ? (
                      <p className="text-xs text-muted-foreground">No recipient tokens yet.</p>
                    ) : (
                      <div className="divide-y divide-border/60 rounded-md border border-border/60">
                        {current.tokens
                          .filter((t) => !t.revoked_at)
                          .map((t) => (
                            <div
                              key={t.id}
                              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                            >
                              <span className="font-medium">{t.label}</span>
                              {t.recipient_email ? (
                                <span className="text-xs text-muted-foreground">
                                  {t.recipient_email}
                                </span>
                              ) : null}
                              <code className="font-mono text-xs">{t.token_prefix}…</code>
                              <span className="ml-auto text-xs text-muted-foreground">
                                {t.last_used_at
                                  ? `used ${t.use_count} times, last ${new Date(t.last_used_at).toLocaleString()}`
                                  : "never used"}
                                {t.expires_at
                                  ? ` · expires ${new Date(t.expires_at).toLocaleDateString()}`
                                  : ""}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                aria-label={`Revoke token ${t.label}`}
                                disabled={busy}
                                onClick={() =>
                                  void run(`Token "${t.label}" revoked`, () =>
                                    revokeFn({ data: { access_token: token, token_id: t.id } }),
                                  )
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                      </div>
                    )}
                    <div className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Token label</Label>
                        <Input
                          value={tokenLabel}
                          placeholder="Auditors"
                          onChange={(e) => setTokenLabel(e.target.value)}
                          aria-label="Recipient token label"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Recipient email (binds @me)</Label>
                        <Input
                          value={recipient}
                          placeholder="optional"
                          onChange={(e) => setRecipient(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Expires in days</Label>
                        <Input
                          value={expiresDays}
                          placeholder="never"
                          inputMode="numeric"
                          onChange={(e) => setExpiresDays(e.target.value.replace(/[^0-9]/g, ""))}
                        />
                      </div>
                      <div className="sm:col-span-3">
                        <Button
                          size="sm"
                          disabled={busy || !tokenLabel.trim()}
                          onClick={() => void mint()}
                        >
                          <KeyRound className="mr-1.5 h-3.5 w-3.5" /> Mint recipient token
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Endpoint <code className="font-mono">{endpoint}</code>. A recipient loads the
                      profile into their client — for example{" "}
                      <code className="font-mono">
                        delta_sharing.load_as_pandas(&quot;profile.share#{current.name}
                        .schema.table&quot;)
                      </code>
                      .
                    </p>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
