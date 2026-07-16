import type { Notebook } from "./types";

/**
 * Foundations Lab #2 — Images & Multimodal.
 * Beginner-friendly: image generation with Gemini/GPT-image, image
 * understanding (describe / compare / extract / OCR), and the
 * "describe-then-redraw" round-trip pattern.
 */
export const fndMultimodalImageNotebook: Notebook = {
  id: "fnd-multimodal-image",
  title: "Image & Multimodal Lab",
  description:
    "Generate images from text, describe images with vision models, compare two images, OCR a receipt, and round-trip describe-then-redraw — all in one notebook.",
  difficulty: "beginner",
  tags: ["content"],
  subgroup: "Prompting Basics",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 2 · Image & Multimodal Lab

Modern AI models accept **and produce** more than just text. In this notebook we cover the two halves of multimodal AI:

1. **Image generation** — text in, picture out (Gemini's *Nano Banana*, OpenAI's *gpt-image-2*)
2. **Image understanding** — picture in, text out (description, comparison, OCR, extraction)

Then we do the fun thing: chain them together to make a model **describe** an image and **redraw it** from the description.

### What you should already know
The basics of \`fetch\` and \`messages\` arrays from **Notebook 1**. Everything we do here is the same call pattern, just with new endpoints and content shapes.`,
    },

    // ───────────────────────────────── 1. Generate your first image
    { id: "md-1", kind: "markdown", source: `## 1 · Generate your first image

The image endpoint lives at \`${"`${aiBaseURL}/images/generations`"}\`. The simplest possible body is:

\`\`\`json
{ "model": "google/gemini-2.5-flash-image", "prompt": "A red panda on a skateboard" }
\`\`\`

The response contains \`data[0].b64_json\` — a base64-encoded PNG. We turn it into a \`data:image/png;base64,…\` URL and \`ctx.log\` it as an image so the notebook UI renders it.

> **Why this works:** the proxy on this app forwards the request to Lovable AI Gateway and keeps your API key on the server. From your code's perspective it looks exactly like calling OpenAI directly.` },
    {
      id: "gen-image", kind: "code", language: "js", runtime: "browser",
source: `async function generateImage(prompt, opts = {}) {
  const model = opts.model ?? "google/gemini-3.1-flash-image-preview";
  const isGemini = model.startsWith("google/");

  // Gemini image models use the chat-completions image shape (messages + modalities).
  // OpenAI image models use the classic images-generations shape (prompt + size/quality).
  const buildBody = () => isGemini
    ? {
        model,
        messages: [{ role: "user", content: prompt }],
        modalities: ["image", "text"],
        // Images are emitted as tokens — default caps truncate the PNG mid-stream.
        max_tokens: opts.maxTokens ?? 16384,
      }
    : {
        model,
        prompt,
        ...(opts.size ? { size: opts.size } : {}),
        quality: opts.quality ?? "low",
      };

  // Image models can occasionally return an empty payload (data:null, 0 output tokens).
  // We retry up to 3 times before giving up.
  let lastJson = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await ctx.fetch(ctx.aiBaseURL + "/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
      body: JSON.stringify(buildBody()),
    });
    if (!res.ok) throw new Error("Image gen failed: " + res.status + " " + await res.text());
    lastJson = await res.json();
    const b64 = lastJson?.data?.[0]?.b64_json;
    if (b64) return "data:image/png;base64," + b64;
    ctx.log("Empty image response, retrying… (attempt " + (attempt + 1) + "/3)");
    await new Promise(r => setTimeout(r, 600));
  }
  throw new Error(
    "Image model returned no image after 3 attempts. " +
    "This usually means the prompt was filtered or the model briefly failed — " +
    "try rephrasing the prompt or switching model (e.g. 'openai/gpt-image-2'). " +
    "Last response: " + JSON.stringify(lastJson).slice(0, 250)
  );
}
ctx.state.generateImage = generateImage;

// 🎨 Change the prompt and re-run.
const dataUrl = await generateImage(
  "A cozy reading nook with a window overlooking a foggy forest at dawn, warm lamp light, watercolor style"
);

ctx.log("Generated image (base64 length):", dataUrl.length);
// Return a Markdown-ish object that the notebook UI will render
return { image: dataUrl };
`,
    },
    { id: "md-1x", kind: "markdown", source: `The cell returns an object whose \`image\` field is a data URL. The notebook viewer renders \`data:image/png;base64,…\` URLs as inline previews.

**Try it:**
- Change the prompt to something hyper-specific ("isometric pixel art of a 1980s sci-fi computer terminal, CRT glow, palette of teal and magenta")
- Swap the model to \`openai/gpt-image-2\` (different aesthetic)
- Add \`size: "1024x1024"\` in the options` },

    // ───────────────────────────────── 2. Image understanding (description)
    { id: "md-2", kind: "markdown", source: `## 2 · Image understanding — describe an image

Vision models accept a **content array** instead of a plain string. Each element is either text or an image:

\`\`\`json
"content": [
  { "type": "text", "text": "What is in this picture?" },
  { "type": "image_url", "image_url": { "url": "https://..." } }
]
\`\`\`

The model returns a normal text response describing what it sees. Below we ask Gemini to describe a public Wikimedia photo.` },
    {
      id: "describe", kind: "code", language: "js", runtime: "browser",
      source: `async function callVision(messages, opts = {}) {
  const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
    body: JSON.stringify({
      model: opts.model ?? "google/gemini-2.5-flash",
      messages,
      temperature: opts.temperature ?? 0.2,
    }),
  });
  if (!res.ok) throw new Error("Vision call failed: " + res.status + " " + await res.text());
  const json = await res.json();
  return json.choices[0].message.content;
}
ctx.state.callVision = callVision;

const imageUrl =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/640px-PNG_transparency_demonstration_1.png";

const description = await callVision([
  {
    role: "user",
    content: [
      { type: "text", text: "Describe this image in 2 sentences. Then list every distinct color you see." },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  },
]);

return { image: imageUrl, description };
`,
    },
    { id: "md-2x", kind: "markdown", source: `Same chat-completions endpoint as Notebook 1 — the **only** difference is the \`content\` field is now an array instead of a string. That's the entire multimodal API.` },

    // ───────────────────────────────── 3. Compare two images
    { id: "md-3", kind: "markdown", source: `## 3 · Compare two images at once

You can pass **multiple images** in the same content array. The model treats them as image 1, image 2, etc. — perfect for diffing, "spot the difference", before/after, or A/B comparisons.` },
    {
      id: "compare", kind: "code", language: "js", runtime: "browser",
      source: `const callVision = ctx.state.callVision;

const img1 = "https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Sunflower_from_Silesia2.jpg/320px-Sunflower_from_Silesia2.jpg";
const img2 = "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Sunflower_field_2.jpg/320px-Sunflower_field_2.jpg";

const verdict = await callVision([
  {
    role: "user",
    content: [
      { type: "text", text:
        "I will show you two images. Image 1 is on top, Image 2 below. " +
        "Compare them across: subject, framing, lighting, mood. " +
        "End with a 1-line verdict: which one would be a better magazine cover?" },
      { type: "image_url", image_url: { url: img1 } },
      { type: "image_url", image_url: { url: img2 } },
    ],
  },
]);

return { image_1: img1, image_2: img2, comparison: verdict };
`,
    },
    { id: "md-3x", kind: "markdown", source: `The model genuinely reasons about both pictures — it isn't just describing one. This unlocks design-review agents, photo-curation tools, QA bots that compare a UI screenshot to a Figma mockup, and more.` },

    // ───────────────────────────────── 4. OCR / extraction
    { id: "md-4", kind: "markdown", source: `## 4 · OCR-style extraction → structured JSON

Combine **vision** with the **structured-output** trick from Notebook 1: ask the model to read text from an image and return JSON.

This is how modern "scan a receipt" / "scan a business card" features work — no specialized OCR library required.` },
    {
      id: "ocr", kind: "code", language: "js", runtime: "browser",
      source: `// A public sample receipt image
const receipt = "https://templates.invoicehome.com/sales-receipt-template-us-classic-white-750px.png";

const res = await ctx.fetch(ctx.aiBaseURL + "/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + ctx.aiApiKey },
  body: JSON.stringify({
    model: "google/gemini-2.5-flash",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: \`Extract the receipt into JSON with this exact shape:
{
  "merchant": string,
  "date": string,
  "currency": string,
  "items": [{ "name": string, "qty": number, "price": number }],
  "subtotal": number,
  "tax": number,
  "total": number
}
If a field is not visible, use null.\`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract this receipt." },
          { type: "image_url", image_url: { url: receipt } },
        ],
      },
    ],
  }),
});

const json = await res.json();
const parsed = JSON.parse(json.choices[0].message.content);
return { image: receipt, extracted: parsed };
`,
    },
    { id: "md-4x", kind: "markdown", source: `The result is real JSON — \`parsed.items[0].price\` is a number you can sum, store in a DB, or display in a table. Combine with the structured-output techniques from Notebook 1 and you have a full document-AI pipeline.` },

    // ───────────────────────────────── 5. Round-trip
    { id: "md-5", kind: "markdown", source: `## 5 · The round-trip — describe → re-draw

Now the cool one. We:

1. Take a starting image.
2. Ask a **vision model** to describe it in detail.
3. Feed that description into an **image-generation model**.
4. Compare the original and the AI's redrawn version.

This is the canonical pattern behind "remix this photo in a different style" features.` },
    {
      id: "roundtrip", kind: "code", language: "js", runtime: "browser",
      source: `const callVision = ctx.state.callVision;
const generateImage = ctx.state.generateImage;

const original = "https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/Sunflower_from_Silesia2.jpg/640px-Sunflower_from_Silesia2.jpg";

// Step 1 — describe
const description = await callVision([
  {
    role: "user",
    content: [
      { type: "text", text:
        "Describe this image as a single, vivid sentence (40-60 words) suitable as a prompt " +
        "for an image-generation model. Include subject, composition, lighting, colors, and mood. " +
        "Do not start with 'A picture of'." },
      { type: "image_url", image_url: { url: original } },
    ],
  },
], { temperature: 0.3 });

ctx.log("AI description used as prompt:", description);

// Step 2 — feed the description back into image generation
const redrawn = await generateImage(description);

return {
  original_image: original,
  ai_description: description,
  redrawn_image: redrawn,
};
`,
    },
    { id: "md-5x", kind: "markdown", source: `The redrawn version won't be pixel-identical — and that's the point. It's the model's *interpretation* of its own description. Look at what survives the round-trip (subject, mood) and what doesn't (exact composition, specific details). That gap tells you a lot about what each model "sees" and "imagines."

### You finished both Foundations notebooks 🎉
You now know the two raw primitives — **text** and **images** — that every later notebook builds on. Next up: **LangChain Fundamentals**, which wraps everything you just did in a much nicer API.` },
  ],
};
