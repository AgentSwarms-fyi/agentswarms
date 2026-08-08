import * as React from "react";

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

interface WelcomeEmailProps {
  siteName?: string;
  siteUrl?: string;
  recipient?: string;
}

export const WelcomeEmail = ({
  siteName = "AgentSwarms",
  // The operator's own instance. This used to default to agentswarms.fyi, which
  // is a DIFFERENT product — the hosted learning platform — so a self-hosted
  // deployment that forgot SITE_URL sent its new users to someone else's site.
  // localhost is wrong too, but it is obviously wrong, which is the point.
  siteUrl = "http://localhost:8080",
  recipient = "there",
}: WelcomeEmailProps) => {
  const dashboardUrl = `${siteUrl}/dashboard`;
  // Every link below is a route that ships WITH the app, so it resolves on any
  // instance. `/learn` was tried once and 404s on a self-hosted deployment —
  // it is a page on the hosted project site, not part of this product.
  const docsUrl = `${siteUrl}/docs`;
  const agentsUrl = `${siteUrl}/agents`;
  const swarmsUrl = `${siteUrl}/swarms`;
  const knowledgeUrl = `${siteUrl}/knowledge`;
  const biUrl = `${siteUrl}/bi`;
  const dataUrl = `${siteUrl}/data-sql`;

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Welcome to {siteName} — agents, swarms and BI over your own data</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Welcome to {siteName} 👋</Heading>

          <Text style={text}>Hi {recipient},</Text>

          <Text style={text}>
            Your account on <strong>{siteName}</strong> is ready — a unified{" "}
            <strong>agentic AI &amp; business intelligence</strong> platform. Build agents and
            multi-agent swarms, ground them in your own documents and databases, and put the answers
            on a dashboard. Everything runs on this instance, against your own model provider keys.
          </Text>

          <Heading as="h2" style={h2}>
            Where to start
          </Heading>

          <Section style={featureRow}>
            <Text style={featureTitle}>🤖 Agents</Text>
            <Text style={featureText}>
              Give an agent a prompt, tools, and a knowledge base, then talk to it. Guardrails, PII
              handling and per-user budgets apply from the first message.{" "}
              <Link href={agentsUrl} style={link}>
                Build an agent →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>🕸️ Swarms</Text>
            <Text style={featureText}>
              Compose multi-agent workflows on a visual canvas — routers, loops, approvals, sub-
              swarms and custom code. Deploy one behind an API key or a schedule when it is ready.{" "}
              <Link href={swarmsUrl} style={link}>
                Open the canvas →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>📚 Knowledge bases</Text>
            <Text style={featureText}>
              Upload documents or sync Google Drive, Notion, SharePoint and Dropbox, then retrieve
              them with hybrid search and citations.{" "}
              <Link href={knowledgeUrl} style={link}>
                Create a knowledge base →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>🗄️ Your data</Text>
            <Text style={featureText}>
              Connect a warehouse or upload a file, describe it once in the semantic layer, and ask
              questions in plain language.{" "}
              <Link href={dataUrl} style={link}>
                Connect data →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>📊 Dashboards</Text>
            <Text style={featureText}>
              Turn those answers into dashboards with alerts and scheduled reports — the same
              numbers your agents are reasoning over.{" "}
              <Link href={biUrl} style={link}>
                Open BI workspace →
              </Link>
            </Text>
          </Section>

          <Section style={ctaSection}>
            <Button style={button} href={dashboardUrl}>
              Go to your dashboard
            </Button>
          </Section>

          <Hr style={hr} />

          <Text style={footer}>
            New here? The{" "}
            <Link href={docsUrl} style={link}>
              documentation
            </Link>{" "}
            ships with this instance — start with Quickstart and Core concepts.
          </Text>
          <Text style={footer}>— The {siteName} team</Text>
        </Container>
      </Body>
    </Html>
  );
};

export default WelcomeEmail;

export const template = {
  component: WelcomeEmail,
  subject: "Welcome to AgentSwarms — your agentic AI & BI workspace is ready 🚀",
  displayName: "Welcome email",
  previewData: {
    siteName: "AgentSwarms",
    siteUrl: "http://localhost:8080",
    recipient: "Alex",
  },
};

// ============ Styles (white body — required) ============
const main = {
  backgroundColor: "#ffffff",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
};
const container = { padding: "24px 28px", maxWidth: "560px" };
const h1 = {
  fontSize: "24px",
  fontWeight: "bold" as const,
  color: "#0f172a",
  margin: "0 0 18px",
};
const h2 = {
  fontSize: "16px",
  fontWeight: "bold" as const,
  color: "#0f172a",
  margin: "28px 0 8px",
};
const text = {
  fontSize: "14px",
  color: "#334155",
  lineHeight: "1.6",
  margin: "0 0 14px",
};
const featureRow = { margin: "0 0 14px" };
const featureTitle = {
  fontSize: "14px",
  fontWeight: "bold" as const,
  color: "#0f172a",
  margin: "0 0 4px",
};
const featureText = {
  fontSize: "13px",
  color: "#475569",
  lineHeight: "1.55",
  margin: "0",
};
const link = { color: "#6366f1", textDecoration: "underline" };
const ctaSection = { textAlign: "center" as const, margin: "28px 0 8px" };
const button = {
  backgroundColor: "#6366f1",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "bold" as const,
  borderRadius: "8px",
  padding: "12px 22px",
  textDecoration: "none",
  display: "inline-block",
};
const hr = {
  borderColor: "#e2e8f0",
  margin: "28px 0 18px",
};
const footer = {
  fontSize: "12px",
  color: "#64748b",
  lineHeight: "1.5",
  margin: "0 0 8px",
};
