import { AI_API_URL, APP_NAME } from "./config.js?v=20261019-v5.14";
import { prettify } from "./models.js?v=20261019-v5.14";
import { localModelStream } from "./local-ai.js?v=20261019-v5.14";

const WORKER_MODEL_TIMEOUT_MS = 15000;
const SETTINGS_KEY = "myai_settings";
const LEGACY_DEFAULT_SYSTEM_PROMPT = "Kamu adalah asisten AI yang ramah, cerdas, dan membantu. Berkomunikasilah secara natural, hangat, dan relevan seperti teman bicara yang baik; pahami konteks percakapan sebelumnya dan tanyakan klarifikasi hanya bila memang diperlukan. Jawab dalam bahasa yang dipakai pengguna. Gunakan Markdown untuk format, dan tulis rumus matematika dengan LaTeX ($...$ atau $$...$$).";
export const DEFAULT_SETTINGS = {
  showPaid: false,
  systemPrompt: "Jawablah secara ramah, jelas, dan natural. Utamakan jawaban yang sesuai kebutuhan pengguna.",
  temperature: 0.7,
  about: "",
  enterToSend: true,
  autoSpeak: false,
};

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      if (Object.prototype.hasOwnProperty.call(saved, "apiKeys")) {
        const cleaned = { ...saved };
        delete cleaned.apiKeys;
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(cleaned));
        } catch (error) {
          console.warn("Legacy browser API keys could not be removed from local storage.", error);
        }
      }
      return {
        ...DEFAULT_SETTINGS,
        showPaid: saved.showPaid === true,
        systemPrompt: typeof saved.systemPrompt === "string" && saved.systemPrompt !== LEGACY_DEFAULT_SYSTEM_PROMPT
          ? saved.systemPrompt
          : DEFAULT_SETTINGS.systemPrompt,
        temperature: Number.isFinite(Number(saved.temperature)) ? Math.min(1.5, Math.max(0, Number(saved.temperature))) : DEFAULT_SETTINGS.temperature,
        about: typeof saved.about === "string" ? saved.about.slice(0, 1500) : "",
        enterToSend: saved.enterToSend !== false,
        autoSpeak: saved.autoSpeak === true,
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    showPaid: s.showPaid === true,
    systemPrompt: s.systemPrompt,
    temperature: s.temperature,
    about: s.about || "",
    enterToSend: s.enterToSend !== false,
    autoSpeak: s.autoSpeak === true,
  }));
}

const GUEST_CHAR_BUDGET = 5800;
let guestModelsPromise = null;

export function invalidateGuestModels() {
  guestModelsPromise = null;
}

// Worker guest menolak >8 pesan, >6000 karakter total, atau >1 gambar.
function fitGuestMessages(messages) {
  const chatOnly = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const fitted = [];
  let used = 0;
  let imageUsed = false;
  for (let index = chatOnly.length - 1; index >= 0 && fitted.length < 8; index -= 1) {
    const message = chatOnly[index];
    const remaining = GUEST_CHAR_BUDGET - used;
    if (remaining < 200 && fitted.length) break;
    let content = String(message.content || "");
    if (content.length > remaining) {
      content = message.role === "user" && !fitted.length
        ? content.slice(0, Math.max(0, remaining - 60)) + "\n\n[...dipotong karena batas AI guest]"
        : "";
    }
    if (!content) break;
    const next = { role: message.role, content };
    if (!imageUsed && message.images?.length) {
      next.images = [message.images[0]];
      imageUsed = true;
    }
    used += content.length;
    fitted.unshift(next);
  }
  while (fitted.length && fitted[0].role !== "user") fitted.shift();
  return fitted;
}

async function errorText(res) {
  const raw = await res.text();
  try {
    const j = JSON.parse(raw);
    return `${res.status}: ${j.error?.message || j.message || raw}`;
  } catch {
    return `${res.status}: ${raw.slice(0, 300)}`;
  }
}

async function* readSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const parseLine = (line) => {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return { done: true };
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buf += decoder.decode();
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const event = parseLine(line);
      if (event?.done) return;
      if (event) yield event;
    }
  }
  const event = parseLine(buf.trim());
  if (event && !event.done) yield event;
}

// ---------- OpenAI-compatible (OpenRouter, Groq) ----------

