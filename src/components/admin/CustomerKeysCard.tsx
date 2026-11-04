// Admin → IAM → Settings → Customer keys.
//
// Every user's stored credentials are under that user's own key; a customer
// key wraps the user keys of the users and groups assigned to it. This card
// creates customer keys (held by the app, or in the customer's own KMS),
// assigns users and groups, checks a key, destroys one, and erases a single
// user's key. The server does the moving: every assignment change re-wraps
// the covered users' keys at once, and the card reports what moved.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reportFailure } from "@/lib/silentFailureNet";
import { filesPassLine, laterPass } from "@/utils/lakehouse/customerKeyFiles";
import { storedFilesPassLine } from "@/utils/storage/storedFiles";
import { memoryPassDetail } from "@/utils/memory/memoryPass";
import { chatPassDetail } from "@/utils/chat/chatPass";
import type { IamGroupRow, IamUserRow } from "@/utils/iam.functions";
import {
  assignCustomerKey,
  checkCustomerKey,
  createCustomerKey,
  destroyCustomerKey,
  eraseUserKey,
  getCustomerKeys,
  reEncryptLakehouseFilesNow,
  sealStoredFilesNow,
  unassignCustomerKey,
  type CheckPayload,
  type CustomerKeysPayload,
  type CustomerKeyView,
  type LakehouseFilesState,
  type MembershipPayload,
  type StoredFilesState,
} from "@/utils/providers/customerKeys.functions";

