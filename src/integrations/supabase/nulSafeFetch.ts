// Writes to Postgres never carry U+0000 (R301).
//
// Postgres cannot store the NUL character in `text` or `jsonb`, and it refuses
// the whole statement over one: "unsupported Unicode escape sequence". The
// character is invisible in an input, so the message cannot be acted on, and
// every editor that saved a pasted NUL - terminal output, a binary dump, text
// fetched from the web - could never save again. Driven: a notebook title
// holding one stayed "Unsaved changes" with "Save failed", and a BI report
// whose header held one could not be saved.
//
// Every Supabase client in the app sends its PostgREST requests through this
// fetch. A write (POST, PATCH, PUT to /rest/v1/) whose JSON body holds a NUL
// is parsed, cleaned and sent; anything else - reads, auth, storage, a body
// that is not JSON - goes through untouched. R300 already cleans uploads at the
// row sink so it can say how many cells it changed; this is the floor under
// every other write.

const WRITES = new Set(["POST", "PATCH", "PUT"]);

/** `value` with every NUL removed from its strings and object keys, at any depth. */
export function withoutNulDeep(value: unknown): unknown {
  if (typeof value === "string")
    return value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
  if (Array.isArray(value)) return value.map(withoutNulDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.includes("\u0000") ? k.replaceAll("\u0000", "") : k] = withoutNulDeep(v);
    }
    return out;
  }
  return value;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A fetch for Supabase clients that strips NUL characters from PostgREST writes. */
export const nulSafeFetch: typeof fetch = (input, init) => {
  const body = init?.body;
  // JSON writes the character as the six-character escape; a body without it
  // holds no NUL and is sent as it is.
  if (
    typeof body === "string" &&
    body.includes("\\u0000") &&
    WRITES.has((init?.method ?? "GET").toUpperCase()) &&
    urlOf(input).includes("/rest/v1/")
  ) {
    try {
      const cleaned = JSON.stringify(withoutNulDeep(JSON.parse(body)));
      return globalThis.fetch(input, { ...init, body: cleaned });
    } catch {
      // Not JSON: Postgres will say what it says.
    }
  }
  // Resolved at call time, so a fetch installed after the client was made is
  // the one used.
  return globalThis.fetch(input, init);
};

/** Supabase client options with `nulSafeFetch` as the client's fetch. */
export function withNulSafeFetch<O extends object>(
  options?: O,
): O & { global: { fetch: typeof fetch } } {
  const global = (options as { global?: object } | undefined)?.global ?? {};
  return {
    ...(options ?? ({} as O)),
    global: { ...global, fetch: nulSafeFetch },
  } as O & { global: { fetch: typeof fetch } };
}
