// A dataset shared under a column mask, as each caller's own JWT reads it over
// PostgREST (R491). Exits non-zero on any wrong answer.
//
// The rows of a shared dataset have gone through shared_dataset_rows() since
// 20260766000000, but the "Shared data tables are readable" policy still served
// the dataset's user_data_tables row to the grantee, `columns` and all, so
//   GET /rest/v1/user_data_tables?select=columns
// named every column the grant masks. This sets up an owner, a grantee and a
// stranger, shares datasets the way an admin does (service role), and asks as
// each of them.
//
// WRITES: three users, a group, four datasets and their grants. Run it only
// against the throwaway database deploy/ci/rds-like/run.sh and
// deploy/ci/supabase-image/run.sh start; nothing is cleaned up.
//
// Usage: node shared-dataset-checks.mjs <rest base url> <jwt secret> <gotrue base url>
import { createHmac, randomBytes } from "node:crypto";

const [, , base, secret, authBase] = process.argv;
if (!base || !secret || !authBase) {
  console.error(
    "usage: node shared-dataset-checks.mjs <rest base url> <jwt secret> <gotrue base url>",
  );
  process.exit(2);
}

const jwt = (role, sub) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "HS256", typ: "JWT" });
  // As jwt.mjs issues them: GoTrue's admin API takes this service token too.
  const p = b64({
    role,
    iss: "supabase",
    iat: now,
    exp: now + 600,
    ...(sub ? { sub, aud: "authenticated" } : {}),
  });
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
};
const service = jwt("service_role");

async function call(method, url, token, body) {
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, json, text };
}
const rest = (method, path, token, body) => call(method, `${base}${path}`, token, body);

async function setup(what, promise) {
  const r = await promise;
  if (r.status >= 300) throw new Error(`setup: ${what}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

let failed = 0;
function expect(what, ok, got) {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "BAD"} ${what.padEnd(66)} ${got}`);
}

/** Column names of a `columns` jsonb array, in order. */
const names = (columns) =>
  Array.isArray(columns) ? columns.map((c) => (typeof c === "string" ? c : c?.name)) : columns;
const show = (v) => JSON.stringify(v);
const same = (a, b) => show(a) === show(b);
const namesSalary = (cols) =>
  Array.isArray(cols) &&
  cols.some((c) => /salary/i.test(String(typeof c === "string" ? c : c?.name)));

const tag = randomBytes(4).toString("hex");

async function user(who) {
  const u = await setup(
    `GoTrue creates ${who}`,
    call("POST", `${authBase}/admin/users`, service, {
      email: `${who}-${tag}@shared-dataset.test`,
      password: randomBytes(16).toString("hex"),
      email_confirm: true,
    }),
  );
  return { id: u.id, token: jwt("authenticated", u.id) };
}

async function dataset(ownerId, name, columns, rows, sample = false) {
  const [t] = await setup(
    `dataset ${name}`,
    rest("POST", "/user_data_tables", service, {
      user_id: sample ? null : ownerId,
      name: `${name}_${tag}`,
      columns,
      is_sample: sample,
    }),
  );
  if (rows.length) {
    await setup(
      `rows of ${name}`,
      rest(
        "POST",
        "/user_data_rows",
        service,
        rows.map((row) => ({ table_id: t.id, row })),
      ),
    );
  }
  return t.id;
}

async function grant(resourceId, principalType, principalId, columnMask, rowFilter = null) {
  await setup(
    `grant on ${resourceId}`,
    rest("POST", "/iam_resource_grants", service, {
      resource_type: "data_table",
      resource_id: resourceId,
      principal_type: principalType,
      principal_id: principalId,
      column_mask: columnMask,
      row_filter: rowFilter,
    }),
  );
}

const owner = await user("owner");
const grantee = await user("grantee");
const stranger = await user("stranger");
const [group] = await setup(
  "group",
  rest("POST", "/iam_groups", service, { name: `shared-dataset-${tag}` }),
);
await setup(
  "membership",
  rest("POST", "/iam_group_members", service, { group_id: group.id, user_id: grantee.id }),
);

const col = (name, type = "string") => ({ name, type });
// Masked by two grants whose masks intersect to `salary`, written in other
// cases and with spaces, as an admin types them. The app matches masks without
// regard to case or surrounding space (intersectColumnMasks), and so must the
// database.
const M = await dataset(
  owner.id,
  "shared_masked",
  [col("region"), col("Revenue", "number"), col("salary", "number")],
  [
    { region: "east", Revenue: 10, salary: 100 },
    { region: "west", Revenue: 20, salary: 200 },
  ],
);
await grant(M, "user", grantee.id, ["SALARY", "region"]);
await grant(M, "group", group.id, [" Salary "]);
// Shared with no mask: nothing to hide, so the previous release's direct read
// keeps working for it.
const U = await dataset(owner.id, "shared_open", [col("a"), col("b")], [{ a: 1, b: 2 }]);
await grant(U, "user", grantee.id, []);
// Masked, and its row filter admits no row: sqlEngine.ts used to fall back to
// the owner's full column list for exactly this one.
const E = await dataset(
  owner.id,
  "shared_empty",
  [col("region"), col("salary", "number")],
  [{ region: "east", salary: 1 }],
);
await grant(E, "user", grantee.id, ["salary"], { column: "region", values: ["nowhere"] });
const S = await dataset(null, "sample_k", [col("k")], [{ k: 1 }], true);

const columnsOf = async (who, id) => {
  const r = await rest("GET", `/user_data_tables?id=eq.${id}&select=columns`, who.token);
  return {
    status: r.status,
    rows: Array.isArray(r.json) ? r.json.map((x) => names(x.columns)) : r.json,
  };
};
const rpc = (who, fn, body = {}) => rest("POST", `/rpc/${fn}`, who.token, body);

