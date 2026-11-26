// The one repository connection's settings: GitHub or GitLab, repository,
// branch, folder, host and the access token picked from the user's secrets.
// Shared by Integrations → Git repository and BI's Git sync dialog (R541), so
// both edit the same settings the same way.
//
// The token is one of the user's secrets, picked by name (R494); a token
// typed in before is stored encrypted and never read back to the client (it
// shows as a key saved in the field until a secret is picked).
import { useEffect, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTokenRef } from "@/hooks/use-token-ref";
import { SecretSelect } from "@/components/secrets/SecretSelect";
import { parseSecretRef, secretRef } from "@/lib/secretRefs";
import { gitGetConfig, gitSaveConfig } from "@/utils/gitExport.functions";

export type GitLastExport = { at: string | null; status: string | null; error: string | null };

export type GitRepositorySettings = {
  loading: boolean;
  saving: boolean;
  /** Whether settings are stored at all. */
  saved: boolean;
  canSave: boolean;
  provider: "github" | "gitlab";
  repo: string;
  branch: string;
  folder: string;
  last: GitLastExport;
  setLast: (l: GitLastExport) => void;
  /** Saves the form; resolves false (after saying why) when it could not. */
  save: () => Promise<boolean>;
  fields: ReactNode;
};

/**
 * The settings form's state and fields. Loads when `enabled` turns on (a
 * dialog opening, a tab shown), not when the session refreshes (R125): that
 * put the saved repo, branch and folder back over unsaved edits.
 */
export function useGitRepositorySettings(token: string, enabled: boolean): GitRepositorySettings {
  const { tokenRef, signedIn } = useTokenRef(token);
  const getConfig = useServerFn(gitGetConfig);
  const saveConfig = useServerFn(gitSaveConfig);

  const [provider, setProvider] = useState<"github" | "gitlab">("github");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [basePath, setBasePath] = useState("agentswarms");
  const [host, setHost] = useState("");
  const [pat, setPat] = useState("");
  const [hasToken, setHasToken] = useState(false);
  // The secret the saved token names, when it names one.
  const [tokenSecret, setTokenSecret] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [last, setLast] = useState<GitLastExport>({ at: null, status: null, error: null });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const token = tokenRef.current;
    if (!enabled || !token) return;
    setLoading(true);
    getConfig({ data: { access_token: token } })
      .then((res) => {
        if (!res.ok) throw new Error(res.error);
        if (res.config) {
          const c = res.config;
          setProvider(c.provider === "gitlab" ? "gitlab" : "github");
          setRepo(c.repo);
          setBranch(c.branch);
          setBasePath(c.base_path);
          setHost(c.host ?? "");
          setHasToken(c.has_token);
          setTokenSecret(c.token_secret);
          setLast({ at: c.last_export_at, status: c.last_status, error: c.last_error });
          setSaved(true);
        }
      })
      .catch((e) => toast.error((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signedIn, getConfig]);

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const res = await saveConfig({
        data: {
          access_token: tokenRef.current,
          provider,
          repo: repo.trim(),
          branch: branch.trim(),
          base_path: basePath.trim() || "agentswarms",
          host: provider === "gitlab" ? host.trim() || undefined : undefined,
          // Only send the token when one was picked (keeps the stored one otherwise).
          token: pat ? pat : undefined,
        },
      });
      if (!res.ok) throw new Error(res.error);
      if (pat) {
        setHasToken(true);
        setTokenSecret(parseSecretRef(pat));
        setPat("");
      }
      setSaved(true);
      toast.success("Repository settings saved");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const fields = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5">
        <div className="space-y-1.5">
          <Label className="text-xs">Provider</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as "github" | "gitlab")}>
            <SelectTrigger className="h-9 text-sm" aria-label="Provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="gitlab">GitLab</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="git-branch">
            Branch
          </Label>
          <Input
            id="git-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="h-9 text-sm"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="git-repo">
          {provider === "github" ? "Repository (owner/name)" : "Project (group/project or its id)"}
        </Label>
        <Input
          id="git-repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="h-9 font-mono text-xs"
          placeholder="acme/analytics"
        />
      </div>
      {provider === "gitlab" && (
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="git-host">
            Host (self-hosted, optional)
          </Label>
          <Input
            id="git-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="h-9 font-mono text-xs"
            placeholder="https://gitlab.example.com"
          />
        </div>
      )}
      <div className="space-y-1.5">
        <Label className="text-xs" htmlFor="git-folder">
          Folder in repo
        </Label>
        <Input
          id="git-folder"
          value={basePath}
          onChange={(e) => setBasePath(e.target.value)}
          className="h-9 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Access token</Label>
        <SecretSelect
          aria-label="Access token"
          value={pat || (tokenSecret ? secretRef(tokenSecret) : "")}
          onChange={setPat}
          storedKey={hasToken && !tokenSecret}
          destination={
            provider === "github" ? "https://api.github.com" : host.trim() || "https://gitlab.com"
          }
          suggestedName={provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN"}
          purpose="A personal access token that can read and write the repository."
        />
      </div>
    </div>
  );

  return {
    loading,
    saving,
    saved,
    canSave: repo.trim() !== "" && branch.trim() !== "",
    provider,
    repo,
    branch,
    folder: basePath.trim().replace(/^\/+|\/+$/g, "") || "agentswarms",
    last,
    setLast,
    save,
    fields,
  };
}
