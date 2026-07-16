// View counter for blog posts. Reads counts from `blog_view_counts` and (when
// `increment` is true) calls the `increment_blog_view` RPC once per browser
// session per slug, so reloading the same post doesn't inflate the counter.
import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

const SESSION_KEY = "agentswarms.blog-views-counted";

function alreadyCountedThisSession(slug: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const set = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    if (set.has(slug)) return true;
    set.add(slug);
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify([...set]));
    return false;
  } catch {
    return false;
  }
}

function format(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function BlogViewCounter({
  slug,
  increment = false,
  initial,
  className,
}: {
  slug: string;
  increment?: boolean;
  initial?: number;
  className?: string;
}) {
  const [count, setCount] = useState<number | null>(initial ?? null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        if (increment && !alreadyCountedThisSession(slug)) {
          const { data } = await (
            supabase.rpc as unknown as (
              fn: string,
              args: Record<string, unknown>,
            ) => Promise<{ data: number | null }>
          )("increment_blog_view", { _slug: slug });
          if (!cancelled && typeof data === "number") {
            setCount(data);
            return;
          }
        }
        const { data } = await (
          supabase.from("blog_view_counts" as never) as unknown as {
            select: (c: string) => {
              eq: (
                c: string,
                v: string,
              ) => { maybeSingle: () => Promise<{ data: { views: number } | null }> };
            };
          }
        )
          .select("views")
          .eq("blog_slug", slug)
          .maybeSingle();
        if (!cancelled) setCount(data?.views ?? 0);
      } catch {
        if (!cancelled) setCount(0);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [slug, increment]);

  return (
    <span
      className={`inline-flex items-center gap-1 ${className ?? ""}`}
      aria-label="View count"
      title={count != null ? `${count} ${count === 1 ? "view" : "views"}` : "Views"}
    >
      <Eye className="h-3 w-3" />
      {count != null ? format(count) : "—"}
    </span>
  );
}
