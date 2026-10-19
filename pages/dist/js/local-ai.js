const WEBLLM_URL = "https://esm.run/@mlc-ai/web-llm@0.2.86";
const MODEL_ID = "Qwen2.5-3B-Instruct-q4f16_1-MLC";
const MAX_TOKENS = 512;

let enginePromise = null;

async function loadEngine(onProgress) {
  if (!navigator.gpu) {
    throw new Error("AI offline memerlukan browser dengan WebGPU, misalnya Chrome terbaru, dan perangkat yang kompatibel.");
  }
  const webllm = await import(WEBLLM_URL);
  const availableModel = webllm.prebuiltAppConfig.model_list.some((model) => model.model_id === MODEL_ID);
  if (!availableModel) throw new Error("Model offline MyAI tidak ada di runtime WebLLM yang dimuat.");
  return webllm.CreateMLCEngine(MODEL_ID, {
    context_window_size: 4096,
    initProgressCallback: (progress) => {
      if (typeof progress?.text === "string") {
        onProgress?.({ progress: Number(progress.progress) || 0, text: progress.text });
      }
    },
  });
}

async function getEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = loadEngine(onProgress).catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

export async function* localModelStream(messages, opts, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const engine = await getEngine(opts.onProgress);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const request = await engine.chat.completions.create({
    messages: messages
      .filter((message) => ["system", "user", "assistant"].includes(message.role))
      .map(({ role, content }) => ({ role, content: String(content || "") })),
    stream: true,
    temperature: Math.min(1, Math.max(0, Number(opts.temperature) || 0.7)),
    max_tokens: MAX_TOKENS,
  });
  const abortGeneration = () => engine.interruptGenerate();
  signal?.addEventListener("abort", abortGeneration, { once: true });
  try {
    for await (const chunk of request) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const text = chunk.choices?.[0]?.delta?.content;
      if (typeof text === "string" && text) yield { content: text };
    }
  } finally {
    signal?.removeEventListener("abort", abortGeneration);
  }
}

export const LOCAL_MODEL_ID = MODEL_ID;
