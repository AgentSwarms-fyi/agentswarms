// A small in-memory stand-in for the PostgREST client calls the key code
// makes (select/eq/neq/gt/is/in/not/or/order, a jsonb key's ->>, insert/update/delete with .select(),
// maybeSingle/single, one rpc), with the unique constraints of migration
// 20261105000000, so tests run the real keyStore.server and the sweep
// against tables, not against a mock of each call.
type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

export type FakeDb = ReturnType<typeof fakePostgrest>;

/**
 * What is unique per table: columns, or an expression (an index on
 * lower(btrim(name))), with a partial index's predicate.
 */
const UNIQUE: Record<
  string,
  Array<{ cols: string[]; key?: (r: Row) => unknown; where?: Filter }>
> = {
  user_keys: [{ cols: ["kid"] }, { cols: ["user_id"], where: (r) => r.erased_at == null }],
  customer_keys: [
    { cols: ["kid"] },
    {
      cols: [],
      key: (r) =>
        String(r.name ?? "")
          .trim()
          .toLowerCase(),
      where: (r) => r.destroyed_at == null,
    },
  ],
  customer_key_members: [
    { cols: ["user_id"], where: (r) => r.user_id != null },
    { cols: ["group_id"], where: (r) => r.group_id != null },
  ],
};

const EMBEDS: Record<string, string> = {
  customer_keys: "customer_key_id",
  iam_groups: "group_id",
  swarm_runs: "run_id",
};

function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of expr) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function orFilter(expr: string): Filter {
  const parts = splitTop(expr).map((p) => {
    const [col, op, ...rest] = p.split(".");
    const value = rest.join(".");
    if (op === "eq") return (r: Row) => String(r[col]) === value;
    if (op === "in") {
      const vals = value.replace(/^\(|\)$/g, "").split(",");
      return (r: Row) => vals.includes(String(r[col]));
    }
    throw new Error(`fakePostgrest: or() op ${op}`);
  });
  return (r) => parts.some((f) => f(r));
}

// A column, or a jsonb key of one (`request_payload->>pricing_missing`), as
// Postgres gives it: `->>` is text, so a true comes back as "true".
function cell(r: Row, col: string): unknown {
  const at = col.indexOf("->>");
  if (at < 0) return r[col];
  const v = (r[col.slice(0, at)] as Row | null | undefined)?.[col.slice(at + 3)];
  return v === null || v === undefined ? null : String(v);
}

