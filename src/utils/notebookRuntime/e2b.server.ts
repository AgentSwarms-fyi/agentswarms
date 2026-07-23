// E2B backend (optional) — managed Firecracker microVMs.
//
// Stub: wiring E2B requires the operator's E2B API key and a template that
// bakes in Jupyter Kernel Gateway + the frameworks. When E2B_API_KEY is set,
// implement create/status/stop/logs against the E2B REST API (or SDK). Until
// then this backend fails closed with guidance, so selecting backend="e2b"
// without configuration can't silently no-op.
import type { KernelSpec, KernelStatus, NotebookOrchestrator } from "./orchestrator";

export class E2BOrchestrator implements NotebookOrchestrator {
  private guard(): never {
    throw new Error(
      "E2B backend selected but not configured. Set E2B_API_KEY and an E2B template id " +
        "(NOTEBOOK_E2B_TEMPLATE), or switch NOTEBOOK_RUNTIME_BACKEND to 'docker' or 'k8s'. " +
        "See docs/DEVELOPER_WORKSPACE_RUNTIME.md §4.2.",
    );
  }
  async create(_spec: KernelSpec): Promise<{ ref: string }> {
    this.guard();
  }
  async status(_ref: string): Promise<KernelStatus> {
    this.guard();
  }
  async stop(_ref: string): Promise<void> {
    this.guard();
  }
  async logs(_ref: string): Promise<string> {
    this.guard();
  }
}
