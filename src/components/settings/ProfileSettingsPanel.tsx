import { useEffect, useRef, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Upload, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

export type ProfileRow = {
  id?: string;
  user_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  role: string | null;
  designation: string | null;
  organization: string | null;
  bio: string | null;
};

/** The fields the profile form saves; the avatar saves on its own. */
function profileForm(p: ProfileRow): string {
  return JSON.stringify([
    p.first_name ?? "",
    p.last_name ?? "",
    p.display_name ?? "",
    p.role ?? "",
    p.designation ?? "",
    p.organization ?? "",
    p.bio ?? "",
  ]);
}

/**
 * The public-profile editor — avatar, name, role, org, bio. Shared between
 * the full /account page and the quick Settings dialog's Profile tab so
 * there is exactly one place this logic can drift, not two copies that
 * quietly disagree.
 *
 * `goneRef`: set by a page that deletes the account, so the way out does not
 * ask about this form's unsaved edits.
 */
export function ProfileSettingsPanel({ goneRef }: { goneRef?: { current: boolean } } = {}) {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  // Why the profile could not be read. The form is not offered then: it
  // would open blank, and Save would write the blanks over the stored
  // profile (R282).
  const [profileError, setProfileError] = useState<string | null>(null);
  // The form as loaded or last saved, so the page can tell what is unsaved
  // (R282, sweep 8).
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const unsaved = profile !== null && savedAs !== null && profileForm(profile) !== savedAs;

  useEffect(() => {
    if (!user) return;
    void loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function loadProfile() {
    if (!user) return;
    setProfileLoading(true);
    setProfileError(null);
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      setProfileError(error.message);
      setProfileLoading(false);
      return;
    }
    // No row is a profile not yet saved, which starts from the email.
    const loaded: ProfileRow = data
      ? (data as unknown as ProfileRow)
      : {
          user_id: user.id,
          display_name: user.email ?? "",
          first_name: null,
          last_name: null,
          avatar_url: null,
          role: null,
          designation: null,
          organization: null,
          bio: null,
        };
    setProfile(loaded);
    setSavedAs(profileForm(loaded));
    setProfileLoading(false);
  }

  async function saveProfile() {
    if (!user || !profile) return;
    setProfileSaving(true);
    try {
      const first = profile.first_name?.trim() || "";
      const last = profile.last_name?.trim() || "";
      // Keep display_name in sync with first/last when both are present
      const display = first && last ? `${first} ${last}` : profile.display_name?.trim() || null;
      const payload = {
        user_id: user.id,
        first_name: first || null,
        last_name: last || null,
        display_name: display,
        role: profile.role?.trim() || null,
        designation: profile.designation?.trim() || null,
        organization: profile.organization?.trim() || null,
        bio: profile.bio?.trim() || null,
        avatar_url: profile.avatar_url ?? null,
      } as Record<string, unknown>;
      const { error } = await supabase
        .from("profiles")
        .upsert(payload as never, { onConflict: "user_id" });
      if (error) throw error;
      // The form shows what was stored, and records it as saved; an edit
      // typed while the save was out stays on screen, unsaved.
      const stored: ProfileRow = { ...profile, ...(payload as Partial<ProfileRow>) };
      const sentForm = profileForm(profile);
      setProfile((p) => (p && profileForm(p) === sentForm ? stored : p));
      setSavedAs(profileForm(stored));
      toast.success("Profile updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be under 5 MB");
      return;
    }
    setAvatarUploading(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() || "png";
      const path = `${user.id}/avatar-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const publicUrl = pub.publicUrl;

      const { error: updErr } = await supabase
        .from("profiles")
        .upsert({ user_id: user.id, avatar_url: publicUrl } as never, { onConflict: "user_id" });
      if (updErr) throw updErr;

      setProfile((p) => (p ? { ...p, avatar_url: publicUrl } : p));
      toast.success("Profile picture updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setAvatarUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleAvatarRemove() {
    if (!user || !profile?.avatar_url) return;
    setAvatarUploading(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .upsert({ user_id: user.id, avatar_url: null } as never, { onConflict: "user_id" });
      if (error) throw error;
      setProfile((p) => (p ? { ...p, avatar_url: null } : p));
      toast.success("Profile picture removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setAvatarUploading(false);
    }
  }

  const initials = (profile?.display_name || user?.email || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // FOUND IN R282: the profile form kept no record of what was saved, so a
  // link or a closed tab left its edits behind without a word.
  useBlocker({
    shouldBlockFn: async () =>
      !goneRef?.current &&
      !(await confirmAsk({
        title: "Discard the changes to your profile?",
        body: "They are not saved. Leaving the page drops them.",
        actionLabel: "Discard changes",
      })),
    enableBeforeUnload: unsaved,
    disabled: !unsaved,
  });

  if (profileError !== null) {
    return (
      <div className="space-y-2 text-sm" data-testid="profile-load-error">
        <p className="text-destructive">Your profile could not be read: {profileError}</p>
        <Button size="sm" variant="outline" onClick={() => void loadProfile()}>
          Try again
        </Button>
      </div>
    );
  }

  if (profileLoading || !profile) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading profile…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <Avatar className="h-20 w-20 border border-border">
          {profile.avatar_url ? <AvatarImage src={profile.avatar_url} alt="Profile" /> : null}
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        <div className="space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarChange}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={avatarUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {avatarUploading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="mr-1.5 h-3.5 w-3.5" />
              )}
              {profile.avatar_url ? "Change picture" : "Upload picture"}
            </Button>
            {profile.avatar_url && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={avatarUploading}
                onClick={handleAvatarRemove}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PNG or JPG, up to 5 MB.</p>
        </div>
      </div>

      <Separator />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="first-name">
            First name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="first-name"
            value={profile.first_name ?? ""}
            onChange={(e) => setProfile({ ...profile, first_name: e.target.value })}
            placeholder="Ada"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="last-name">
            Last name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="last-name"
            value={profile.last_name ?? ""}
            onChange={(e) => setProfile({ ...profile, last_name: e.target.value })}
            placeholder="Lovelace"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="display-name">
            Display name{" "}
            <span className="text-xs font-normal text-muted-foreground">
              (auto-set from first + last; shown in the sidebar and user list)
            </span>
          </Label>
          <Input
            id="display-name"
            value={profile.display_name ?? ""}
            onChange={(e) => setProfile({ ...profile, display_name: e.target.value })}
            placeholder="Your name"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="role">Current role</Label>
          <Input
            id="role"
            value={profile.role ?? ""}
            onChange={(e) => setProfile({ ...profile, role: e.target.value })}
            placeholder="e.g. AI Engineer"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="designation">Designation</Label>
          <Input
            id="designation"
            value={profile.designation ?? ""}
            onChange={(e) => setProfile({ ...profile, designation: e.target.value })}
            placeholder="e.g. Senior Staff"
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="organization">Organization</Label>
          <Input
            id="organization"
            value={profile.organization ?? ""}
            onChange={(e) => setProfile({ ...profile, organization: e.target.value })}
            placeholder="e.g. Acme Inc."
          />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="bio">Short bio</Label>
          <Textarea
            id="bio"
            rows={3}
            value={profile.bio ?? ""}
            onChange={(e) => setProfile({ ...profile, bio: e.target.value })}
            placeholder="A short bio for your profile."
          />
        </div>
      </div>

      <div className="flex items-center justify-end gap-3">
        {unsaved && (
          <span
            className="text-xs text-amber-600 dark:text-amber-400"
            data-testid="profile-unsaved"
          >
            Unsaved changes
          </span>
        )}
        <Button onClick={saveProfile} disabled={profileSaving}>
          {profileSaving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Save profile
        </Button>
      </div>
    </div>
  );
}
