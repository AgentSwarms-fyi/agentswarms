// Inline Mermaid rendering for chat messages.
//
// A ```mermaid fence in an assistant reply renders as the actual diagram,
// with SVG/PNG download — the raw text stays one click away, and any parse
// failure falls back to showing the code, because model-written Mermaid is
// not guaranteed to be valid and a diagram that vanished entirely would be
// worse than one that arrived as text.
//
// mermaid is ~1.5MB minified, so it is imported dynamically on the first
// diagram actually rendered and never lands in the entry bundle.
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, Image as ImageIcon } from "lucide-react";

let mermaidPromise: Promise<typeof import("mermaid")> | null = null;
let renderSeq = 0;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      mod.default.initialize({
        startOnLoad: false,
        // Never execute scripts/click handlers from model-written diagram
        // source — this is untrusted output rendered into the user's
        // authenticated origin, same rule as the markdown link sanitiser.
        securityLevel: "strict",
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
        fontFamily: "inherit",
      });
      return mod;
    });
  }
  return mermaidPromise;
}

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on a delay so the click has consumed the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then(async (mod) => {
        // parse() first: render() can leave orphan error nodes in the DOM on
        // bad input, parse() fails cleanly.
        await mod.default.parse(code);
        const { svg: rendered } = await mod.default.render(`adhoc-mermaid-${renderSeq++}`, code);
        if (!cancelled) setSvg(rendered);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Invalid diagram syntax");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const downloadSvg = () => {
    if (!svg) return;
    download("diagram.svg", new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  };

  const downloadPng = () => {
    const svgEl = hostRef.current?.querySelector("svg");
    if (!svg || !svgEl) return;
    // Rasterise at 2x the on-screen box so text stays crisp.
    const box = svgEl.getBoundingClientRect();
    const width = Math.max(2, Math.round(box.width * 2));
    const height = Math.max(2, Math.round(box.height * 2));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // Solid background: transparent PNGs of dark-theme diagrams paste as
      // unreadable soup into docs.
      ctx.fillStyle = document.documentElement.classList.contains("dark") ? "#0b0f1a" : "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        if (blob) download("diagram.png", blob);
      }, "image/png");
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  };

  // Parse failure → show the source, say why. The diagram the model wrote is
  // still the user's answer; hiding it because it didn't compile would be a
  // silent failure of exactly the kind this codebase hunts.
  if (error) {
    return (
      <div className="my-3 overflow-hidden rounded-lg border border-border/60">
        <div className="flex items-center justify-between bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span>mermaid — could not render: {error.split("\n")[0]}</span>
        </div>
        <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border/60">
      <div className="flex items-center justify-between bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground">
        <span>diagram</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={copy}
            title="Copy Mermaid source"
            aria-label="Copy Mermaid source"
            className="rounded p-1 hover:bg-muted hover:text-foreground"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={downloadSvg}
            disabled={!svg}
            title="Download as SVG"
            aria-label="Download diagram as SVG"
            className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={downloadPng}
            disabled={!svg}
            title="Download as PNG"
            aria-label="Download diagram as PNG"
            className="rounded p-1 hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {svg ? (
        <div
          ref={hostRef}
          className="flex justify-center overflow-x-auto bg-background p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          // mermaid ran with securityLevel "strict" and produced this SVG
          // itself; the raw model text was parsed, never injected.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="flex items-center justify-center p-6 text-xs text-muted-foreground">
          Rendering diagram…
        </div>
      )}
    </div>
  );
}
