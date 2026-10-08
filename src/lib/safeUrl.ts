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
