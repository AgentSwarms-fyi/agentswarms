// A credential set for one server never follows a redirect to another (R419).
//
// safeFetch follows redirects itself, hop by hop, so that every hop's address
// is checked (R387). Until R419 that loop re-sent the caller's headers and
// body to every hop unchanged: a key meant for one server followed a 302 to
// any other, and a redirect was a way for a secret shared toward an allowed
// host to leave it. fetch() would have dropped `Authorization` there; the
// callers here also carry credentials in other headers, so a hop to another
// origin now keeps only headers that cannot hold one, and never the body.
//
// Two real HTTP servers on loopback, on different ports: different origins.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { redirectedRequest, safeFetch } from "@/utils/ssrfGuard.server";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

let a: Server;
let b: Server;
let aUrl = "";
let bUrl = "";
const seenAtB: Seen[] = [];
const seenAtA: Seen[] = [];

function listen(srv: Server): Promise<string> {
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`),
    ),
  );
}

function record(req: IncomingMessage, into: Seen[]): Promise<void> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      into.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      resolve();
    });
  });
}

beforeAll(async () => {
  // B is the other origin: it records what arrived.
  b = createServer(async (req, res) => {
    await record(req, seenAtB);
    res.end("ok");
  });
  bUrl = await listen(b);
  // A redirects: /away/<status> to B, /here/<status> to itself.
  a = createServer(async (req, res) => {
    await record(req, seenAtA);
    const [, kind, status] = (req.url ?? "").split("/");
    if (kind === "away") {
      res.writeHead(Number(status), { location: `${bUrl}/landed` }).end();
    } else if (kind === "here") {
      res.writeHead(Number(status), { location: "/final" }).end();
    } else {
      res.end("final");
    }
  });
  aUrl = await listen(a);
});

afterAll(() => {
  a?.close();
  b?.close();
});

const credentialHeaders = {
  Authorization: "Bearer SECRET-A",
  "x-api-key": "SECRET-B",
  "api-key": "SECRET-C",
  "X-Custom-Token": "SECRET-D",
  Cookie: "session=SECRET-E",
  Accept: "application/json",
  "User-Agent": "agentswarms-test",
};

describe("a redirect to another origin", () => {
  it("keeps no header that can carry a credential", async () => {
    seenAtB.length = 0;
    const res = await safeFetch(`${aUrl}/away/302`, {
      headers: credentialHeaders,
      allowPrivate: true,
    });
    expect(await res.text()).toBe("ok");
    const got = seenAtB.at(-1)!;
    expect(got.url).toBe("/landed");
    for (const h of ["authorization", "x-api-key", "api-key", "x-custom-token", "cookie"]) {
      expect(got.headers[h], h).toBeUndefined();
    }
    expect(JSON.stringify(got.headers)).not.toMatch(/SECRET-/);
    // What cannot hold one still goes.
    expect(got.headers.accept).toBe("application/json");
    expect(got.headers["user-agent"]).toBe("agentswarms-test");
  });

  it("never re-sends a body (307/308), and says why", async () => {
    seenAtB.length = 0;
    for (const status of [307, 308]) {
      await expect(
        safeFetch(`${aUrl}/away/${status}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...credentialHeaders },
          body: JSON.stringify({ client_secret: "SECRET-F" }),
          allowPrivate: true,
        }),
      ).rejects.toThrow(/never forwarded to another server/);
    }
    expect(seenAtB).toHaveLength(0);
  });

  it("turns a POST answered 303 into a bodiless GET without the credentials", async () => {
    seenAtB.length = 0;
    await safeFetch(`${aUrl}/away/303`, {
      method: "POST",
      headers: { "content-type": "application/json", ...credentialHeaders },
      body: '{"client_secret":"SECRET-F"}',
      allowPrivate: true,
    });
    const got = seenAtB.at(-1)!;
    expect(got.method).toBe("GET");
    expect(got.body).toBe("");
    expect(got.headers["content-type"]).toBeUndefined();
    expect(JSON.stringify(got.headers)).not.toMatch(/SECRET-/);
  });
});

describe("a redirect within the same origin", () => {
  it("keeps the headers, and a 307 keeps its method and body", async () => {
    seenAtA.length = 0;
    await safeFetch(`${aUrl}/here/307`, {
      method: "POST",
      headers: { "content-type": "text/plain", Authorization: "Bearer SAME-ORIGIN" },
      body: "payload",
      allowPrivate: true,
    });
    const final = seenAtA.at(-1)!;
    expect(final.url).toBe("/final");
    expect(final.method).toBe("POST");
    expect(final.body).toBe("payload");
    expect(final.headers.authorization).toBe("Bearer SAME-ORIGIN");
  });

  it("a 302 after a POST becomes a GET, as fetch() does, still authenticated", async () => {
    seenAtA.length = 0;
    await safeFetch(`${aUrl}/here/302`, {
      method: "POST",
      headers: { "content-type": "text/plain", Authorization: "Bearer SAME-ORIGIN" },
      body: "payload",
      allowPrivate: true,
    });
    const final = seenAtA.at(-1)!;
    expect(final.method).toBe("GET");
    expect(final.body).toBe("");
    expect(final.headers.authorization).toBe("Bearer SAME-ORIGIN");
  });
});

describe("redirectedRequest, the rule itself", () => {
  const from = new URL("https://api.example.com/v1/x");
  it("compares origins, so another port or scheme on the same host is another server", () => {
    const h = new Headers({ authorization: "Bearer k" });
    for (const to of ["https://api.example.com:8443/y", "http://api.example.com/y"]) {
      const out = redirectedRequest(302, from, new URL(to), {
        method: "GET",
        headers: h,
        body: undefined,
      });
      expect(out.headers.has("authorization"), to).toBe(false);
    }
    const same = redirectedRequest(302, from, new URL("https://api.example.com/z"), {
      method: "GET",
      headers: h,
      body: undefined,
    });
    expect(same.headers.get("authorization")).toBe("Bearer k");
  });
});