const PROVIDER_NAME: Record<string, string> = {
  app: "Held by the app",
  vault: "Vault Transit",
  aws: "AWS KMS",
  azure: "Azure Key Vault",
  gcp: "Cloud KMS",
  oci: "OCI Vault",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an assignment change moved, in one toast line. */
function movedLine(r: MembershipPayload): string {
  const parts = [
    plural(r.users, "user"),
    r.userKeysRewrapped > 0 ? `${plural(r.userKeysRewrapped, "user key")} re-wrapped` : null,
    r.valuesReEncrypted > 0 ? `${plural(r.valuesReEncrypted, "value")} re-encrypted` : null,
    r.lakehouseFilesFollow ? "their lakehouse files follow in the background" : null,
  ].filter(Boolean);
  return parts.join(", ");
}

export function CustomerKeysCard(props: {
  token: string;
  users: IamUserRow[];
  groups: IamGroupRow[];
}) {
  const { token, users, groups } = props;
  const listFn = useServerFn(getCustomerKeys);
  const createFn = useServerFn(createCustomerKey);
  const checkFn = useServerFn(checkCustomerKey);
  const assignFn = useServerFn(assignCustomerKey);
  const unassignFn = useServerFn(unassignCustomerKey);
  const destroyFn = useServerFn(destroyCustomerKey);
  const eraseFn = useServerFn(eraseUserKey);
  const filesFn = useServerFn(reEncryptLakehouseFilesNow);
  const sealFn = useServerFn(sealStoredFilesNow);

  const [state, setState] = useState<CustomerKeysPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // A pass run from this page, until the audit trail has it.
  const [passHere, setPassHere] = useState<LakehouseFilesState["lastPass"]>(null);
  const [sealedHere, setSealedHere] = useState<StoredFilesState["lastPass"]>(null);
  const [checks, setChecks] = useState<Record<string, CheckPayload | { ok: false; error: string }>>(
    {},
  );

  // The new-key form.
  const [name, setName] = useState("");
  const [where, setWhere] = useState<"app" | "kms">("app");
  const [keyRef, setKeyRef] = useState("");
  const [endpoint, setEndpoint] = useState("");

  // Assignment pickers, per key: "user:<id>" or "group:<id>".
  const [picks, setPicks] = useState<Record<string, string>>({});

  // Confirmations.
  const [destroying, setDestroying] = useState<CustomerKeyView | null>(null);
  const [destroyName, setDestroyName] = useState("");
  const [eraseUser, setEraseUser] = useState<string>("");
  const [erasing, setErasing] = useState(false);
  const [eraseEmail, setEraseEmail] = useState("");

  const userById = useMemo(() => new Map(users.map((u) => [u.user_id, u])), [users]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups]);
  const userLabel = (id: string) => userById.get(id)?.email ?? id.slice(0, 8);
  const groupLabel = (id: string) => groupById.get(id)?.name ?? id.slice(0, 8);

  const load = useCallback(async () => {
    try {
      const res = await listFn({ data: { access_token: token } });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setState(res);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [listFn, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const keyName = (id: string) => state?.keys.find((k) => k.id === id)?.name ?? id.slice(0, 8);

  // Who is assigned anywhere already: the pickers leave them out.
  const assignedUsers = new Set<string>();
  const assignedGroups = new Set<string>();
  for (const k of state?.keys ?? []) {
    for (const m of k.members) {
      (m.kind === "user" ? assignedUsers : assignedGroups).add(m.principalId);
    }
  }

  const run = async <T,>(tag: string, label: string, fn: () => Promise<T>) => {
    setBusy(tag);
    const t = toast.loading(`${label}…`);
    try {
      return { t, value: await fn() };
    } catch (e) {
      reportFailure(label.toLowerCase(), e, { id: t });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const r = await run("create", "Creating the customer key", () =>
      createFn({
        data: {
          access_token: token,
          name: name.trim(),
          where,
          key_ref: where === "kms" ? keyRef.trim() : undefined,
          endpoint:
            where === "kms" && keyRef.trim().startsWith("ocid1.") ? endpoint.trim() : undefined,
        },
      }),
    );
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    toast.success(
      `Customer key "${name.trim()}" created (${r.value.kid}). Assign users or groups to it.`,
      {
        id: r.t,
        duration: 8000,
      },
    );
    setName("");
    setKeyRef("");
    setEndpoint("");
    await load();
  };

  const check = async (k: CustomerKeyView) => {
    const r = await run(`check:${k.id}`, `Checking "${k.name}"`, () =>
      checkFn({ data: { access_token: token, id: k.id } }),
    );
    if (!r) return;
    setChecks((c) => ({ ...c, [k.id]: r.value }));
    if (r.value.ok) toast.success(r.value.detail, { id: r.t });
    else toast.error(r.value.error, { id: r.t, duration: 10000 });
  };

  const assign = async (k: CustomerKeyView) => {
    const pick = picks[k.id];
    if (!pick) return;
    const [type, id] = pick.split(":") as ["user" | "group", string];
    const who = type === "user" ? userLabel(id) : `group ${groupLabel(id)}`;
    const r = await run(`assign:${k.id}`, `Assigning ${who} to "${k.name}"`, () =>
      assignFn({
        data: { access_token: token, id: k.id, principal_type: type, principal_id: id },
      }),
    );
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    const res = r.value;
    if (res.ownerFailures.length > 0 || res.valuesFailed > 0) {
      toast.error(
        `Assigned ${who}: ${movedLine(res)}; ${plural(res.ownerFailures.length, "user")} could not be moved (${res.ownerFailures[0]?.error ?? `${res.valuesFailed} values did not decrypt`}).`,
        { id: r.t, duration: 12000 },
      );
    } else {
      toast.success(`Assigned ${who} to "${k.name}": ${movedLine(res)}.`, {
        id: r.t,
        duration: 8000,
      });
    }
    setPicks((p) => ({ ...p, [k.id]: "" }));
    await load();
  };

  const unassign = async (k: CustomerKeyView, memberId: string, who: string) => {
    const r = await run(`unassign:${memberId}`, `Removing ${who} from "${k.name}"`, () =>
      unassignFn({ data: { access_token: token, member_id: memberId } }),
    );
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    toast.success(`Removed ${who} from "${k.name}": ${movedLine(r.value)}.`, {
      id: r.t,
      duration: 8000,
    });
    await load();
  };

  const destroy = async () => {
    const k = destroying;
    if (!k) return;
    const r = await run(`destroy:${k.id}`, `Destroying "${k.name}"`, () =>
      destroyFn({ data: { access_token: token, id: k.id, confirm_name: destroyName } }),
    );
    setDestroying(null);
    setDestroyName("");
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    const left = r.value.lakehouseSchemasLeft;
    const modelsLeft = r.value.lakehouseModelsLeft;
    const what = [
      left > 0 ? plural(left, "schema") : null,
      modelsLeft > 0 ? plural(modelsLeft, "model") : null,
    ].filter(Boolean);
    toast.success(
      `"${k.name}" destroyed; ${plural(r.value.userKeysErased, "user key")} erased with it.` +
        (what.length
          ? ` Its members' lakehouse files (${what.join(", ")}) stay under the customer's KMS key: for them to become unreadable, the customer disables or deletes that key.`
          : ""),
      { id: r.t, duration: what.length ? 15000 : 8000 },
    );
    await load();
  };

  const reEncryptFiles = async () => {
    const r = await run("files", "Re-encrypting lakehouse files", () =>
      filesFn({ data: { access_token: token } }),
    );
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    const v = r.value;
    const detail = {
      ...(v.skipped ? { skipped: v.skipped } : {}),
      files: v.files,
      schemas: v.schemas,
      models: v.models,
      experiment_runs: v.runs,
      files_reencrypted: v.reEncrypted,
      files_to_store_key: v.toStoreKey,
      files_already_right: v.alreadyRight,
      files_kept_under_destroyed: v.keptUnderDestroyed,
      files_too_large: v.tooLarge,
      schemas_conflicted: v.conflicted,
      models_conflicted: v.modelsConflicted,
      files_not_owned: v.notOwned,
      files_failed: v.failed,
    };
    const line = filesPassLine(detail);
    if (v.failed > 0) toast.error(`${line}. ${v.errors[0] ?? ""}`, { id: r.t, duration: 15000 });
    else toast.success(`${line}.`, { id: r.t, duration: 10000 });
    // The audit row the card reads is written after this answer: until it is
    // there, the last pass is this one (R440's round showed the one before).
    setPassHere({ at: new Date().toISOString(), by: null, detail });
    await load();
  };

  const sealStored = async () => {
    const r = await run("stored", "Encrypting stored files", () =>
      sealFn({ data: { access_token: token } }),
    );
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    const v = r.value;
    const detail = {
      files: v.files,
      documents: v.documents,
      copies: v.copies,
      files_sealed_now: v.sealedNow,
      copies_rebuilt: v.rebuilt,
      files_already_right: v.alreadyRight,
      files_unreadable: v.unreadable,
      copies_not_rebuilt: v.notRebuilt,
      files_not_owned: v.notOwned,
      files_vanished: v.vanished,
      files_left: v.left,
      files_failed: v.failed,
      ...memoryPassDetail(v.memory),
      ...chatPassDetail(v.chat),
    };
    const line = storedFilesPassLine(detail);
    const failure = v.errors[0] ?? v.memory.errors[0] ?? v.chat.errors[0] ?? "";
    if (v.failed + v.memory.failed + v.chat.failed > 0)
      toast.error(`${line}. ${failure}`, { id: r.t, duration: 15000 });
    else toast.success(`${line}.`, { id: r.t, duration: 10000 });
    setSealedHere({ at: new Date().toISOString(), by: null, detail });
    await load();
  };

  const erase = async () => {
    const id = eraseUser;
    const r = await run("erase", `Erasing ${userLabel(id)}'s key`, () =>
      eraseFn({ data: { access_token: token, user_id: id, confirm_email: eraseEmail } }),
    );
    setErasing(false);
    setEraseEmail("");
    if (!r) return;
    if (!r.value.ok) return toast.error(r.value.error, { id: r.t, duration: 10000 });
    toast.success(`${userLabel(id)}'s key ${r.value.kid} erased.`, { id: r.t, duration: 8000 });
    setEraseUser("");
    await load();
  };

  const lastPass = laterPass(state?.lakehouseFiles.lastPass ?? null, passHere);
  const lastSeal = laterPass(state?.storedFiles.lastPass ?? null, sealedHere);
  const live = (state?.keys ?? []).filter((k) => !k.destroyedAt);
  const destroyed = (state?.keys ?? []).filter((k) => k.destroyedAt);
  const s = state?.summary;
  const looksOci = where === "kms" && keyRef.trim().startsWith("ocid1.");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Customer keys</CardTitle>
        <CardDescription>
          Every user&apos;s stored credentials are under that user&apos;s own key. A customer key
          wraps the user keys of the users and groups assigned to it: held by the app, or a key in
          the customer&apos;s own KMS, which they control and can revoke. Destroying a customer key,
          or the customer revoking theirs, leaves what its members stored unreadable, and nobody
          else&apos;s. Erasing one user&apos;s key does the same for that user. The documents chat
          generates and the copies of uploaded datasets are under the same user keys. A key in AWS
          KMS (on S3) or Cloud KMS (on Cloud Storage) can also cover its members&apos; lakehouse
          files, their models and what their runs stage: the store encrypts each of them under it.
          Customer keys are optional: without one, every user key is wrapped by the
          deployment&apos;s key and everything works. New to keys?{" "}
          <Link to="/docs/keys" className="text-primary hover:underline">
            Keys &amp; encryption
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !state ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : !state.enabled ? (
          <p className="text-sm text-muted-foreground">
            Needs the database migration{" "}
            <code className="font-mono text-xs">20261105000000_customer_keys.sql</code> (
            <code className="font-mono text-xs">npx supabase db push</code>). Until then every
            credential is under the deployment&apos;s key, as before.
          </p>
        ) : (
          <>
            {s ? (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <span>
                  <strong>{s.live}</strong> user {s.live === 1 ? "key" : "keys"}
                </span>
                <span className="text-muted-foreground">
                  {s.underCustomer} under a customer key
                </span>
                {s.erased > 0 ? (
                  <span className="text-muted-foreground">{s.erased} erased</span>
                ) : null}
                {s.toMove + s.onOlderDeploymentKey > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {s.toMove + s.onOlderDeploymentKey} to re-wrap: Re-encrypt to current key
                    (above) moves them
                  </span>
                ) : null}
                {s.unheld > 0 ? (
                  <span className="text-destructive">
                    {s.unheld} wrapped by a key this server does not hold: put it back in
                    PROVIDER_CREDS_SECRET_OLD (or its key provider), or, if it is lost for good,
                    erase those users&apos; keys below; each one&apos;s next save makes a new key
                  </span>
                ) : null}
              </div>
            ) : null}

            {state.conflicts.length > 0 ? (
              <div className="rounded-md border border-destructive/40 p-3 text-xs">
                <p className="font-medium text-destructive">
                  {plural(state.conflicts.length, "user")} in groups assigned to different customer
                  keys. Nothing new is stored for them until one key is chosen: assign each one
                  directly.
                  {state.lakehouseFiles.on
                    ? " Their lakehouse files are written under the store's own encryption until then."
                    : ""}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {state.conflicts.map((c) => (
                    <li key={c.userId}>
                      {userLabel(c.userId)}: {c.keyIds.map((k) => `"${keyName(k)}"`).join(" and ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div
              className="space-y-1.5 rounded-md border border-border/60 p-3 text-xs"
              data-lakehouse-files
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Lakehouse files</span>
                {state.lakehouseFiles.on ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={busy !== null}
                    onClick={() => void reEncryptFiles()}
                  >
                    {busy === "files" ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Re-encrypt lakehouse files
                  </Button>
                ) : null}
              </div>
              {state.lakehouseFiles.on ? (
                <p className="text-muted-foreground">
                  {state.lakehouseFiles.why} A schema&apos;s new files, its owner&apos;s model
                  artifacts and experiment files, and the rows their runs stage are written under
                  the owner&apos;s customer key; files written before an assignment are copied in
                  place under it, by the assignment and by this button (one request per file).
                  Staged rows are not: they are deleted once loaded.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  Stay under the store&apos;s own encryption: {state.lakehouseFiles.why}
                </p>
              )}
              {state.lakehouseFiles.engine && !state.lakehouseFiles.engine.ok ? (
                <p className="text-amber-600 dark:text-amber-400" data-engine-key>
                  New files are written under the bucket&apos;s own encryption for now:{" "}
                  {state.lakehouseFiles.engine.why}. An assignment and this button move them under
                  the key; Check on a key asks the store again.
                </p>
              ) : null}
              {state.lakehouseFiles.error ? (
                <p className="text-destructive">{state.lakehouseFiles.error}</p>
              ) : null}
              {lastPass ? (
                <p data-last-pass>
                  Last pass{" "}
                  {formatDistanceToNow(new Date(lastPass.at), {
                    addSuffix: true,
                  })}
                  {lastPass.by ? ` (${lastPass.by})` : ""}: {filesPassLine(lastPass.detail)}.
                </p>
              ) : null}
            </div>

            <div
              className="space-y-1.5 rounded-md border border-border/60 p-3 text-xs"
              data-stored-files
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Stored files</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy !== null}
                  onClick={() => void sealStored()}
                >
                  {busy === "stored" ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Encrypt stored files
                </Button>
              </div>
              <p className="text-muted-foreground">
                The documents chat generates and the copies of uploaded datasets are encrypted by
                the app under their owner&apos;s user key, whatever kind of key covers it, so
                erasing a user key or destroying a customer key leaves them unreadable too. So is
                what agents remember about each user: long-term memory, conversation summaries and
                scratchpads, and chat history with agents, swarms and AI Analyst: every message,
                with its citations and its document&apos;s name and thumbnail, and every
                conversation&apos;s title, and the text model calls and swarm runs keep: prompts,
                messages, tool calls and replies, and each step&apos;s input and output. What was
                stored before that is encrypted by a pass every hour, or by this button. Not
                covered: profile pictures (others see them), and what stays in the database as it
                is: a dataset&apos;s own rows, and the text an approval request shows its approvers.
              </p>
              {state.storedFiles.error ? (
                <p className="text-destructive">{state.storedFiles.error}</p>
              ) : null}
              {lastSeal ? (
                <p data-last-seal>
                  Last pass{" "}
                  {formatDistanceToNow(new Date(lastSeal.at), {
                    addSuffix: true,
                  })}
                  {lastSeal.by ? ` (${lastSeal.by})` : ""}: {storedFilesPassLine(lastSeal.detail)}.
                </p>
              ) : null}
            </div>

            {live.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No customer keys yet. Every user key is wrapped by the deployment&apos;s key.
              </p>
            ) : (
              <div className="space-y-3">
                {live.map((k) => {
                  const result = checks[k.id];
                  const choices = [
                    ...groups
                      .filter((g) => !assignedGroups.has(g.id))
                      .map((g) => ({ value: `group:${g.id}`, label: `Group: ${g.name}` })),
                    ...users
                      .filter((u) => !assignedUsers.has(u.user_id))
                      .map((u) => ({ value: `user:${u.user_id}`, label: u.email ?? u.user_id })),
                  ];
                  return (
                    <div
                      key={k.id}
                      className="space-y-2 rounded-md border border-border/60 p-3 text-sm"
                      data-customer-key={k.name}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <KeyRound className="h-4 w-4 text-primary" aria-hidden />
                        <span className="font-medium">{k.name}</span>
                        <Badge variant={k.provider === "app" ? "secondary" : "default"}>
                          {PROVIDER_NAME[k.provider] ?? k.provider}
                        </Badge>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {k.kid}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          created {formatDistanceToNow(new Date(k.createdAt), { addSuffix: true })}
                        </span>
                        <div className="ml-auto flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`Check ${k.name}`}
                            disabled={busy !== null}
                            onClick={() => void check(k)}
                          >
                            {busy === `check:${k.id}` ? (
                              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                            )}
                            Check
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive"
                            aria-label={`Destroy ${k.name}`}
                            disabled={busy !== null}
                            onClick={() => {
                              setDestroyName("");
                              setDestroying(k);
                            }}
                          >
                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                            Destroy
                          </Button>
                        </div>
                      </div>
                      {k.keyRef ? (
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {k.keyRef}
                          {k.endpoint ? ` at ${k.endpoint}` : ""}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Covers {plural(k.coveredUsers, "user")}; wraps{" "}
                        {plural(k.userKeys, "user key")}
                        {k.toMove > 0 ? (
                          <span className="text-amber-600 dark:text-amber-400">
                            ; {k.toMove} to move (Re-encrypt to current key moves them)
                          </span>
                        ) : null}
                        .
                      </p>
                      {state.lakehouseFiles.on ? (
                        k.lakehouseFiles.kmsKeyId ? (
                          <p className="text-xs text-emerald-600 dark:text-emerald-400">
                            Lakehouse files: the store encrypts them under this key (
                            {plural(k.lakehouseFiles.schemas, "schema")}
                            {k.lakehouseFiles.models > 0
                              ? `, ${plural(k.lakehouseFiles.models, "model")}`
                              : ""}
                            ).
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Lakehouse files: {k.lakehouseFiles.why}
                          </p>
                        )
                      ) : null}
                      {result ? (
                        <div className="text-xs">
                          {result.ok ? (
                            <p className="text-emerald-600 dark:text-emerald-400">
                              {result.detail}
                            </p>
                          ) : (
                            <p className="text-destructive">{result.error}</p>
                          )}
                          {result.ok && result.facts?.length ? (
                            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                              {result.facts.map((f) => (
                                <Fragment key={f.label}>
                                  <dt className="text-muted-foreground">{f.label}</dt>
                                  <dd className="break-all font-mono">{f.value}</dd>
                                </Fragment>
                              ))}
                            </dl>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {k.members.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            Nobody is assigned yet.
                          </span>
                        ) : (
                          k.members.map((m) => {
                            const who =
                              m.kind === "user"
                                ? userLabel(m.principalId)
                                : `group ${groupLabel(m.principalId)}`;
                            return (
                              <Badge key={m.id} variant="outline" className="gap-1 font-normal">
                                {who}
                                <button
                                  type="button"
                                  aria-label={`Remove ${who} from ${k.name}`}
                                  className="rounded-sm opacity-70 hover:opacity-100 disabled:opacity-30"
                                  disabled={busy !== null}
                                  onClick={() => void unassign(k, m.id, who)}
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </Badge>
                            );
                          })
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={picks[k.id] ?? ""}
                          onValueChange={(v) => setPicks((p) => ({ ...p, [k.id]: v }))}
                        >
                          <SelectTrigger
                            className="h-8 w-72 text-xs"
                            aria-label={`Assign to ${k.name}`}
                          >
                            <SelectValue placeholder="Assign a group or a user…" />
                          </SelectTrigger>
                          <SelectContent>
                            {choices.length === 0 ? (
                              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                                Every group and user is assigned already.
                              </div>
                            ) : (
                              choices.map((c) => (
                                <SelectItem key={c.value} value={c.value} className="text-xs">
                                  {c.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Assign to ${k.name}: the group or user picked`}
                          disabled={busy !== null || !picks[k.id]}
                          onClick={() => void assign(k)}
                        >
                          {busy === `assign:${k.id}` ? (
                            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                          )}
                          Assign
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {destroyed.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Destroyed:{" "}
                {destroyed.map((k, i) => (
                  <Fragment key={k.id}>
                    {i > 0 ? "; " : ""}
                    {k.name} (<code className="font-mono">{k.kid}</code>, on{" "}
                    {k.destroyedAt?.slice(0, 10)})
                  </Fragment>
                ))}
                . What was stored under them does not read.
              </p>
            ) : null}

            <div className="space-y-2 rounded-md border border-dashed border-border/80 p-3">
              <p className="text-sm font-medium">New customer key</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_14rem]">
                <div className="space-y-1">
                  <Label htmlFor="ck-name" className="text-xs">
                    Name
                  </Label>
                  <Input
                    id="ck-name"
                    value={name}
                    maxLength={80}
                    placeholder="Acme Corp"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Where the key is</Label>
                  <Select value={where} onValueChange={(v) => setWhere(v as "app" | "kms")}>
                    <SelectTrigger aria-label="Where the key is">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="app">Held by the app</SelectItem>
                      <SelectItem value="kms">In the customer&apos;s KMS</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {where === "kms" ? (
                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="ck-ref" className="text-xs">
                      The customer&apos;s key
                    </Label>
                    <Input
                      id="ck-ref"
                      value={keyRef}
                      className="font-mono text-xs"
                      placeholder="arn:aws:kms:eu-west-1:111122223333:key/…"
                      onChange={(e) => setKeyRef(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      An AWS KMS key ARN, an Azure Key Vault key identifier, a Cloud KMS key&apos;s
                      resource name, an OCI Vault key&apos;s OCID, or a Vault Transit key. The app
                      calls it as its own identity, so the customer grants that identity encrypt and
                      decrypt on the key (docs/KEY_MANAGEMENT.md, customer keys).
                    </p>
                  </div>
                  {looksOci ? (
                    <div className="space-y-1">
                      <Label htmlFor="ck-endpoint" className="text-xs">
                        The vault&apos;s cryptographic endpoint
                      </Label>
                      <Input
                        id="ck-endpoint"
                        value={endpoint}
                        className="font-mono text-xs"
                        placeholder="https://<vault>-crypto.kms.<region>.oraclecloud.com"
                        onChange={(e) => setEndpoint(e.target.value)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
              <Button
                size="sm"
                disabled={busy !== null || !name.trim() || (where === "kms" && !keyRef.trim())}
                onClick={() => void create()}
              >
                {busy === "create" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                )}
                Create customer key
              </Button>
            </div>

            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <p className="text-sm font-medium">Erase a user&apos;s key</p>
              <p className="text-xs text-muted-foreground">
                Everything the user stored becomes unreadable at once (in other server processes
                within the key cache time, DATA_KEY_CACHE_SECONDS); their next save makes them a new
                key. A database backup taken earlier still holds the erased key: erasure there needs
                the backup to expire, or a customer key deleted in its KMS.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={eraseUser} onValueChange={setEraseUser}>
                  <SelectTrigger className="h-8 w-72 text-xs" aria-label="User whose key to erase">
                    <SelectValue placeholder="A user with a key…" />
                  </SelectTrigger>
                  <SelectContent>
                    {state.userKeys.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        No user has a key yet.
                      </div>
                    ) : (
                      state.userKeys.map((k) => (
                        <SelectItem key={k.userId} value={k.userId} className="text-xs">
                          {userLabel(k.userId)} ({k.kid}
                          {k.customerKeyId ? `, under "${keyName(k.customerKeyId)}"` : ""})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={busy !== null || !eraseUser}
                  onClick={() => {
                    setEraseEmail("");
                    setErasing(true);
                  }}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Erase key
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <AlertDialog open={!!destroying} onOpenChange={(o) => (!o ? setDestroying(null) : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Destroy &ldquo;{destroying?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {plural(destroying?.userKeys ?? 0, "user key")} are erased with it and its
              assignments removed. Everything its members stored becomes unreadable, their generated
              documents and dataset copies included, and cannot be recovered from this app.
              {destroying?.lakehouseFiles.kmsKeyId
                ? " Their lakehouse files stay encrypted under the customer's KMS key, readable while that key allows: for them to become unreadable too, the customer disables or deletes it."
                : ""}{" "}
              Type the key&apos;s name to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="The customer key's name"
            value={destroyName}
            onChange={(e) => setDestroyName(e.target.value)}
            placeholder={destroying?.name}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={destroyName.trim() !== destroying?.name}
              onClick={(e) => {
                e.preventDefault();
                void destroy();
              }}
            >
              Destroy the key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={erasing} onOpenChange={setErasing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase {userLabel(eraseUser)}&apos;s key?</AlertDialogTitle>
            <AlertDialogDescription>
              Every credential, connection and secret this user stored becomes unreadable, and so do
              the documents chat generated for them and the copies of their datasets. Type the
              user&apos;s email to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="The user's email"
            value={eraseEmail}
            onChange={(e) => setEraseEmail(e.target.value)}
            placeholder={userById.get(eraseUser)?.email ?? ""}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={
                eraseEmail.trim().toLowerCase() !==
                (userById.get(eraseUser)?.email ?? "").toLowerCase()
              }
              onClick={(e) => {
                e.preventDefault();
                void erase();
              }}
            >
              Erase the key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
