// The "New secret" form: the Secrets page's own, and the one a secret picker
// opens in place so a key can be stored without leaving the form that needs
// it (R493). The value is encrypted by the server on save and never comes
// back; the caller learns only the new secret's name.
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { hostLines, parseAllowedHosts } from "@/lib/secretHosts";
import { SECRET_NAME_MAX, isSecretName } from "@/lib/secretRefs";
import { reportFailure } from "@/lib/silentFailureNet";
import { createSecret } from "@/utils/secrets.functions";

/**
 * Where colleagues it is shared with may send this secret. Your own use is
 * never limited; the field is about other people.
 */
export function AllowedHostsField({
  value,
  onChange,
  id = "secret-allowed-hosts",
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const parsed = useMemo(() => parseAllowedHosts(hostLines(value)), [value]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Allowed hosts (for people it is shared with)</Label>
      <Textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="font-mono text-xs"
        placeholder={"acme.snowflakecomputing.com\n*.openai.azure.com"}
        aria-invalid={!parsed.ok}
        aria-describedby={`${id}-help`}
      />
      {!parsed.ok ? (
        <p role="alert" className="text-xs text-destructive">
          {parsed.error}
        </p>
      ) : null}
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        One per line. Someone this secret is shared with can send it only to these hosts, and only
        as a credential: never in a URL or request body, never into code they run. Your own use is
        not limited. Left empty, only you can use it.
      </p>
    </div>
  );
}

export function CreateSecretDialog({
  open,
  onOpenChange,
  onCreated,
  initialName = "",
  initialHosts = [],
  purpose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new secret's name once the server has stored it. */
  onCreated: (name: string) => void;
  /** A name to start from, such as one the field suggests. */
  initialName?: string;
  /** Allowed hosts to start from: where the field that asked sends it. */
  initialHosts?: readonly string[];
  /** Which field it is for, in a sentence under the title. */
  purpose?: string;
}) {
  const createFn = useServerFn(createSecret);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [hosts, setHosts] = useState("");
  const [busy, setBusy] = useState(false);

  // Each opening starts from the field's suggestions; a value typed for a
  // secret that was not saved never waits in the form for the next one.
  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }
    setName(initialName);
    setDescription("");
    setValue("");
    setHosts(initialHosts.join("\n"));
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const nameProblem =
    trimmed && !isSecretName(trimmed)
      ? `Start with a letter; letters, digits and _ only, at most ${SECRET_NAME_MAX}.`
      : null;

  const submit = async () => {
    if (!trimmed) return toast.error("Name is required");
    if (nameProblem) return toast.error(nameProblem);
    if (!value) return toast.error("Value is required");
    const allowed = parseAllowedHosts(hostLines(hosts));
    if (!allowed.ok) return toast.error(allowed.error);
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return toast.error("Your session expired. Sign in again.");
    setBusy(true);
    try {
      const res = await createFn({
        data: {
          access_token: token,
          name: trimmed,
          description: description.trim() || undefined,
          value,
          allowed_hosts: allowed.hosts,
        },
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(`Secret ${trimmed} saved, encrypted`);
      setValue("");
      onCreated(trimmed);
      onOpenChange(false);
    } catch (e) {
      reportFailure("create the secret", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New secret</DialogTitle>
          <DialogDescription>
            {purpose ? `${purpose} ` : ""}The value is encrypted on save and can be replaced later,
            but never viewed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-secret-name">Name</Label>
            <Input
              id="new-secret-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="SNOWFLAKE_PROD_TOKEN"
              className="font-mono"
              autoComplete="off"
              aria-invalid={!!nameProblem}
              aria-describedby="new-secret-name-help"
            />
            <p
              id="new-secret-name-help"
              className={nameProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {nameProblem ??
                "Letters, digits and underscores, starting with a letter. Forms list it by this name."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-secret-description">Description (optional)</Label>
            <Input
              id="new-secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-secret-value">Value</Label>
            <Textarea
              id="new-secret-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              className="font-mono text-xs"
              placeholder="The API key / token / password to store"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <AllowedHostsField value={hosts} onChange={setHosts} id="new-secret-allowed-hosts" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