export function fakePostgrest(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  let seq = 0;
  const log: string[] = [];

  function missing(name: string) {
    return {
      code: "PGRST205",
      message: `Could not find the table 'public.${name}' in the schema cache`,
    };
  }

  function violates(name: string, rows: Row[], candidate: Row, self?: Row): boolean {
    for (const u of UNIQUE[name] ?? []) {
      if (u.where && !u.where(candidate)) continue;
      const clash = rows.some(
        (r) =>
          r !== self &&
          (!u.where || u.where(r)) &&
          (u.key
            ? u.key(r) === u.key(candidate)
            : u.cols.every((c) => r[c] != null && r[c] === candidate[c])),
      );
      if (clash) return true;
    }
    return false;
  }

  function from(name: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;
    let selectCols = "*";
    let single: "one" | "maybe" | null = null;
    let returning = false;

    const embed = (r: Row): Row => {
      const out = { ...r };
      for (const m of selectCols.matchAll(/(\w+)\(([^)]*)\)/g)) {
        const [, rel, cols] = m;
        const fk = EMBEDS[rel];
        const target = (tables[rel] ?? []).find((x) => x.id === r[fk]);
        out[rel] = target
          ? Object.fromEntries(cols.split(",").map((c) => [c.trim(), target[c.trim()]]))
          : null;
      }
      return out;
    };

    function run(): { data: unknown; error: unknown } {
      const rows = tables[name];
      if (!rows) return { data: null, error: missing(name) };
      const match = (r: Row) => filters.every((f) => f(r));
      let result: Row[] = [];
      if (mode === "select") result = rows.filter(match).map(embed);
      if (mode === "insert") {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        const added: Row[] = [];
        for (const p of list) {
          const row: Row = {
            id: p.id ?? crypto.randomUUID(),
            created_at: new Date(1_700_000_000_000 + ++seq * 1000).toISOString(),
            ...p,
          };
          if (name === "user_keys") row.erased_at ??= null;
          if (name === "customer_keys") row.destroyed_at ??= null;
          if (violates(name, [...rows, ...added], row)) {
            return {
              data: null,
              error: { code: "23505", message: `duplicate key value violates unique constraint` },
            };
          }
          added.push(row);
        }
        rows.push(...added);
        result = added.map((r) => ({ ...r }));
      }
      if (mode === "update") {
        const hit = rows.filter(match);
        for (const r of hit) {
          const next = { ...r, ...(payload as Row) };
          if (violates(name, rows, next, r)) {
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          }
        }
        for (const r of hit) Object.assign(r, payload as Row);
        result = hit.map((r) => ({ ...r }));
      }
      if (mode === "delete") {
        const keep = rows.filter((r) => !match(r));
        result = rows.filter(match).map((r) => ({ ...r }));
        tables[name] = keep;
      }
      log.push(`${mode} ${name}`);
      if (mode !== "select" && !returning && !single) return { data: null, error: null };
      if (single) {
        if (result.length > 1)
          return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        if (result.length === 0) {
          return single === "maybe"
            ? { data: null, error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: result[0], error: null };
      }
      return { data: result, error: null };
    }

    const q = {
      select(cols = "*") {
        selectCols = cols;
        if (mode !== "select") returning = true;
        return q;
      },
      insert(p: Row | Row[]) {
        mode = "insert";
        payload = p;
        return q;
      },
      upsert(p: Row | Row[]) {
        mode = "insert";
        payload = p;
        return q;
      },
      update(p: Row) {
        mode = "update";
        payload = p;
        return q;
      },
      delete() {
        mode = "delete";
        return q;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => cell(r, col) === v);
        return q;
      },
      is(col: string, v: null) {
        filters.push((r) => (cell(r, col) ?? null) === v);
        return q;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return q;
      },
      // A jsonb column compares as JSON ("{}" is an empty object), any other as text.
      neq(col: string, v: unknown) {
        filters.push((r) => {
          const x = r[col] ?? null;
          if (x === null) return false;
          return typeof x === "object" ? JSON.stringify(x) !== String(v) : String(x) !== String(v);
        });
        return q;
      },
      // An array column sharing any element with `vals` (Postgres `&&`).
      overlaps(col: string, vals: unknown[]) {
        filters.push(
          (r) => Array.isArray(r[col]) && (r[col] as unknown[]).some((x) => vals.includes(x)),
        );
        return q;
      },
      gte(col: string, v: unknown) {
        filters.push((r) => r[col] != null && String(r[col]) >= String(v));
        return q;
      },
      gt(col: string, v: unknown) {
        filters.push((r) => r[col] != null && String(r[col]) > String(v));
        return q;
      },
      // NOT LIKE on a NULL is NULL in Postgres: the row is left out, as here.
      not(col: string, op: string, v: unknown) {
        if (op === "like") {
          const pattern = String(v)
            .split("")
            .map((ch) =>
              ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[^A-Za-z0-9]/, "\\$&"),
            )
            .join("");
          const re = new RegExp("^" + pattern + "$", "s");
          filters.push((r) => r[col] != null && !re.test(String(r[col])));
        } else if (op === "is") {
          filters.push((r) => (cell(r, col) ?? null) !== v);
        } else {
          throw new Error(`fakePostgrest: not.${op} is not supported`);
        }
        return q;
      },
      or(expr: string) {
        filters.push(orFilter(expr));
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return q;
      },
      maybeSingle() {
        single = "maybe";
        return Promise.resolve(run());
      },
      single() {
        single = "one";
        return Promise.resolve(run());
      },
      then<T>(ok: (v: { data: unknown; error: unknown }) => T, bad?: (e: unknown) => T) {
        return Promise.resolve(run()).then(ok, bad);
      },
    };
    return q;
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (fn !== "destroy_customer_key") throw new Error(`fakePostgrest: rpc ${fn}`);
    const key = (tables.customer_keys ?? []).find((c) => c.id === args.p_id && !c.destroyed_at);
    if (!key) return { data: null, error: { code: "P0002", message: "does not exist" } };
    tables.customer_key_members = (tables.customer_key_members ?? []).filter(
      (m) => m.customer_key_id !== args.p_id,
    );
    let erased = 0;
    const now = new Date().toISOString();
    for (const k of tables.user_keys ?? []) {
      if (k.customer_key_id === args.p_id && !k.erased_at) {
        Object.assign(k, { material: null, iv: null, erased_at: now, erased_by: args.p_by });
        erased++;
      }
    }
    Object.assign(key, { material: null, iv: null, destroyed_at: now, destroyed_by: args.p_by });
    return { data: erased, error: null };
  }

  return {
    tables,
    log,
    client: { from, rpc },
  };
}
