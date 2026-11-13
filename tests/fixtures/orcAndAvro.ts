// Minimal ORC and Avro writers, so the object-store tests can make their own files.
//
// DuckDB reads ORC through a community extension and cannot write it — on
// v1.5.5, `COPY ... (FORMAT orc)` is "Copy Function with name orc does not
// exist" — and it has no Avro support at all. Nothing in node_modules writes
// either. Without a writer, tests/unit/objectStoreParquet.test.ts read files
// that only existed in a bucket someone had seeded by hand, and on a fresh
// store they failed with NoSuchKey.
//
// Scope is what those tests need and no more. ORC: one stripe, no compression,
// no nulls, no row index, and the ORC 0.11 encodings (RLE v1, DIRECT and
// DICTIONARY strings), which every reader still supports; types boolean, int,
// bigint, double, string, struct, list, map. Avro: one uncompressed block of
// long and string fields. Layouts follow https://orc.apache.org/specification/ORCv1/
// and https://avro.apache.org/docs/1.11.1/specification/#object-container-files.

export type OrcColumn =
  | { kind: "boolean"; values: ArrayLike<boolean> }
  | { kind: "int" | "bigint"; values: ArrayLike<number> }
  | { kind: "double"; values: ArrayLike<number> }
  | { kind: "string"; values: ArrayLike<string> }
  | { kind: "struct"; fields: [string, OrcColumn][] }
  | { kind: "list"; lengths: ArrayLike<number>; element: OrcColumn }
  | { kind: "map"; lengths: ArrayLike<number>; key: OrcColumn; value: OrcColumn };

/** A growable byte buffer. A number[] would cost 8 bytes per byte of a 5 MB file. */
class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(b: number) {
    this.room(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  /** Unsigned base-128 varint. BigInt, because zigzag doubles a value past 2^53. */
  varint(n: number | bigint) {
    if (typeof n === "number" && n < 0x80000000) {
      while (n >= 0x80) {
        this.byte((n & 0x7f) | 0x80);
        n >>>= 7;
      }
      this.byte(n);
      return;
    }
    let v = BigInt(n);
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    this.byte(Number(v));
  }
  /** Zigzag, so small negative numbers stay small: 0, -1, 1, -2 → 0, 1, 2, 3. */
  signed(n: number) {
    if (!Number.isSafeInteger(n)) throw new Error(`${n} is not an exact integer`);
    if (Math.abs(n) < 0x40000000) this.varint(n >= 0 ? 2 * n : -2 * n - 1);
    else this.varint(n >= 0 ? 2n * BigInt(n) : -2n * BigInt(n) - 1n);
  }
  done() {
    return this.buf.slice(0, this.len);
  }
}

const utf8 = new TextEncoder();

// ── protobuf, the two wire types the ORC footer uses ────────────────────────
type PbValue = number | string | Uint8Array;
type PbField = [number, PbValue];

function pb(fields: PbField[]): Uint8Array {
  const out = new Bytes();
  for (const [field, v] of fields) {
    if (typeof v === "number") {
      out.varint(field * 8); // wire type 0: varint
      out.varint(v);
    } else {
      const b = typeof v === "string" ? utf8.encode(v) : v;
      out.varint(field * 8 + 2); // wire type 2: length-delimited
      out.varint(b.length);
      out.bytes(b);
    }
  }
  return out.done();
}

/** A packed repeated uint32, carried as one length-delimited field. */
function packed(nums: number[]): Uint8Array {
  const out = new Bytes();
  for (const n of nums) out.varint(n);
  return out.done();
}

// ── the ORC 0.11 run-length encodings ───────────────────────────────────────

/**
 * Integer RLE v1: a run is 3–130 values with one constant delta that fits a
 * signed byte (control 0..127 = length - 3, the delta, then the first value);
 * anything else goes out as literals (control -1..-128 = count, then values).
 */
function intRle(values: ArrayLike<number>, signed: boolean): Uint8Array {
  const out = new Bytes();
  const put = (v: number) => (signed ? out.signed(v) : out.varint(v));
  const literals: number[] = [];
  const flush = () => {
    for (let s = 0; s < literals.length; s += 128) {
      const chunk = literals.slice(s, s + 128);
      out.byte(256 - chunk.length);
      chunk.forEach(put);
    }
    literals.length = 0;
  };
  for (let i = 0; i < values.length;) {
    const delta = values[i + 1] - values[i];
    if (
      i + 2 < values.length &&
      delta >= -128 &&
      delta <= 127 &&
      values[i + 2] - values[i + 1] === delta
    ) {
      let len = 3;
      while (
        len < 130 &&
        i + len < values.length &&
        values[i + len] - values[i + len - 1] === delta
      )
        len++;
      flush();
      out.byte(len - 3);
      out.byte(delta & 0xff);
      put(values[i]);
      i += len;
    } else {
      literals.push(values[i++]);
    }
  }
  flush();
  return out.done();
}

/** Byte RLE: runs of 3–130 equal bytes, else up to 128 literals. */
function byteRle(bytes: ArrayLike<number>): Uint8Array {
  const out = new Bytes();
  const literals: number[] = [];
  const flush = () => {
    for (let s = 0; s < literals.length; s += 128) {
      const chunk = literals.slice(s, s + 128);
      out.byte(256 - chunk.length);
      chunk.forEach((b) => out.byte(b));
    }
    literals.length = 0;
  };
  for (let i = 0; i < bytes.length;) {
    let len = 1;
    while (len < 130 && i + len < bytes.length && bytes[i + len] === bytes[i]) len++;
    if (len >= 3) {
      flush();
      out.byte(len - 3);
      out.byte(bytes[i]);
      i += len;
    } else {
      literals.push(bytes[i++]);
    }
  }
  flush();
  return out.done();
}

/** Booleans are bit-packed, most significant bit first, then byte-RLE'd. */
function booleanRle(values: ArrayLike<boolean>): Uint8Array {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i]) bits[i >> 3] |= 0x80 >> (i & 7);
  return byteRle(bits);
}

