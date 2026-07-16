import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Download,
  FileJson,
  FileCode,
  Container,
  Check,
  Bot,
  Workflow,
  Braces,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { exportAgent, type ExportFormat } from "@/lib/agentExport";
import type { Agent } from "@/components/agents/AgentForm";
import { toast } from "sonner";

type OptionGroup = {
  heading: string;
  items: { id: ExportFormat; title: string; description: string; icon: any; tag: string }[];
};

const GROUPS: OptionGroup[] = [
  {
    heading: "LangChain",
    items: [
      {
        id: "langchain-py",
        title: "LangChain Python",
        description: "LCEL chain with ChatPromptTemplate, model binding, and tool stubs.",
        icon: FileCode,
        tag: "Python",
      },
      {
        id: "langchain-ts",
        title: "LangChain TypeScript",
        description: "LCEL chain using @langchain/core — ready to run with tsx.",
        icon: Braces,
        tag: "TypeScript",
      },
    ],
  },
  {
    heading: "LangGraph",
    items: [
      {
        id: "langgraph-py",
        title: "LangGraph Python (ReAct)",
        description: "StateGraph with agent + tool nodes and conditional routing.",
        icon: Workflow,
        tag: "Python",
      },
      {
        id: "langgraph-ts",
        title: "LangGraph TypeScript (ReAct)",
        description: "StateGraph using @langchain/langgraph with MessagesAnnotation.",
        icon: Workflow,
        tag: "TypeScript",
      },
    ],
  },
  {
    heading: "Strands Agents SDK",
    items: [
      {
        id: "strands-py",
        title: "Strands Python",
        description:
          "AWS Strands Agent with model provider + tool stubs — runnable with strands-agents.",
        icon: Bot,
        tag: "Python",
      },
      {
        id: "strands-ts",
        title: "Strands TypeScript",
        description: "Strands Agent using @strands-agents/sdk with invoke() and tool stubs.",
        icon: Braces,
        tag: "TypeScript",
      },
    ],
  },
  {
    heading: "Other Frameworks",
    items: [
      {
        id: "yaml",
        title: "CrewAI YAML Config",
        description: "Strict CrewAI-compatible config for the Python framework.",
        icon: FileCode,
        tag: "Python",
      },
      {
        id: "autogen",
        title: "AutoGen Python Script",
        description: "Microsoft AutoGen AssistantAgent script — runnable with pyautogen.",
        icon: Bot,
        tag: "Python",
      },
    ],
  },
  {
    heading: "Portable",
    items: [
      {
        id: "json",
        title: "Universal Agent.json",
        description: "Standardized JSON manifest with prompts, tools and model configuration.",
        icon: FileJson,
        tag: "Portable",
      },
      {
        id: "docker",
        title: "Standalone Dockerfile",
        description: "Bundle with Dockerfile + config for instant self-hosting.",
        icon: Container,
        tag: "Self-host",
      },
    ],
  },
];

export function ExportAgentDialog({
  agent,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  agent: Agent;
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [format, setFormat] = useState<ExportFormat>("langchain-py");

  function handleDownload() {
    exportAgent(agent, format);
    toast.success(`Exported ${agent.name} as ${format.toUpperCase()}`);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Export "{agent.name}"</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {GROUPS.map((group) => (
            <div key={group.heading}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {group.heading}
              </p>
              <div className="space-y-2">
                {group.items.map((opt) => {
                  const Icon = opt.icon;
                  const selected = format === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setFormat(opt.id)}
                      className={cn(
                        "w-full text-left rounded-lg border p-3 transition-all",
                        selected
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border hover:border-primary/50",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={cn(
                            "rounded-md p-1.5",
                            selected ? "bg-primary text-primary-foreground" : "bg-muted",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-semibold text-sm">{opt.title}</p>
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground border rounded px-1.5 py-0.5 shrink-0">
                              {opt.tag}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">{opt.description}</p>
                        </div>
                        {selected && <Check className="h-4 w-4 text-primary mt-1 shrink-0" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <Button onClick={handleDownload} className="w-full mt-2">
          <Download className="h-4 w-4 mr-2" /> Download
        </Button>
      </DialogContent>
    </Dialog>
  );
}
