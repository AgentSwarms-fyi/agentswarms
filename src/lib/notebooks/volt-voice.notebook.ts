import type { Notebook } from "./types";

export const voltVoiceNotebook: Notebook = {
  id: "volt-voice",
  title: "Voice — TTS, STT & a voice-enabled Agent",
  description:
    "VoltAgent's @voltagent/voice package: text-to-speech with OpenAI or ElevenLabs, speech-to-text with Whisper, and a Voice instance attached to an Agent for full speak-listen-respond loops.",
  difficulty: "intermediate",
  tags: ["agent", "content"],
  subgroup: "Multimodal",
  requires: ["lovable-ai"],
  cells: [
    {
      id: "intro", kind: "markdown",
      source: `# 7 · Voice — \`@voltagent/voice\` + an Agent

The \`@voltagent/voice\` package gives an Agent two new capabilities:

| Direction | Method | What it does |
| --- | --- | --- |
| **Text → audio (TTS)** | \`voice.speak(text, opts?)\` | Returns a \`Readable\` stream of audio bytes |
| **Audio → text (STT)** | \`voice.listen(audio, opts?)\` | Returns the transcript string |

Two providers ship out of the box: \`OpenAIVoiceProvider\` and \`ElevenLabsVoiceProvider\`. You attach one to an Agent and the agent owns the capability:

\`\`\`ts
const concierge = new Agent({ name, instructions, model, voice });
const transcript = await concierge.voice.listen(audio);
const { text }   = await concierge.generateText(transcript);
const audioReply = await concierge.voice.speak(text, { voice: "nova" });
\`\`\`

We'll build the **listen → reason → speak** loop one piece at a time. Each cell adds one concept on top of the previous.`,
    },

    {
      id: "md-chat", kind: "markdown",
      source: `## Step 1 · The shared \`chat()\` helper

Both STT and TTS in our runnable version delegate to the platform's chat endpoint (TTS is simulated; the *shape* matches the real provider exactly). One tiny helper, reused everywhere.`,
    },
    {
      id: "code-chat", kind: "code", language: "js", runtime: "browser",
      source: `const AI = ctx.aiBaseURL, KEY = ctx.aiApiKey;

globalThis.chat = async function chat(messages) {
  const r = await ctx.fetch(\`\${AI}/chat/completions\`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: \`Bearer \${KEY}\` },
    body: JSON.stringify({ model: "google/gemini-3-flash-preview", messages }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message ?? r.statusText);
  return data.choices[0].message.content;
};

ctx.log("chat() ready");
return "ok";
`,
    },

    {
      id: "md-provider", kind: "markdown",
      source: `## Step 2 · Define \`OpenAIVoiceProvider\`

The real provider takes \`{ apiKey, ttsModel, voice, speechModel }\` and exposes \`listen()\` + \`speak()\`. We mirror that surface so the rest of the notebook is identical to production code.`,
    },
    {
      id: "code-provider", kind: "code", language: "js", runtime: "browser",
      source: `class OpenAIVoiceProvider {
  constructor({ ttsModel = "tts-1", voice = "alloy", speechModel = "whisper-1" } = {}) {
    Object.assign(this, { ttsModel, voice, speechModel });
  }
  /** STT — in real VoltAgent this calls Whisper on raw audio bytes. */
  async listen(audioDescription, opts = {}) {
    const out = await chat([
      { role: "system", content: \`You are a Whisper-equivalent STT model (\${opts.model ?? this.speechModel}). Reply with ONLY the transcript.\` },
      { role: "user",   content: \`Audio description: \${audioDescription}\\n\\nTranscript:\` },
    ]);
    return out.trim().replace(/^["']|["']$/g, "");
  }
  /** TTS — real provider returns a Readable of mp3 bytes. We return a structured spec + delivery note. */
  async speak(text, opts = {}) {
    const direction = await chat([
      { role: "system", content: "You direct voice actors. Given a line, give a one-line delivery note (tone, pace, emotion)." },
      { role: "user",   content: text },
    ]);
    return {
      audioFormat: "mp3",
      voice: opts.voice ?? this.voice,
      model: opts.model ?? this.ttsModel,
      durationSecEstimate: Math.max(1, Math.round(text.split(/\\s+/).length / 2.6)),
      direction: direction.trim(),
      bytes: \`<audio:\${text.length}chars,model=\${this.ttsModel},voice=\${opts.voice ?? this.voice}>\`,
    };
  }
}
globalThis.OpenAIVoiceProvider = OpenAIVoiceProvider;
ctx.log("OpenAIVoiceProvider defined with methods: listen(), speak()");
return "ok";
`,
    },

    {
      id: "md-agent", kind: "markdown",
      source: `## Step 3 · Attach voice to an Agent

In VoltAgent, \`voice\` is just another constructor field. The agent doesn't need to know about audio — it just exposes \`agent.voice.*\`.`,
    },
    {
      id: "code-agent", kind: "code", language: "js", runtime: "browser",
      source: `class Agent {
  constructor({ name, instructions, model, voice }) { Object.assign(this, { name, instructions, model, voice }); }
  async generateText(prompt) {
    const text = await chat([{ role: "system", content: this.instructions }, { role: "user", content: prompt }]);
    return { text };
  }
}

const voice = new OpenAIVoiceProvider({ ttsModel: "tts-1", voice: "nova" });
const concierge = new Agent({
  name: "concierge",
  instructions: "You are a warm, brief hotel concierge. Reply in TWO short sentences max.",
  model: "google/gemini-3-flash-preview",
  voice,
});
globalThis.concierge = concierge;

ctx.log("concierge ready · has voice?", !!concierge.voice);
return { name: concierge.name, hasVoice: !!concierge.voice };
`,
    },

    {
      id: "md-listen", kind: "markdown",
      source: `## Step 4 · LISTEN — turn incoming audio into text

The first half of the loop. A guest leaves a voice note; \`voice.listen()\` gives us the transcript.`,
    },
    {
      id: "code-listen", kind: "code", language: "js", runtime: "browser",
      source: `const concierge = globalThis.concierge;
if (!concierge) throw new Error("Run Step 3 (Attach voice to an Agent) first.");

const audioDesc = "A woman speaking English with a mild French accent, slightly hurried. She says she needs a dinner reservation for two at 8pm tonight, somewhere walkable from the hotel that does seafood.";

ctx.log("🎙  listening to incoming audio...");
const transcript = await concierge.voice.listen(audioDesc, { model: "whisper-1" });
globalThis.transcript = transcript;

ctx.log("📝 transcript:", transcript);
return transcript;
`,
    },

    {
      id: "md-reason", kind: "markdown",
      source: `## Step 5 · REASON — let the agent think

Standard \`agent.generateText()\`. Nothing voice-specific here — proof that voice is a capability, not a coupling.`,
    },
    {
      id: "code-reason", kind: "code", language: "js", runtime: "browser",
      source: `const concierge = globalThis.concierge;
const transcript = globalThis.transcript;
if (!concierge) throw new Error("Run Step 3 first.");
if (!transcript) throw new Error("Run Step 4 (LISTEN) first.");

ctx.log("🤔 generating reply...");
const { text: reply } = await concierge.generateText(transcript);
globalThis.reply = reply;

ctx.log("💬 reply:", reply);
return reply;
`,
    },

    {
      id: "md-speak", kind: "markdown",
      source: `## Step 6 · SPEAK — synthesise the audio response

\`voice.speak()\` closes the loop. In production this is a stream of mp3 bytes you pipe straight into an HTTP response or browser \`MediaSource\`.`,
    },
    {
      id: "code-speak", kind: "code", language: "js", runtime: "browser",
      source: `const concierge = globalThis.concierge;
const reply = globalThis.reply;
if (!concierge) throw new Error("Run Step 3 first.");
if (!reply) throw new Error("Run Step 5 (REASON) first.");

ctx.log("🔊 synthesising speech...");
const audio = await concierge.voice.speak(reply, { voice: "nova" });

ctx.log("audio.spec:", JSON.stringify({
  voice: audio.voice, model: audio.model,
  durationSecEstimate: audio.durationSecEstimate, audioFormat: audio.audioFormat,
}, null, 2));
ctx.log("audio.direction:", audio.direction);
ctx.log("audio.bytes:", audio.bytes);

return audio;
`,
    },

    {
      id: "outro", kind: "markdown",
      source: `## What you just built

A complete VoltAgent voice loop:

\`\`\`text
user audio ──▶ voice.listen() ──▶ transcript ──▶ agent.generateText() ──▶ reply ──▶ voice.speak() ──▶ audio
\`\`\`

In production:

- Swap \`OpenAIVoiceProvider\` for \`ElevenLabsVoiceProvider\` and pass a real \`voiceId\` for higher-quality TTS.
- Pipe \`voice.speak()\`'s \`Readable\` straight into an HTTP response (\`Content-Type: audio/mpeg\`) or browser \`MediaSource\`.
- \`voice.listen()\` accepts \`Buffer | Readable\`, so it composes with any uploaded file or live mic stream.
- Set \`speechModel\` / \`ttsModel\` per call to mix cheap STT with high-quality TTS.

The agent code itself never changes — voice is a capability the agent owns.`,
    },
  ],
};