// ── columns → types, streams, encodings, statistics ─────────────────────────
const KIND = { boolean: 0, int: 3, bigint: 4, double: 6, string: 7, list: 10, map: 11, struct: 12 };
const STREAM = { DATA: 1, LENGTH: 2, DICTIONARY_DATA: 3 };
const ENCODING = { DIRECT: 0, DICTIONARY: 1 };

type Stream = { column: number; kind: number; bytes: Uint8Array };
type Columns = { types: Uint8Array[]; encodings: Uint8Array[]; stats: Uint8Array[] };

const sum = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
};

/**
 * Strings: a dictionary when the column repeats itself (what real writers do
 * for low-cardinality text, and what keeps a 1.9M-row fixture near 5 MB),
 * otherwise the bytes themselves.
 */
function encodeString(values: ArrayLike<string>, id: number, streams: Stream[]): Uint8Array {
  const distinct = [...new Set(Array.from(values))].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
  const lengths: number[] = [];
  const data = new Bytes();
  const take = (s: string) => {
    const b = utf8.encode(s);
    data.bytes(b);
    lengths.push(b.length);
  };
  if (distinct.length * 2 > values.length) {
    Array.from(values).forEach(take);
    streams.push({ column: id, kind: STREAM.DATA, bytes: data.done() });
    streams.push({ column: id, kind: STREAM.LENGTH, bytes: intRle(lengths, false) });
    return pb([[1, ENCODING.DIRECT]]);
  }
  // DICTIONARY: the entries sorted by UTF-8 bytes, as the specification has it,
  // and each row stored as its entry's index.
  distinct.forEach(take);
  const index = new Map(distinct.map((s, i) => [s, i]));
  const rows = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) rows[i] = index.get(values[i])!;
  streams.push({ column: id, kind: STREAM.DATA, bytes: intRle(rows, false) });
  streams.push({ column: id, kind: STREAM.DICTIONARY_DATA, bytes: data.done() });
  streams.push({ column: id, kind: STREAM.LENGTH, bytes: intRle(lengths, false) });
  return pb([
    [1, ENCODING.DICTIONARY],
    [2, distinct.length],
  ]);
}

