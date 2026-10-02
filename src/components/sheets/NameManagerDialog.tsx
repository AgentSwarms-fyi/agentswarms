// Data -> Names: the workbook's named ranges, as Excel's Name Manager.
// A name refers to cells (Data!$B$2:$B$13) or a value (0.2) and is used in
// formulas by name: =SUM(Revenue)*TaxRate. Renaming a name rewrites the
// formulas that use it; deleting one leaves them showing #NAME?.

import { useEffect, useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmAsk } from "@/components/ui/confirm-dialog";
import {
  MAX_NAMES,
  nameProblem,
  parseRef,
  qualifyRef,
  type DefinedName,
} from "@/lib/sheets/definedNames";

export function NameManagerDialog({
  open,
  onOpenChange,
  onClosed,
  names,
  readOnly,
  activeSheet,
  selectionRef,
  tableNames,
  preview,
  onChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Where the keyboard goes once the dialog is gone (the grid). */
  onClosed?: () => void;
  names: DefinedName[];
  readOnly: boolean;
  /** A reference typed without a sheet is on this one. */
  activeSheet: string;
  /** The selection, as a new name's reference starts. */
  selectionRef: string;
  /** Table sheets' names: a formula reads those as the table. */
  tableNames: string[];
  /** What a reference comes to now, shown beside each name. */
  preview: (ref: string) => string;
  /** The whole new list, and the rename when a name's name changed. */
  onChange: (next: DefinedName[], renamed?: { from: string; to: string }) => void;
}) {
  // The name being edited (its name before editing), or null for a new one.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ref, setRef] = useState(selectionRef);
  const [comment, setComment] = useState("");
  const [touched, setTouched] = useState(false);
  const [filter, setFilter] = useState("");

  const reset = (to = selectionRef) => {
    setEditing(null);
    setName("");
    setRef(to);
    setComment("");
    setTouched(false);
  };
  useEffect(() => {
    if (open) {
      reset();
      setFilter("");
    }
    // Once per opening: the selection does not move while the dialog is up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const problem = useMemo(() => {
    const others = names
      .filter((d) => d.name.toLowerCase() !== editing?.toLowerCase())
      .map((d) => d.name);
    const p = nameProblem(name, others);
    if (p) return p;
    if (tableNames.some((t) => t.toLowerCase() === name.trim().toLowerCase()))
      return `"${name.trim()}" is a table sheet's name; choose another name`;
    if (!editing && names.length >= MAX_NAMES) return `A workbook keeps at most ${MAX_NAMES} names`;
    const r = parseRef(qualifyRef(ref, activeSheet));
    return r.ok ? null : r.error;
  }, [name, ref, editing, names, tableNames, activeSheet]);

  const submit = () => {
    setTouched(true);
    if (problem || readOnly) return;
    const d: DefinedName = {
      name: name.trim(),
      ref: qualifyRef(ref, activeSheet),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    if (editing) {
      const next = names.map((x) => (x.name.toLowerCase() === editing.toLowerCase() ? d : x));
      onChange(next, editing !== d.name ? { from: editing, to: d.name } : undefined);
    } else {
      onChange([...names, d]);
    }
    reset();
  };

  const remove = async (d: DefinedName) => {
    const yes = await confirmAsk({
      title: `Delete the name ${d.name}?`,
      body: "Formulas that use it show #NAME? until a name of that name is defined again. Undo (Ctrl+Z) brings it back.",
      actionLabel: "Delete",
    });
    if (!yes) return;
    onChange(names.filter((x) => x !== d));
    if (editing?.toLowerCase() === d.name.toLowerCase()) reset();
  };

  const shown = names.filter(
    (d) =>
      !filter.trim() ||
      d.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
      d.ref.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        data-testid="name-manager"
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
      >
        <DialogHeader>
          <DialogTitle>Names</DialogTitle>
          <DialogDescription>
            Names for cells, ranges and values, used in formulas by name: =SUM(Revenue)*TaxRate.
            Typing a new name in the Name box names the selection too.
          </DialogDescription>
        </DialogHeader>

        {names.length > 6 && (
          <Input
            aria-label="Find a name"
            placeholder="Find a name or reference"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 text-xs"
          />
        )}
        <div className="max-h-72 overflow-auto rounded border border-border">
          {names.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No names yet.{" "}
              {readOnly ? "" : "Name the selection below, or type a name in the Name box."}
            </p>
          ) : (
            <table className="w-full text-xs" data-testid="name-list">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Name</th>
                  <th className="px-2 py-1.5 font-medium">Refers to</th>
                  <th className="px-2 py-1.5 font-medium">Value</th>
                  {!readOnly && <th className="w-16 px-2 py-1.5" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr
                    key={d.name}
                    className="border-t border-border align-top"
                    data-name={d.name}
                    aria-selected={editing?.toLowerCase() === d.name.toLowerCase()}
                  >
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{d.name}</div>
                      {d.comment && <div className="text-muted-foreground">{d.comment}</div>}
                    </td>
                    <td className="break-all px-2 py-1.5 font-mono">{d.ref}</td>
                    <td
                      className="max-w-[16rem] truncate px-2 py-1.5 font-mono tabular-nums"
                      data-testid="name-value"
                      title={preview(d.ref)}
                    >
                      {preview(d.ref)}
                    </td>
                    {!readOnly && (
                      <td className="whitespace-nowrap px-1 py-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label={`Edit ${d.name}`}
                          onClick={() => {
                            setEditing(d.name);
                            setName(d.name);
                            setRef(d.ref);
                            setComment(d.comment ?? "");
                            setTouched(false);
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          aria-label={`Delete ${d.name}`}
                          onClick={() => void remove(d)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!readOnly && (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1.4fr]"
            data-testid="name-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="name-name">{editing ? `Name (was ${editing})` : "New name"}</Label>
              <Input
                id="name-name"
                value={name}
                placeholder="Revenue"
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="name-ref">Refers to</Label>
              <Input
                id="name-ref"
                className="font-mono"
                value={ref}
                placeholder="Data!$B$2:$B$13, or 0.2"
                autoComplete="off"
                onChange={(e) => setRef(e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="name-comment">Comment (optional)</Label>
              <Input
                id="name-comment"
                value={comment}
                maxLength={1000}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 sm:col-span-2">
              {touched && problem ? (
                <p className="mr-auto text-xs text-destructive" role="alert">
                  {problem}
                </p>
              ) : (
                <p className="mr-auto text-xs text-muted-foreground">
                  {ref.trim() && !problem ? `Now: ${preview(qualifyRef(ref, activeSheet))}` : ""}
                </p>
              )}
              {editing && (
                <Button type="button" variant="ghost" size="sm" onClick={() => reset()}>
                  Cancel edit
                </Button>
              )}
              <Button type="submit" size="sm" data-testid="name-save">
                {editing ? "Save name" : "Add name"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
