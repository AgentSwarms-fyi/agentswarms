-- Allow knowledge_bases & knowledge_documents to be marked as shared samples (user_id NULL).
ALTER TABLE public.knowledge_bases ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
ALTER TABLE public.knowledge_documents ADD COLUMN IF NOT EXISTS is_sample boolean NOT NULL DEFAULT false;
ALTER TABLE public.knowledge_bases ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.knowledge_documents ALTER COLUMN user_id DROP NOT NULL;

-- Replace single ALL policy with granular ones that also allow public read of samples.
DROP POLICY IF EXISTS "Users manage own knowledge bases" ON public.knowledge_bases;
CREATE POLICY "View own or sample KBs" ON public.knowledge_bases FOR SELECT
  USING ((is_sample = true) OR (auth.uid() = user_id));
CREATE POLICY "Insert own KBs (non-sample)" ON public.knowledge_bases FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_sample = false);
CREATE POLICY "Update own KBs" ON public.knowledge_bases FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own KBs" ON public.knowledge_bases FOR DELETE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users manage own documents" ON public.knowledge_documents;
CREATE POLICY "View own or sample docs" ON public.knowledge_documents FOR SELECT
  USING ((is_sample = true) OR (auth.uid() = user_id));
CREATE POLICY "Insert own docs (non-sample)" ON public.knowledge_documents FOR INSERT
  WITH CHECK (auth.uid() = user_id AND is_sample = false);
CREATE POLICY "Update own docs" ON public.knowledge_documents FOR UPDATE
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Delete own docs" ON public.knowledge_documents FOR DELETE
  USING (auth.uid() = user_id);

-- Seed 4 sample knowledge bases (idempotent on name+is_sample).
DO $$
DECLARE
  kb_id uuid;
