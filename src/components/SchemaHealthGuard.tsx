import { useCallback, useEffect, useState } from "react";
import {
  checkSchemaHealth,
  installSchemaHealthFetchInterceptor,
  type SchemaIssue,
} from "@/lib/schemaHealthCheck";
import { SchemaHealthModal } from "@/components/SchemaHealthModal";

// A dismissal only lasts the tab session, not forever: the underlying
// problem (an unapplied migration) hasn't gone away just because the modal
// was closed, so it's worth resurfacing on the next fresh load rather than
// staying silent indefinitely.
const DISMISS_KEY = "schemaHealth:dismissedAt";

function issueKey(issue: SchemaIssue): string {
  return `${issue.kind}:${issue.table}.${issue.column ?? ""}`;
}

/**
 * Mount once near the app root (see src/routes/__root.tsx). Runs the
 * proactive startup check and installs the reactive fetch interceptor, then
 * renders SchemaHealthModal if either one finds a missing column/table.
 * Renders nothing otherwise — this component has no visible footprint on a
 * healthy database.
 */
export function SchemaHealthGuard() {
  const [issues, setIssues] = useState<SchemaIssue[]>([]);
  const [dismissed, setDismissed] = useState(false);

  const addIssue = useCallback((issue: SchemaIssue) => {
    setIssues((prev) =>
      prev.some((i) => issueKey(i) === issueKey(issue)) ? prev : [...prev, issue],
    );
  }, []);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY)) setDismissed(true);
    } catch {
      // Storage disabled — just means dismissal won't be remembered either.
    }

    // Reactive layer: catches anything queried anywhere in the app, whether
    // or not it's in the curated REQUIRED_SCHEMA_CHECKS list.
    installSchemaHealthFetchInterceptor(addIssue);

    // Proactive layer: catches the curated list immediately, without
    // waiting for the user to navigate into whatever feature uses it.
    void checkSchemaHealth().then((found) => found.forEach(addIssue));
  }, [addIssue]);

  if (issues.length === 0 || dismissed) return null;

  return (
    <SchemaHealthModal
      open
      issues={issues}
      onDismiss={() => {
        setDismissed(true);
        try {
          window.sessionStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {
          // Ignore — the modal still closes, it just may reopen on
          // navigation within this same session.
        }
      }}
    />
  );
}
