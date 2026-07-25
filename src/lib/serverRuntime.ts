// Client for the server-side notebook runtime — the ONLY runtime. Starts a
// session via /api/notebook/runtime, polls until the kernel is ready, then
// connects to the gateway over a websocket and executes cells on a real
// container kernel (full CPython, pip install, the actual frameworks).
//
// There is deliberately no in-browser fallback: this product targets production
// agentic systems, and a WebAssembly interpreter cannot run LangChain et al.

/** Output of one executed cell, rendered by the notebook editor. */
export type CellRunResult = {
  stdout: string;
  result: string | null;
  error: string | null;
  durationMs: number;
};

export type ServerStatus = "idle" | "starting" | "ready" | "error" | "stopped";

type StartResp = {
  sessionId?: string;
  status?: string;
  sessionToken?: string;
  gatewayUrl?: string;
  error?: string;
  message?: string;
};

type PendingRun = {
  stdout: string;
  result: string | null;
  error: string | null;
  started: number;
  resolve: (r: CellRunResult) => void;
};

export class ServerRuntime {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private token: string | null = null;
  private gatewayUrl: string | null = null;
  private ready = false;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((e: Error) => void) | null = null;
  private runs = new Map<string, PendingRun>();

  onStatus?: (s: ServerStatus, msg?: string) => void;

  constructor(
    private getAccessToken: () => string | null,
    // A saved notebook's uuid, or null for content with no DB row (e.g. a
    // bundled sample). Interactive cells run inline over the websocket, so a
    // binding is optional.
    private notebookId: string | null,
  ) {}

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.getAccessToken() ?? ""}`,
    };
  }

  private async call(payload: Record<string, unknown>): Promise<StartResp> {
    const res = await fetch("/api/notebook/runtime", {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as StartResp;
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
  }

  async start(): Promise<void> {
    this.onStatus?.("starting");
    try {
      const data = await this.call({ action: "start", notebookId: this.notebookId });
      this.sessionId = data.sessionId ?? null;
      this.token = data.sessionToken ?? null;
      this.gatewayUrl = data.gatewayUrl ?? null;
      await this.waitReady();
      await this.connect();
    } catch (e) {
      this.onStatus?.("error", e instanceof Error ? e.message : "Failed to start runtime");
      throw e;
    }
  }

  private async waitReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = await this.call({ action: "status", sessionId: this.sessionId });
      if (data.status === "ready") {
        this.token = data.sessionToken ?? this.token;
        this.gatewayUrl = data.gatewayUrl ?? this.gatewayUrl;
        return;
      }
      if (data.status === "error" || data.status === "stopped") {
        throw new Error("The runtime failed to start");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("The runtime took too long to start");
  }

  /**
   * Where the gateway lives from the browser's point of view. The server sends
   * an explicit URL only when an operator configured one; otherwise we derive it
   * from the current page, so localhost, a cloud VM's IP, and a custom domain
   * all work with no configuration (wss:// automatically on an https page).
   */
  private resolveGatewayUrl(): string {
    if (this.gatewayUrl) return this.gatewayUrl;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const port = import.meta.env.VITE_NOTEBOOK_GATEWAY_PORT || "8090";
    return `${proto}//${window.location.hostname}:${port}`;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.token) return reject(new Error("Runtime session token is missing"));
      this.connectResolve = resolve;
      this.connectReject = reject;
      const gw = this.resolveGatewayUrl();
      const sep = gw.includes("?") ? "&" : "?";
      const url = `${gw}${sep}token=${encodeURIComponent(this.token)}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return reject(e instanceof Error ? e : new Error("Failed to open websocket"));
      }
      this.ws = ws;
      ws.onmessage = (ev) => this.onMessage(ev);
      ws.onerror = () => {
        if (this.connectReject) this.connectReject(new Error("Gateway connection failed"));
      };
      ws.onclose = (ev) => {
        this.ready = false;
        // A gateway rejection (bad token, session not ready, kernel unreachable)
        // arrives as a close code. Reject the pending connect with it rather than
        // letting the caller sit until the generic timeout fires.
        const why = ev.reason || `gateway closed the connection (code ${ev.code})`;
        if (this.connectReject) {
          this.connectReject(new Error(why));
          this.connectReject = null;
          this.connectResolve = null;
        }
        this.onStatus?.("stopped", why);
        this.failAll(why);
      };
      setTimeout(() => {
        if (!this.ready && this.connectReject)
          this.connectReject(new Error("Kernel connect timed out"));
      }, 30_000);
    });
  }

  private onMessage(ev: MessageEvent) {
    let m: { type?: string; id?: string; text?: string; reason?: string };
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (m.type === "fatal") {
      const why = m.reason || "the runtime gateway refused the connection";
      this.connectReject?.(new Error(why));
      this.connectReject = null;
      this.connectResolve = null;
      this.onStatus?.("error", why);
      return;
    }
    if (m.type === "ready") {
      this.ready = true;
      this.onStatus?.("ready");
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
      return;
    }
    const run = m.id ? this.runs.get(m.id) : undefined;
    if (!run) return;
    if (m.type === "stream") {
      run.stdout += m.text ?? "";
    } else if (m.type === "result") {
      run.result = (run.result ?? "") + (m.text ?? "");
    } else if (m.type === "error") {
      run.error = (run.error ? run.error + "\n" : "") + (m.text ?? "");
    } else if (m.type === "done") {
      run.resolve({
        stdout: run.stdout,
        result: run.result,
        error: run.error,
        durationMs: Date.now() - run.started,
      });
      this.runs.delete(m.id!);
    }
  }

  private failAll(message: string) {
    for (const [id, run] of this.runs) {
      run.resolve({
        stdout: run.stdout,
        result: run.result,
        error: message,
        durationMs: Date.now() - run.started,
      });
      this.runs.delete(id);
    }
  }

  run(code: string): Promise<CellRunResult> {
    return new Promise((resolve) => {
      if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) {
        return resolve({
          stdout: "",
          result: null,
          error: "Server runtime not connected",
          durationMs: 0,
        });
      }
      const id = crypto.randomUUID();
      this.runs.set(id, { stdout: "", result: null, error: null, started: Date.now(), resolve });
      this.ws.send(JSON.stringify({ type: "run", id, code }));
    });
  }

  async stop(): Promise<void> {
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
    this.ready = false;
    if (this.sessionId) {
      await this.call({ action: "stop", sessionId: this.sessionId }).catch(() => {});
    }
    this.onStatus?.("stopped");
  }
}
