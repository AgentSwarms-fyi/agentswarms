import type { Notebook } from "./types";

export const lcDocumentsNotebook: Notebook = {
  id: "lc-documents",
  title: "Images & PDFs with LangChain",
  description:
    "Hands-on image lab (vision Q&A on multiple images) and PDF processing (extract text with pdfjs, then summarise with a LangChain chain).",
  difficulty: "beginner",
  tags: ["langchain"],
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · Images & PDFs

In notebook 1 we sent a single image. Here we'll do two real workflows:

1. **Image lab** — compare two images side-by-side, then OCR-style extraction with structured output
2. **PDF processing** — fetch a PDF, extract its text with \`pdfjs\`, wrap each page as a LangChain \`Document\`, then summarise with a prompt chain

Everything is browser-side. The LLM call goes through our authenticated proxy.`,
    },

    // Image lab — multi-image compare
    { id: "md-1", kind: "markdown", source: `## 1 · Image lab — compare two images\n\nSame \`HumanMessage\` content-array trick, but with **two** \`image_url\` parts. The model can reason across them.` },
    {
      id: "compare-images", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;

const llm = new ChatOpenAI({
  model: "google/gemini-2.5-flash", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const a = "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Banana-Single.jpg/120px-Banana-Single.jpg";
const b = "https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/Red_Apple.jpg/120px-Red_Apple.jpg";

const msg = new HumanMessage({
  content: [
    { type: "text", text: "Compare the two fruits. Reply as JSON: {fruits:[{name,colour}], differences:[...]}" },
    { type: "image_url", image_url: { url: a } },
    { type: "image_url", image_url: { url: b } },
  ],
});

const res = await llm.invoke([msg]);
return res.content;
`,
    },

    // Image lab — structured output from a single image
    { id: "md-2", kind: "markdown", source: `## 2 · Image → typed object with \`withStructuredOutput\`\n\nWhy chase the model for valid JSON when LangChain can enforce a Zod schema for you?` },
    {
      id: "image-structured", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { HumanMessage } = ctx.lc.messages;
const { z } = ctx.lc;

const schema = z.object({
  caption: z.string(),
  dominant_colour: z.string(),
  contains_text: z.boolean(),
  objects: z.array(z.string()).max(8),
});

const llm = new ChatOpenAI({
  model: "google/gemini-2.5-flash", temperature: 0,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
}).withStructuredOutput(schema, { name: "image_meta" });

const url = "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png";

return await llm.invoke([
  new HumanMessage({
    content: [
      { type: "text", text: "Describe this image as image_meta." },
      { type: "image_url", image_url: { url } },
    ],
  }),
]);
`,
    },
    { id: "md-2x", kind: "markdown", source: `\`withStructuredOutput(zodSchema)\` binds the schema as a tool under the hood and parses the call back into a typed JS object. The result already matches your schema — no \`JSON.parse\` dance.` },

    // PDF processing
    { id: "md-3", kind: "markdown", source: `## 3 · PDF processing\n\nWe fetch a real public PDF, extract text with **pdfjs**, then wrap each page as a LangChain \`Document\`. \`Document\` is the universal "chunk of text + metadata" type used by retrievers, splitters, and chains.` },
    {
      id: "pdf-extract", kind: "code", language: "js", runtime: "browser",
      source: `// Configure pdfjs worker (CDN — no install needed).
const pdfjs = ctx.pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs";

const url = "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";
const buf = await (await fetch(url)).arrayBuffer();
const pdf = await pdfjs.getDocument({ data: buf }).promise;
ctx.log("PDF loaded, pages:", pdf.numPages);

const { Document } = ctx.lc.documents;
const docs = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => it.str).join(" ");
  docs.push(new Document({ pageContent: text, metadata: { page: i, source: url } }));
}

ctx.state.pdfDocs = docs;
return { pages: docs.length, first_page_preview: docs[0].pageContent.slice(0, 200) };
`,
    },

    { id: "md-4", kind: "markdown", source: `## 4 · Summarise the PDF with a prompt chain\n\nThe canonical LangChain pipeline: \`PromptTemplate → ChatModel → StringOutputParser\`, composed with \`.pipe()\`.` },
    {
      id: "pdf-summarise", kind: "code", language: "js", runtime: "browser",
      source: `const { ChatOpenAI } = ctx.lc.openai;
const { ChatPromptTemplate } = ctx.lc.prompts;
const { StringOutputParser } = ctx.lc.outputParsers;

const docs = ctx.state.pdfDocs ?? [];
if (!docs.length) throw new Error("Run the previous cell first to load the PDF.");

const joined = docs.map((d) => "[page " + d.metadata.page + "]\\n" + d.pageContent).join("\\n\\n");

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You summarise PDFs in 3 bullet points, citing page numbers."],
  ["human", "Summarise:\\n\\n{doc}"],
]);

const llm = new ChatOpenAI({
  model: "google/gemini-3-flash-preview", temperature: 0.2,
  apiKey: ctx.aiApiKey,
  configuration: { baseURL: ctx.aiBaseURL, dangerouslyAllowBrowser: true },
});

const chain = prompt.pipe(llm).pipe(new StringOutputParser());
return await chain.invoke({ doc: joined.slice(0, 8000) });
`,
    },
    { id: "md-4x", kind: "markdown", source: `That's the full **LCEL** (LangChain Expression Language) pattern: \`prompt.pipe(model).pipe(parser)\`. Swap any piece and the chain still works — that's the whole point.` },
  ],
};