async function* openAIStream(url, key, model, messages, opts, signal, extraHeaders = {}) {
  const openAIMessages = messages.map(({ images, ...message }) => images?.length
    ? { ...message, content: [{ type: "text", text: message.content }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] }
    : message);
  const post = (extra) => {
    const headers = { "Content-Type": "application/json", ...extraHeaders };
    if (key) headers.Authorization = `Bearer ${key}`;
    return fetch(url, {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model,
        messages: openAIMessages,
        stream: true,
        temperature: opts.temperature,
        ...(opts.webSearch && url.includes("openrouter.ai") ? { plugins: [{ id: "web", max_results: opts.researchMode ? 10 : 5 }] } : {}),
        ...extra,
      }),
    });
  };
  let res = await post();
  if (res.status === 429 || res.status === 413) {
    const msg = await errorText(res);
    // Tier gratis Groq membatasi token output per menit; ulangi dengan max_tokens di bawah batas itu.
    const limit = Number(msg.match(/output tokens per minute[^]*?Limit (\d+)/i)?.[1]);
    if (!limit) throw new Error(msg);
    res = await post({ max_tokens: Math.floor(limit * 0.9) });
  }
  if (!res.ok) throw new Error(await errorText(res));
  for await (const j of readSSE(res)) {
    if (j.error) throw new Error(j.error.message || "Error dari server");
    const annotations = j.choices?.[0]?.delta?.annotations || j.choices?.[0]?.message?.annotations || [];
    for (const annotation of annotations) {
      if (annotation.type === "url_citation" && annotation.url_citation?.url) {
        yield { citation: { url: annotation.url_citation.url, title: annotation.url_citation.title } };
      }
    }
    const d = j.choices?.[0]?.delta;
    if (d?.reasoning) yield { reasoning: d.reasoning };
    if (d?.content) yield { content: d.content };
  }
}

async function catalogFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request katalog melewati batas waktu 12 detik.");
    if (error instanceof TypeError) throw new Error("Tidak bisa menghubungi API katalog (periksa koneksi atau CORS).");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listOpenRouter() {
  const res = await catalogFetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error("OpenRouter: " + await errorText(res));
  const { data = [] } = await res.json();
  const free = [];
  const paid = [];
  for (const model of data) {
    const modalities = model.architecture?.output_modalities || ["text"];
    if (modalities.some((modality) => modality !== "text") || /safety|guard|:batch/i.test(model.id)) continue;
    const pricing = model.pricing && typeof model.pricing === "object" ? Object.values(model.pricing) : [];
    const isValidPrice = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0)
      || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0);
    const hasVerifiedPrice = pricing.length > 0 && pricing.every(isValidPrice);
    const isFree = hasVerifiedPrice && pricing.every((value) => Number(value) === 0);
    const hasPaidPrice = pricing.some((value) => Number.isFinite(Number(value)) && Number(value) > 0);
    const item = {
      id: model.id,
      name: (model.name || model.id).replace(/^[^:]+:\s*/, "").replace(/\s*\(free\)$/i, ""),
      priceTier: isFree ? "free" : "premium",
    };
    if (isFree) free.push(item);
    else if (hasPaidPrice || !hasVerifiedPrice) paid.push(item);
  }
  return { free, paid };
}

