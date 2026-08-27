// The built-in fetcher: extraction quality, the limits that bound it, and the
// SSRF guarantee it inherits.
//
// The network is stubbed throughout. These assert what the module does with a
// response, not that any particular site is up — a test that needs the real
// internet fails for reasons that have nothing to do with this code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativeScrape } from "@/utils/nativeScrape.server";

const realFetch = globalThis.fetch;

function htmlResponse(body: string, init: { status?: number; type?: string } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "text/html; charset=utf-8" },
  });
}

/** Stub fetch. safeFetch calls it with redirect:"manual"; one hop is enough. */
function stubFetch(fn: (url: string) => Response) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return fn(url);
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("nativeScrape — extraction", () => {
  it("pulls the article out of a page and leaves the chrome behind", async () => {
    stubFetch(() =>
      htmlResponse(`
        <html><head><title>Carrier Policy</title>
          <meta name="description" content="How OTIF is measured." /></head>
        <body>
          <nav><a href="/">Home</a><a href="/pricing">Pricing</a></nav>
          <header>Site header that is not the article</header>
          <div class="cookie">We use cookies. Accept?</div>
          <article>
            <h1>On-Time-In-Full</h1>
            <p>OTIF is the share of shipments delivered within the SLA window and undamaged.</p>
            <p>A shipment counts as on time when transit days are at or under the SLA.</p>
          </article>
          <footer>Copyright notice</footer>
        </body></html>`),
    );

    const r = await nativeScrape("https://example.com/policy");

    expect(r.provider).toBe("native");
    expect(r.title).toBe("Carrier Policy");
    expect(r.description).toBe("How OTIF is measured.");
    expect(r.markdown).toContain("On-Time-In-Full");
    expect(r.markdown).toContain("share of shipments delivered");
    // The whole point of stripping chrome: none of this is the article.
    expect(r.markdown).not.toContain("Pricing");
    expect(r.markdown).not.toContain("We use cookies");
    expect(r.markdown).not.toContain("Copyright notice");
    expect(r.thin).toBe(false);
  });

  it("converts headings, links and code to markdown", async () => {
    stubFetch(() =>
      htmlResponse(`<html><body><main>
        <h2>Install</h2>
        <p>Read the <a href="https://example.com/docs">documentation</a> first.</p>
        <pre><code>npm install agentswarms</code></pre>
        <ul><li>First</li><li>Second</li></ul>
        ${"<p>Padding sentence to clear the thin-content floor.</p>".repeat(6)}
      </main></body></html>`),
    );

    const r = await nativeScrape("https://example.com/install");

    expect(r.markdown).toContain("## Install");
    expect(r.markdown).toContain("[documentation](https://example.com/docs)");
    expect(r.markdown).toContain("npm install agentswarms");
    // Turndown indents list markers ("-   First"), so match the bullet loosely
    // rather than pinning the exact spacing it happens to emit.
    expect(r.markdown).toMatch(/^-\s+First$/m);
  });

  it("keeps a table as a table instead of flattening it to prose", async () => {
    stubFetch(() =>
      htmlResponse(`<html><body><main>
        <table>
          <tr><th>Region</th><th>Revenue</th></tr>
          <tr><td>West</td><td>1302450</td></tr>
          <tr><td>North</td><td>752300</td></tr>
        </table>
        ${"<p>Padding sentence to clear the thin-content floor.</p>".repeat(6)}
      </main></body></html>`),
    );

    const r = await nativeScrape("https://example.com/table");

    expect(r.markdown).toContain("| Region | Revenue |");
    expect(r.markdown).toContain("| West | 1302450 |");
  });

  it("picks the densest candidate when a page nests main inside article", async () => {
    // <main> wraps the nav column too; <article> is the real content. Taking
    // the FIRST match rather than the densest would drag the sidebar in.
    stubFetch(() =>
      htmlResponse(`<html><body>
        <main>
          <div>short wrapper</div>
          <article>${"<p>The actual article body, repeated for density. </p>".repeat(10)}</article>
        </main>
      </body></html>`),
    );

    const r = await nativeScrape("https://example.com/nested");
    expect(r.markdown).toContain("The actual article body");
    expect(r.thin).toBe(false);
  });
});

describe("nativeScrape — honest about what it cannot do", () => {
  it("flags a JavaScript-rendered shell as thin rather than returning nothing", async () => {
    stubFetch(() =>
      htmlResponse(
        `<html><head><title>Dashboard</title></head>
         <body><div id="root"></div><script src="/app.js"></script></body></html>`,
      ),
    );

    const r = await nativeScrape("https://example.com/spa");

    expect(r.thin).toBe(true);
    expect(r.note).toMatch(/rendered by JavaScript/i);
    // The caller needs to be able to say WHY, so the reason must survive.
    expect(r.note).toMatch(/Firecrawl/);
  });

  it("refuses a content type it would only mangle", async () => {
    stubFetch(
      () => new Response("%PDF-1.7 binary", { headers: { "content-type": "application/pdf" } }),
    );
    await expect(nativeScrape("https://example.com/paper.pdf")).rejects.toThrow(
      /Unsupported content type/i,
    );
  });

  it("surfaces an HTTP error instead of parsing the error page", async () => {
    stubFetch(() => htmlResponse("<html><body>Not found</body></html>", { status: 404 }));
    await expect(nativeScrape("https://example.com/missing")).rejects.toThrow(/HTTP 404/);
  });

  it("returns plain text untouched", async () => {
    stubFetch(
      () =>
        new Response("Just some text.\n\nA second paragraph.", {
          headers: { "content-type": "text/plain" },
        }),
    );
    const r = await nativeScrape("https://example.com/robots.txt");
    expect(r.markdown).toBe("Just some text.\n\nA second paragraph.");
  });
});

describe("nativeScrape — limits", () => {
  it("refuses a page that declares itself over the size ceiling", async () => {
    stubFetch(
      () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) },
        }),
    );
    await expect(nativeScrape("https://example.com/huge")).rejects.toThrow(/too large/i);
  });

  it("truncates to maxChars so a long page cannot blow the model's context", async () => {
    stubFetch(() =>
      htmlResponse(
        `<html><body><main>${"<p>Lorem ipsum dolor sit amet. </p>".repeat(500)}</main></body></html>`,
      ),
    );
    const r = await nativeScrape("https://example.com/long", { maxChars: 500 });
    expect(r.markdown.length).toBeLessThan(600);
    expect(r.markdown).toContain("[truncated]");
  });
});

describe("nativeScrape — SSRF", () => {
  // web_browse takes a URL CHOSEN BY THE MODEL, so it is reachable by prompt
  // injection. These assert the guard is actually on the path; if someone
  // swaps safeFetch for bare fetch to "simplify", these fail.
  it("refuses cloud instance metadata", async () => {
    stubFetch(() => htmlResponse("<html><body>creds</body></html>"));
    await expect(nativeScrape("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });

  it("refuses the IPv4-mapped IPv6 spelling of metadata", async () => {
    stubFetch(() => htmlResponse("<html><body>creds</body></html>"));
    await expect(
      nativeScrape("http://[::ffff:169.254.169.254]/latest/meta-data/"),
    ).rejects.toThrow();
  });

  it("refuses a non-http scheme", async () => {
    stubFetch(() => htmlResponse("<html></html>"));
    await expect(nativeScrape("file:///etc/passwd")).rejects.toThrow();
  });
});
