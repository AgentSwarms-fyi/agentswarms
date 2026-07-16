// Comment thread for a blog post. Reads are public; posting requires sign-in.
// Persists to the `blog_comments` table. Degrades gracefully if not migrated.
import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Trash2, Send } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

type Comment = {
  id: string;
  user_id: string;
  author_name: string;
  content: string;
  created_at: string;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function BlogComments({ slug }: { slug: string }) {
  const { user, isAuthenticated } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);

  const authorName =
    (user?.user_metadata?.name as string | undefined) ||
    (user?.email ? user.email.split("@")[0] : "Reader");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await (
        supabase.from("blog_comments" as never) as unknown as {
          select: (c: string) => {
            eq: (
              c: string,
              v: string,
            ) => {
              order: (c: string, o: { ascending: boolean }) => Promise<{ data: Comment[] | null }>;
            };
          };
        }
      )
        .select("id, user_id, author_name, content, created_at")
        .eq("blog_slug", slug)
        .order("created_at", { ascending: false });
      setComments(data ?? []);
    } catch {
      setComments([]);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const content = draft.trim();
    if (!content || !user) return;
    if (content.length > 2000) {
      toast.error("Comment is too long (2000 char max).");
      return;
    }
    setPosting(true);
    try {
      await (
        supabase.from("blog_comments" as never) as unknown as {
          insert: (v: object) => Promise<{ error: unknown }>;
        }
      ).insert({
        blog_slug: slug,
        user_id: user.id,
        author_name: authorName,
        content,
      });
      setDraft("");
      await load();
    } catch {
      toast.error("Couldn't post your comment. The comments table may not be set up yet.");
    } finally {
      setPosting(false);
    }
  }

  async function remove(id: string) {
    try {
      await (
        supabase.from("blog_comments" as never) as unknown as {
          delete: () => { eq: (c: string, v: string) => Promise<unknown> };
        }
      )
        .delete()
        .eq("id", id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast.error("Couldn't delete the comment.");
    }
  }

  return (
    <section className="space-y-6">
      <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-foreground">
        <MessageSquare className="h-5 w-5 text-primary" />
        Comments{" "}
        {comments.length > 0 && <span className="text-muted-foreground">({comments.length})</span>}
      </h2>

      {/* Composer */}
      {isAuthenticated ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Share your take, a war story, or a question…"
            className="w-full resize-y rounded-lg border border-border/60 bg-background/60 p-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Posting as <span className="font-medium text-foreground">{authorName}</span>
            </span>
            <button
              type="button"
              onClick={submit}
              disabled={posting || !draft.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" /> {posting ? "Posting…" : "Post comment"}
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
          <a href="/login" className="font-semibold text-primary hover:underline">
            Sign in
          </a>{" "}
          to join the discussion.
        </div>
      )}

      {/* Thread */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet — be the first.</p>
      ) : (
        <ul className="space-y-4">
          {comments.map((c) => (
            <li key={c.id} className="rounded-xl border border-border/60 bg-card/30 p-4">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-nexus-glow text-xs font-bold text-primary-foreground">
                  {c.author_name?.[0]?.toUpperCase() ?? "R"}
                </span>
                <span className="text-sm font-semibold text-foreground">{c.author_name}</span>
                <span className="text-xs text-muted-foreground">· {timeAgo(c.created_at)}</span>
                {user?.id === c.user_id && (
                  <button
                    type="button"
                    onClick={() => remove(c.id)}
                    className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
                    aria-label="Delete comment"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
                {c.content}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
