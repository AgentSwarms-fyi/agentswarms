// Confirmation sent back to the visitor who just submitted the public contact
// form. 1:1 transactional — the recipient explicitly triggered it by hitting
// "Send" on /contact, so they expect this email.
import { Body, Container, Head, Heading, Html, Preview, Text, Hr } from "@react-email/components";
import type { TemplateEntry } from "./registry";

const SITE_NAME = "AgentSwarms";

interface ContactConfirmationProps {
  name?: string;
  message?: string;
}

const ContactConfirmationEmail = ({ name, message }: ContactConfirmationProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{`Thanks for reaching out to ${SITE_NAME}`}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Heading style={h1}>{name ? `Thanks, ${name}!` : "Thanks for reaching out!"}</Heading>
        <Text style={lead}>
          We just received your message. Someone from the {SITE_NAME} team will get back to you
          within 1–2 business days.
        </Text>
        {message ? (
          <>
            <Text style={metaLabel}>Your message:</Text>
            <Text style={messageBox}>{message}</Text>
          </>
        ) : null}
        <Hr style={hr} />
        <Text style={footer}>{SITE_NAME} — Unified Agentic AI &amp; Business Intelligence.</Text>
      </Container>
    </Body>
  </Html>
);

export const template = {
  component: ContactConfirmationEmail,
  subject: `Thanks for contacting ${SITE_NAME}`,
  displayName: "Visitor: contact form confirmation",
  previewData: {
    name: "Jane",
    message: "How do I export a swarm to JSON?",
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
  margin: "0 0 12px",
};
const lead = {
  fontSize: "14px",
  color: "#55575d",
  lineHeight: "1.6",
  margin: "0 0 16px",
};
const metaLabel = {
  fontSize: "12px",
  color: "#6b7280",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  margin: "8px 0 6px",
};
const messageBox = {
  fontSize: "14px",
  color: "#0b0d12",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
  background: "#f6f7fb",
  border: "1px solid #e6e8ee",
  borderRadius: "8px",
  padding: "12px 14px",
  margin: "0 0 16px",
};
const hr = {
  border: "none",
  borderTop: "1px solid #e6e8ee",
  margin: "24px 0 16px",
};
const footer = { fontSize: "12px", color: "#8a8d96", margin: 0 };
