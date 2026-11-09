// HS256 JWTs the way Supabase issues them. Usage: node jwt.mjs <secret> <role> [sub]
import { createHmac } from "node:crypto";

const [, , secret, role, sub] = process.argv;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64({ alg: "HS256", typ: "JWT" });
const payload = b64({
  role,
  iss: "supabase",
  iat: now,
  exp: now + 3600,
  ...(sub ? { sub, aud: "authenticated" } : {}),
});
const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
process.stdout.write(`${header}.${payload}.${sig}`);
