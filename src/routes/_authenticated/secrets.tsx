// Secrets Manager — the page itself is a thin shell now; the real
// create/edit/delete UI lives in SecretsManagerPanel so Settings → API Keys
// can host the identical controls inline.
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SecretsManagerPanel } from "@/components/settings/SecretsManagerPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import {
  createSecret,
  deleteSecret,
  listSecrets,
  updateSecret,
  type SecretSummary,
} from "@/utils/secrets.functions";
import { reportFailure } from "@/lib/silentFailureNet";

export const Route = createFileRoute("/_authenticated/secrets")({
  head: () => ({
    meta: [{ title: "Secrets — AgentSwarms" }],
  }),
  component: SecretsPage,
});

function SecretsPage() {
  const { session } = useAuth();
  const token = session?.access_token;

  const listFn = useServerFn(listSecrets);
  const createFn = useServerFn(createSecret);
  const updateFn = useServerFn(updateSecret);
  const deleteFn = useServerFn(deleteSecret);

  const [secrets, setSecrets] = useState<SecretSummary[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [editTarget, setEditTarget] = useState<SecretSummary | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Why the list could not be read, or null. Held in state rather than only
  // raised in a toast: the toast is the one element guaranteed to be gone by
  // the time somebody reads the page, and what it leaves behind is an empty
  // table that says the account has no secrets.
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!token) return;
    setLoadError(null);
    listFn({ data: { access_token: token } })
      .then((res) => {
        if (res.ok) {
          setSecrets(res.secrets);
          setMe(res.me);
        } else {
          // MEASURED: the server genuinely returned {ok:false,error:"Unauthorized"}
          // and this branch rendered "No secrets yet. Create one…" for an account
          // holding two. The toast was gone ten seconds later; the invitation to
          // start over was not.
          toast.error(res.error);
          setLoadError(res.error);
          setSecrets([]);
        }
      })
      .catch((e: unknown) => {
        // MEASURED: with the request rejected outright there was no catch at
        // all, so the skeleton stayed up indefinitely — no toast, no error, an
        // unhandled rejection in the console, and no Refresh control on this
        // page to retry with.
        const msg = e instanceof Error ? e.message : "Could not reach the server";
        toast.error(msg);
        setLoadError(msg);
        setSecrets([]);
      });
  }, [token, listFn]);

  useEffect(() => {
    reload();
  }, [reload]);

  const copyRef = (s: SecretSummary) => {
    void navigator.clipboard.writeText(`{{secret:${s.name}}}`);
    setCopiedId(s.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const submitCreate = async () => {
    if (!token) return;
    if (!name.trim()) return toast.error("Name is required");
    if (!value) return toast.error("Value is required");
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: token,
          name: name.trim(),
          description: description.trim() || undefined,
          value,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Secret created — reference it as {{secret:${name.trim()}}}`);
      setCreateOpen(false);
      setName("");
      setDescription("");
      setValue("");
      reload();
    } catch (e) {
      reportFailure("create the secret", e);
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!token || !editTarget) return;
    setBusy(true);
    try {
      const res = await updateFn({
        data: {
          access_token: token,
          secret_id: editTarget.id,
          description: editDescription,
          value: editValue || undefined,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(editValue ? "Secret value replaced" : "Secret updated");
      setEditTarget(null);
      setEditValue("");
      reload();
    } catch (e) {
      reportFailure("update the secret", e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: SecretSummary) => {
    if (!token) return;
    if (
      !(await confirmAsk({
        title: `Delete secret ${s.name}? Anything referencing it will stop working.`,
      }))
    )
      return;
    const res = await deleteFn({ data: { access_token: token, secret_id: s.id } });
    if (!res.ok) return toast.error(res.error);
    toast.success("Secret deleted");
    reload();
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          Integrations
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight flex items-center gap-2">
          <KeyRound className="h-7 w-7 text-primary" /> Secrets
        </h1>
      </div>

      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your secrets</CardTitle>
          <CardDescription>
            Sharing with other users or groups is managed by superadmins under Admin → IAM → Access.
            Shared secrets are usable in references but never readable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SecretsManagerPanel />
        </CardContent>
      </Card>
    </div>
  );
}
