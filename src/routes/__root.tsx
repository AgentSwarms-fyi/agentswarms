import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/hooks/use-theme";
import { CookieConsent } from "@/components/CookieConsent";

// Runs before React hydrates — sets the .dark class from localStorage so the
// page never flashes the wrong theme. Falls back to dark (the app default).
const themeBootScript = `
(function(){try{
  var t = localStorage.getItem('agentswarms.theme.v2');
  var d = document.documentElement;
  if (t === 'light') { d.classList.remove('dark'); d.style.colorScheme='light'; }
  else { d.classList.add('dark'); d.style.colorScheme='dark'; }
}catch(e){}})();
`;
// AgentSwarms - Educational Agentic AI Platform

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "AgentSwarms — The Hands-On School for Agentic AI" },
      {
        name: "description",
        content:
          "The interactive playground to learn Agentic AI by building it. Free curriculum: agents, RAG, tools, guardrails, multi-agent swarms, text-to-SQL.",
      },
      {
        name: "keywords",
        content:
          "agentic AI, learn agentic AI, agentic AI playground, agentic AI course, multi-agent systems, AI agents tutorial, RAG tutorial, LLM agents, AI agent builder, agent orchestration, swarm intelligence, hands-on AI learning, free agentic AI course, build AI agents, LangChain alternative, Langflow alternative",
      },
      { name: "author", content: "AgentSwarms" },
      { name: "google-site-verification", content: "ygg2nXLsleEPk5VKSn0eyspqKvV9-MLpL6RXbX6zOPI" },
      {
        name: "robots",
        content: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
      },
      {
        name: "googlebot",
        content: "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
      },
      { name: "theme-color", content: "#0F172A" },
      { property: "og:title", content: "AgentSwarms — The Hands-On School for Agentic AI" },
      {
        property: "og:description",
        content:
          "Learn Agentic AI by building it. Free interactive playground with 40+ lessons and 30+ runnable agents — RAG, tools, guardrails, swarms, SQL agents.",
      },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "AgentSwarms" },
      { property: "og:locale", content: "en_US" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "AgentSwarms — The Hands-On School for Agentic AI" },
      {
        name: "twitter:description",
        content: "AgentSwarm: Build, manage, and orchestrate generative AI agents and swarms.",
      },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1779185738527-Screenshot_2026-05-19_at_2.15.29_PM.webp",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1779185738527-Screenshot_2026-05-19_at_2.15.29_PM.webp",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // Fonts are self-hosted (public/fonts, @font-face in styles.css): an
      // enterprise deployment must not send every visitor to a font CDN, must
      // keep working air-gapped, and the variable files carry weights 100–900
      // where the old CDN link fetched four static cuts. Preloaded because
      // font-display: swap without a preload buys a visible reflow instead.
      {
        rel: "preload",
        href: "/fonts/inter-var-latin.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: "/fonts/inter-tight-var-latin.woff2",
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" },
      { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" },
      { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "EducationalOrganization",
          name: "AgentSwarms",
          alternateName: "AgentSwarms — School for Agentic AI",
          url: "https://agentswarms.fyi/",
          logo: "https://agentswarms.fyi/favicon-32x32.png",
          description:
            "The only interactive, hands-on playground for learning Agentic AI. Free curriculum covering agents, RAG, tools, guardrails, multi-agent swarms, and text-to-SQL.",
          sameAs: ["https://agentswarms.fyi/"],
        }),
      },
      {
        // Register the PWA service worker (installable + offline shell). Runs
        // in the browser only; failures are swallowed so they never affect load.
        children:
          "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <ThemeProvider>
      <Outlet />
      <Toaster />
      <CookieConsent />
    </ThemeProvider>
  );
}