BEGIN
  -- KB 1
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases WHERE is_sample = true AND name = 'Sample · UAF: Unified Audio Front-End LLM') THEN
    INSERT INTO public.knowledge_bases (user_id, name, description, is_sample)
    VALUES (NULL, 'Sample · UAF: Unified Audio Front-End LLM', 'arXiv:2604.19221 — Full-duplex speech interaction with a single audio front-end LLM.', true)
    RETURNING id INTO kb_id;
    INSERT INTO public.knowledge_documents (user_id, knowledge_base_id, name, content, is_sample, metadata)
    VALUES (NULL, kb_id, 'UAF Paper Excerpt.md',
'# UAF: A Unified Audio Front-End LLM for Full-Duplex Speech Interaction

Authors: Yadong Li, Guoxin Wu, Haiping Hou, Biye Li (Alibaba Inc.). arXiv:2604.19221 (2026).

## Abstract
Full-duplex speech interaction is the most natural mode of human communication. Traditional cascaded speech pipelines suffer from accumulated latency, information loss, and error propagation. End-to-end audio LLMs like GPT-4o unify speech understanding and generation but remain inherently half-duplex and rely on separate task-specific front-end components such as voice activity detection (VAD) and turn-taking detection (TD). The authors propose UAF, the first unified audio front-end LLM tailored for full-duplex speech systems. UAF reformulates VAD, TD, speaker recognition (SR), automatic speech recognition (ASR), and question answering (QA) into a single auto-regressive sequence prediction problem. It takes streaming fixed-duration audio chunks (e.g. 600 ms), uses a reference audio prompt to anchor the target speaker, and regressively generates discrete tokens encoding both semantic content and system-level state controls (e.g. interruption signals). UAF achieves leading performance across multiple front-end tasks and significantly improves response latency and interruption accuracy.

## Key Problems with Cascaded Pipelines
1. Error propagation and nonlinear distortion across modules degrade reliability. Spectral subtraction noise reduction often destroys weak speech structure, hurting ASR.
2. Disjoint optimization prevents leveraging cross-task dependencies. Energy-based VAD misclassifies user thinking sounds or background voices as interruptions.
3. Each module adds computational redundancy and latency. End-to-end delay is hard to compress to the human comfort zone of 200-500 ms, making timely barge-in difficult.

## Architecture
UAF uses an Encoder-Projector-LLM architecture adapted from Qwen3-Omni-30B-A3B-Instruct. An audio encoder encodes multi-speaker input; a projector injects audio embeddings into the LLM''s text feature space. The model emits a token stream that interleaves audio chunk states (SIL / TALK), turn states (Complete / InComplete / Interrupt / Backchannel), ASR markers (AsrStart / AsrEnd), and answer markers (AnswerStart / AnswerEnd). Dedicated lightweight heads handle VAD and TD; the main LM head handles ASR and QA, trained jointly with VAD State Loss, Turn State Loss, and CE Loss.

## Sequence Formulation
At time t, the joint distribution is P(x_t, s_t | x_{<=t-1}, s_{<=t-1}, a_{<=t}, A_ref), where A_ref is the reference speaker prompt, a_t is the current audio chunk, x_t is the text tokens, and s_t are control tokens.

## Training Stages
- Stage I: encoder + projector pretraining on ASR.
- Stage II: front-end task pretraining (VAD, TD, SR) on synthetic multi-speaker audio.
- Stage III: all-task joint fine-tuning on multi-turn user-agent dialogues with LoRA on the LLM.

## Data Pipeline
Synthetic full audio is built from TTS reference speaker speech, interference (cocktail-party) speech sampled from VoxCeleb and CommonVoice, and environmental noise from MUSAN. Each 600 ms chunk is labeled with VAD/Turn/ASR states.

## Results
- Standard ASR on Fleurs-zh, AISHELL-1, AISHELL-2, and an Online-test set from Taobao recordings: UAF outperforms Paraformer-zh-streaming, Qwen3-Omni-30B-A3B, Qwen2.5-Omni-7B, Kimi-Audio-7B, and Qwen2-Audio-7B in WER.
- TD on the Easy-Turn test set: UAF beats Smart Turn V2 across Complete / InComplete / Backchannel / Interrupt accuracy.
- A shared LM head for VAD/TD underperforms dedicated lightweight task heads, justifying the multi-head design.

## Takeaway
Embedding front-end perception (VAD, TD, SR) directly inside an LLM-based generative framework, rather than treating it as preprocessing, yields lower latency, better interruption handling, and stronger ASR than cascaded systems.
',
    true, '{"source":"arxiv:2604.19221","kind":"paper_excerpt"}'::jsonb);
  END IF;

  -- KB 2
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases WHERE is_sample = true AND name = 'Sample · Agentic AI for Fall Risk Detection') THEN
    INSERT INTO public.knowledge_bases (user_id, name, description, is_sample)
    VALUES (NULL, 'Sample · Agentic AI for Fall Risk Detection', 'arXiv:2604.19538 — Integrating anomaly detection into Agentic AI for proactive risk management in human activity.', true)
    RETURNING id INTO kb_id;
    INSERT INTO public.knowledge_documents (user_id, knowledge_base_id, name, content, is_sample, metadata)
    VALUES (NULL, kb_id, 'ADFM-AAI Paper Excerpt.md',
'# Integrating Anomaly Detection into Agentic AI for Proactive Risk Management in Human Activity

Authors: Farbod Zorriassatine, Ahmad Lotfi (Nottingham Trent University). arXiv:2604.19538 (2026).

## Abstract
Agentic AI offers goal-directed, proactive, autonomous decision-making and is well suited to addressing movement-related risks in human activity, especially falls among the elderly. Existing fall mitigation systems struggle with poor context awareness, high false alarm rates, environmental noise, and data scarcity. The authors argue that fall detection (FD) and fall prediction (FP) can be reformulated as anomaly detection (AD) problems and addressed more effectively by an Agentic AI system. They propose ADFM-AAI, a conceptual Agentic AI framework for fall mitigation.

## Six Core Capabilities of an Ideal Agentic AI System
1. Collaborative multi-agent architecture.
2. Continuous learning.
3. Adaptive goal decomposition and execution.
4. Advanced reasoning (planning, abstraction, problem-solving).
5. Orchestrated autonomy aligning local actions with global objectives.
6. Persistent memory enabling true autonomy and learning.

## Why Falls Matter
One in three older adults experiences a fall each year. Falls cause serious injuries, loss of independence, and high healthcare cost. Despite ML/AI fall-detection research, injury rates have not declined; some reports show increases. Existing solutions work in narrow contexts but fail to generalise across care pathways, partly due to limited explainability and trust.

## Anomaly Detection as the Right Frame
AD is a mature technique for spotting rare critical events. Cross-domain methods from cybersecurity, finance, healthcare, and manufacturing translate well to fall mitigation. Treating gait deviations, ADL changes, fatigue signals, or environmental hazards as anomalies enables proactive prevention rather than reactive detection.

## ADFM-AAI Framework
The proposed Fall Mitigation Agentic AI System maps the four consolidated capabilities — Perception & Data Acquisition, Reasoning & Planning, Action & Intervention, and Orchestration & Governance — to layers of specialised agents.

### Agent layers (Table I)
- Data Gathering: Data Preprocessing Agents, Ingestion Agents.
- Analysis & Prediction: Intelligent Feature Engineering, FM, Anomaly Detection.
- Action & Intervention: Triggering proactive non-urgent interventions, executing emergency protocols, Alerting Agents, IoT-device interaction.
- Orchestration: Agent supervision, Explainability (XAI), Human-Agent collaboration, Governance and Safety.
- Fall Mitigation specialists: FD, FP, pre-impact FD, FRA (Fall Risk Assessment).
- AD specialists: AD-Processor, AD-Model-Selector, AD-Info Miner, AD-Code Generator, AD-Reviewer, AD-Evaluator, Optimiser, concept-drift, data-imbalance.

## LLM as Shared Reasoning Service
LLMs collaborate with task agents to interpret sensor streams, narrate clinical context, and pick AD models dynamically. The framework draws on workflow templates such as AD-Agent (task parsing, model selection, knowledge retrieval, code synthesis and debugging, performance assessment, hyperparameter tuning).

## Why Static Configurations Fail
Static, rule-based pipelines cannot adapt to real-world complexity (varied homes, sensors, user behaviour). Agentic orchestration dynamically selects relevant tools and integrates them into adaptive workflows, enabling early identification of subtle deviations linked to age-related decline, fatigue, or environmental factors.

## Takeaway
Reframing fall detection / prediction as anomaly detection inside a multi-agent Agentic AI system addresses the long-standing problems of false alarms, context blindness, and data scarcity, and offers a path to widely deployable proactive risk management.
',
    true, '{"source":"arxiv:2604.19538","kind":"paper_excerpt"}'::jsonb);
  END IF;

  -- KB 3
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases WHERE is_sample = true AND name = 'Sample · Detecting Data Contamination in LLMs') THEN
    INSERT INTO public.knowledge_bases (user_id, name, description, is_sample)
    VALUES (NULL, 'Sample · Detecting Data Contamination in LLMs', 'arXiv:2604.19561 — Black-box Membership Inference Attacks on modern LLMs.', true)
    RETURNING id INTO kb_id;
    INSERT INTO public.knowledge_documents (user_id, knowledge_base_id, name, content, is_sample, metadata)
    VALUES (NULL, kb_id, 'MIA Paper Excerpt.md',
'# Detecting Data Contamination in Large Language Models

Authors: Juliusz Janicki, Evangelos Kanoulas (University of Amsterdam); Savvas Chamezopoulos, Georgios Tsatsaronis (Elsevier). arXiv:2604.19561 (2026).

## Abstract
LLMs train on massive corpora that may include copyrighted material, benchmark leakage, or PII. Membership Inference Attacks (MIAs) try to detect whether a document was part of training data. Black-box MIAs (which only see model outputs) are the most broadly applicable but the hardest to evaluate. This paper benchmarks state-of-the-art black-box MIAs under a unified dataset across modern LLMs, and introduces a new method called Familiarity Ranking. Headline result: no method reliably detects membership. AUC-ROC is around 0.5 for all methods on all evaluated LLMs. Newer models (GPT-4o, Claude 3.5 Sonnet, LLaMA 3.1) show both higher TPR and FPR — they reason and generalise too well, blurring the line between memorisation and reasoning.

## Why MIAs Matter
Training data may contain benchmark contamination, PII, and copyrighted novels, exposing model providers to lawsuits (e.g. NYT v OpenAI). Robust contamination detection underpins trust, compliance, and fair benchmarking.

## MIA Families
- White-box: use model weights.
- Gray-box: use logits/probabilities. Examples: Min-k%, Min-k%++, RECALL, CON-RECALL.
- Black-box: only output text. Most general, hardest to evaluate, hardest to compare across papers because each uses bespoke data manipulations.

Black-box methods typically pair a "hook" (a paper title, book name, or true prefix) that anchors the LLM''s answer scope, with a data manipulation (a corrupted suffix, a paraphrase, a multiple-choice distractor) that reveals memorisation when the model recovers the original.

## Methods Benchmarked
- DE-COP — multiple-choice with verbatim vs paraphrased options.
- Name Cloze Queries — mask named entities and ask the model to recover them.
- Prefix Probing — give the start, ask the model to continue.
- Familiarity Ranking (new) — ask the model to rank chunks by perceived familiarity with the named source.

## Datasets
Two unified evaluation sets sourced from RealTimeData: an arXiv split and a Wikipedia split. Each provides member and non-member chunks with consistent metadata so methods can be compared head-to-head.

## Models Evaluated
GPT-4o, GPT-4o-mini, GPT-3.5-Turbo, Claude 3.5 Sonnet, Claude 3 Haiku, LLaMA 3.1, Mixtral, Mistral — selected for varied release dates, training cutoffs, and providers.

## Findings
- Across all methods and models, AUC-ROC sits near 0.5 — no reliable membership signal.
- True positive and false positive rates both rise on stronger models, indicating that improved reasoning and generalisation make memorisation indistinguishable from inference.
- Recent LLMs appear to implement safeguards against verbatim copyrighted reproduction, further suppressing the signal.
- Familiarity Ranking gives the model more expressive freedom but does not surpass the 0.5 baseline.

## Implication
Black-box MIA is no longer a credible standalone tool for proving training-data inclusion in modern LLMs. Future work should combine gray-box / white-box signals, focus on rare verbatim leakage, or shift to legal-process disclosures rather than purely statistical attacks.
',
    true, '{"source":"arxiv:2604.19561","kind":"paper_excerpt"}'::jsonb);
  END IF;

  -- KB 4
  IF NOT EXISTS (SELECT 1 FROM public.knowledge_bases WHERE is_sample = true AND name = 'Sample · A-MAR: Agent-based Multimodal Art Retrieval') THEN
    INSERT INTO public.knowledge_bases (user_id, name, description, is_sample)
    VALUES (NULL, 'Sample · A-MAR: Agent-based Multimodal Art Retrieval', 'arXiv:2604.19689 — Reasoning-conditioned multimodal RAG for fine-grained artwork understanding.', true)
    RETURNING id INTO kb_id;
    INSERT INTO public.knowledge_documents (user_id, knowledge_base_id, name, content, is_sample, metadata)
    VALUES (NULL, kb_id, 'A-MAR Paper Excerpt.md',
'# A-MAR: Agent-based Multimodal Art Retrieval for Fine-Grained Artwork Understanding

Authors: Shuai Wang, Hongyi Zhu, Jia-Hong Huang, Yixian Shen, Chengxi Zeng, Stevan Rudinac, Monika Kackovic, Nachoem Wijnberg, Marcel Worring. ICMR ''26 / arXiv:2604.19689 (2026).

## Abstract
Understanding fine art requires multi-step reasoning across visual content and cultural, historical, and stylistic context. Multimodal LLMs answer art questions but rely on implicit reasoning and internalised (often hallucinated) knowledge, hurting interpretability and grounding. A-MAR is an Agent-based Multimodal Art Retrieval framework that explicitly conditions retrieval on a structured reasoning plan. Given an artwork and a query, an agentic planner first decomposes the task into reasoning steps that specify each step''s goal and required evidence. Retrieval is then guided by that plan, enabling targeted evidence selection and step-wise grounded explanations. The authors also release ArtCoT-QA, a benchmark of multi-step art reasoning chains with step-level grounding labels. Experiments on SemArt, Artpedia, and ArtCoT-QA show A-MAR outperforms static retrieval and strong MLLM baselines in explanation quality, evidence grounding, and multi-step reasoning.

## Motivation
Interpreting a Renaissance painting may require: (1) identifying motifs, (2) linking them to religious or philosophical symbolism, (3) positioning them in historical narratives. Each step needs a different kind of evidence in a specific order. Static single-shot RAG retrieves once for the whole question, mixing relevant and irrelevant context, and gives the generator no signal about when to use which evidence.

## A-MAR Architecture
1. Multimodal input: user query q, artwork image i, artwork metadata m.
2. Agent-based planner produces:
   - A reasoning plan r1 ... rt (e.g. identify motif → link context → interpret meaning).
   - A retrieval intent — a structured representation of evidence requirements (e.g. {visual motifs, artist background, historical knowledge}). The intent is not a paraphrase of the question; it is the planner''s explicit evidence spec.
3. Reasoning-conditioned retrieval fetches multimodal evidence guided by the retrieval intent.
4. Evidence-grounded generation produces a step-wise explanation that follows the reasoning plan, citing retrieved evidence per step.

The retrieved context is shared across reasoning steps rather than pre-segmented; the plan governs how the generator composes evidence. This decouples what is retrieved from how it is used, enabling fine-grained analysis of grounding and reasoning faithfulness.

## ArtCoT-QA Benchmark
A diagnostic benchmark of interpretive artwork questions with annotated multi-step reasoning chains and step-level grounding labels. Designed for evaluation that goes beyond final-answer accuracy, measuring whether each reasoning step is supported by retrieved evidence.

## Experiments
- Datasets: SemArt and Artpedia for explanation quality (comparable to prior work); ArtCoT-QA for reasoning-intensive evaluation.
- Backbones: Claude-4.5-Haiku and Mistral-large-3.
- Metrics: BLEU-1..4, METEOR, SPICE, ROUGE-L, CLIP score, plus step-level grounding accuracy on ArtCoT-QA.

### Research Questions
- RQ1: Does agent-based multimodal retrieval improve overall explanation quality? Yes — A-MAR consistently beats static ArtRAG.
- RQ2: Does it improve grounding and multi-step reasoning? Yes, with higher step-level grounding accuracy.
- RQ3: How much of the win comes from reasoning-aware planning? Ablations fixing the backbone and varying only the planning strategy show the planner is the key contributor.
- RQ4: Qualitative analysis shows A-MAR retrieves targeted contextual knowledge per step where static RAG retrieves generic context.

## Takeaway
For knowledge-intensive multimodal tasks like art understanding, conditioning retrieval on an explicit reasoning plan beats one-shot RAG and pure-MLLM baselines. A-MAR is a step toward interpretable, goal-driven AI systems with concrete relevance to cultural-industry applications.
',
    true, '{"source":"arxiv:2604.19689","kind":"paper_excerpt"}'::jsonb);
  END IF;
END $$;