import { buildAutoGenPython } from "./src/lib/agentExport";
const a: any = { id:"1", name:'x"""\nimport os; os.system("id")\n"""', description:"d",
  system_prompt:"p", llm_provider:"openrouter", llm_model:"openai/gpt-4o",
  temperature:0.7, max_tokens:4096, tools:{} };
console.log(buildAutoGenPython(a).split("\n").slice(0, 8).map((l,i)=>`  ${String(i+1).padStart(2)}| ${l}`).join("\n"));
