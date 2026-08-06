// Reusable site footer — visible on landing/about/contact/privacy pages.
// Keeps the public marketing pages credible: links to legal pages, contact,
// and the project's home base. The admin email is intentionally NOT exposed
// here — visitors reach us through the contact form only.
import { Link } from "@tanstack/react-router";
import { Mail, LayoutDashboard } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { ThemeToggle } from "@/components/ThemeToggle";
import agentSwarmsLogo from "@/assets/agentswarms-logo.jpg";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M18.244 2H21l-6.52 7.45L22.5 22h-6.86l-4.78-6.27L5.4 22H2.64l6.97-7.96L1.5 2h6.99l4.32 5.71L18.244 2Zm-1.2 18h1.62L7.04 4H5.32l11.72 16Z" />
    </svg>
  );
}

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t border-border/40 bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div>
            <Link to="/" className="inline-flex items-center gap-2 font-semibold">
              <img
                src={agentSwarmsLogo}
                alt="AgentSwarms logo"
                width={24}
                height={24}
                className="h-6 w-6 shrink-0 rounded-md object-cover"
              />
              AgentSwarms
            </Link>
            <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Unified Agentic AI &amp; Business Intelligence
            </p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Agents, multi-agent swarms and an AI-native BI suite — deployed on your own
              infrastructure, with your database and your model keys. Source-available (Elastic
              License 2.0).
            </p>
          </div>

          {/* Learn — the handbook, blog, lessons and glossary live on the
              hosted project site at agentswarms.fyi, so link out to them. */}
          <div>
            <h4 className="text-sm font-semibold text-foreground">Learn</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                <a href="https://agentswarms.fyi/learn" className="hover:text-foreground">
                  Full handbook
                </a>
              </li>
              <li>
                <a href="https://agentswarms.fyi/blog" className="hover:text-foreground">
                  Blog
                </a>
              </li>
              <li>
                <a href="https://agentswarms.fyi/lessons" className="hover:text-foreground">
                  Lessons
                </a>
              </li>
              <li>
                <a href="https://agentswarms.fyi/learn#glossary" className="hover:text-foreground">
                  Glossary
                </a>
              </li>
              <li>
                <a
                  href="https://agentswarms.fyi/interview-questions"
                  className="hover:text-foreground"
                >
                  Interview Questions
                </a>
              </li>
            </ul>
          </div>

          {/* Product. The trust pages (architecture/security/licensing) are
              listed here because the footer is the one surface present on
              every public page — before this they were reachable only from
              the landing page's mobile menu. */}
          <div>
            <h4 className="text-sm font-semibold text-foreground">Product</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/architecture" className="hover:text-foreground">
                  Architecture
                </Link>
              </li>
              <li>
                <Link to="/security" className="hover:text-foreground">
                  Security
                </Link>
              </li>
              <li>
                <Link to="/license" className="hover:text-foreground">
                  Licensing
                </Link>
              </li>
              <li>
                <Link to="/about" className="hover:text-foreground">
                  About
                </Link>
              </li>
              <li>
                <Link to="/contact" className="hover:text-foreground">
                  Contact
                </Link>
              </li>
              <li>
                <Link to="/login" className="hover:text-foreground">
                  Sign in
                </Link>
              </li>
            </ul>
          </div>

          {/* Legal & Contact */}
          <div>
            <h4 className="text-sm font-semibold text-foreground">Legal & Contact</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/privacy" className="hover:text-foreground">
                  Privacy
                </Link>
              </li>
              <li>
                <Link to="/terms" className="hover:text-foreground">
                  Terms of Use
                </Link>
              </li>
              <li>
                <a
                  href="mailto:hello@agentswarms.fyi"
                  className="inline-flex items-center gap-1.5 hover:text-foreground"
                >
                  <Mail className="h-3 w-3" />
                  <span>hello@agentswarms.fyi</span>
                </a>
              </li>
              <li>
                <Link
                  to="/contact"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <Mail className="h-3 w-3" /> Report an issue
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-border/40 pt-6 text-xs text-muted-foreground sm:flex-row">
          <span>© {year} AgentSwarms — Unified Agentic AI &amp; Business Intelligence.</span>
          <span>Self-hosted · Source-available (ELv2) · Your data, your models.</span>
        </div>
      </div>
    </footer>
  );
}

// Slimmer header used on /about, /contact, /privacy, /pricing, /curriculum etc.
export function SiteHeader() {
  const { isAuthenticated, loading } = useAuth();
  return (
    <nav className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link to="/" className="inline-flex items-center gap-2 font-semibold">
          <img
            src={agentSwarmsLogo}
            alt="AgentSwarms AI School logo"
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-lg object-cover"
          />
          <span>AgentSwarms</span>
        </Link>
        <div className="flex items-center gap-4 text-sm text-muted-foreground sm:gap-5">
          <Link to="/docs" className="hidden hover:text-foreground sm:inline">
            Docs
          </Link>
          <Link to="/about" className="hidden hover:text-foreground md:inline">
            About
          </Link>
          <Link to="/contact" className="hidden hover:text-foreground md:inline">
            Contact
          </Link>
          {/* Same toggle the landing page offers — docs are read at length,
              so the reader gets to pick their theme without leaving the page. */}
          <ThemeToggle variant="ghost" className="h-8 w-8 text-muted-foreground" />
          {/* Reserve a fixed slot so the Sign in / Lab swap after Supabase
              resolves the session doesn't cause a visible flash on first paint. */}
          {loading ? (
            <span
              aria-hidden
              className="inline-flex h-[34px] w-[88px] rounded-md border border-border/60 bg-card/60"
            />
          ) : isAuthenticated ? (
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-foreground hover:border-primary/50"
            >
              <LayoutDashboard className="h-3.5 w-3.5" /> Lab
            </Link>
          ) : (
            <Link
              to="/login"
              className="rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-foreground hover:border-primary/50"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
