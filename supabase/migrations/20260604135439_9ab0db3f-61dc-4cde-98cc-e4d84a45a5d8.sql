
INSERT INTO public.knowledge_bases (id, user_id, name, description, is_sample)
VALUES (
  'c0ffee00-0000-4000-8000-000000000001',
  NULL,
  'Sample · Notebook RAG Lab',
  'Read-only documents used by the platform RAG notebooks (Basic Document RAG, Embeddings/RAG, Semantic Chunking). Demonstrates the full pipeline: source doc -> chunk -> embed -> retrieve -> generate.',
  true
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.knowledge_documents (id, knowledge_base_id, user_id, name, content, is_sample, metadata)
VALUES (
  'c0ffee00-0000-4000-8000-00000000d001',
  'c0ffee00-0000-4000-8000-000000000001',
  NULL,
  'LangChain Ecosystem Primer.md',
  E'# The LangChain Ecosystem\n\n## LangChain\nLangChain is an open-source framework for building applications powered by large language models. Its core abstractions are the Runnable (any composable step in a chain), the ChatModel (a typed wrapper over chat completion APIs), the Tool (a callable a model can invoke), and the PromptTemplate (a typed, variable-interpolated prompt). Runnables compose with the pipe operator into LangChain Expression Language (LCEL) chains.\n\n## LangGraph\nLangGraph is a companion library for stateful, multi-actor workflows. It models agents as graphs whose nodes mutate a typed shared state and whose edges decide what runs next. LangGraph supports checkpointing - every state transition is persisted, so a workflow can be resumed after a crash or paused for human approval through interruptBefore. This makes it the canonical choice for production agents that need durability, human-in-the-loop review, or branching control flow.\n\n## Retrieval-Augmented Generation (RAG)\nRetrieval-Augmented Generation combines a retriever over a vector database with an LLM. The retriever embeds the user query, performs nearest-neighbour search against pre-embedded document chunks, and returns the top-k matches. Those chunks are inserted into the prompt as context, so the model answers from grounded source material rather than parametric memory. RAG is the standard mitigation for hallucinations and the standard way to give an LLM access to private or recent data without fine-tuning.\n\n## Embeddings\nText embeddings map natural language into a high-dimensional vector space where semantic similarity corresponds to vector distance. Modern embedding models (OpenAI text-embedding-3, Google gemini-embedding-001) output 1536- or 3072-dimensional vectors. Cosine distance is the standard similarity metric - values near 0 mean nearly identical meaning, values near 1 mean unrelated. Embeddings are the foundation of vector search, clustering, deduplication, and recommendation.\n\n## Chunking\nBefore embedding, long documents are split into chunks. The chunk size controls a tradeoff: small chunks give precise retrieval but lose surrounding context; large chunks give richer context but dilute the embedding signal. Common strategies are fixed-size (every N characters), recursive (paragraph -> sentence -> character), and semantic (cut where adjacent-sentence embedding distance spikes). Overlap of 10-20% between adjacent chunks helps preserve context across cut points.',
  true,
  '{"source": "notebook-rag-lab"}'::jsonb
), (
  'c0ffee00-0000-4000-8000-00000000d002',
  'c0ffee00-0000-4000-8000-000000000001',
  NULL,
  'Eiffel Tower - Encyclopedia Entry.md',
  E'# The Eiffel Tower\n\nThe Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower between 1887 and 1889 as the entrance arch to the 1889 World Fair.\n\n## Reception\nWhen first unveiled the tower was sharply criticised by some of France leading artists and intellectuals for its industrial appearance. Over the following decades it became a global cultural icon of France and one of the most recognisable structures in the world.\n\n## Dimensions\nThe tower is 330 metres tall - roughly the height of an 81-storey building - and remains the tallest structure in Paris. Its base is square, measuring 125 metres on each side. The puddled-iron framework weighs approximately 7,300 tonnes; with elevators, shops, and antennae the total mass is around 10,100 tonnes.\n\n## Records\nDuring its construction the Eiffel Tower surpassed the Washington Monument to become the tallest man-made structure in the world, a title it held for 41 years until the Chrysler Building in New York City was completed in 1930. It receives roughly seven million visitors per year, making it the most-visited paid monument on Earth.\n\n## Engineering\nThe tower pyramidal silhouette is not decorative - Eiffel derived the exact curvature from the differential equation for a structure where wind force at every height equals the moment about any point below. The result is a shape that channels wind loads efficiently into the four masonry pier foundations rather than racking the lattice.',
  true,
  '{"source": "notebook-rag-lab"}'::jsonb
), (
  'c0ffee00-0000-4000-8000-00000000d003',
  'c0ffee00-0000-4000-8000-000000000001',
  NULL,
  'Three Topics Essay.md',
  E'The Roman aqueducts are among the most enduring achievements of classical engineering. They carried water across vast distances using only gravity and precisely calculated gradients. Some still function in fragments today, two millennia after their construction. The engineering principles behind them remained the basis of European hydraulics until the industrial revolution.\n\nPhotosynthesis is the process by which plants convert sunlight into chemical energy. Chlorophyll molecules absorb photons in the red and blue parts of the spectrum, reflecting green. The captured energy splits water molecules and reduces carbon dioxide into glucose. Without this single biochemical pathway, almost all macroscopic life on Earth would collapse within weeks.\n\nJazz emerged in New Orleans at the turn of the twentieth century from a confluence of blues, ragtime, and brass-band traditions. Early players improvised collectively rather than around a single soloist. The form spread up the Mississippi to Chicago and then to New York, where it acquired the harmonic sophistication of swing and bebop. Today jazz is studied in conservatories worldwide as one of the great American art forms.',
  true,
  '{"source": "notebook-rag-lab"}'::jsonb
) ON CONFLICT (id) DO NOTHING;
