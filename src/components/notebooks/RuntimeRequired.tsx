// Shown when the server runtime isn't available yet. Notebooks execute on real
// container kernels (there is no browser fallback), so instead of a dead "it
// doesn't work" state this tells the developer exactly what to run and where to
// enable it — with the admin path surfaced only to people who can act on it.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Check, Copy, Server, ShieldCheck, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useIsSuperadmin } from "@/hooks/use-iam";

const COMPOSE_CMD = "docker compose --profile notebooks up -d --build";
const VERIFY_CMD = "bash deploy/notebooks/test/verify-runtime.sh";

function CommandRow({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 text-[11px]">
        {cmd}
      </code>
      <Button
        size="sm"
        variant="secondary"
        className="h-7 shrink-0 gap-1 text-xs"
        onClick={() => {
          void navigator.clipboard.writeText(cmd);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
        Copy
      </Button>
    </div>
  );
}

export function RuntimeRequired({ reason }: { reason?: string }) {
  const isSuperadmin = useIsSuperadmin();

  return (
    <div className="mx-auto max-w-2xl rounded-lg border border-border bg-card/50 p-6">
      <div className="mb-3 flex items-start gap-3">
        <Server className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Server runtime required</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Notebooks run on real container kernels — full CPython with <code>pip install</code> and
            the actual frameworks (LangChain, LangGraph, LlamaIndex). That runtime isn&apos;t
            available yet, so cells can&apos;t execute.
          </p>
          {reason ? (
            <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs">
              {reason}
            </p>
          ) : null}
        </div>
      </div>

      <div className="space-y-4 text-sm">
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <Terminal className="h-3.5 w-3.5" /> 1 · Start the runtime services
          </p>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Run this once on the host (the first build installs the frameworks, so it takes a few
            minutes):
          </p>
          <CommandRow cmd={COMPOSE_CMD} />
        </div>

        <div>
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <ShieldCheck className="h-3.5 w-3.5" /> 2 · Enable it
          </p>
          {isSuperadmin ? (
            <p className="text-xs text-muted-foreground">
              Open{" "}
              <Link to="/admin/runtime" className="text-primary hover:underline">
                Admin → Developer runtime
              </Link>
              , run the preflight, and switch <strong>Enable server runtime</strong> on. The signing
              secret is generated for you.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Ask an administrator to enable it under <strong>Admin → Developer runtime</strong>.
              They may also need to grant your account access.
            </p>
          )}
        </div>

        <div>
          <p className="mb-1.5 flex items-center gap-1.5 font-medium">
            <Terminal className="h-3.5 w-3.5" /> 3 · Verify (optional)
          </p>
          <p className="mb-1.5 text-xs text-muted-foreground">
            Checks the whole chain and prints a pass/fail report:
          </p>
          <CommandRow cmd={VERIFY_CMD} />
        </div>
      </div>
    </div>
  );
}
