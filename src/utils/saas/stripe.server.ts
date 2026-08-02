// Stripe connector.
//
// Auth is a restricted API key. Stripe's list endpoints are uniform — same
// cursor scheme, same envelope — so one paging routine serves every object
// type and adding a stream is a table entry rather than code.

import { flattenRecord, isoifyTimestamps } from "./flatten";
import type { SaasConfig, SaasStream } from "./types";
import { connectorFetch } from "@/utils/http/connectorFetch.server";

const API = "https://api.stripe.com/v1";

/** Stripe's maximum. Fewer requests for the same data. */
const PAGE_SIZE = 100;

type StripeCfg = Extract<SaasConfig, { provider: "stripe" }>;

/**
 * The object types offered, and which of their fields are Unix timestamps.
 *
 * Timestamps are declared rather than detected. Guessing from the field name
 * would convert `trial_end` correctly and `quantity` disastrously, and
 * guessing from the value cannot distinguish a date from an amount in cents.
 */
const STREAMS: Record<string, { label: string; path: string; timestamps: readonly string[] }> = {
  charges: {
    label: "Charges",
    path: "charges",
    timestamps: ["created"],
  },
  customers: {
    label: "Customers",
    path: "customers",
    timestamps: ["created"],
  },
  invoices: {
    label: "Invoices",
    path: "invoices",
    timestamps: [
      "created",
      "due_date",
      "period_start",
      "period_end",
      "status_transitions_finalized_at",
      "status_transitions_paid_at",
    ],
  },
  subscriptions: {
    label: "Subscriptions",
    path: "subscriptions",
    timestamps: [
      "created",
      "start_date",
      "current_period_start",
      "current_period_end",
      "canceled_at",
      "ended_at",
      "trial_start",
      "trial_end",
    ],
  },
  payment_intents: {
    label: "Payment intents",
    path: "payment_intents",
    timestamps: ["created", "canceled_at"],
  },
  products: { label: "Products", path: "products", timestamps: ["created", "updated"] },
  prices: { label: "Prices", path: "prices", timestamps: ["created"] },
  refunds: { label: "Refunds", path: "refunds", timestamps: ["created"] },
  payouts: { label: "Payouts", path: "payouts", timestamps: ["created", "arrival_date"] },
  balance_transactions: {
    label: "Balance transactions",
    path: "balance_transactions",
    timestamps: ["created", "available_on"],
  },
};

type StripeList = {
  data?: Record<string, unknown>[];
  has_more?: boolean;
  error?: { message?: string; type?: string };
};

async function stripeFetch(cfg: StripeCfg, path: string, params: Record<string, string>) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await connectorFetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${cfg.api_key}`,
      // Pinning the version means Stripe changing its default cannot silently
      // change the shape of a synced dataset underneath an existing dashboard.
      "Stripe-Version": "2024-06-20",
    },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => ({}))) as StripeList;
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        "Stripe: that API key was rejected. Check it is the secret key, not the publishable one.",
      );
    }
    throw new Error(`Stripe: ${body.error?.message ?? `HTTP ${res.status}`}`);
  }
  return body;
}

export async function listStripeStreams(cfg: SaasConfig): Promise<SaasStream[]> {
  // One cheap call so bad credentials fail HERE, during setup, rather than at
  // the first sync. The stream list itself is static.
  await stripeFetch(cfg as StripeCfg, "customers", { limit: "1" });
  return Object.entries(STREAMS).map(([id, s]) => ({ id, label: s.label }));
}

/**
 * Page through one object type.
 *
 * Stripe cursors on the LAST OBJECT'S ID via `starting_after`, not on an
 * offset. That matters: an offset would skip or repeat rows as the underlying
 * list changes during a long sync, and a Stripe account is changing constantly.
 */
export async function* fetchStripeRows(
  cfg: SaasConfig,
  streamId: string,
): AsyncGenerator<Record<string, unknown>> {
  const stream = STREAMS[streamId];
  if (!stream) throw new Error(`Stripe: unknown object type "${streamId}"`);
  const c = cfg as StripeCfg;

  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripeFetch(c, stream.path, {
      limit: String(PAGE_SIZE),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const rows = page.data ?? [];
    if (rows.length === 0) return;

    for (const raw of rows) {
      yield isoifyTimestamps(flattenRecord(raw), stream.timestamps);
    }

    // `has_more` is authoritative; a full page is not. Trusting page size
    // instead would make one extra request on every exact multiple, and miss
    // the case where Stripe returns fewer than asked but has more to give.
    if (!page.has_more) return;
    const last = rows[rows.length - 1];
    const id = typeof last.id === "string" ? last.id : null;
    // Without an id there is no cursor, and looping again would refetch the
    // same page for ever.
    if (!id) return;
    startingAfter = id;
  }
}