/** Flatten a column tree in pre-order, which is how ORC numbers its columns. */
function encodeColumn(col: OrcColumn, count: number, out: Columns, streams: Stream[]): number {
  const id = out.types.length;
  out.types.push(new Uint8Array());
  out.encodings.push(pb([[1, ENCODING.DIRECT]]));
  out.stats.push(pb([[1, count]])); // numberOfValues; nothing here is ever null
  const children: number[] = [];
  const names: string[] = [];
  switch (col.kind) {
    case "boolean":
      streams.push({ column: id, kind: STREAM.DATA, bytes: booleanRle(col.values) });
      break;
    case "int":
    case "bigint":
      streams.push({ column: id, kind: STREAM.DATA, bytes: intRle(col.values, true) });
      break;
    case "double": {
      const view = new DataView(new ArrayBuffer(col.values.length * 8));
      for (let i = 0; i < col.values.length; i++) view.setFloat64(i * 8, col.values[i], true);
      streams.push({ column: id, kind: STREAM.DATA, bytes: new Uint8Array(view.buffer) });
      break;
    }
    case "string":
      out.encodings[id] = encodeString(col.values, id, streams);
      break;
    case "struct":
      for (const [name, child] of col.fields) {
        names.push(name);
        children.push(encodeColumn(child, count, out, streams));
      }
      break;
    case "list":
      streams.push({ column: id, kind: STREAM.LENGTH, bytes: intRle(col.lengths, false) });
      children.push(encodeColumn(col.element, sum(col.lengths), out, streams));
      break;
    case "map": {
      streams.push({ column: id, kind: STREAM.LENGTH, bytes: intRle(col.lengths, false) });
      const entries = sum(col.lengths);
      children.push(encodeColumn(col.key, entries, out, streams));
      children.push(encodeColumn(col.value, entries, out, streams));
      break;
    }
  }
  out.types[id] = pb([
    [1, KIND[col.kind]],
    ...(children.length ? [[2, packed(children)] as PbField] : []),
    ...names.map((n): PbField => [3, n]),
  ]);
  return id;
}

/** An ORC file holding `rows` rows of the given top-level columns. */
export function writeOrc(rows: number, columns: [string, OrcColumn][]): Uint8Array {
  const cols: Columns = { types: [], encodings: [], stats: [] };
  const streams: Stream[] = [];
  encodeColumn({ kind: "struct", fields: columns }, rows, cols, streams);

  const file = new Bytes();
  file.bytes(utf8.encode("ORC"));
  for (const s of streams) file.bytes(s.bytes);
  const dataLength = file.len - 3;
  const stripeFooter = pb([
    ...streams.map((s): PbField => [
      1,
      pb([
        [1, s.kind],
        [2, s.column],
        [3, s.bytes.length],
      ]),
    ]),
    ...cols.encodings.map((e): PbField => [2, e]),
    [3, "UTC"],
  ]);
  file.bytes(stripeFooter);

  const footer = pb([
    [1, 3], // headerLength: the "ORC" magic
    [2, file.len], // contentLength: header + stripes
    [
      3,
      pb([
        [1, 3], // offset
        [2, 0], // indexLength: no row index
        [3, dataLength],
        [4, stripeFooter.length],
        [5, rows],
      ]),
    ],
    ...cols.types.map((t): PbField => [4, t]),
    [6, rows],
    ...cols.stats.map((s): PbField => [7, s]),
    [8, 0], // rowIndexStride: 0 means no index
  ]);
  file.bytes(footer);

  const postscript = pb([
    [1, footer.length],
    [2, 0], // compression: NONE
    [3, 262144],
    [4, packed([0, 11])], // file version 0.11, the RLE v1 encodings used above
    [5, 0], // metadataLength: no stripe statistics
    [6, 1], // writerVersion: HIVE_8732
    [8000, "ORC"],
  ]);
  file.bytes(postscript);
  file.byte(postscript.length);
  return file.done();
}

/** An Avro object container file: one record type, one block, codec "null". */
export function writeAvro(
  name: string,
  fields: [string, "long" | "string"][],
  rows: (number | string)[][],
): Uint8Array {
  const out = new Bytes();
  const str = (s: string) => {
    const b = utf8.encode(s);
    out.signed(b.length);
    out.bytes(b);
  };
  out.bytes(utf8.encode("Obj\x01"));
  const schema = JSON.stringify({
    type: "record",
    name,
    fields: fields.map(([n, type]) => ({ name: n, type })),
  });
  // File metadata is a map<bytes>: one block of two entries, then a zero count.
  out.signed(2);
  str("avro.schema");
  str(schema);
  str("avro.codec");
  str("null");
  out.signed(0);
  const sync = utf8.encode("as-test-fixture!"); // any 16 bytes, repeated after each block
  out.bytes(sync);

  const block = new Bytes();
  for (const row of rows) {
    fields.forEach(([, type], i) => {
      if (type === "long") block.signed(row[i] as number);
      else {
        const b = utf8.encode(row[i] as string);
        block.signed(b.length);
        block.bytes(b);
      }
    });
  }
  const body = block.done();
  out.signed(rows.length);
  out.signed(body.length);
  out.bytes(body);
  out.bytes(sync);
  return out.done();
}

// ── the files the object-store tests put in the bucket ──────────────────────

