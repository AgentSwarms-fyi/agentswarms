// The step palette.
//
// It sits down the side rather than in a row above the canvas, for the reason
// a row stops working at about six items: fifteen buttons wrapped over three
// lines pushed the canvas down the screen and told you nothing about which of
// them belonged together. A column can be grouped, and a group can carry a
// heading that says what the family is FOR — which is the thing somebody
// building their first graph actually needs.
import { Button } from "@/components/ui/button";
import { NODE_KIND_LABEL, type WorkflowNodeKind } from "@/lib/workflows";
import { cn } from "@/lib/utils";
import { KIND_GROUPS, KIND_STYLE } from "./nodeStyles";

export function WorkflowPalette({
  onAdd,
  disabled,
}: {
  onAdd: (kind: WorkflowNodeKind) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {KIND_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {group.label}
          </p>
          <p className="text-[10px] leading-tight text-muted-foreground/70">{group.hint}</p>
          <div className="grid gap-1 pt-0.5">
            {group.kinds.map((kind) => {
              const style = KIND_STYLE[kind];
              const Icon = style.icon;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  disabled={disabled}
                  title={style.blurb}
                  onClick={() => onAdd(kind)}
                  className={cn(
                    // `whitespace-normal` and `min-w-0` together are what stop
                    // the blurb running off the edge: the button is nowrap by
                    // default, and a nowrap flex child refuses to shrink, so
                    // the text overflowed the card instead of wrapping in it.
                    "h-auto w-full min-w-0 justify-start gap-2 whitespace-normal border px-2 py-1.5 text-left transition-colors",
                    style.tile,
                  )}
                >
                  <span className={cn("shrink-0 rounded p-1", style.chip)}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden">
                    <span className="block truncate text-[11px] font-medium leading-tight">
                      {NODE_KIND_LABEL[kind]}
                    </span>
                    <span className="block text-[10px] font-normal leading-tight opacity-70">
                      {style.blurb}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
