// A pipeline's secret bindings as rows: an environment variable, and the
// secret it is set to (R493).
//
// It was a textarea of `KEY={{secret:NAME}}` lines, a notation to learn, and
// a line spelled any other way was skipped by the run without a word. The
// rows write exactly those lines (src/lib/secretBindings.ts), so the run and
// the stored text are unchanged; a line from before that the run would skip
// shows here with what is wrong, and a save refuses it until it is fixed.
//
// The run binds these into the environment its code reads, so only secrets the
// pipeline's owner OWNS resolve: shared ones are not offered.
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretSelect } from "@/components/secrets/SecretSelect";
import { useRowKeys } from "@/hooks/use-row-keys";
import {
  parseSecretBindings,
  secretBindingsProblems,
  serializeSecretBindings,
  type SecretBindingRow,
} from "@/lib/secretBindings";
import { parseSecretRef, secretRef, suggestSecretName } from "@/lib/secretRefs";

export function SecretBindingsEditor({
  value,
  onChange,
}: {
  /** The stored bindings text, one `ENV_NAME={{secret:NAME}}` per line. */
  value: string;
  onChange: (text: string) => void;
}) {
  const rows = parseSecretBindings(value);
  const rowKeys = useRowKeys(rows.length);
  const problems = new Map(secretBindingsProblems(value).map((p) => [p.row, p.message]));
  const write = (next: SecretBindingRow[]) => onChange(serializeSecretBindings(next));
  const edit = (i: number, patch: Partial<SecretBindingRow>) =>
    write(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Secret bindings</Label>
      <p className="text-xs text-muted-foreground">
        Each sets an environment variable the pipeline&apos;s code reads, such as{" "}
        <code className="text-[11px]">os.environ[&quot;API_TOKEN&quot;]</code>, to one of your
        secrets. Resolved at run start, as the pipeline&apos;s owner, and scrubbed from its logs.
      </p>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">None yet.</p> : null}
      {rows.map((r, i) => {
        // Text where a secret belongs is said by the picker itself.
        const problem = r.value && !r.secret ? null : problems.get(i);
        return (
          <div key={rowKeys.keys[i]} className="space-y-0.5">
            <div className="flex items-start gap-1.5">
              <Input
                value={r.env}
                onChange={(e) => edit(i, { env: e.target.value.replace(/[^A-Za-z0-9_]/g, "") })}
                placeholder="API_TOKEN"
                aria-label={`Binding ${i + 1} environment variable`}
                aria-invalid={problem ? true : undefined}
                className="h-7 w-40 shrink-0 font-mono text-xs"
              />
              <span className="mt-1 text-xs text-muted-foreground" aria-hidden>
                =
              </span>
              <SecretSelect
                className="flex-1"
                size="sm"
                ownedOnly
                aria-label={`Binding ${i + 1} secret`}
                value={r.secret ? secretRef(r.secret) : r.value}
                onChange={(v) => {
                  const secret = parseSecretRef(v);
                  // A variable is usually named after its secret: start it there.
                  edit(i, { value: v, secret, ...(!r.env && secret ? { env: secret } : {}) });
                }}
                suggestedName={suggestSecretName(r.env) || undefined}
                rawNote="Set to text, not a secret, so the run ignores it. Pick a secret."
                purpose={r.env ? `For the ${r.env} environment variable.` : undefined}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={`Remove binding ${i + 1}`}
                onClick={() => {
                  rowKeys.removeAt(i);
                  write(rows.filter((_, j) => j !== i));
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
            {problem ? <p className="text-[11px] text-destructive">{problem}</p> : null}
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1 text-xs"
        // One blank row at a time: a second would only be another to remove.
        disabled={rows.some((r) => !r.env && !r.value)}
        onClick={() => write([...rows, { env: "", value: "", secret: null }])}
      >
        <Plus className="h-3.5 w-3.5" /> Add binding
      </Button>
    </div>
  );
}
