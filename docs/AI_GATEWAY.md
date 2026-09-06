# AI gateway

An OpenAI-compatible endpoint in front of your agents and connected models.
Point any OpenAI SDK, IDE plugin, evaluation harness or other agent at
`https://<your host>/api/v1` with a **gateway key**, and it talks to a saved
agent, with its prompt, tools, knowledge and guardrails, or to a connected
model directly. Every call runs as the key's owner, under that owner's IAM
model rules, budgets, traces and audit trail. Nothing new to govern, one new
door to reach it through.

The same key, with the `metrics` scope, reaches the **semantic layer**:
`GET /api/v1/metrics` lists the governed models the owner may read and
`POST /api/v1/metrics/query` runs a metric query, so a spreadsheet, a
notebook or another application gets the numbers the dashboards and the
agents get, from the same definitions. See [The semantic layer](#the-semantic-layer).

This is the inbound half of the gateway. The outbound half, routing the
platform's own model traffic through LiteLLM, Portkey or Helicone, is the
existing setting on the same tab (Integrations → LLM Gateway) and is
unchanged.

## Keys

Mint a key under **Integrations → LLM Gateway → API access**. A key is
minted by one user and reaches only what that user could reach by hand:

| Setting             | What it does                                                                                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scopes**          | `agents` lets the key call your saved agents (`model: "agent:<name or id>"`); `models` lets it call a connected model directly (`model: "<provider>/<model>"`); `metrics` lets it read the semantic layer (`/metrics`, `/metrics/query`). |
| **Agents**          | With the `agents` scope, an optional allow-list; none ticked means every agent you own.                                                                                                                                                   |
| **Model patterns**  | With the `models` scope, `provider/model` patterns the key may call (`openrouter/*`, `anthropic/claude-*`); empty means anything your IAM model rules allow.                                                                              |
| **Semantic models** | With the `metrics` scope, an optional allow-list of semantic models the key may query; none ticked means every model you own or are granted. Naming a model never grants access you lack.                                                 |
| **Fallback chain**  | Ordered `provider/model` entries tried when the requested model fails with a provider error, before the instance-wide chain.                                                                                                              |
| **Calls a minute**  | A per-key rate limit; blank uses the instance default.                                                                                                                                                                                    |
| **Monthly budget**  | A ceiling in USD on what this key may spend; the spend is attributed to the key on every trace.                                                                                                                                           |
| **Expires**         | Optional; an expired key answers 401 the moment it lapses.                                                                                                                                                                                |

The plaintext key (`gw_…`) is shown once. The row holds a SHA-256 hash and
the first characters, enough to tell keys apart. Revoking is immediate and
permanent; mint a new key to restore access. Creating, editing and revoking
a key are audited by trigger under `gateway_key`.

## Calling it

Base URL: `https://<your host>/api/v1`. Two endpoints:

- `GET /models` lists what the key may name: one row per agent as
  `agent:<id>`, with the name alias and the model behind it under
  `agentswarms`; a `models` key sees its allow-list patterns as hints.
- `POST /chat/completions` runs one turn. `stream: true` answers as
  server-sent events in the `chat.completion.chunk` shape; otherwise one
  `chat.completion` object.

```bash
curl https://<your host>/api/v1/chat/completions \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "agent:Support triage", "stream": true,
       "messages": [{"role": "user", "content": "A customer reports a failed payment"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="https://<your host>/api/v1", api_key="gw_...")
reply = client.chat.completions.create(
    model="openrouter/openai/gpt-4o-mini",
    messages=[{"role": "system", "content": "Answer in one line."},
              {"role": "user", "content": "What is a lakehouse?"}],
)
print(reply.choices[0].message.content)
```

What the endpoint takes from the request: `model`, `messages` (`system` and
`developer` messages become the instruction; `tool` messages are dropped,
because an agent runs its own tools), `stream`, `temperature`,
`max_tokens` / `max_completion_tokens`, and `stream_options.include_usage`.
Image parts in a message are not passed to the model. `tools` and
`functions` from the client are ignored: an agent's tools are the ones its
owner configured, and a bare model has none.

What comes back, beyond the OpenAI fields: an `agentswarms` object on the
completion (or on the final streamed chunk) with the `trace_id`, the
`fallback_from` model if one was used, the citations and tool calls the
turn produced, and any guardrail note; and headers `X-Trace-Id`,
`X-Gateway-Model` (the model that actually answered) and
`X-Gateway-Fallback: true` when it was not the one requested. Usage arrives
in `usage` on non-streamed replies and, when `include_usage` is set, on the
final chunk.

An agent called through the gateway keeps no memory between calls: the
caller holds the conversation and replays it, the way the OpenAI API works,
and a key is not a person.

## The semantic layer

A key with the `metrics` scope answers governed questions without an agent
in between. Two endpoints under the same base URL:

- `GET /metrics` lists the semantic models the key may query, described for
  a client: names, labels and descriptions, each metric's aggregation and
  format, each dimension's type, synonyms and sampled values, the declared
  parameters (and which are required), the hierarchies, and the grains and
  period comparisons a time dimension accepts. Never the SQL behind them.
  A shared model with a restricted grant is listed with its `access_note`
  and without the masked fields.
- `POST /metrics/query` runs one query in the same structured shape the
  runner and the `metric_query` agent tool use.

```bash
curl https://<your host>/api/v1/metrics -H "Authorization: Bearer gw_..."

curl https://<your host>/api/v1/metrics/query \
  -H "Authorization: Bearer gw_..." \
  -H "Content-Type: application/json" \
  -d '{"model": "revenue", "metrics": ["net_revenue", "orders"],
       "dimensions": ["region", "order_date"], "grains": {"order_date": "month"},
       "filters": [{"field": "order_date", "op": "last_n_days", "value": 180}],
       "order_by": [{"field": "order_date", "dir": "desc"}], "limit": 500}'
```

```python
import requests
r = requests.post("https://<your host>/api/v1/metrics/query",
    headers={"Authorization": "Bearer gw_..."},
    json={"model": "revenue", "metrics": ["net_revenue"],
          "dimensions": ["order_date"], "grains": {"order_date": "month"},
          "compare": "yoy"})
for row in r.json()["rows"]:
    print(row)
```

The body takes `model` (a name or id from `GET /metrics`), `metrics`,
`dimensions`, `filters` (`field`, `op`, `value`; the ops are the comparison
ops `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not_in`, `contains` and the
relative-date windows such as `last_n_days`, `this_month`, `ytd`), `grains`
(dimension to `day`, `week`, `month`, `quarter`, `year` or a fiscal grain),
`order_by`, `limit`, `compare` (`prior_period`, `mom`, `yoy`) and `params`
for the model's declared parameters. A request that fails validation
answers 400 naming the field; one the compiler refuses - an unknown metric,
a grain on a non-time dimension, a missing parameter - answers 400 in the
compiler's words.

The answer is `{ "object": "metrics.result", "model", "columns", "rows",
"row_count", "truncated", "sql" }`, with `access_note` when the owner sees
a restricted share, `rollup` when a declared pre-aggregate answered, and
`resolution_notes` when a synonym was resolved. `rows` holds at most the
request's `limit`, the instance cap (`AI_GATEWAY_METRICS_MAX_ROWS`, 10,000
by default) or the semantic layer's own ceiling of 10,000 rows, whichever is
smallest; `truncated` says whether more matched (at the ceiling, that the
ceiling was reached). The `X-Semantic-Model` header names the model that
answered.

