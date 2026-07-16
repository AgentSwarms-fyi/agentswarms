// Like / dislike for a blog post. Persists to the `blog_reactions` table (one
// row per user per post). Reads are public so counts show for everyone; writing
// requires sign-in. Degrades gracefully if the table isn't migrated yet.
import { useCallback, useEffect, useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

type Reaction = "like" | "dislike";
type Row = { user_id: string; reaction: Reaction };

export function BlogReactions({ slug }: { slug: string }) {
  const { user, isAuthenticated } = useAuth();
  const [likes, setLikes] = useState(0);
  const [dislikes, setDislikes] = useState(0);
  const [mine, setMine] = useState<Reaction | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await (
        supabase.from("blog_reactions" as never) as unknown as {
          select: (c: string) => {
            eq: (c: string, v: string) => Promise<{ data: Row[] | null }>;
          };
        }
      )
        .select("user_id, reaction")
        .eq("blog_slug", slug);
      const rows = data ?? [];
      setLikes(rows.filter((r) => r.reaction === "like").length);
      setDislikes(rows.filter((r) => r.reaction === "dislike").length);
      setMine(rows.find((r) => r.user_id === user?.id)?.reaction ?? null);
    } catch {
      /* table not migrated yet — non-fatal */
    }
  }, [slug, user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function react(reaction: Reaction) {
    if (!isAuthenticated || !user) {
      toast.info("Sign in to react to this post.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      if (mine === reaction) {
        // toggle off
        await (
          supabase.from("blog_reactions" as never) as unknown as {
            delete: () => {
              eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<unknown> };
            };
          }
        )
          .delete()
          .eq("user_id", user.id)
          .eq("blog_slug", slug);
      } else {
        await (
          supabase.from("blog_reactions" as never) as unknown as {
            upsert: (v: object, o: object) => Promise<{ error: unknown }>;
          }
        ).upsert(
          { user_id: user.id, blog_slug: slug, reaction },
          { onConflict: "user_id,blog_slug" },
        );
      }
      await load();
    } catch {
      toast.error("Couldn't save your reaction.");
    } finally {
      setBusy(false);
    }
  }

  const btn = (active: boolean) =>
    `inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
      active
        ? "border-primary/60 bg-primary/15 text-primary"
        : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
    }`;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => react("like")}
        className={btn(mine === "like")}
        aria-pressed={mine === "like"}
      >
        <ThumbsUp className="h-4 w-4" /> {likes}
      </button>
      <button
        type="button"
        onClick={() => react("dislike")}
        className={btn(mine === "dislike")}
        aria-pressed={mine === "dislike"}
      >
        <ThumbsDown className="h-4 w-4" /> {dislikes}
      </button>
      {!isAuthenticated && (
        <a href="/login" className="text-xs text-muted-foreground hover:text-foreground">
          Sign in to react
        </a>
      )}
    </div>
  );
}
