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
  siteUrl = "https://agentswarms.fyi",
  recipient = "there",
}: WelcomeEmailProps) => {
  const dashboardUrl = `${siteUrl}/dashboard`;
  // The in-app documentation, NOT `${siteUrl}/learn`. /learn is a page on the
  // hosted project site; on a self-hosted instance siteUrl is that operator's
  // own domain, so the welcome email — the first thing a new user receives —
  // linked them to a 404 on their own deployment. /docs ships with the app and
  // is correct on every instance.
  const learnUrl = `${siteUrl}/docs`;
  const playgroundUrl = `${siteUrl}/playground`;
  const swarmsUrl = `${siteUrl}/swarms`;

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>Welcome to {siteName} — your hands-on lab for Agentic AI</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>Welcome to {siteName} 👋</Heading>

          <Text style={text}>Hi {recipient},</Text>

          <Text style={text}>
            Thanks for joining <strong>{siteName}</strong> — a hands-on playground for learning{" "}
            <em>Agentic AI</em>. Whether you're new to LLM agents or deep into multi-agent
            orchestration, you've got a full lab to experiment in.
          </Text>

          <Heading as="h2" style={h2}>
            Here's what you can do
          </Heading>

          <Section style={featureRow}>
            <Text style={featureTitle}>🎓 Learn the fundamentals</Text>
            <Text style={featureText}>
              Core concepts, a guided quickstart, and reference for every module — agents, swarms,
              retrieval, guardrails and budgets.{" "}
              <Link href={learnUrl} style={link}>
                Open the documentation →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>🤖 Build & test agents</Text>
            <Text style={featureText}>
              Spin up agents with custom prompts, tools, knowledge bases, and run them live in the
              playground.{" "}
              <Link href={playgroundUrl} style={link}>
                Try the playground →
              </Link>
            </Text>
          </Section>

          <Section style={featureRow}>
            <Text style={featureTitle}>🕸️ Design swarms</Text>
            <Text style={featureText}>
              Compose multi-agent workflows on a visual canvas — routers, loops, tool nodes,
              approvals, and more.{" "}
              <Link href={swarmsUrl} style={link}>
                Open the Swarm canvas →
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
            Wishing you happy learning and lots of fun experimenting! If you ever get stuck, just
            reply to this email — we read every message.
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
  subject: "Welcome to AgentSwarms — let's build some agents 🚀",
  displayName: "Welcome email",
  previewData: {
    siteName: "AgentSwarms",
    siteUrl: "https://agentswarms.fyi",
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
