// The public pages the browser checks load, and the warm-up loads first.

/** The text a page must show; by default, any first-level heading. */
export const PAGES: { path: string; shows?: string }[] = [
  { path: "/" },
  { path: "/login", shows: "Sign in to your account" },
  { path: "/docs" },
  { path: "/docs/swarms" },
  { path: "/docs/knowledge" },
  { path: "/docs/self-hosting" },
  { path: "/security" },
  { path: "/architecture" },
  { path: "/about" },
  { path: "/privacy" },
  { path: "/terms" },
  { path: "/license" },
];
