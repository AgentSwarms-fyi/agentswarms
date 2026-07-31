// Conversational Chat Swarm: run a saved swarm as a multi-turn conversation.
// The full transcript is persisted (swarm_chats) and replayed into the swarm's
// agent nodes each turn, and the swarm's flow-state variables are carried from
// one turn to the next so a chat swarm can accumulate structured state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Node, Edge } from "@xyflow/react";
import { runSwarm, type SwarmNodeData } from "@/lib/swarmRuntime";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { MarkdownMessage } from "@/components/playground/MarkdownMessage";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  MessagesSquare,
  Send,
  Plus,
  Square,
  Loader2,
  Bot,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";

type ChatMsg = { role: "user" | "assistant"; content: string; ts: number };
type ChatRow = { id: string; title: string; updated_at: string };

// Cap replayed history so very long conversations don't blow up token usage;
// carried flow-state preserves the important accumulated context beyond this.
const MAX_HISTORY_MESSAGES = 20;

function deriveTitle(msgs: ChatMsg[]): string {
  const first = msgs.find((m) => m.role === "user");
  if (!first) return "New chat";
  const t = first.content.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 48) + "…" : t || "New chat";
}

export function SwarmChatDialog({
  swarmId,
  swarmName,
  nodes,
  edges,
  open,
  onOpenChange,
}: {
  swarmId: string | null;
  swarmName: string;
  nodes: Node<SwarmNodeData>[];
  edges: Edge[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [carriedState, setCarriedState] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [runningNode, setRunningNode] = useState<string | null>(null);
  const [showState, setShowState] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Mirror of activeChatId updated synchronously so a fast second send can't
  // race a not-yet-committed insert and create a duplicate chat row.
  const chatIdRef = useRef<string | null>(null);

  const nodeLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, n.data?.label || n.data?.kind || n.id);
    return m;
  }, [nodes]);

  const hasAgent = useMemo(() => nodes.some((n) => n.data?.kind === "agent"), [nodes]);

  const loadChats = useCallback(async () => {
    if (!swarmId) return;
    const { data } = await supabase
      .from("swarm_chats")
      .select("id, title, updated_at")
      .eq("swarm_id", swarmId)
      .order("updated_at", { ascending: false });
    setChats((data ?? []) as ChatRow[]);
  }, [swarmId]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    chatIdRef.current = null;
    setActiveChatId(null);
    setMessages([]);
    setCarriedState({});
    setError(null);
    setLiveText("");
    setRunning(false);
  }, []);

  useEffect(() => {
    if (open && swarmId) {
      void loadChats();
      newChat();
    }
    if (!open) abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, swarmId]);

  // Keep the thread scrolled to the newest message / streaming tokens.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, liveText, running]);

  const selectChat = async (id: string) => {
    abortRef.current?.abort();
    const { data } = await supabase
      .from("swarm_chats")
      .select("messages, state")
      .eq("id", id)
      .maybeSingle();
    chatIdRef.current = id;
    setActiveChatId(id);
    setMessages(((data?.messages as ChatMsg[] | null) ?? []) as ChatMsg[]);
    setCarriedState(
      ((data?.state as Record<string, string> | null) ?? {}) as Record<string, string>,
    );
    setError(null);
    setLiveText("");
    setRunning(false);
  };

  const deleteChat = async (id: string) => {
    const { error: err } = await supabase.from("swarm_chats").delete().eq("id", id);
    if (err) return toast.error("Could not delete chat");
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (id === activeChatId) newChat();
  };

  const persist = useCallback(
    async (msgs: ChatMsg[], state: Record<string, string>): Promise<string | null> => {
      if (!user || !swarmId) return chatIdRef.current;
      const title = deriveTitle(msgs);
      const existing = chatIdRef.current;
      if (existing) {
        await supabase
          .from("swarm_chats")
          .update({ messages: msgs as never, state: state as never, title })
          .eq("id", existing);
        void loadChats();
        return existing;
      }
      const { data } = await supabase
        .from("swarm_chats")
        .insert({
          user_id: user.id,
          swarm_id: swarmId,
          messages: msgs as never,
          state: state as never,
          title,
        })
        .select("id")
        .single();
      const newId = data?.id ?? null;
      if (newId) {
        chatIdRef.current = newId; // set synchronously so the next send updates, not inserts
        setActiveChatId(newId);
      }
      void loadChats();
      return newId;
    },
    [user, swarmId, loadChats],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || running || !swarmId) return;

    const priorHistory = messages
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    const userMsg: ChatMsg = { role: "user", content: text, ts: Date.now() };
    const withUser = [...messages, userMsg];
    setMessages(withUser);
    setInput("");
    setRunning(true);
    setLiveText("");
    setError(null);
    setRunningNode(null);

    const controller = new AbortController();
    abortRef.current = controller;

    let tokenNode = "";
    let live = "";
    let finalOut = "";
    let finalSt: Record<string, string> = {};
    let failure: string | null = null;

    try {
      await runSwarm(nodes, edges, {
        initialInput: text,
        history: priorHistory,
        initialState: carriedState,
        signal: controller.signal,
        onEvent: (e) => {
          switch (e.type) {
            case "node_start":
              setRunningNode(e.nodeId);
              break;
            case "node_token":
              // Show the currently-streaming node's output; reset when a
              // different node takes over so the preview tracks the live node.
              if (e.nodeId !== tokenNode) {
                tokenNode = e.nodeId;
                live = "";
              }
              live += e.token;
              setLiveText(live);
              break;
            case "run_done":
              finalOut = e.finalOutput;
              finalSt = e.finalState ?? {};
              break;
            case "run_error":
              failure = e.error;
              break;
            default:
              break;
          }
        },
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    setRunning(false);
    setRunningNode(null);
    setLiveText("");
    abortRef.current = null;

    if (failure) {
      setError(failure);
      await persist(withUser, carriedState); // keep the user's turn for retry
      return;
    }

    const assistantMsg: ChatMsg = {
      role: "assistant",
      content: finalOut || "_(no output)_",
      ts: Date.now(),
    };
    const committed = [...withUser, assistantMsg];
    setMessages(committed);

    // Carry user-defined flow-state forward: drop the turn's input and the
    // per-node auto outputs (out_<id>), keep named variables.
    const carry: Record<string, string> = {};
    for (const [k, v] of Object.entries(finalSt)) {
      if (k === "input" || k.startsWith("out_")) continue;
      carry[k] = v;
    }
    setCarriedState(carry);
    await persist(committed, carry);
  };

  const stateEntries = Object.entries(carriedState);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl p-0 gap-0 overflow-hidden h-[82vh] flex flex-col">
        <DialogHeader className="px-4 py-3 border-b border-border/60 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <MessagesSquare className="h-4 w-4 text-primary" /> Chat with “{swarmName}”
          </DialogTitle>
          <DialogDescription className="text-xs">
            Multi-turn conversation. The swarm remembers the exchange and carries its variables
            between turns.
          </DialogDescription>
        </DialogHeader>

        {!swarmId ? (
          <div className="p-4">
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Save this swarm first, then reopen Chat.
            </div>
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            {/* Chat list */}
            <div className="w-52 shrink-0 border-r border-border/60 flex flex-col bg-muted/20">
              <div className="p-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full h-8 text-xs"
                  onClick={newChat}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" /> New chat
                </Button>
              </div>
              <ScrollArea className="flex-1">
                <div className="px-2 pb-2 space-y-1">
                  {chats.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground px-1 py-2">
                      No conversations yet.
                    </p>
                  ) : (
                    chats.map((c) => (
                      <div
                        key={c.id}
                        className={`group flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer text-xs ${
                          c.id === activeChatId ? "bg-primary/15 text-foreground" : "hover:bg-muted"
                        }`}
                        onClick={() => selectChat(c.id)}
                      >
                        <span className="truncate flex-1">{c.title}</span>
                        <button
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void deleteChat(c.id);
                          }}
                          title="Delete chat"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </div>

            {/* Thread */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {messages.length === 0 && !running && (
                  <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-2">
                    <Bot className="h-8 w-8 opacity-40" />
                    <p className="text-sm">Start the conversation below.</p>
                    {!hasAgent && (
                      <p className="text-[11px] flex items-center gap-1 text-amber-500">
                        <AlertTriangle className="h-3 w-3" /> This swarm has no Agent node — replies
                        may be empty.
                      </p>
                    )}
                  </div>
                )}

                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2 text-sm whitespace-pre-wrap">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex justify-start">
                      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-1 text-sm">
                        <MarkdownMessage content={m.content} />
                      </div>
                    </div>
                  ),
                )}

                {running && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm">
                      {liveText ? (
                        <span className="whitespace-pre-wrap">{liveText}</span>
                      ) : (
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {runningNode
                            ? `Running ${nodeLabel.get(runningNode) ?? "node"}…`
                            : "Thinking…"}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <span className="font-medium">Run failed:</span> {error}
                    </div>
                  </div>
                )}
              </div>

              {/* Flow state */}
              {stateEntries.length > 0 && (
                <div className="border-t border-border/60 px-4 py-1.5 shrink-0">
                  <button
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => setShowState((s) => !s)}
                  >
                    {showState ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    Flow state · {stateEntries.length} variable
                    {stateEntries.length === 1 ? "" : "s"}
                  </button>
                  {showState && (
                    <div className="mt-1.5 max-h-32 overflow-y-auto space-y-1 pb-1">
                      {stateEntries.map(([k, v]) => (
                        <div key={k} className="text-[11px] font-mono flex gap-2">
                          <span className="text-primary shrink-0">{k}</span>
                          <span className="text-muted-foreground truncate">{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Composer */}
              <div className="border-t border-border/60 p-3 shrink-0">
                <div className="flex items-end gap-2">
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder="Message the swarm…  (Enter to send, Shift+Enter for newline)"
                    className="min-h-[42px] max-h-40 resize-none text-sm"
                    disabled={running}
                  />
                  {running ? (
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-[42px] w-[42px] shrink-0"
                      onClick={() => abortRef.current?.abort()}
                      title="Stop"
                    >
                      <Square className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      className="h-[42px] w-[42px] shrink-0"
                      onClick={() => void send()}
                      disabled={!input.trim()}
                      title="Send"
                    >
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