console.log("  direct reads of user_data_tables");
{
  const r = await columnsOf(owner, M);
  expect(
    "the owner reads its dataset's columns, all of them",
    same(r.rows, [["region", "Revenue", "salary"]]),
    show(r.rows),
  );
}
{
  const r = await columnsOf(grantee, M);
  expect(
    "a grantee reads no row of a masked share directly",
    r.status === 200 && same(r.rows, []),
    show(r.rows),
  );
}
{
  const r = await rest("GET", "/user_data_tables?select=id,columns", grantee.token);
  const leaked = (r.json ?? []).filter((x) => namesSalary(x.columns)).map((x) => x.id);
  expect(
    "no row a grantee can list names a masked column",
    r.status === 200 && leaked.length === 0,
    `${(r.json ?? []).length} rows, naming salary: ${show(leaked)}`,
  );
}
{
  const r = await columnsOf(grantee, U);
  expect(
    "a grantee still reads a share with no mask (previous release)",
    same(r.rows, [["a", "b"]]),
    show(r.rows),
  );
}
{
  const r = await columnsOf(grantee, S);
  expect("a grantee reads a sample, unchanged", same(r.rows, [["k"]]), show(r.rows));
}
{
  const r = await columnsOf(stranger, M);
  expect("a stranger reads nothing", same(r.rows, []), show(r.rows));
}

console.log("  shared_dataset_columns()");
{
  const r = await rpc(grantee, "shared_dataset_columns", { _table_id: M });
  expect(
    "grantee: the masks intersect, without regard to case or space",
    r.status === 200 && same(names(r.json), ["region", "Revenue"]),
    `${r.status} ${show(names(r.json))}`,
  );
}
{
  const r = await rpc(grantee, "shared_dataset_columns", { _table_id: E });
  expect(
    "grantee: a share whose filter admits no row is still masked",
    r.status === 200 && same(names(r.json), ["region"]),
    `${r.status} ${show(names(r.json))}`,
  );
}
{
  const r = await rpc(grantee, "shared_dataset_columns", { _table_id: S });
  expect(
    "grantee: a sample's columns, all of them",
    r.status === 200 && same(names(r.json), ["k"]),
    `${r.status} ${show(names(r.json))}`,
  );
}
{
  const r = await rpc(owner, "shared_dataset_columns", { _table_id: M });
  expect(
    "owner: all of its columns",
    r.status === 200 && same(names(r.json), ["region", "Revenue", "salary"]),
    `${r.status} ${show(names(r.json))}`,
  );
}
{
  const r = await rpc(stranger, "shared_dataset_columns", { _table_id: M });
  expect(
    "stranger: nothing",
    r.status === 200 && r.json === null,
    `${r.status} ${r.text.slice(0, 80)}`,
  );
}
{
  const r = await rest("POST", "/rpc/shared_dataset_columns", jwt("anon"), { _table_id: M });
  expect("anon: refused", r.status === 401 || r.status === 403, `${r.status}`);
}

console.log("  shared_datasets()");
{
  const r = await rpc(grantee, "shared_datasets");
  const byId = new Map((Array.isArray(r.json) ? r.json : []).map((x) => [x.id, x]));
  const got = [M, U, E].map((id) => names(byId.get(id)?.columns));
  expect(
    "grantee: every share, each through its mask, none of them sample",
    r.status === 200 &&
      same(got, [["region", "Revenue"], ["a", "b"], ["region"]]) &&
      !byId.has(S) &&
      [M, U, E].every(
        (id) => byId.get(id)?.user_id === owner.id && byId.get(id)?.is_sample === false,
      ),
    `${r.status} ${show(got)}${byId.has(S) ? " +sample" : ""}`,
  );
}
{
  const r = await rpc(owner, "shared_datasets");
  const ids = (Array.isArray(r.json) ? r.json : []).map((x) => x.id);
  expect(
    "owner: its own datasets are not shared with it",
    r.status === 200 && ![M, U, E].some((id) => ids.includes(id)),
    `${r.status} ${ids.length} rows`,
  );
}
{
  const r = await rpc(stranger, "shared_datasets");
  expect("stranger: none", r.status === 200 && same(r.json, []), `${r.status} ${show(r.json)}`);
}

console.log("  shared_dataset_rows()");
{
  const r = await rpc(grantee, "shared_dataset_rows", { _table_id: M });
  const rows = Array.isArray(r.json) ? r.json : [];
  const keys = [...new Set(rows.flatMap((x) => Object.keys(x)))].sort();
  expect(
    "grantee: no value of a masked column, matched without case",
    r.status === 200 && rows.length === 2 && same(keys, ["Revenue", "region"]),
    `${r.status} ${rows.length} rows, keys ${show(keys)}`,
  );
}
{
  const r = await rpc(grantee, "shared_dataset_rows", { _table_id: E });
  expect(
    "grantee: a filter that admits no row gives none",
    r.status === 200 && same(r.json, []),
    `${r.status} ${show(r.json)}`,
  );
}
{
  const r = await rpc(stranger, "shared_dataset_rows", { _table_id: M });
  expect("stranger: none", r.status === 200 && same(r.json, []), `${r.status} ${show(r.json)}`);
}

console.log("  what only the database calls");
{
  const r = await rpc(grantee, "dataset_grant_mask", { _table_id: M, _uid: grantee.id });
  expect("a client cannot ask for anyone's mask", r.status >= 400, `${r.status}`);
}

// Not process.exit(): see api-checks.mjs (libuv's UV_HANDLE_CLOSING on Windows).
process.exitCode = failed ? 1 : 0;
