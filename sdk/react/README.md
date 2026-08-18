# @agentswarms/react

React SDK for [AgentSwarms](../../README.md) embeds. It talks to the **same public embed API the iframes use** — so every control you set in the Web Embedding workspace (key enable/disable, expiry, domain allow-list, monthly budget cap, model governance, guardrails, rate limits) applies identically. Nothing in this package can widen access; the embed key is public by construction, like a maps/site key.

Use it instead of (or alongside) an iframe when you want:

- **Your own UI** — render messages with your components, your markdown pipeline, your theme.
- **Programmatic control** — send messages from anywhere in your app, prefill context, intercept every stream event, wire citations and Visual-BI widgets into your own surfaces.
- **No iframe constraints** — no fixed height, no cross-document messaging, participates in your layout/router/state like any other component.

## Install

Until the package is published to npm, install straight from the repo folder:

```bash
npm install ./sdk/react
```

(or in a monorepo: `"@agentswarms/react": "file:../agentswarms/sdk/react"`).

Then create an embed key at **`/embeds`** in your AgentSwarms instance. Add the domain of the app that will use the SDK to the key's **allowed domains** — the server checks the browser `Origin` on every request.

## Drop-in component

```tsx
import { AgentChat } from "@agentswarms/react";

export function SupportWidget() {
  return (
    <AgentChat
      baseUrl="https://agents.your-domain.com"
      embedKey="emk_..."
      title="Support"
      style={{ "--as-accent": "#7c3aed", height: 560 } as React.CSSProperties}
    />
  );
}
```

Themeable via CSS variables: `--as-bg`, `--as-fg`, `--as-muted`, `--as-border`, `--as-accent`, `--as-accent-fg`, `--as-bubble`, `--as-radius`.

## Headless chat hook

```tsx
import { useAgentChat } from "@agentswarms/react";

function MyChat() {
  const { messages, send, stop, isStreaming, citations, widget, error } = useAgentChat({
    baseUrl: "https://agents.your-domain.com",
    embedKey: "emk_...",
    // nodeId: "…",             // swarm embeds: address one node
    // initialMessages: [...],  // seed a welcome message
    // onEvent: (e) => {},      // raw typed stream events
  });

  // render messages however you like; call send("…") from anywhere
}
```

- `messages` updates live as the answer streams (last assistant message grows in place).
- `citations` fills when the agent used its knowledge base; `widget` fills when Visual BI produced a chart spec.
- Guardrail/budget refusals arrive as a normal assistant message (by design — same as the iframe). `error` is only for hard failures: bad/disabled key, expired, origin not allowed, rate limited, network.

## Headless analyst hook

```tsx
import { useAgentAnalyst } from "@agentswarms/react";

const { turns, activeTurn, ask, isRunning, error } = useAgentAnalyst({
  baseUrl: "https://agents.your-domain.com",
  embedKey: "emk_...", // key created for an AI Analyst resource
});
```

The analyst streams whole-turn snapshots: `activeTurn` is the in-flight turn (approach and steps filling in live — render it for progress), and each finished turn is appended to `turns`. Follow-up questions automatically carry the prior turns for context.

## Protocol layer (framework-free)

`createSseParser`, `mapChatFrame`, `mapAnalystFrame` are exported for non-React consumers (Vue, Svelte, vanilla). They implement the exact SSE wire protocol of `/api/embed/chat` and `/api/embed/analyst` and are unit-tested in the main repo (`tests/sdk-protocol.test.ts`).

## Security model

All enforcement is server-side; the SDK is a renderer:

| Control                              | Where it's enforced                                |
| ------------------------------------ | -------------------------------------------------- |
| Key validity, enable/disable, expiry | server, per request                                |
| Domain allow-list                    | server, against the browser `Origin` header        |
| Monthly budget cap                   | server; over-budget answers become a polite notice |
| Model governance / IAM, guardrails   | server, same path as the iframe                    |
| Rate limiting                        | server, per key + IP                               |

Disabling a key in `/embeds` cuts off SDK consumers exactly as instantly as it cuts off iframes.
