import * as React from 'react'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text,
} from '@react-email/components'
import type { TemplateEntry } from './registry'

interface BudgetAlertEmailProps {
  siteName?: string
  siteUrl?: string
  recipient?: string
  monthlyCapUsd?: number
  spentUsd?: number
  percentUsed?: number
  /** 'threshold' for warning at 50/75/90%, 'exceeded' once cap is hit */
  kind?: 'threshold' | 'exceeded'
}

const fmt = (n: number) =>
  `$${(Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2)}`

export const BudgetAlertEmail = ({
  siteName = 'AgentSwarms',
  siteUrl = 'https://agentswarms.fyi',
  recipient = 'there',
  monthlyCapUsd = 5,
  spentUsd = 0,
  percentUsed = 0,
  kind = 'threshold',
}: BudgetAlertEmailProps) => {
  const budgetsUrl = `${siteUrl}/budgets`
  const isExceeded = kind === 'exceeded'
  const headline = isExceeded
    ? `You've reached your monthly AI spend cap`
    : `You've used ${Math.round(percentUsed)}% of your monthly AI budget`

  return (
    <Html lang="en" dir="ltr">
      <Head />
      <Preview>
        {isExceeded
          ? `Monthly cap of ${fmt(monthlyCapUsd)} reached on ${siteName}`
          : `${Math.round(percentUsed)}% of ${fmt(monthlyCapUsd)} used on ${siteName}`}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={h1}>{headline}</Heading>

          <Text style={text}>Hi {recipient},</Text>

          <Text style={text}>
            {isExceeded ? (
              <>
                Your {siteName} AI spend for this month has reached your hard
                cap of <strong>{fmt(monthlyCapUsd)}</strong>. You've used{' '}
                <strong>{fmt(spentUsd)}</strong> so far. Agents may stop
                accepting new runs until you raise the cap or the next billing
                month begins.
              </>
            ) : (
              <>
                Heads up — you've spent <strong>{fmt(spentUsd)}</strong> of
                your <strong>{fmt(monthlyCapUsd)}</strong> monthly AI budget on{' '}
                {siteName} ({Math.round(percentUsed)}%).
              </>
            )}
          </Text>

          <Section style={box}>
            <Text style={boxLine}>Month-to-date spend: <strong>{fmt(spentUsd)}</strong></Text>
            <Text style={boxLine}>Monthly cap: <strong>{fmt(monthlyCapUsd)}</strong></Text>
            <Text style={boxLine}>Used: <strong>{Math.round(percentUsed)}%</strong></Text>
          </Section>

          <Section style={ctaSection}>
            <Button style={button} href={budgetsUrl}>
              Review &amp; adjust your budget →
            </Button>
          </Section>

          <Text style={text}>
            You can raise the cap, change alert thresholds, or set per-agent
            daily limits from the Budgets &amp; Guardrails page.
          </Text>

          <Hr style={hr} />

          <Text style={footer}>
            You're getting this because spend alerts are enabled on your
            account. Turn them off any time in {siteName} → Budgets.
          </Text>
          <Text style={footer}>— The {siteName} team</Text>
        </Container>
      </Body>
    </Html>
  )
}

export default BudgetAlertEmail

export const template = {
  component: BudgetAlertEmail,
  subject: (data: Record<string, any>) =>
    data?.kind === 'exceeded'
      ? `You've reached your monthly AgentSwarms AI spend cap`
      : `You've used ${Math.round(data?.percentUsed ?? 0)}% of your AgentSwarms AI budget`,
  displayName: 'Budget alert',
  previewData: {
    siteName: 'AgentSwarms',
    siteUrl: 'https://agentswarms.fyi',
    recipient: 'Alex',
    monthlyCapUsd: 5,
    spentUsd: 4.75,
    percentUsed: 95,
    kind: 'threshold' as const,
  },
} satisfies TemplateEntry

// ============ Styles (white body — required) ============
const main = {
  backgroundColor: '#ffffff',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
}
const container = { padding: '24px 28px', maxWidth: '560px' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 18px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 14px' }
const box = {
  backgroundColor: '#fef3c7',
  border: '1px solid #fcd34d',
  borderRadius: '10px',
  padding: '14px 18px',
  margin: '18px 0',
}
const boxLine = { fontSize: '13px', color: '#92400e', margin: '4px 0' }
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
const footer = { fontSize: '12px', color: '#64748b', lineHeight: '1.5', margin: '0 0 8px' }
