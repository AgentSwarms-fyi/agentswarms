import * as React from 'react'
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
} from '@react-email/components'

interface CertReadyEmailProps {
  siteName?: string
  siteUrl?: string
  recipient?: string
  passedTracks?: number
  agentCount?: number
}

export const CertReadyEmail = ({
  siteName = 'AgentSwarms',
  siteUrl = 'https://agentswarms.fyi',
  recipient = 'there',
  passedTracks = 4,
  agentCount = 3,
}: CertReadyEmailProps) => {
  const examUrl = `${siteUrl}/certification`
  const learnUrl = `${siteUrl}/learn`

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        You're ready for the {siteName} Agentic AI Practitioner exam — and it's free
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>You're ready for the certification 🏆</Heading>

          <Text style={text}>Hi {recipient},</Text>

          <Text style={text}>
            Nice work — you've passed{' '}
            <strong>{passedTracks}/6 curriculum tracks</strong> and shipped{' '}
            <strong>
              {agentCount} self-built agent{agentCount === 1 ? '' : 's'}
            </strong>
            . That puts you in the top tier of {siteName} learners and you're
            now eligible to sit the <strong>Agentic AI Practitioner</strong> exam.
          </Text>

          <Heading as="h2" style={h2}>
            What's the exam?
          </Heading>
          <Text style={text}>
            50 multiple-choice questions across LLM internals, agentic
            patterns, guardrails, memory, swarms, text-to-SQL, and Responsible
            AI — plus an AI-evaluated review of agents and swarms you've built
            yourself.
          </Text>

          <Section style={offerBox}>
            <Text style={offerHeadline}>It's free while we're in launch mode</Text>
            <Text style={offerSub}>
              Pass and you get:
            </Text>
            <Text style={bullet}>• A LinkedIn-pluggable badge</Text>
            <Text style={bullet}>• A downloadable PDF certificate</Text>
            <Text style={bullet}>
              • A public verification URL ({siteUrl.replace('https://', '')}/verify/…)
            </Text>
          </Section>

          <Section style={ctaSection}>
            <Button style={button} href={examUrl}>
              Start the exam →
            </Button>
          </Section>

          <Text style={text}>
            Not feeling 100% ready? No pressure — keep practicing in the{' '}
            <Link href={learnUrl} style={link}>
              Learn &amp; Certify
            </Link>{' '}
            hub. Your progress is saved and this invitation isn't going
            anywhere.
          </Text>

          <Hr style={hr} />

          <Text style={footer}>
            We only sent you this because you crossed the readiness bar — it
            won't go to anyone who hasn't earned it.
          </Text>
          <Text style={footer}>— The {siteName} team</Text>
        </Container>
      </Body>
    </Html>
  )
}

export default CertReadyEmail

export const template = {
  component: CertReadyEmail,
  subject: "You're ready for the AgentSwarms certification 🏆",
  displayName: 'Certification readiness nudge',
  previewData: {
    siteName: 'AgentSwarms',
    siteUrl: 'https://agentswarms.fyi',
    recipient: 'Alex',
    passedTracks: 5,
    agentCount: 4,
  },
}

// ============ Styles (white body — required) ============
const main = {
  backgroundColor: '#ffffff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
}
const container = { padding: '24px 28px', maxWidth: '560px' }
const h1 = {
  fontSize: '24px',
  fontWeight: 'bold' as const,
  color: '#0f172a',
  margin: '0 0 18px',
}
const h2 = {
  fontSize: '16px',
  fontWeight: 'bold' as const,
  color: '#0f172a',
  margin: '24px 0 8px',
}
const text = {
  fontSize: '14px',
  color: '#334155',
  lineHeight: '1.6',
  margin: '0 0 14px',
}
const offerBox = {
  backgroundColor: '#f5f3ff',
  border: '1px solid #ddd6fe',
  borderRadius: '10px',
  padding: '16px 18px',
  margin: '18px 0',
}
const offerHeadline = {
  fontSize: '15px',
  fontWeight: 'bold' as const,
  color: '#5b21b6',
  margin: '0 0 6px',
}
const offerSub = {
  fontSize: '13px',
  color: '#475569',
  margin: '0 0 6px',
}
const bullet = {
  fontSize: '13px',
  color: '#334155',
  margin: '2px 0',
  lineHeight: '1.5',
}
const link = { color: '#6366f1', textDecoration: 'underline' }
const ctaSection = { textAlign: 'center' as const, margin: '24px 0 18px' }
const button = {
  backgroundColor: '#6366f1',
  color: '#ffffff',
  fontSize: '14px',
  fontWeight: 'bold' as const,
  borderRadius: '8px',
  padding: '12px 22px',
  textDecoration: 'none',
  display: 'inline-block',
}
const hr = { borderColor: '#e2e8f0', margin: '24px 0 16px' }
const footer = {
  fontSize: '12px',
  color: '#64748b',
  lineHeight: '1.5',
  margin: '0 0 8px',
}
