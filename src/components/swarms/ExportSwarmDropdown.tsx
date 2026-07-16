import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download } from "lucide-react";
import { exportSwarm, downloadSwarmAsJson } from "@/lib/swarmPortable";
import { downloadSwarmAsLangGraph } from "@/lib/swarmExportLangGraph";
import { downloadSwarmAsCrewAI, downloadSwarmAsOpenAIAgents } from "@/lib/swarmExportFrameworks";
import { downloadSwarmAsStrands } from "@/lib/swarmExportStrands";
import type { Node, Edge } from "@xyflow/react";
import type { SwarmNodeData } from "@/lib/swarmRuntime";

interface ExportSwarmDropdownProps {
  name: string;
  description?: string;
  nodes: Node<SwarmNodeData>[] | unknown[];
  edges: Edge[] | unknown[];
}

export function ExportSwarmDropdown({ name, description, nodes, edges }: ExportSwarmDropdownProps) {
  function getPortable() {
    return exportSwarm({
      name,
      description,
      nodes: nodes as Node<SwarmNodeData>[],
      edges: edges as Edge[],
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" title="Export swarm">
          <Download className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => downloadSwarmAsJson(getPortable())}>JSON</DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsLangGraph(getPortable(), "python")}>
          LangGraph Python
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsLangGraph(getPortable(), "typescript")}>
          LangGraph TypeScript
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsCrewAI(getPortable())}>
          CrewAI (Python)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsOpenAIAgents(getPortable())}>
          OpenAI Agents SDK (Python)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsStrands(getPortable(), "python")}>
          Strands SDK (Python)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadSwarmAsStrands(getPortable(), "typescript")}>
          Strands SDK (TypeScript)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
