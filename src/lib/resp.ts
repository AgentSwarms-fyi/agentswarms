// RESP2 — the wire format valkey and redis speak.
//
// NO IMPORTS: encoding and parsing are pure byte work, so they are tested
// against byte strings rather than against a running server, and the server
// test then only has to prove that the socket plumbing around them works.
//
// WHY THIS IS HERE INSTEAD OF A CLIENT LIBRARY. Five commands are needed —
// PING, SET, MGET, SCAN, DEL — and a dependency in a source-available product
// is a thing its operators inherit. What makes hand-writing it acceptable is
// not that the protocol is easy (a framing bug is a real hazard) but that the
// feature store is NEVER AUTHORITATIVE: every failure path falls back to the
// lakehouse and answers correctly, slower. A parser bug here costs latency,
// not correctness — which is not true of most places one might hand-roll a
// protocol, and is the whole reason this one may be.
//
// RESP3 is not spoken. The client never sends HELLO, so the server stays in
// RESP2, which is the format below.

/** A reply, as the protocol can express it. Errors are values here, not throws. */
export type RespValue = string | number | null | RespError | RespValue[];

export class RespError extends Error {}

const CR = 13;
const LF = 10;

/**
 * Encode one command as an array of bulk strings.
 *
 * Bulk strings carry a BYTE length, so anything non-ASCII has to be measured
 * after encoding rather than by `.length` — a feature value containing "é" is
 * one character and two bytes, and sending the character count truncates the
 * command and desynchronises every reply after it.
 */
export function encodeCommand(args: (string | number)[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [enc.encode(`*${args.length}\r\n`)];
  for (const a of args) {
    const body = enc.encode(String(a));
    parts.push(enc.encode(`$${body.length}\r\n`), body, enc.encode("\r\n"));
  }
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Where a CRLF ends the line starting at `from`, or -1 when it is not all here yet. */
function lineEnd(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
}

/**
 * Parse ONE reply beginning at `at`.
 *
 * Returns null when the buffer does not yet hold a whole reply — the caller
 * keeps the bytes and tries again when more arrive. That case is the entire
 * reason this is written as a resumable parse rather than a stream of events:
 * a bulk string can and does arrive in two packets.
 */
export function parseReply(buf: Uint8Array, at: number): { value: RespValue; next: number } | null {
  if (at >= buf.length) return null;
  const kind = buf[at];
  const end = lineEnd(buf, at + 1);
  if (end === -1) return null;
  const head = new TextDecoder().decode(buf.subarray(at + 1, end));
  const after = end + 2;

  switch (kind) {
    case 0x2b /* + */:
      return { value: head, next: after };
    case 0x2d /* - */:
      return { value: new RespError(head), next: after };
    case 0x3a /* : */:
      return { value: Number(head), next: after };
    case 0x24 /* $ */: {
      const len = Number(head);
      if (len === -1) return { value: null, next: after };
      // +2 for the CRLF that follows the payload. Without checking for it, a
      // reply whose last byte has arrived but whose terminator has not would
      // be read as complete and the next parse would start one byte early.
      if (buf.length < after + len + 2) return null;
      return {
        value: new TextDecoder().decode(buf.subarray(after, after + len)),
        next: after + len + 2,
      };
    }
    case 0x2a /* * */: {
      const n = Number(head);
      if (n === -1) return { value: null, next: after };
      const items: RespValue[] = [];
      let cursor = after;
      for (let i = 0; i < n; i++) {
        const item = parseReply(buf, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      // Not RESP2. Treated as a protocol error rather than guessed at: the
      // connection is desynchronised and the only safe move is to drop it.
      return { value: new RespError(`unexpected reply byte ${kind}`), next: after };
  }
}

/**
 * Parse as many whole replies as the buffer holds.
 *
 * `consumed` is how many bytes to drop; anything after it is the start of a
 * reply that has not fully arrived.
 */
export function parseReplies(buf: Uint8Array): { replies: RespValue[]; consumed: number } {
  const replies: RespValue[] = [];
  let at = 0;
  for (;;) {
    const one = parseReply(buf, at);
    if (!one) break;
    replies.push(one.value);
    at = one.next;
  }
  return { replies, consumed: at };
}
