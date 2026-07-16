import { createFileRoute } from "@tanstack/react-router";
import { BLOG_POSTS } from "@/lib/blog";

const SITE_URL = "https://agentswarms.fyi";

// Public, indexable routes only. Authenticated app routes are excluded
// because they live behind /login and are marked noindex.
const PUBLIC_ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/curriculum", changefreq: "weekly", priority: "0.95" },
  { path: "/learn", changefreq: "weekly", priority: "0.95" },
  { path: "/interview-questions", changefreq: "weekly", priority: "0.9" },
  { path: "/blog", changefreq: "weekly", priority: "0.9" },
  ...BLOG_POSTS.map((p) => ({ path: `/blog/${p.slug}`, changefreq: "monthly", priority: "0.8" })),
  { path: "/pricing", changefreq: "monthly", priority: "0.8" },
  { path: "/about", changefreq: "monthly", priority: "0.7" },
  { path: "/contact", changefreq: "monthly", priority: "0.5" },
  { path: "/docs", changefreq: "weekly", priority: "0.85" },
  { path: "/docs/dashboard", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/agents", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/swarms", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/playground", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/notebooks", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/skills", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/templates", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/integrations", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/analytics", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/debugging", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/certification", changefreq: "monthly", priority: "0.7" },
  { path: "/docs/account", changefreq: "monthly", priority: "0.7" },
  { path: "/login", changefreq: "monthly", priority: "0.3" },
  { path: "/reset-password", changefreq: "yearly", priority: "0.2" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const lastmod = new Date().toISOString().slice(0, 10);
        const urls = PUBLIC_ROUTES.map(
          (r) =>
            `  <url>\n` +
            `    <loc>${SITE_URL}${r.path}</loc>\n` +
            `    <lastmod>${lastmod}</lastmod>\n` +
            `    <changefreq>${r.changefreq}</changefreq>\n` +
            `    <priority>${r.priority}</priority>\n` +
            `  </url>`,
        ).join("\n");

        const sitemap =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          `${urls}\n` +
          `</urlset>\n`;

        return new Response(sitemap, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