async function listOpenRouterImageModels() {
  const res = await catalogFetch("https://openrouter.ai/api/v1/images/models");
  if (!res.ok) throw new Error("OpenRouter Image: " + await errorText(res));
  const { data = [] } = await res.json();
  return data
    .filter((model) => model.id && model.architecture?.output_modalities?.includes("image"))
    .map((model) => ({ id: model.id, name: model.name || model.id }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listGroq(key) {
  const res = await catalogFetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error("Groq: " + await errorText(res));
  const { data = [] } = await res.json();
  return data
    .filter((model) => !/whisper|tts|guard|playai|orpheus/i.test(model.id))
    .map((model) => ({ id: model.id, name: prettify(model.id) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function listGemini(key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`;
  const res = await catalogFetch(url);
  if (!res.ok) throw new Error("Gemini: " + await errorText(res));
  const { models = [] } = await res.json();
  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .filter((model) => /gemini|gemma/i.test(model.name) && !/tts|image|embedding|live|native-audio|robotics|computer-use/i.test(model.name))
    .map((model) => ({ id: model.name.replace(/^models\//, ""), name: model.displayName || prettify(model.name) }))
    .sort((left, right) => right.id.localeCompare(left.id));
}

// ---------- Google Gemini ----------

async function* geminiStream(key, model, messages, opts, signal) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        { text: m.content },
        ...(m.images || []).map((image) => {
          const [, mimeType, data] = image.match(/^data:([^;]+);base64,(.+)$/) || [];
          if (!mimeType || !data) throw new Error("Format gambar tidak valid.");
          return { inlineData: { mimeType, data } };
        }),
      ],
    }));
  const body = {
    contents,
    generationConfig: { temperature: opts.temperature },
    ...(opts.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const cited = new Set();
  for await (const j of readSSE(res)) {
    for (const part of j.candidates?.[0]?.content?.parts || []) {
      if (!part.text) continue;
      if (part.thought) yield { reasoning: part.text };
      else yield { content: part.text };
    }
    for (const source of j.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
      if (source.web?.uri && !cited.has(source.web.uri)) {
        cited.add(source.web.uri);
        yield { citation: { url: source.web.uri, title: source.web.title } };
      }
    }
  }
}

async function* geminiImageStream(key, messages, opts, signal) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: message.content },
      ...(message.images || []).map((image) => {
        const [, mimeType, data] = image.match(/^data:([^;]+);base64,(.+)$/) || [];
        if (!mimeType || !data) throw new Error("Format gambar referensi tidak valid.");
        return { inlineData: { mimeType, data } };
      }),
    ],
  }));
  const body = {
    contents,
    generationConfig: {
      temperature: opts.temperature,
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=" + encodeURIComponent(key), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const result = await res.json();
  let hasImage = false;
  for (const part of result.candidates?.[0]?.content?.parts || []) {
    if (part.text) yield { content: part.text };
    if (part.inlineData?.data) {
      hasImage = true;
      yield { image: `data:${part.inlineData.mimeType || "image/png"};base64,${part.inlineData.data}` };
    }
  }
  if (!hasImage) throw new Error("Gemini tidak mengembalikan gambar. Coba ubah prompt atau periksa akses model image.");
}

async function* openRouterImageStream(key, model, messages, opts, signal) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const userMessages = messages.filter((message) => message.role === "user");
  const prompt = [system, ...userMessages.map((message) => message.content)].filter(Boolean).join("\n\n");
  const references = userMessages.flatMap((message) => message.images || []).map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  const res = await fetch("https://openrouter.ai/api/v1/images", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": location.origin,
      "X-Title": APP_NAME,
    },
    body: JSON.stringify({
      model,
      prompt,
      output_format: "png",
      ...(references.length ? { input_references: references } : {}),
    }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const result = await res.json();
  let hasImage = false;
  for (const item of result.data || []) {
    if (item.b64_json) {
      hasImage = true;
      yield { image: `data:${item.media_type || "image/png"};base64,${item.b64_json}` };
    } else if (item.url && /^https?:\/\//i.test(item.url)) {
      hasImage = true;
      yield { image: item.url };
    }
  }
  if (!hasImage) throw new Error("OpenRouter tidak mengembalikan gambar. Coba model lain atau periksa dukungan akun.");
}

export async function listManualModels(apiKeys) {
  const definitions = [
    { id: "gemini", label: "Gemini", load: listGemini },
    { id: "groq", label: "Groq", load: listGroq },
    { id: "openrouter", label: "OpenRouter", load: async () => {
      const catalog = await listOpenRouter();
      return [...catalog.free, ...catalog.paid];
    } },
  ].filter((provider) => apiKeys?.[provider.id]);
  const results = await Promise.allSettled(definitions.map(async (provider) => ({
    provider: `manual-${provider.id}`,
    label: `${provider.label} · key akun`,
    tag: "Key tersimpan di akun Google · biaya/kuota provider berlaku",
    models: (await provider.load(apiKeys[provider.id])).map((model) => ({
      ...model,
      priceTier: provider.id === "openrouter"
        ? model.priceTier
        : "check",
    })),
  })));
  const groups = [];
  const errors = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value.models.length) groups.push(result.value);
      else errors.push(`${definitions[index].label}: tidak ada model yang tersedia.`);
    } else {
      errors.push(`${definitions[index].label}: ${result.reason?.message || "gagal memuat model."}`);
    }
  });
  return { groups, errors };
}

export async function listServerModels(authToken, { includeCatalog = false } = {}) {
  if (!AI_API_URL) throw new Error("URL API Cloudflare Pages belum diatur di js/config.js.");
  if (!authToken) throw new Error("Masuk dengan Google untuk memuat API AI server.");
  const apiBase = AI_API_URL.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${apiBase}/models`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ includeCatalog }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Koneksi ke API Cloudflare Pages melewati batas 15 detik. Coba muat ulang dan periksa status Pages.");
    }
    if (error instanceof TypeError) {
      throw new Error("API Cloudflare Pages tidak dapat dijangkau (DNS, koneksi, atau CORS). Periksa koneksi dan status website.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(await errorText(response));
  const result = await response.json();
  if (!Array.isArray(result.providers) || !Array.isArray(result.groups) || !Array.isArray(result.errors)) {
    throw new Error("Respons katalog dari Cloudflare Worker tidak valid.");
  }
  return result;
}

export async function listGuestModels() {
  if (guestModelsPromise) return guestModelsPromise;
  const apiBase = AI_API_URL.replace(/\/+$/, "");
  guestModelsPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WORKER_MODEL_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(`${apiBase}/guest/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Katalog AI guest melewati batas waktu 15 detik.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(await errorText(response));
    const result = await response.json();
    if (!Array.isArray(result.groups) || !Number.isInteger(result.remaining) || result.remaining < 0 || result.remaining > 2) {
      throw new Error("Katalog AI guest tidak valid.");
    }
    return { groups: result.groups, remaining: result.remaining, errors: [] };
  })();
  try {
    return await guestModelsPromise;
  } catch (error) {
    guestModelsPromise = null;
    throw error;
  }
}

async function* guestStream(model, messages, opts, signal) {
  const apiBase = AI_API_URL.replace(/\/+$/, "");
  const body = JSON.stringify({
    model,
    messages: fitGuestMessages(messages),
    temperature: Math.min(0.7, opts.temperature),
  });
  if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) {
    throw new Error("Prompt AI guest terlalu besar. Ringkas teks atau kurangi gambar.");
  }
  const response = await fetch(`${apiBase}/guest/chat`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(await errorText(response));
  const remaining = Number(response.headers.get("X-Guest-Remaining"));
  if (Number.isInteger(remaining) && remaining >= 0 && remaining <= 2) {
    yield {
      guestRemaining: remaining,
      ...(remaining === 0 ? { notice: "Jatah dua jawaban AI gratis tanpa login sudah digunakan. Masuk dengan Google untuk melanjutkan." } : {}),
    };
  }
  for await (const chunk of readSSE(response)) {
    if (chunk.error) throw new Error(chunk.error.message || "AI guest gagal menjawab.");
    if (chunk.content) {
      yield { content: chunk.content };
      continue;
    }
    const geminiParts = chunk.candidates?.[0]?.content?.parts || [];
    if (geminiParts.length) {
      for (const part of geminiParts) {
        if (part.text) yield part.thought ? { reasoning: part.text } : { content: part.text };
      }
      continue;
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning) yield { reasoning: delta.reasoning };
    const content = delta?.content;
    if (typeof content === "string") yield { content };
    else if (Array.isArray(content)) {
      const text = content.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text).join("");
      if (text) yield { content: text };
    }
  }
}

function pollinationsSize(prompt) {
  if (/\b(landscape|lanskap|wide|lebar|banner|wallpaper desktop|16:9|pemandangan)\b/i.test(prompt)) return [1344, 768];
  if (/\b(portrait|potret|vertikal|vertical|poster|story|9:16|wallpaper hp)\b/i.test(prompt)) return [768, 1344];
  return [1024, 1024];
}

async function* pollinationsStream(model, messages, signal) {
  const prompt = String([...messages].reverse().find((message) => message.role === "user")?.content || "").trim().slice(0, 1500);
  if (!prompt) throw new Error("Tulis deskripsi gambar terlebih dahulu.");
  const [width, height] = pollinationsSize(prompt);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&model=${encodeURIComponent(model)}&nologo=true&enhance=true&seed=${seed}`;
  // Muat dulu agar error terdeteksi sebelum gambar ditampilkan.
  await new Promise((resolve, reject) => {
    const image = new Image();
    const onAbort = () => {
      image.src = "";
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    image.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Layanan gambar gratis sedang sibuk atau prompt ditolak. Coba lagi beberapa saat."));
    };
    image.src = url;
  });
  yield { image: url };
  yield { content: `Gambar dibuat dari prompt: *${prompt.replace(/[*_`]/g, "")}*` };
}

export function streamChat(provider, model, messages, opts, signal) {
  if (provider === "local-webgpu") return localModelStream(messages, opts, signal);
  if (provider === "pollinations") return pollinationsStream(model, messages, signal);
  if (provider === "guest") return guestStream(model, messages, opts, signal);
  if (provider === "manual-gemini-image") {
    if (!opts.manualApiKeys?.gemini) throw new Error("API key Gemini tidak ditemukan di akun ini.");
    return geminiImageStream(opts.manualApiKeys.gemini, messages, opts, signal);
  }
  if (provider.startsWith("manual-")) {
    const manualProvider = provider.slice("manual-".length);
    const key = opts.manualApiKeys?.[manualProvider];
    if (!key) throw new Error(`API key ${manualProvider} tidak ditemukan di akun ini.`);
    if (manualProvider === "gemini") return geminiStream(key, model, messages, opts, signal);
    const endpoints = {
      groq: "https://api.groq.com/openai/v1/chat/completions",
      openrouter: "https://openrouter.ai/api/v1/chat/completions",
    };
    const endpoint = endpoints[manualProvider];
    if (!endpoint) throw new Error("Provider API manual tidak didukung.");
    const headers = manualProvider === "openrouter"
      ? { "HTTP-Referer": location.origin, "X-Title": APP_NAME }
      : {};
    return openAIStream(endpoint, key, model, messages, opts, signal, headers);
  }
  return serverStream(provider, model, messages, opts, signal);
}

async function* serverStream(provider, model, messages, opts, signal) {
  if (!AI_API_URL) throw new Error("URL API Cloudflare Pages belum diatur di js/config.js.");
  if (!opts.authToken) throw new Error("Masuk dengan Google untuk memakai API AI server.");
  const body = JSON.stringify({
    provider,
    model,
    messages,
    temperature: opts.temperature,
    webSearch: opts.webSearch,
    researchMode: opts.researchMode,
    imageGeneration: opts.imageGeneration,
  });
  if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) {
    throw new Error("Permintaan online maksimal 4 MiB. Hapus beberapa lampiran atau lanjutkan chat baru.");
  }
  const apiBase = AI_API_URL.replace(/\/+$/, "");
  const response = await fetch(`${apiBase}/chat`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${opts.authToken}`,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok) throw new Error(await errorText(response));

  if (opts.imageGeneration) {
    const result = await response.json();
    let hasImage = false;
    for (const item of result.data || []) {
      if (item.b64_json) {
        hasImage = true;
        yield { image: `data:${item.media_type || "image/png"};base64,${item.b64_json}` };
      } else if (item.url && /^https?:\/\//i.test(item.url)) {
        hasImage = true;
        yield { image: item.url };
      }
    }
    if (!hasImage) throw new Error("OpenRouter tidak mengembalikan gambar. Coba model lain atau periksa akses akun.");
    return;
  }

  if (provider === "modelscope") {
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("ModelScope tidak mengembalikan teks jawaban yang valid.");
    }
    yield { content };
    return;
  }

  if (!response.body) throw new Error("Backend AI tidak mengembalikan aliran jawaban.");
  if (provider === "gemini") {
    const cited = new Set();
    for await (const result of readSSE(response)) {
      for (const part of result.candidates?.[0]?.content?.parts || []) {
        if (!part.text) continue;
        if (part.thought) yield { reasoning: part.text };
        else yield { content: part.text };
      }
      for (const source of result.candidates?.[0]?.groundingMetadata?.groundingChunks || []) {
        if (source.web?.uri && !cited.has(source.web.uri)) {
          cited.add(source.web.uri);
          yield { citation: { url: source.web.uri, title: source.web.title } };
        }
      }
    }
    return;
  }

  for await (const result of readSSE(response)) {
    if (result.error) throw new Error(result.error.message || "Error dari server provider.");
    const annotations = result.choices?.[0]?.delta?.annotations || result.choices?.[0]?.message?.annotations || [];
    for (const annotation of annotations) {
      if (annotation.type === "url_citation" && annotation.url_citation?.url) {
        yield {
          citation: {
            url: annotation.url_citation.url,
            title: annotation.url_citation.title,
          },
        };
      }
    }
    const delta = result.choices?.[0]?.delta;
    if (delta?.reasoning) yield { reasoning: delta.reasoning };
    if (delta?.content) yield { content: delta.content };
  }
}
