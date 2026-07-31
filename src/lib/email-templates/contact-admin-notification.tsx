// Internal notification sent to the AgentSwarms admin every time a visitor
// submits the public contact form. The recipient (admin) explicitly opted in
// by being the project owner — this is a 1:1 transactional message tied to a
// specific user-initiated event.
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Hr,
} from "@react-email/components";
import type { TemplateEntry } from "./registry";

const SITE_NAME = "AgentSwarms";

interface ContactAdminProps {
  name?: string;
  email?: string;
  subject?: string;
  message?: string;
  sourcePage?: string;
  submittedAt?: string;
}

const ContactAdminEmail = ({
  name,
  email,
  subject,
  message,
  sourcePage,
  submittedAt,
}: ContactAdminProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`New contact message from ${name ?? "a visitor"}`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>New contact message</Heading>
        <Text style={lead}>Someone just reached out through the {SITE_NAME} contact form.</Text>

        <Section style={card}>
          <Row label="From" value={name ?? "(no name)"} />
          <Row label="Email" value={email ?? "(no email)"} />
          {subject ? <Row label="Subject" value={subject} /> : null}
          {sourcePage ? <Row label="Page" value={sourcePage} /> : null}
          {submittedAt ? <Row label="Submitted" value={submittedAt} /> : null}
        </Section>

        <Heading style={h2}>Message</Heading>
        <Text style={messageStyle}>{message ?? "(empty)"}</Text>

        <Hr style={hr} />
        <Text style={footer}>
          You received this because you are the {SITE_NAME} project admin. Reply directly to this
          email to respond to the sender.
        </Text>
      </Container>
    </Body>
  </Html>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <Text style={rowText}>
    <span style={rowLabel}>{label}: </span>
    <span style={rowValue}>{value}</span>
  </Text>
);

export const template = {
  component: ContactAdminEmail,
  subject: (data: Record<string, any>) =>
    `[AgentSwarms] New contact: ${data?.subject || data?.name || "visitor message"}`,
  displayName: "Admin: contact form notification",
  previewData: {
    name: "Jane Doe",
    email: "jane@example.com",
    subject: "Question about swarms",
    message: "Hi! Loving the platform. How do I export a swarm to JSON?",
    sourcePage: "/contact",
    submittedAt: "2026-04-21 14:32 UTC",
  },
} satisfies TemplateEntry;

const main = {
  backgroundColor: "#ffffff",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
};
const container = { padding: "24px 28px", maxWidth: "560px" };
const h1 = {
  fontSize: "22px",
  fontWeight: 700,
  color: "#0b0d12",
  margin: "0 0 8px",
};
const h2 = {
  fontSize: "14px",
  fontWeight: 600,
  color: "#0b0d12",
  margin: "20px 0 8px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const lead = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.5",
  margin: "0 0 16px",
};
const card = {
  background: "#f6f7fb",
  borderRadius: "8px",
  padding: "14px 16px",
  margin: "0 0 8px",
};
const rowText = { fontSize: "14px", color: "#0b0d12", margin: "4px 0" };
const rowLabel = { color: "#6b7280", fontWeight: 500 };
const rowValue = { color: "#0b0d12", fontWeight: 500 };
const messageStyle = {
  fontSize: "14px",
  color: "#0b0d12",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
  background: "#fafbff",
  border: "1px solid #e6e8ee",
  borderRadius: "8px",
  padding: "14px 16px",
  margin: "0 0 16px",
};
const hr = {
  border: "none",
  borderTop: "1px solid #e6e8ee",
  margin: "24px 0 16px",
};
const footer = { fontSize: "12px", color: "#8a8d96", margin: 0 };