Governance is the semantic layer's own, unchanged: the query runs as the
key's owner through the same chokepoint as a dashboard tile or an agent's
`metric_query` call - the owner's models plus the ones IAM shares with them,
a grantee's row filters and field masks rewritten into the query, the data
read and billed as the model owner - and audits `metric.query` with
`via: gateway`, the key, the compiled SQL and a digest of the result. The
key's allow-list narrows that access and never widens it. Rate limits and
expiry apply as to any other call; a metrics query makes no model call, so
budgets are not touched.

## Fallback

When the requested model fails with a provider error, the gateway tries the
next entry of the key's chain, then the instance-wide chain
(`AI_GATEWAY_FALLBACK_MODELS`, or Admin → Developer runtime), each once, and
answers with the first that works. For an agent, only the model changes;
the prompt, tools and knowledge stay the agent's.

Retryable means the provider was the problem: throttling (429), exhausted
credits (402), timeouts and 5xx. A caller's own mistake is never retried,
and neither is a policy refusal of the model the caller asked for: a
request your IAM rules forbid answers 403 `model_not_allowed`. A forbidden
model that only appears in a fallback chain is skipped. A fallback happens
only before any token has reached the caller; once a stream has started,
its model answers it. Every switch is audited as `gateway.fallback` with
the models, the status and the reason.

