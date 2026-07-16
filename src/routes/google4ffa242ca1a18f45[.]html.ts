import { createFileRoute } from "@tanstack/react-router";

// Google Search Console domain/site verification file.
// Must respond with this exact body at /google4ffa242ca1a18f45.html
export const Route = createFileRoute("/google4ffa242ca1a18f45.html")({
  server: {
    handlers: {
      GET: async () => {
        return new Response("google-site-verification: google4ffa242ca1a18f45.html", {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});