/**
 * TPC-DS customer_demographics: every combination of eight attributes, so
 * 2·5·7·20·4·7·7·7 = 1,920,800 rows. The same shape as the Apache ORC
 * project's demo-11 file the tests were first measured on, including Hive's
 * anonymous `_colN` names, and about 5 MB — big enough that the ORC download
 * ceiling has something to refuse.
 */
const GENDER = ["M", "F"];
const MARITAL = ["M", "S", "D", "W", "U"];
const EDUCATION = [
  "Primary",
  "Secondary",
  "College",
  "2 yr Degree",
  "4 yr Degree",
  "Advanced Degree",
  "Unknown",
];
const CREDIT = ["Good", "High Risk", "Low Risk", "Unknown"];
// gender, marital, education, purchase estimate, credit, three dependant counts
const RADICES = [GENDER.length, MARITAL.length, EDUCATION.length, 20, CREDIT.length, 7, 7, 7];

export const FLAT_ORC_ROWS = RADICES.reduce((a, b) => a * b, 1);

export function flatOrc(): Uint8Array {
  const n = FLAT_ORC_ROWS;
  // Row i is a mixed-radix number, one digit per attribute, the first fastest.
  const digits = RADICES.map(() => new Uint8Array(n));
  for (let i = 0; i < n; i++) {
    let r = i;
    RADICES.forEach((base, k) => {
      digits[k][i] = r % base;
      r = Math.floor(r / base);
    });
  }
  const text = (k: number, labels: string[]): OrcColumn => ({
    kind: "string",
    values: Array.from(digits[k], (d) => labels[d]),
  });
  const int = (k: number, f: (d: number) => number = (d) => d): OrcColumn => ({
    kind: "int",
    values: Int32Array.from(digits[k], f),
  });
  return writeOrc(n, [
    ["_col0", { kind: "int", values: Int32Array.from({ length: n }, (_, i) => i + 1) }],
    ["_col1", text(0, GENDER)],
    ["_col2", text(1, MARITAL)],
    ["_col3", text(2, EDUCATION)],
    ["_col4", int(3, (d) => 500 * (d + 1))],
    ["_col5", text(4, CREDIT)],
    ["_col6", int(5)],
    ["_col7", int(6)],
    ["_col8", int(7)],
  ]);
}

/**
 * The shape of the Apache ORC project's TestOrcFile.test1: scalars beside a
 * struct holding a list of structs, a list of structs, and a map of structs.
 *
 * The MAP is the column that matters. On DuckDB v1.5.5 the ORC extension's
 * DESCRIBE silently leaves a MAP(VARCHAR, STRUCT) column out — 7 columns
 * where the file has 8 — and reading the file then panics in the extension's
 * Arrow bridge ("assertion `left == right` failed, left: 8, right: 7", the same
 * assertion test1 trips with 12 and 11), which aborts the process. Without the
 * map the file reads cleanly; checked column by column.
 */
export function nestedOrc(): Uint8Array {
  const inner = (ints: number[], strings: string[]): OrcColumn => ({
    kind: "struct",
    fields: [
      ["int1", { kind: "int", values: ints }],
      ["string1", { kind: "string", values: strings }],
    ],
  });
  return writeOrc(2, [
    ["boolean1", { kind: "boolean", values: [false, true] }],
    ["int1", { kind: "int", values: [65536, 65536] }],
    ["long1", { kind: "bigint", values: [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER] }],
    ["double1", { kind: "double", values: [-15, -5] }],
    ["string1", { kind: "string", values: ["hi", "bye"] }],
    [
      "middle",
      {
        kind: "struct",
        fields: [
          [
            "list",
            {
              kind: "list",
              lengths: [2, 2],
              element: inner([1, 2, 1, 2], ["bye", "sigh", "bye", "sigh"]),
            },
          ],
        ],
      },
    ],
    [
      "list",
      {
        kind: "list",
        lengths: [2, 3],
        element: inner([3, 4, 100000000, -100000, 1234], ["good", "bad", "cat", "in", "hat"]),
      },
    ],
    [
      "map",
      {
        kind: "map",
        lengths: [0, 2],
        key: { kind: "string", values: ["chani", "mauddib"] },
        value: inner([5, 1], ["chani", "mauddib"]),
      },
    ],
  ]);
}

/** A real Avro file the platform has no reader for. */
export function eventsAvro(): Uint8Array {
  return writeAvro(
    "Event",
    [
      ["event_id", "long"],
      ["kind", "string"],
    ],
    [
      [1, "click"],
      [2, "view"],
      [3, "click"],
    ],
  );
}
