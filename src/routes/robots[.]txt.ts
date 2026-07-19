import { createFileRoute } from "@tanstack/react-router";

// Domain-agnostic robots.txt for self-hosted instances.
// Public marketing/docs pages are crawlable; the authenticated app,
// auth flows, and API are not.
export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () => {
        const body =
          `User-agent: *\n` +
          `Allow: /\n` +
          `Disallow: /login\n` +
          `Disallow: /reset-password\n` +
          `Disallow: /verify\n` +
          `Disallow: /dashboard\n` +
          `Disallow: /agents\n` +
          `Disallow: /swarms\n` +
          `Disallow: /playground\n` +
          `Disallow: /image-playground\n` +
          `Disallow: /prompt-compare\n` +
          `Disallow: /prompts\n` +
          `Disallow: /skills\n` +
          `Disallow: /patterns\n` +
          `Disallow: /knowledge\n` +
          `Disallow: /data-sql\n` +
          `Disallow: /notebooks\n` +
          `Disallow: /traces\n` +
          `Disallow: /analytics\n` +
          `Disallow: /budgets\n` +
          `Disallow: /integrations\n` +
          `Disallow: /model-registry\n` +
          `Disallow: /mcp\n` +
          `Disallow: /account\n` +
          `Disallow: /templates\n` +
          `Disallow: /certification\n` +
          `Disallow: /admin\n` +
          `Disallow: /api/\n` +
          `Disallow: /email/\n`;

        return new Response(body, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
