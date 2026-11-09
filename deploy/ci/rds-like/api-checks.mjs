// PostgREST on the RDS-shaped database, as the app uses it: the schema is
// served, row-level security holds between two users, and service_role
// (BYPASSRLS) sees everything. Exits non-zero on any wrong answer.
// Usage: node api-checks.mjs <rest base url> <jwt secret>
import { createHmac, randomUUID } from "node:crypto";

const [, , base, secret] = process.argv;
const jwt = (role, sub) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ role, iat: now, exp: now + 600, ...(sub ? { sub, aud: "authenticated" } : {}) });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
};
const A = randomUUID();
const B = randomUUID();
const tok = {
  anon: jwt("anon"),
  service: jwt("service_role"),
  a: jwt("authenticated", A),
  b: jwt("authenticated", B),
};

async function call(method, path, token, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let rows = null;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) rows = j.length;
  } catch {
    /* not JSON */
  }
  return { status: r.status, rows, text };
}

let failed = 0;
function expect(what, got, want) {
  const ok = got.status === want.status && (want.rows === undefined || got.rows === want.rows);
  if (!ok) failed++;
  const rows = got.rows !== null ? ` (${got.rows} rows)` : "";
  console.log(
    `  ${ok ? "ok " : "BAD"} ${what.padEnd(44)} ${got.status}${rows}${ok ? "" : ` ${got.text.slice(0, 100)}`}`,
  );
}

const T = "/conversation_memory";
const root = await call("GET", "/", tok.anon);
expect("PostgREST serves the schema (anon, GET /)", root, { status: 200 });
expect(
  "user A writes A's row",
  await call("POST", T, tok.a, { conversation_id: randomUUID(), user_id: A }),
  { status: 201 },
);
expect(
  "user A writes a row as user B (RLS refuses)",
  await call("POST", T, tok.a, { conversation_id: randomUUID(), user_id: B }),
  { status: 403 },
);
expect("user A reads", await call("GET", `${T}?select=user_id`, tok.a), { status: 200, rows: 1 });
expect("user B reads", await call("GET", `${T}?select=user_id`, tok.b), { status: 200, rows: 0 });
expect("anon reads", await call("GET", `${T}?select=user_id`, tok.anon), { status: 200, rows: 0 });
expect(
  "service_role writes a row for user B",
  await call("POST", T, tok.service, { conversation_id: randomUUID(), user_id: B }),
  { status: 201 },
);
expect(
  "service_role reads both (BYPASSRLS)",
  await call("GET", `${T}?select=user_id`, tok.service),
  { status: 200, rows: 2 },
);
expect("user B reads its own", await call("GET", `${T}?select=user_id`, tok.b), {
  status: 200,
  rows: 1,
});
process.exit(failed ? 1 : 0);
