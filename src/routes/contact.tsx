import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { ArrowRight, Loader2, Mail, MessageSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";

const ClientSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(255),
  subject: z.string().trim().max(200).optional().or(z.literal("")),
  message: z
    .string()
    .trim()
    .min(10, "Tell us a bit more (at least 10 characters)")
    .max(5000, "Please keep it under 5000 characters"),
  website: z.string().max(0).optional().or(z.literal("")),
});

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact AgentSwarms — We read every message" },
      {
        name: "description",
        content:
          "Have feedback, a partnership idea, or a bug to report? Send a message to the AgentSwarms team — we read every one and reply within 1–2 business days.",
      },
      { property: "og:title", content: "Contact AgentSwarms" },
      {
        property: "og:description",
        content: "Get in touch with the team behind AgentSwarms.",
      },
      { property: "og:url", content: "https://agentswarms.fyi/contact" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Contact AgentSwarms" },
      { name: "twitter:description", content: "Get in touch with the team behind AgentSwarms." },
      {
        property: "og:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
      {
        name: "twitter:image",
        content:
          "https://storage.googleapis.com/gpt-engineer-file-uploads/A8j55GgL3fSxUGx8RgucpYdm9B63/social-images/social-1776452942019-Captsvvsvsure.webp",
      },
    ],
    links: [{ rel: "canonical", href: "https://agentswarms.fyi/contact" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "ContactPage",
          name: "Contact AgentSwarms",
          url: "https://agentswarms.fyi/contact",
          description: "Get in touch with the team behind AgentSwarms.",
          isPartOf: { "@type": "WebSite", name: "AgentSwarms", url: "https://agentswarms.fyi/" },
        }),
      },
    ],
  }),
  component: ContactPage,
});

function ContactPage() {
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const fd = new FormData(e.currentTarget);
    const raw = {
      name: String(fd.get("name") ?? ""),
      email: String(fd.get("email") ?? ""),
      subject: String(fd.get("subject") ?? ""),
      message: String(fd.get("message") ?? ""),
      website: String(fd.get("website") ?? ""), // honeypot
    };
    const parsed = ClientSchema.safeParse(raw);
    if (!parsed.success) {
      const fieldErrs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0]) fieldErrs[String(issue.path[0])] = issue.message;
      }
      setErrors(fieldErrs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...parsed.data,
          sourcePage: typeof window !== "undefined" ? window.location.pathname : "/contact",
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Something went wrong");
      }
      setDone(true);
      toast.success("Message sent — we'll be in touch shortly.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <div className="text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <Mail className="h-3.5 w-3.5" /> Contact
          </div>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Contact AgentSwarms</h1>
          <p className="mt-3 text-lg font-medium text-foreground/80">We read every message.</p>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Feedback, partnership ideas, bug reports, "how do I do X?" — drop us a line. A real
            person on the AgentSwarms team replies within 1–2 business days.
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Prefer email? Reach us directly at{" "}
            <a
              href="mailto:hello@agentswarms.fyi"
              className="font-medium text-primary hover:underline"
            >
              hello@agentswarms.fyi
            </a>
            .
          </p>
        </div>

        {done ? (
          <div className="mt-12 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
            <ShieldCheck className="mx-auto h-10 w-10 text-emerald-400" />
            <h2 className="mt-3 text-xl font-semibold">Message received</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Check your inbox — we sent a quick confirmation. We'll follow up from a real human
              soon.
            </p>
            <div className="mt-6 flex justify-center gap-3">
              <Link to="/docs">
                <Button variant="outline">Explore the docs</Button>
              </Link>
              <Link to="/">
                <Button>
                  Back home <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="mt-12 space-y-5 rounded-xl border border-border/60 bg-card/40 p-6 backdrop-blur-sm sm:p-8"
            noValidate
          >
            {/* Honeypot — hidden from humans, bots fill it in */}
            <div className="hidden" aria-hidden="true">
              <label>
                Your website
                <input type="text" name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" name="name" required maxLength={120} placeholder="Jane Doe" />
                {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  maxLength={255}
                  placeholder="jane@company.com"
                />
                {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="subject">Subject (optional)</Label>
              <Input id="subject" name="subject" maxLength={200} placeholder="What's this about?" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="message" className="flex items-center gap-2">
                <MessageSquare className="h-3.5 w-3.5 text-primary" />
                Message
              </Label>
              <Textarea
                id="message"
                name="message"
                required
                minLength={10}
                maxLength={5000}
                rows={7}
                placeholder="What's on your mind?"
              />
              {errors.message ? (
                <p className="text-xs text-destructive">{errors.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">10–5000 characters.</p>
              )}
            </div>

            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <p className="text-xs text-muted-foreground">
                We'll never share your email. By sending you agree to our{" "}
                <Link to="/privacy" className="underline hover:text-foreground">
                  privacy policy
                </Link>
                .
              </p>
              <Button type="submit" size="lg" disabled={submitting} className="gap-2">
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                  </>
                ) : (
                  <>
                    Send message <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </form>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
