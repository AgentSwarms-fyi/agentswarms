import { useState, type ReactNode, isValidElement, Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, Download } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Rich markdown renderer for assistant messages.
 *
 * - Headings, paragraphs, lists, tables, blockquotes get tasteful spacing.
 * - Inline code is pill-styled; fenced code blocks get a language label
 *   header + working copy-to-clipboard button.
 * - SQL / TS / JS / Python / Bash / JSON etc. are syntax highlighted
 *   via rehype-highlight (highlight.js classes, themed in src/styles.css).
 */
// Matches markdown image syntax `![alt](url)` where url is a data:image URL
// or an http(s) image URL. Used to extract image references that ReactMarkdown
// can mangle when the URL is a very large base64 data URL (commonmark URL
// parsing is unreliable past a few KB). We render those as plain <img> instead.
const MARKDOWN_IMAGE_RE =
  /!\[([^\]]*)\]\((data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)]*)?)\)/g;

type Segment = { kind: "text"; value: string } | { kind: "image"; src: string; alt: string };

function splitImageSegments(content: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(MARKDOWN_IMAGE_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: "text", value: content.slice(lastIndex, start) });
    }
    segments.push({ kind: "image", alt: match[1] || "image", src: match[2] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: "text", value: content.slice(lastIndex) });
  }
  return segments;
}