## Governance

- **Identity.** The turn runs on the chat route's internal channel as the
  key's owner. Data tools read what the owner may read, and no more.
- **Model rules.** IAM allow-lists apply to the model that answers, whether
  requested or fallen back to.
- **Budgets.** The owner's personal and group budgets apply, and the key's
  own monthly ceiling on top; every trace made through the key carries
  `cost_scope_type = gateway_key`, so the ceiling is measured, not
  estimated. Over budget answers 429 `insufficient_quota`.
- **Rate limits.** Per key, per minute, across every replica.
- **Audit.** `gateway.chat` for every completed turn (target, model,
  fallback, tokens, trace id), `gateway.fallback` for every switch,
  `gateway.access.denied` for a revoked, expired, out-of-scope or throttled
  key with the caller's address, and the table's own trigger for key
  changes. Agent turns also audit `agent.chat`, as in the app. A metric
  query audits `metric.query` with `via: gateway`, the key, the compiled
  SQL and a digest of the result, exactly as the agent tool does.
- **Traces.** Each turn is an execution trace under the owner, with the
  agent's name, so Observability shows gateway traffic beside everything
  else.

Errors use the OpenAI shape, `{ "error": { "message", "type", "code" } }`:
`invalid_api_key` (401), `insufficient_scope` and `model_not_allowed` (403),
`model_not_found` (404), `rate_limit_exceeded` and `insufficient_quota`
(429), `invalid_request_error` (400), `upstream_error` (502).

## Limits

| Setting                         | Default | Where                                                                                                |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `AI_GATEWAY_RATE_LIMIT_PER_MIN` | 60      | Calls a minute one key may make unless it sets its own; Admin → Developer runtime.                   |
| `AI_GATEWAY_FALLBACK_MODELS`    | none    | Comma-separated `provider/model` entries every call may fall back to, after the key's chain.         |
| `AI_GATEWAY_METRICS_MAX_ROWS`   | 10,000  | Rows one metrics query may return; a smaller `limit` in the request wins. Admin → Developer runtime. |
| Fallback entries per key        | 10      | Entries that do not parse as `provider/model` are dropped when saved, and said so.                   |

## How this compares

LiteLLM and Portkey are gateways in front of model providers: keys, routing,
fallbacks, spend, all for raw models. This endpoint is a gateway in front of
your **agents** as well as your models, and it inherits the platform's
governance instead of carrying its own copy: the same IAM rules, budgets,
guardrails, traces and audit that apply in the app apply here. If you
already run one of those gateways, keep it as the outbound route and put
this endpoint in front of the agents.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 401 `invalid_api_key`                     | Missing, malformed, revoked or expired key. Mint a new one under Integrations → LLM Gateway.                                                                       |
| 404 `model_not_found`                     | `model` is neither `agent:<name or id>` nor `<provider>/<model>`, the agent is inactive, or two agents share the name — use `agent:<id>`.                          |
| 403 `insufficient_scope`                  | The key lacks the scope, or the agent is not on its allow-list.                                                                                                    |
| 403 `model_not_allowed`                   | Your IAM model rules forbid the model, or the key's model patterns do.                                                                                             |
| 429 `insufficient_quota`                  | The owner's or the key's monthly budget is spent.                                                                                                                  |
| The reply came from a different model     | A fallback fired; `X-Gateway-Model` names it and the audit log has `gateway.fallback` with the reason.                                                             |
| 502 `upstream_error` after several models | Every candidate failed; `gateway.chat` in the audit log lists the models tried.                                                                                    |
| 404 `model_not_found` on `/metrics/query` | The name is not among `GET /metrics`: not a model the owner owns or is granted. A model the key's allow-list excludes answers 403 `model_not_allowed`.             |
| 400 on `/metrics/query` names a field     | The request or the compiler refused it: an unknown metric or dimension, a grain on a non-time dimension, a missing parameter. `GET /metrics` shows the vocabulary. |
