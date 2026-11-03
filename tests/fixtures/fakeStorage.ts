// An in-memory Supabase Storage for the stored-files tests (R441): buckets of
// objects with their content type; upload (upsert or not), download (a Blob),
// list (one folder level, folders as `id: null`, paged), remove. Errors have
// storage-js's shape: a missing object is status 400 with statusCode "404".
type Obj = { bytes: Uint8Array; contentType: string };
type StorageErr = { message: string; status?: number; statusCode?: string };

export type FakeStorage = ReturnType<typeof fakeStorage>;

export function fakeStorage(buckets: string[] = ["chat-docs", "datasets"]) {
  const objects = new Map<string, Map<string, Obj>>();
  for (const b of buckets) objects.set(b, new Map());
  const calls = { upload: 0, download: 0, list: 0, remove: 0 };
  /** Make the next calls of a kind fail with this message, per bucket. */
  const failures: Record<string, Partial<Record<"upload" | "download" | "list", string>>> = {};
  const noBucket: StorageErr = { message: "Bucket not found", status: 400, statusCode: "404" };
  const notFound: StorageErr = { message: "Object not found", status: 400, statusCode: "404" };

  async function bytesOf(body: unknown): Promise<Uint8Array> {
    if (body instanceof Uint8Array) return new Uint8Array(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
    return new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
  }

  function from(bucket: string) {
    const objs = objects.get(bucket);
    const failing = (kind: "upload" | "download" | "list"): StorageErr | null =>
      failures[bucket]?.[kind] ? { message: failures[bucket]![kind]!, status: 500 } : null;
    return {
      async upload(
        path: string,
        body: unknown,
        opts: { upsert?: boolean; contentType?: string } = {},
      ) {
        calls.upload++;
        if (!objs) return { data: null, error: noBucket };
        const f = failing("upload");
        if (f) return { data: null, error: f };
        if (objs.has(path) && !opts.upsert) {
          return {
            data: null,
            error: { message: "The resource already exists", status: 400, statusCode: "409" },
          };
        }
        objs.set(path, {
          bytes: await bytesOf(body),
          contentType: opts.contentType ?? "application/octet-stream",
        });
        return { data: { path }, error: null };
      },
      async download(path: string) {
        calls.download++;
        if (!objs) return { data: null, error: noBucket };
        const f = failing("download");
        if (f) return { data: null, error: f };
        const o = objs.get(path);
        if (!o) return { data: null, error: notFound };
        return { data: new Blob([o.bytes as BlobPart], { type: o.contentType }), error: null };
      },
      async list(prefix = "", opts: { limit?: number; offset?: number } = {}) {
        calls.list++;
        if (!objs) return { data: null, error: noBucket };
        const f = failing("list");
        if (f) return { data: null, error: f };
        const base = prefix ? `${prefix}/` : "";
        const entries = new Map<string, Record<string, unknown>>();
        for (const [key, o] of objs) {
          if (!key.startsWith(base)) continue;
          const rest = key.slice(base.length);
          const [head, ...tail] = rest.split("/");
          if (!head) continue;
          if (tail.length > 0) entries.set(head, { name: head, id: null, metadata: null });
          else {
            entries.set(head, {
              name: head,
              id: `obj-${key}`,
              metadata: { mimetype: o.contentType, size: o.bytes.length },
            });
          }
        }
        const sorted = [...entries.values()].sort((a, b) =>
          String(a.name).localeCompare(String(b.name)),
        );
        const offset = opts.offset ?? 0;
        return { data: sorted.slice(offset, offset + (opts.limit ?? 100)), error: null };
      },
      async remove(paths: string[]) {
        calls.remove++;
        if (!objs) return { data: null, error: noBucket };
        for (const p of paths) objs.delete(p);
        return { data: paths.map((name) => ({ name })), error: null };
      },
    };
  }

  return {
    client: { from },
    objects,
    calls,
    failures,
    /** Put an object as a browser (or a version before R441) would have: as it is. */
    put(bucket: string, path: string, bytes: Uint8Array, contentType = "application/octet-stream") {
      objects.get(bucket)!.set(path, { bytes: new Uint8Array(bytes), contentType });
    },
    get(bucket: string, path: string): Obj | undefined {
      return objects.get(bucket)?.get(path);
    },
  };
}