export function MarkdownMessage({ content }: { content: string }) {
  // Pre-extract image references so very large base64 data URLs render as
  // plain <img> tags and are never lost to markdown link-destination parsing.
  const segments = splitImageSegments(content);
  return (
    <div
      className={cn(
        "max-w-none min-w-0 text-sm leading-7 text-foreground break-words",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
    >
      {segments.map((seg, i) =>
        seg.kind === "image" ? (
          <RenderedImage key={i} src={seg.src} alt={seg.alt} />
        ) : seg.value.trim() ? (
          <MarkdownChunk key={i} content={seg.value} />
        ) : null,
      )}
    </div>
  );
}

/**
 * URL sanitiser for rendered model output.
 *
 * THIS RENDERS TEXT THE MODEL PRODUCED, and the model can be steered — by the
 * visitor's own message on a public embed, or by a poisoned knowledge-base
 * document. So a link in a completion is untrusted markup, not authored
 * content.
 *
 * react-markdown ships a default urlTransform that strips `javascript:`,
 * `vbscript:` and unknown `data:` payloads. It had been replaced with
 * `(url) => url`, which is not a narrowing of that policy — it is the whole
 * policy removed. `[click me](javascript:…)` rendered as a live anchor, and in
 * the playground that is the user's own authenticated origin.
 *
 * The reason for removing it was real: the default also strips `data:` on
 * `<img>`, so Gemini's base64 image replies showed as broken icons. So this
 * keeps that ONE exception and restores everything else — data: is allowed
 * only for image types, everything else must be a known-safe scheme or
 * relative.
 */
export function safeUrl(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";

  // Strip characters a browser ignores when resolving a scheme, so
  // "java\nscript:" and "java\tscript:" cannot slip past the check below.
  // no-control-regex is disabled deliberately: matching control characters is
  // the entire point here. Narrowing the class to satisfy the rule would
  // reopen the bypass it exists to close.
  // eslint-disable-next-line no-control-regex
  const probe = raw.replace(/[\u0000-\u0020]/g, "").toLowerCase();

  // Base64 (or plain) image payloads — the exception this function exists for.
  if (probe.startsWith("data:")) {
    return /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)[;,]/.test(probe) &&
      // SVG can carry script; allow it only as base64, never as raw markup.
      (!probe.startsWith("data:image/svg+xml") || probe.includes(";base64,"))
      ? raw
      : "";
  }

  // A scheme is everything before the first ":" that precedes any "/", "?" or
  // "#". No scheme at all means a relative URL, which is safe.
  const scheme = probe.match(/^([a-z][a-z0-9+.-]*):/)?.[1];
  if (!scheme) return raw;

  return ["http", "https", "mailto", "tel", "ftp"].includes(scheme) ? raw : "";
}

function MarkdownChunk({ content }: { content: string }) {
  return (
    <>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        // Allow base64 image data: URLs (Gemini image models return them) —
        // WITHOUT disabling protocol filtering, which is what `(url) => url`
        // did. See safeUrl.
        urlTransform={safeUrl}
        components={{
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 text-2xl font-semibold tracking-tight border-b border-border/60 pb-2">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 mb-3 text-xl font-semibold tracking-tight">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-5 mb-2 text-base font-semibold tracking-tight">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 mb-2 text-sm font-semibold tracking-tight text-foreground/90">
              {children}
            </h4>
          ),
          p: ({ children }) => <p className="my-3 text-sm leading-7">{children}</p>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="my-3 ml-5 list-disc space-y-1.5 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 ml-5 list-decimal space-y-1.5 marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="text-sm leading-7">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-l-2 border-primary/50 bg-muted/40 px-4 py-2 text-sm italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-border/60" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          table: ({ children }) => (
            <div className="my-4 w-full overflow-x-auto rounded-lg border border-border/60">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
          tr: ({ children }) => (
            <tr className="border-b border-border/40 last:border-0">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => <td className="px-3 py-2 align-top text-sm">{children}</td>,
          code: ({ className, children, ...props }) => {
            // Inline code: react-markdown passes no language className for inline.
            const isBlock = typeof className === "string" && /language-/.test(className);
            if (!isBlock) {
              return (
                <code
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground/90 border border-border/40"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            // Block code is rendered inside <pre> by `pre` below; keep
            // the hljs classes intact so highlighting still applies.
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ src, alt }) => (
            <RenderedImage src={typeof src === "string" ? src : ""} alt={alt || "image"} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </>
  );
}

/**
 * Pretty fenced code block with language label + copy button.
 *
 * react-markdown gives us a <pre> wrapping a single <code> child whose
 * className is "language-<lang> hljs ...". We extract the language and
 * the raw text from that child to drive the header label and clipboard.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const codeChild = Children.toArray(children).find(
    (c) => isValidElement(c) && (c.type === "code" || (c as any).props?.className),
  ) as any;

  const className: string = codeChild?.props?.className || "";
  const langMatch = /language-([\w-]+)/.exec(className);
  const language = langMatch ? langMatch[1] : "text";

  // Walk the code child's children to extract raw text.
  const codeText = extractText(codeChild?.props?.children);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border/60 bg-muted/40">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/70 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {prettyLanguage(language)}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          aria-label="Copy code to clipboard"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-[13px] leading-6 font-mono [&_code]:bg-transparent [&_code]:p-0 [&_code]:border-0">
        {children}
      </pre>
    </div>
  );
}

/**
 * Inline image renderer with a hover "Download" overlay. Works for both
 * `data:` URLs (e.g. base64 returned by Gemini image models through the
 * AgentSwarms AI gateway) and `http(s):` URLs.
 */
function RenderedImage({ src, alt }: { src: string; alt: string }) {
  if (!src) return null;
  // Choose a sensible filename — strip the data-URL prefix and pick an
  // extension based on the MIME type when present.
  const filename = (() => {
    if (src.startsWith("data:image/")) {
      const mime = src.slice(5, src.indexOf(";"));
      const ext = mime.split("/")[1] || "png";
      return `agentswarms-image-${Date.now()}.${ext}`;
    }
    try {
      const u = new URL(src);
      const last = u.pathname.split("/").filter(Boolean).pop();
      return last || `agentswarms-image-${Date.now()}.png`;
    } catch {
      return `agentswarms-image-${Date.now()}.png`;
    }
  })();
  return (
    <span className="group relative my-3 block overflow-hidden rounded-lg border border-border/60 bg-muted/30">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="block max-h-[60vh] w-full object-contain"
      />
      <a
        href={src}
        download={filename}
        target="_blank"
        rel="noreferrer noopener"
        className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-background/80 px-2 py-1 text-[11px] text-foreground/90 opacity-0 backdrop-blur transition-opacity hover:bg-background group-hover:opacity-100 focus:opacity-100"
        aria-label="Download image"
      >
        <Download className="h-3 w-3" /> Download
      </a>
    </span>
  );
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node.props as any).children);
  return "";
}

function prettyLanguage(lang: string): string {
  const map: Record<string, string> = {
    js: "JavaScript",
    jsx: "JSX",
    ts: "TypeScript",
    tsx: "TSX",
    py: "Python",
    python: "Python",
    sh: "Shell",
    bash: "Bash",
    zsh: "Shell",
    sql: "SQL",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    html: "HTML",
    css: "CSS",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    java: "Java",
    cs: "C#",
    cpp: "C++",
    c: "C",
    php: "PHP",
    text: "Text",
    plaintext: "Text",
  };
  return map[lang.toLowerCase()] || lang.toUpperCase();
}
