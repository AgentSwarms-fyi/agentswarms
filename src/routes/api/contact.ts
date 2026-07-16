// Public contact endpoint — no auth required (visitors aren't logged in).
//
// Flow:
//   1. Validate input with Zod (length + format).
//   2. Lightweight in-memory rate limit by IP (best-effort; resets on cold start).
//   3. Insert into public.contact_messages via service role.
//   4. Enqueue two emails through pgmq (auth queue is not used here):
//        a. Admin notification → CONTACT_ADMIN_EMAIL (kept secret)
//        b. Confirmation back to the visitor
//      The shared process-email-queue cron drains both within seconds.
//
// We never expose CONTACT_ADMIN_EMAIL to the client.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { render } from '@react-email/components'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import * as React from 'react'
import { TEMPLATES } from '@/lib/email-templates/registry'

type AnySupabase = SupabaseClient<any, any, any, any, any>

const SENDER_DOMAIN = 'notify.agentswarms.fyi'
const FROM_DOMAIN = 'agentswarms.fyi'
const FROM_NAME = 'AgentSwarms'
const FROM_LOCAL = 'noreply'

const ContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  subject: z.string().trim().max(200).optional().or(z.literal('')),
  message: z.string().trim().min(10).max(5000),
  // honeypot: bots fill it in, humans don't see it
  website: z.string().max(0).optional().or(z.literal('')),
  sourcePage: z.string().trim().max(500).optional().or(z.literal('')),
})

// Simple in-memory rate limiter. Cloudflare Workers may recycle the
// instance, so this is best-effort, not a hard guarantee.
const rateBucket = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 5

function rateLimitOk(ip: string): boolean {
  const now = Date.now()
  const cur = rateBucket.get(ip)
  if (!cur || cur.resetAt < now) {
    rateBucket.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  if (cur.count >= RATE_LIMIT_MAX) return false
  cur.count++
  return true
}

function newMessageId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function enqueueEmail(args: {
  supabase: AnySupabase
  queue: 'transactional_emails'
  templateName: string
  recipient: string
  templateData: Record<string, unknown>
  label: string
  idempotencyKey: string
}) {
  const entry = TEMPLATES[args.templateName]
  if (!entry) throw new Error(`Unknown template: ${args.templateName}`)

  const element = React.createElement(entry.component, args.templateData)
  const html = await render(element)
  const text = await render(element, { plainText: true })
  const subject =
    typeof entry.subject === 'function'
      ? entry.subject(args.templateData)
      : entry.subject

  const messageId = newMessageId()
  const payload = {
    message_id: messageId,
    to: args.recipient,
    from: { name: FROM_NAME, local: FROM_LOCAL, domain: FROM_DOMAIN },
    sender_domain: SENDER_DOMAIN,
    subject,
    html,
    text,
    purpose: 'transactional',
    label: args.label,
    idempotency_key: args.idempotencyKey,
    queued_at: new Date().toISOString(),
  }

  // Mark as pending in the send log so the dashboard reflects it immediately.
  await args.supabase.from('email_send_log').insert({
    message_id: messageId,
    template_name: args.label,
    recipient_email: args.recipient,
    status: 'pending',
  })

  const { error } = await args.supabase.rpc('enqueue_email', {
    queue_name: args.queue,
    payload,
  })
  if (error) throw error
}

export const Route = createFileRoute('/api/contact')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
        const adminEmail = process.env.CONTACT_ADMIN_EMAIL

        if (!supabaseUrl || !supabaseServiceKey || !adminEmail) {
          console.error('Contact form is not configured')
          return Response.json(
            { error: 'Contact form is not configured.' },
            { status: 500 },
          )
        }

        const ip =
          request.headers.get('cf-connecting-ip') ??
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          'unknown'

        if (!rateLimitOk(ip)) {
          return Response.json(
            { error: 'Too many requests. Please try again in a minute.' },
            { status: 429 },
          )
        }

        let raw: unknown
        try {
          raw = await request.json()
        } catch {
          return Response.json({ error: 'Invalid JSON.' }, { status: 400 })
        }

        const parsed = ContactSchema.safeParse(raw)
        if (!parsed.success) {
          return Response.json(
            {
              error: 'Please check your inputs and try again.',
              details: parsed.error.flatten(),
            },
            { status: 400 },
          )
        }

        const { name, email, subject, message, website, sourcePage } =
          parsed.data

        // Honeypot triggered — pretend success so bots don't probe.
        if (website && website.length > 0) {
          return Response.json({ success: true })
        }

        const supabase: AnySupabase = createClient(
          supabaseUrl,
          supabaseServiceKey,
        )

        const userAgent = request.headers.get('user-agent') ?? null

        const { data: inserted, error: insertError } = await supabase
          .from('contact_messages')
          .insert({
            name,
            email,
            subject: subject || null,
            message,
            source_page: sourcePage || null,
            user_agent: userAgent,
          })
          .select('id, created_at')
          .single()

        if (insertError || !inserted) {
          console.error('contact_messages insert failed', insertError)
          return Response.json(
            { error: 'Could not save your message. Please try again.' },
            { status: 500 },
          )
        }

        const submittedAt = new Date(inserted.created_at).toUTCString()

        // Fire both emails in parallel; don't fail the whole request if one
        // enqueue fails — the message is already persisted.
        const results = await Promise.allSettled([
          enqueueEmail({
            supabase,
            queue: 'transactional_emails',
            templateName: 'contact-admin-notification',
            recipient: adminEmail,
            templateData: {
              name,
              email,
              subject: subject || '(no subject)',
              message,
              sourcePage: sourcePage || '(unknown)',
              submittedAt,
            },
            label: 'contact-admin-notification',
            idempotencyKey: `contact-admin-${inserted.id}`,
          }),
          enqueueEmail({
            supabase,
            queue: 'transactional_emails',
            templateName: 'contact-confirmation',
            recipient: email,
            templateData: { name, message },
            label: 'contact-confirmation',
            idempotencyKey: `contact-confirm-${inserted.id}`,
          }),
        ])

        for (const r of results) {
          if (r.status === 'rejected') {
            console.error('Contact email enqueue failed', r.reason)
          }
        }

        return Response.json({ success: true })
      },
    },
  },
})
