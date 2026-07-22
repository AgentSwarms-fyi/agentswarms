// Lightweight, module-cached IAM directory for the approval-node approver
// picker. Any authenticated user can read it (server fn validates the token
// then uses the service role). One fetch is shared across all consumers.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  listApproverDirectory,
  type ApproverDirectoryUser,
  type ApproverDirectoryGroup,
} from "@/utils/swarmApprovals.functions";

export type ApproverDirectory = {
  users: ApproverDirectoryUser[];
  groups: ApproverDirectoryGroup[];
  myGroupIds: string[];
};

const EMPTY: ApproverDirectory = { users: [], groups: [], myGroupIds: [] };

let cache: Promise<ApproverDirectory> | null = null;

async function load(): Promise<ApproverDirectory> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return EMPTY;
  try {
    const res = await listApproverDirectory({ data: { access_token: token } });
    if (!res.ok) return EMPTY;
    return { users: res.users, groups: res.groups, myGroupIds: res.my_group_ids };
  } catch {
    return EMPTY;
  }
}

export function useApproverDirectory(enabled: boolean) {
  const [directory, setDirectory] = useState<ApproverDirectory | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    if (!cache) cache = load();
    cache
      .then((d) => {
        if (!cancelled) {
          setDirectory(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { directory, loading };
}

export function invalidateApproverDirectory() {
  cache = null;
}
