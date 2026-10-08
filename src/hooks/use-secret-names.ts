import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { listSecrets } from "@/utils/secrets.functions";

// ── Data the pickers read ───────────────────────────────────────────────────

/** The caller's secrets by name (own and IAM-granted), never their values. */
export function useSecretNames(token: string): { names: string[]; loaded: boolean } {
  const fn = useServerFn(listSecrets);
  const [names, setNames] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!token) return;
    void fn({ data: { access_token: token } })
      .then((res) => {
        if (res.ok) setNames(res.secrets.map((s) => s.name));
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return { names, loaded };
}
