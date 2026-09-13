// The wire format, checked at the byte level.
//
// Every failure this file is about is a FRAMING failure: the parser thinks a
// reply ended somewhere it did not, and from then on every answer belongs to
// the wrong command. That is invisible in a happy-path test against a running
// server, because a server on a fast loopback usually delivers a whole reply
// in one packet. So the bytes are fed in deliberately awkward ways here.
import { describe, expect, it } from "vitest";

import { encodeCommand, parseReplies, parseReply, RespError } from "@/lib/resp";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("encoding a command", () => {
  it("is an array of bulk strings", () => {
    expect(text(encodeCommand(["PING"]))).toBe("*1\r\n$4\r\nPING\r\n");
    expect(text(encodeCommand(["GET", "a"]))).toBe("*2\r\n$3\r\nGET\r\n$1\r\na\r\n");
  });

  it("measures the payload in BYTES, not characters", () => {
    // "é" is one character and two bytes. Sending $1 truncates the command and
    // every reply after it belongs to the wrong caller — the exact failure
    // this module can least afford, since feature values are arbitrary UTF-8.
    const out = text(encodeCommand(["SET", "k", "é"]));
    expect(out).toContain("$2\r\né\r\n");
    expect(out).not.toContain("$1\r\né");
  });

  it("and numbers travel as their decimal text", () => {
    expect(text(encodeCommand(["EXPIRE", "k", 60]))).toContain("$2\r\n60\r\n");
  });
});

describe("parsing what comes back", () => {
  it("reads each RESP2 type", () => {
    expect(parseReply(bytes("+OK\r\n"), 0)?.value).toBe("OK");
    expect(parseReply(bytes(":42\r\n"), 0)?.value).toBe(42);
    expect(parseReply(bytes("$5\r\nhello\r\n"), 0)?.value).toBe("hello");
    expect(parseReply(bytes("$-1\r\n"), 0)?.value).toBeNull();
    expect(parseReply(bytes("*2\r\n$1\r\na\r\n$1\r\nb\r\n"), 0)?.value).toEqual(["a", "b"]);
  });

  it("gives an error back as a value, never as a throw", () => {
    // A command that fails must not take the connection down with it: the
    // caller decides whether an error means "fall back" or "this key is
    // simply not here", and it cannot decide anything from a stack unwind.
    const v = parseReply(bytes("-ERR no such key\r\n"), 0)?.value;
    expect(v).toBeInstanceOf(RespError);
    expect((v as RespError).message).toBe("ERR no such key");
  });

  it("returns null for a reply that has not all arrived", () => {
    expect(parseReply(bytes("$5\r\nhel"), 0)).toBeNull();
    expect(parseReply(bytes("+OK"), 0)).toBeNull();
    expect(parseReply(bytes("*2\r\n$1\r\na\r\n"), 0)).toBeNull();
  });

  it("and waits for the CRLF after a bulk string, not just its bytes", () => {
    // The payload is all here and the terminator is not. Treating this as
    // complete would start the NEXT parse two bytes early, and from there the
    // stream is garbage — the subtlest framing bug there is.
    expect(parseReply(bytes("$5\r\nhello"), 0)).toBeNull();
    expect(parseReply(bytes("$5\r\nhello\r\n"), 0)?.next).toBe(11);
  });

  it("a bulk string may contain CRLF of its own", () => {
    // Length-prefixed, so the terminator inside the payload means nothing. A
    // parser that scanned for CRLF instead of counting would cut it short —
    // and a JSON feature row with a newline in a string value would do it.
    const r = parseReply(bytes("$7\r\na\r\nb\r\nc\r\n"), 0);
    expect(r?.value).toBe("a\r\nb\r\nc");
    expect(r?.next).toBe(13);
  });
});

describe("a pipeline of replies", () => {
  it("splits into one value per command", () => {
    const { replies, consumed } = parseReplies(bytes("+OK\r\n+OK\r\n:3\r\n"));
    expect(replies).toEqual(["OK", "OK", 3]);
    expect(consumed).toBe(14);
  });

  it("consumes only whole replies and leaves the rest", () => {
    // This is what makes the socket handler correct: the leftover bytes are
    // the beginning of the next reply and must be kept, not dropped.
    const buf = bytes("+OK\r\n$5\r\nhel");
    const { replies, consumed } = parseReplies(buf);
    expect(replies).toEqual(["OK"]);
    expect(consumed).toBe(5);
    expect(text(buf.subarray(consumed))).toBe("$5\r\nhel");
  });

  it("and reassembles a reply delivered one byte at a time", () => {
    // The real arrival pattern for anything larger than a packet. Feeding it
    // byte by byte is the cheapest way to prove the parser never guesses.
    const whole = bytes("*2\r\n$3\r\nfoo\r\n$-1\r\n+OK\r\n");
    let held = new Uint8Array(0);
    const got: unknown[] = [];
    for (const b of whole) {
      const grown = new Uint8Array(held.length + 1);
      grown.set(held);
      grown[held.length] = b;
      const { replies, consumed } = parseReplies(grown);
      got.push(...replies);
      held = grown.subarray(consumed);
    }
    expect(got).toEqual([["foo", null], "OK"]);
    expect(held.length).toBe(0);
  });
});
