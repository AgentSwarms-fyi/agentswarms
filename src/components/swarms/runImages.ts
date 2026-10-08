// The images in a run's output, for the run panel's thumbnails (R346: moved
// out of RunPanel.tsx, which now exports only components).
import { safeUrl } from "@/lib/safeUrl";

// Extract image URLs from arbitrary text. Catches:
//   - Markdown:  ![alt](https://x/y.png)
//   - Bare URLs: https://x/y.jpg, /local/path.webp
//   - data URIs: data:image/png;base64,...
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?[^\s)"']*)?/i;

const URL_RE =
  /(https?:\/\/[^\s)"'<>]+|\/[\w\-./]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?[^\s)"'<>]*)?|data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+)/g;

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

export type FoundImage = { url: string; alt?: string; source: string };

export function extractImages(text: string, source: string): FoundImage[] {
  if (!text) return [];
  const found: FoundImage[] = [];
  const seen = new Set<string>();
  // EVERY candidate goes through safeUrl, whichever pattern found it.
  //
  // The two branches below disagreed. The bare-URL branch checked its match
  // (`data:image/` or an image extension); the MARKDOWN branch pushed its
  // capture untouched, and MD_IMAGE_RE captures `([^)\s]+)` — any scheme at
  // all. These URLs are rendered as
  //
  //     <a href={img.url} target="_blank"><img src={img.url} /></a>
  //
  // so `![chart](javascript:alert(document.domain))` in a node's output became
  // a clickable thumbnail that ran script in the signed-in owner's session.
  // Node output is model-generated, so it is reachable by prompt injection —
  // through a web_browse result, a knowledge-base document, or an embed
  // visitor's message.
  //
  // safeUrl is the one already used by MarkdownMessage rather than a second
  // copy of the rule: it permits http(s), relative paths and image data URIs
  // (base64 only for SVG, which can otherwise carry script), and strips the
  // control characters that make "java\nscript:" resolve.
  const push = (url: string, alt?: string) => {
    const safe = safeUrl(url);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    found.push({ url: safe, alt, source });
  };
  let m: RegExpExecArray | null;
  const md = new RegExp(MD_IMAGE_RE);
  while ((m = md.exec(text)) !== null) push(m[2], m[1]);
  const url = new RegExp(URL_RE);
  while ((m = url.exec(text)) !== null) {
    const candidate = m[1];
    if (candidate.startsWith("data:image/") || IMAGE_EXT_RE.test(candidate)) {
      push(candidate);
    }
  }
  return found;
}
