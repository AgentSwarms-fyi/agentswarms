// The SMTP transport, end to end against a server on loopback.
//
// mailerTransports.test.ts checks that SMTP is a built-in dependency and that
// the docs say so; nothing sent a message through it. A major upgrade of
// nodemailer (6 to 10, for a security advisory) is exactly what such a test
// is for: the app's own sendMail, the installed nodemailer, and a server that
// records what it was told.
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Received = { mailFrom: string; rcptTo: string[]; data: string };

/** The least SMTP a client needs: greeting, EHLO, MAIL, RCPT, DATA, QUIT. */
function smtpServer() {
  const received: Received[] = [];
  const server = net.createServer((socket) => {
    let current: Received = { mailFrom: "", rcptTo: [], data: "" };
    let inData = false;
    let buffer = "";
    socket.write("220 loopback ESMTP test\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let i: number;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push(current);
            current = { mailFrom: "", rcptTo: [], data: "" };
            socket.write("250 queued\r\n");
          } else current.data += line + "\n";
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250-loopback\r\n250 8BITMIME\r\n");
        else if (verb === "MAIL") {
          current.mailFrom = line;
          socket.write("250 ok\r\n");
        } else if (verb === "RCPT") {
          current.rcptTo.push(line);
          socket.write("250 ok\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  return { server, received };
}

const { server, received } = smtpServer();
let port = 0;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
  for (const k of [
    "RESEND_API_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "EMAIL_FROM",
  ]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = "false";
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((r) => server.close(() => r()));
});

describe("SMTP through the installed nodemailer", () => {
  it("delivers a message: sender, recipient, subject and both bodies", async () => {
    const { sendMail } = await import("@/lib/email/mailer.server");
    const res = await sendMail({
      to: "ops@example.test",
      subject: "Recovered: orders fresh",
      html: "<p>The table is fresh again.</p>",
      text: "The table is fresh again.",
      headers: { "X-AgentSwarms-Test": "smtp-round-trip" },
    });
    expect(res).toEqual({ sent: true });
    expect(received).toHaveLength(1);
    const [msg] = received;
    expect(msg.mailFrom).toMatch(/^MAIL FROM:<[^>]+>/i);
    expect(msg.rcptTo).toEqual([expect.stringMatching(/^RCPT TO:<ops@example\.test>/i)]);
    expect(msg.data).toMatch(/^Subject: Recovered: orders fresh$/m);
    // Header names are case-insensitive; nodemailer writes X-Agentswarms-Test.
    expect(msg.data).toMatch(/^X-AgentSwarms-Test: smtp-round-trip$/im);
    expect(msg.data).toContain("The table is fresh again.");
    expect(msg.data).toMatch(/Content-Type: text\/html/i);
  });

  it("says why when the server refuses", async () => {
    const refusing = net.createServer((s) => s.end("554 no service here\r\n"));
    await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", () => r()));
    process.env.SMTP_PORT = String((refusing.address() as net.AddressInfo).port);
    try {
      const { sendMail } = await import("@/lib/email/mailer.server");
      const res = await sendMail({
        to: "ops@example.test",
        subject: "s",
        html: "<p>h</p>",
        text: "t",
      });
      expect(res.sent).toBe(false);
      expect((res as { reason: string }).reason).toMatch(/554|no service/i);
    } finally {
      process.env.SMTP_PORT = String(port);
      await new Promise<void>((r) => refusing.close(() => r()));
    }
  });
});
