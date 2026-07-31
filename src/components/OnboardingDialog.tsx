// First-run onboarding dialog. Shown to any authenticated user whose profile
// is missing first_name or last_name. We need these to print a real human
// name on the certification certificate (instead of the email local-part)
// and on community attributions. Cannot be dismissed without saving — both
// fields are required.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

export function OnboardingDialog() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(true);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [organization, setOrganization] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setChecking(true);
      const { data } = await supabase
        .from("profiles")
        .select("first_name,last_name,organization,display_name")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;

      const row = data as {
        first_name?: string | null;
        last_name?: string | null;
        organization?: string | null;
        display_name?: string | null;
      } | null;
      const hasName = !!(row?.first_name?.trim() && row?.last_name?.trim());
      if (!hasName) {
        // Pre-fill from OAuth metadata when available
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        const metaFull =
          (typeof meta.full_name === "string" && meta.full_name.trim()) ||
          (typeof meta.name === "string" && meta.name.trim()) ||
          row?.display_name?.trim() ||
          "";
        if (metaFull) {
          const parts = metaFull.split(/\s+/);
          setFirst(parts[0] ?? "");
          setLast(parts.slice(1).join(" ") || "");
        }
        setOrganization(row?.organization ?? "");
        setOpen(true);
      }
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function handleSave() {
    if (!user) return;
    const f = first.trim();
    const l = last.trim();
    if (!f || !l) {
      toast.error("Please enter both first and last name");
      return;
    }
    setSaving(true);
    try {
      const display = `${f} ${l}`;
      const payload = {
        user_id: user.id,
        first_name: f,
        last_name: l,
        display_name: display,
        organization: organization.trim() || null,
      } as Record<string, unknown>;
      const { error } = await supabase
        .from("profiles")
        .upsert(payload as never, { onConflict: "user_id" });
      if (error) throw error;
      toast.success("Welcome! Your profile is set up.");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (checking || !user) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        /* not dismissible until saved */ if (!saving && v) setOpen(true);
      }}
    >
      <DialogContent
        className="sm:max-w-md [&>button.absolute]:hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" /> Welcome to AgentSwarms
          </DialogTitle>
          <DialogDescription>
            Tell us your name so we can print it on your certificate when you pass the certification
            exam.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ob-first">First name *</Label>
              <Input
                id="ob-first"
                autoFocus
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                placeholder="Ada"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ob-last">Last name *</Label>
              <Input
                id="ob-last"
                value={last}
                onChange={(e) => setLast(e.target.value)}
                placeholder="Lovelace"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-org">Organization (optional)</Label>
            <Input
              id="ob-org"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              placeholder="Acme Inc."
            />
          </div>
          <p className="text-xs text-muted-foreground">
            You can update this anytime in <span className="font-medium">Account Settings</span>.
          </p>
          <Button className="w-full" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Continue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
