import { createFileRoute, Link } from "@tanstack/react-router";
import { NOTEBOOKS } from "@/lib/notebooks/catalog";
import { Badge } from "@/components/ui/badge";
import { Notebook as NotebookIcon } from "lucide-react";

export const Route = createFileRoute("/_authenticated/notebooks/")({
  component: NotebooksEmptyState,
});

function NotebooksEmptyState() {
  return (
    <div className="h-full overflow-y-auto p-6 lg:p-8">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-6 flex items-start gap-3">
          <NotebookIcon className="mt-1 h-7 w-7 shrink-0 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">LangChain notebooks</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Choose any notebook below. Every example uses real LangChain packages and runnable cells.
            </p>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {NOTEBOOKS.map((notebook) => (
            <Link
              key={notebook.id}
              to="/notebooks/$notebookId"
              params={{ notebookId: notebook.id }}
              className="block rounded-md border border-border bg-card/50 p-4 transition hover:border-primary/60 hover:bg-card"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <h2 className="min-w-0 text-base font-semibold leading-snug break-words">
                  {notebook.title}
                </h2>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {notebook.difficulty}
                </Badge>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {notebook.description}
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {notebook.tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
