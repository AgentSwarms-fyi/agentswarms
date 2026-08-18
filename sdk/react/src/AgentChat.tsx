// Drop-in chat component — the "batteries included" layer over useAgentChat.
//
// Styling is inline with CSS-variable overrides so it works with zero setup
// and no stylesheet import, yet every color/radius can be themed from the
// host app:
//
//   <AgentChat
//     baseUrl="https://agents.example.com"
//     embedKey="emk_..."
//     style={{ "--as-accent": "#7c3aed", height: 560 } as React.CSSProperties}
//   />
//
// Apps that want full control skip this component and build on useAgentChat.
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { useAgentChat, type UseAgentChatOptions } from "./useAgentChat";

export type AgentChatProps = UseAgentChatOptions & {
  /** Header title; defaults to "Chat". Pass null to hide the header. */
  title?: string | null;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
};

const vars: CSSProperties = {
  // Theme surface: override any of these from the host app.
  ["--as-bg" as string]: "#ffffff",
  ["--as-fg" as string]: "#111827",
  ["--as-muted" as string]: "#6b7280",
  ["--as-border" as string]: "#e5e7eb",
  ["--as-accent" as string]: "#2563eb",
  ["--as-accent-fg" as string]: "#ffffff",
  ["--as-bubble" as string]: "#f3f4f6",
  ["--as-radius" as string]: "12px",
};

export function AgentChat({
  title = "Chat",
  placeholder = "Ask anything…",
  className,
  style,
  ...chatOptions
}: AgentChatProps) {
  const chat = useAgentChat(chatOptions);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (chat.isStreaming) return;
    const text = draft;
    setDraft("");
    void chat.send(text);
  };

  return (
    <div
      className={className}
      style={{
        ...vars,
        display: "flex",
        flexDirection: "column",
        height: 480,
        background: "var(--as-bg)",
        color: "var(--as-fg)",
        border: "1px solid var(--as-border)",
        borderRadius: "var(--as-radius)",
        overflow: "hidden",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        ...style,
      }}
    >
      {title !== null && (
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--as-border)",
            fontWeight: 600,
          }}
        >
          {title}
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {chat.messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                maxWidth: "82%",
                padding: "8px 12px",
                borderRadius: "var(--as-radius)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                background: m.role === "user" ? "var(--as-accent)" : "var(--as-bubble)",
                color: m.role === "user" ? "var(--as-accent-fg)" : "var(--as-fg)",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {chat.isStreaming && chat.messages[chat.messages.length - 1]?.role !== "assistant" && (
          <div style={{ color: "var(--as-muted)", padding: "4px 2px" }}>…</div>
        )}
        {chat.citations.length > 0 && (
          <div style={{ marginTop: 4, fontSize: 12, color: "var(--as-muted)" }}>
            {chat.citations.length} source{chat.citations.length === 1 ? "" : "s"} cited
          </div>
        )}
        {chat.error && (
          <div style={{ marginTop: 4, fontSize: 12, color: "#dc2626" }}>{chat.error}</div>
        )}
      </div>

      <form
        onSubmit={submit}
        style={{
          display: "flex",
          gap: 8,
          padding: 10,
          borderTop: "1px solid var(--as-border)",
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          style={{
            flex: 1,
            padding: "8px 12px",
            border: "1px solid var(--as-border)",
            borderRadius: "var(--as-radius)",
            background: "var(--as-bg)",
            color: "var(--as-fg)",
            outline: "none",
            font: "inherit",
          }}
        />
        {chat.isStreaming ? (
          <button
            type="button"
            onClick={chat.stop}
            style={buttonStyle("var(--as-bubble)", "var(--as-fg)")}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!draft.trim()}
            style={buttonStyle("var(--as-accent)", "var(--as-accent-fg)")}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function buttonStyle(background: string, color: string): CSSProperties {
  return {
    padding: "8px 16px",
    border: "none",
    borderRadius: "var(--as-radius)",
    background,
    color,
    font: "inherit",
    fontWeight: 600,
    cursor: "pointer",
  };
}
