import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { getNotebook, getNotebookSummary, NOTEBOOKS } from "@/lib/notebooks/catalog";
import type { Notebook } from "@/lib/notebooks/types";
import { NotebookViewer } from "@/components/notebooks/NotebookViewer";

export const Route = createFileRoute("/_authenticated/notebooks/$notebookId")({
  head: ({ params }) => {
    const nb = getNotebookSummary(params.notebookId);
    const title = nb ? `${nb.title} — Notebooks` : "Notebook — AgentSwarms";
    const description = nb?.description ?? "Interactive TypeScript notebook on AgentSwarms.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
      ],
    };
  },
  loader: async ({ params }) => {
    const nb = await getNotebook(params.notebookId);
    if (!nb) throw notFound();
    return { notebook: nb };
  },
  component: NotebookPage,
  notFoundComponent: () => (
    <div className="p-8 text-center">
      <h2 className="text-xl font-semibold">Notebook not found</h2>
      <p className="mt-2 text-muted-foreground">Pick one from the list:</p>
      <ul className="mt-4 inline-block text-left">
        {NOTEBOOKS.map((n) => (
          <li key={n.id}>
            <Link to="/notebooks/$notebookId" params={{ notebookId: n.id }} className="text-primary underline">
              {n.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="p-8">
      <h2 className="text-xl font-semibold text-destructive">Couldn't load notebook</h2>
      <pre className="mt-2 text-sm text-muted-foreground">{error.message}</pre>
    </div>
  ),
});

function NotebookPage() {
  // TanStack's generated route types fail to infer this loader's return type
  // (known quirk with async loaders that throw notFound()); the cast matches
  // the loader's actual `{ notebook }` return above.
  const { notebook } = Route.useLoaderData() as unknown as { notebook: Notebook };
  return <NotebookViewer notebook={notebook} />;
}
