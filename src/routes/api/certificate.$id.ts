// GET /api/certificate/:id  → returns a freshly-rendered certificate PDF.
// Authenticated: only the cert owner can download.
// Light-theme certificate using the AgentSwarms brand badge.
import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CERT_BADGE_BASE64 } from "@/assets/cert-badge-base64";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const Route = createFileRoute("/api/certificate/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const auth = request.headers.get("authorization") || "";
        const token = auth.replace(/^Bearer\s+/i, "");
        if (!token) return new Response("Unauthorized", { status: 401 });

        const supabase = createClient(
          import.meta.env.VITE_SUPABASE_URL!,
          import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY!,
          { global: { headers: { Authorization: `Bearer ${token}` } } },
        );
        const { data: cert } = await supabase
          .from("certificates")
          .select("*")
          .eq("id", params.id)
          .maybeSingle();
        if (!cert) return new Response("Not found", { status: 404 });

        const pdfBytes = await renderCertPdf(cert);
        return new Response(pdfBytes as any, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="AgentSwarms-${cert.verification_code}.pdf"`,
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
          },
        });
      },
    },
  },
});


async function renderCertPdf(cert: any): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 landscape (pt)
  const { width: W, height: H } = page.getSize();

  // Light palette — cream paper with AgentSwarms brand accents.
  const paper = rgb(0.992, 0.988, 0.980);   // #FDFCFA
  const ink = rgb(0.043, 0.110, 0.243);     // brand navy
  const inkSoft = rgb(0.227, 0.290, 0.400);
  const muted = rgb(0.45, 0.50, 0.58);
  const teal = rgb(0.102, 0.639, 0.659);    // #1AA3A8
  const orange = rgb(0.910, 0.608, 0.235);  // #E89B3C
  const hairline = rgb(0.85, 0.86, 0.88);

  const helvB = await doc.embedFont(StandardFonts.HelveticaBold);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvI = await doc.embedFont(StandardFonts.HelveticaOblique);
  const courB = await doc.embedFont(StandardFonts.CourierBold);
  const tsB = await doc.embedFont(StandardFonts.TimesRomanBold);

  const badgeBytes = base64ToBytes(CERT_BADGE_BASE64);
  const badge = await doc.embedPng(badgeBytes);

  // Background.
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: paper });

  // Simple double hairline border.
  page.drawRectangle({ x: 28, y: 28, width: W - 56, height: H - 56, borderColor: ink, borderWidth: 1.2 });
  page.drawRectangle({ x: 36, y: 36, width: W - 72, height: H - 72, borderColor: hairline, borderWidth: 0.5 });

  // Top brand bar (thin gradient feel via two rects).
  page.drawRectangle({ x: 36, y: H - 44, width: (W - 72) * 0.55, height: 3, color: teal });
  page.drawRectangle({ x: 36 + (W - 72) * 0.55, y: H - 44, width: (W - 72) * 0.45, height: 3, color: orange });

  // Wordmark — top left.
  page.drawText("AgentSwarms", { x: 58, y: H - 78, size: 14, font: helvB, color: ink });
  page.drawText("Agentic AI Lab  ·  agentswarms.fyi", { x: 58, y: H - 92, size: 8.5, font: helv, color: muted });

  // Verification — top right.
  drawRight(page, "VERIFICATION CODE", W - 58, H - 78, helv, 8, muted);
  drawRight(page, cert.verification_code, W - 58, H - 92, courB, 11, ink);

  // Centered badge.
  if (badge) {
    const size = 96;
    page.drawImage(badge, { x: W / 2 - size / 2, y: H - 200, width: size, height: size });
  }

  // Eyebrow.
  drawCenter(page, "CERTIFICATE  OF  COMPLETION", W / 2, H - 230, helvB, 10, teal);

  // Title.
  drawCenter(page, "Agentic AI Practitioner", W / 2, H - 270, tsB, 32, ink);

  // Recipient.
  drawCenter(page, "This certifies that", W / 2, H - 300, helv, 11, muted);
  drawCenter(page, cert.name_on_cert, W / 2, H - 338, tsB, 28, ink);

  const nameW = tsB.widthOfTextAtSize(cert.name_on_cert, 28);
  page.drawLine({
    start: { x: W / 2 - Math.max(200, nameW / 2 + 30), y: H - 348 },
    end: { x: W / 2 + Math.max(200, nameW / 2 + 30), y: H - 348 },
    color: hairline,
    thickness: 0.8,
  });

  if (cert.organization) {
    drawCenter(page, cert.organization, W / 2, H - 366, helvI, 11, muted);
  }

  const body = [
    "has successfully completed the AgentSwarms certification exam, demonstrating practical proficiency in",
    "LLM internals, agentic patterns, guardrails, Responsible AI, agent memory, multi-agent swarms, text-to-SQL",
    "agents, and the design, deployment, and evaluation of production-grade agentic systems.",
  ];
  body.forEach((ln, i) => drawCenter(page, ln, W / 2, H - 392 - i * 13, helv, 10, inkSoft));

  // Score row — simple cards on paper.
  const scores = [
    ["MULTIPLE-CHOICE", `${cert.mcq_score}%`, "of 50 questions", teal],
    ["AGENT BUILDS", `${cert.agent_score}%`, "5 agents evaluated", ink],
    ["SWARM DESIGN", `${cert.swarm_score}%`, "2 swarms evaluated", orange],
  ] as const;
  const boxW = 170;
  const boxH = 54;
  const gap = 22;
  const totalW = boxW * 3 + gap * 2;
  const startX = (W - totalW) / 2;
  const boxesY = 102;
  scores.forEach(([label, value, sub, accent], i) => {
    const x = startX + i * (boxW + gap);
    page.drawRectangle({ x, y: boxesY, width: boxW, height: boxH, borderColor: hairline, borderWidth: 0.8 });
    page.drawRectangle({ x, y: boxesY + boxH - 2, width: boxW, height: 2, color: accent as any });
    drawCenter(page, label as string, x + boxW / 2, boxesY + boxH - 15, helvB, 7, muted);
    drawCenter(page, value as string, x + boxW / 2, boxesY + 24, helvB, 22, ink);
    drawCenter(page, sub as string, x + boxW / 2, boxesY + 10, helv, 7, muted);
  });

  // Footer signature row.
  page.drawLine({ start: { x: 95, y: 68 }, end: { x: 290, y: 68 }, color: ink, thickness: 0.6 });
  page.drawText("Curriculum Director", { x: 110, y: 74, size: 11, font: helvI, color: ink });
  page.drawText("AgentSwarms — Agentic AI Lab", { x: 95, y: 56, size: 8, font: helv, color: muted });

  page.drawLine({ start: { x: W - 290, y: 68 }, end: { x: W - 95, y: 68 }, color: ink, thickness: 0.6 });
  const issued = new Date(cert.issued_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  page.drawText(issued, { x: W - 275, y: 74, size: 11, font: helvB, color: ink });
  page.drawText("Date of issue", { x: W - 290, y: 56, size: 8, font: helv, color: muted });

  drawCenter(
    page,
    `Verify at agentswarms.fyi/verify/${cert.verification_code}   ·   Issued by AgentSwarms`,
    W / 2, 42, helv, 7.5, muted,
  );

  return await doc.save();
}

function drawCenter(page: any, str: string, x: number, y: number, font: any, size: number, color: any) {
  const w = font.widthOfTextAtSize(str, size);
  page.drawText(str, { x: x - w / 2, y, size, font, color });
}
function drawRight(page: any, str: string, x: number, y: number, font: any, size: number, color: any) {
  const w = font.widthOfTextAtSize(str, size);
  page.drawText(str, { x: x - w, y, size, font, color });
}
