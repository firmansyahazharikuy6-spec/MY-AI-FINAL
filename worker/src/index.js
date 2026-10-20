const PROVIDERS = ["openrouter", "gemini", "groq"];
const OPENAI_ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
};
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CATALOG_TTL_MS = 60 * 1000;
const REQUEST_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const GUEST_MAX_OUTPUT_TOKENS = 512;
const GUEST_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const GUEST_MAX_IMAGE_CHARS = 1_500_000;
const GUEST_TRIAL_LIMIT = 2;
const MONID_API_BASE = "https://api.monid.ai/v1";
const FREE_GEMINI_MODEL_IDS = new Set([
  "gemini-3.8-flash",
]);
const FREE_GROQ_MODEL_IDS = new Set(["qwen/qwen3-32b"]);
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Expose-Headers": "X-Guest-Remaining",
  "Access-Control-Max-Age": "86400",
};

let cachedJwks = null;
let cachedJwksExpiry = 0;
let importedKeys = new Map();
let cachedOpenRouterModels = null;
let cachedOpenRouterModelsExpiry = 0;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function enforceGuestRateLimit(request, env) {
  if (!env.GUEST_AI_LIMITER) {
    throw new HttpError(503, "AI guest belum diaktifkan. Admin perlu deploy binding rate limit Worker.");
  }
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) throw new HttpError(503, "AI guest tidak tersedia pada jaringan ini.");
  const { success } = await env.GUEST_AI_LIMITER.limit({ key: `guest:${ip}` });
  if (!success) throw new HttpError(429, "Batas AI guest tercapai. Coba lagi setelah satu menit.");
}

async function guestTrialCounter(request, env, action) {
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip || !env.GUEST_TRIAL_COUNTER) {
    throw new HttpError(503, "Batas uji coba guest belum dikonfigurasi di Cloudflare Worker.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const name = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = env.GUEST_TRIAL_COUNTER.idFromName(name);
  const stub = env.GUEST_TRIAL_COUNTER.get(id);
  const response = await stub.fetch(`https://guest-trial.internal/${action}`, { method: "POST" });
  if (!response.ok) throw new HttpError(503, "Batas uji coba guest tidak dapat diperiksa. Coba lagi nanti.");
  return response.json();
}

function guestModelsForKeys(keys, freeOpenRouterModels = []) {
  const models = [];
  if (keys.gemini) {
    for (const id of FREE_GEMINI_MODEL_IDS) {
      models.push({ id: `gemini::${id}`, name: "Gemini Flash", priceTier: "free", imageSupport: true });
    }
  }
  if (keys.groq) {
    for (const id of FREE_GROQ_MODEL_IDS) {
      models.push({ id: `groq::${id}`, name: "Qwen3 32B · Groq", priceTier: "free" });
    }
  }
  if (keys.openrouter) {
    const preferredFamilies = [
      /nvidia|nemotron/i,
      /qwen/i,
      /deepseek/i,
      /llama|meta/i,
      /gemma|google/i,
      /mistral/i,
      /phi|microsoft/i,
    ];
    const selected = [];
    const seen = new Set();
    for (const pattern of preferredFamilies) {
      const model = freeOpenRouterModels.find((item) => pattern.test(`${item.id} ${item.name}`) && !seen.has(item.id));
      if (model) {
        selected.push(model);
        seen.add(model.id);
      }
    }
    for (const model of freeOpenRouterModels) {
      if (selected.length >= 10) break;
      if (!seen.has(model.id)) {
        selected.push(model);
        seen.add(model.id);
      }
    }
    models.push(...selected.map((model) => ({
      id: `openrouter::${model.id}`,
      name: model.name,
      priceTier: "free",
    })));
  }
  return models;
}

async function getGuestModels(request, env, keys) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk memuat model guest.");
  const trial = await guestTrialCounter(request, env, "status");
  let openRouterReady = false;
  let freeOpenRouterModels = [];
  if (keys.openrouter) {
    try {
      freeOpenRouterModels = await listOpenRouterModels();
      openRouterReady = freeOpenRouterModels.length > 0;
    } catch (error) {
      console.warn("Guest OpenRouter catalog unavailable:", error?.name || "Error");
    }
  }
  const models = guestModelsForKeys(keys, openRouterReady ? freeOpenRouterModels : []);
  if (!models.length) return jsonResponse({ groups: [], remaining: trial.remaining });
  return jsonResponse({
    remaining: trial.remaining,
    groups: [{
      provider: "guest",
      label: "Model gratis · guest",
      tag: "Dua jawaban guest per alamat IP · model gratis terverifikasi",
      models,
    }],
  });
}

async function guestChat(request, env, keys) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk mengirim chat guest.");
  const body = await readJsonBody(request);
  const separator = typeof body.model === "string" ? body.model.indexOf("::") : -1;
  let selectedProvider = separator > 0 ? body.model.slice(0, separator) : "";
  let selectedModel = separator > 0 ? body.model.slice(separator + 2) : "";
  if (body.model === "guest-general") {
    if (keys.gemini) {
      selectedProvider = "gemini";
      selectedModel = [...FREE_GEMINI_MODEL_IDS][0];
    } else if (keys.groq) {
      selectedProvider = "groq";
      selectedModel = [...FREE_GROQ_MODEL_IDS][0];
    } else if (keys.openrouter) {
      const freeModels = await listOpenRouterModels();
      selectedProvider = "openrouter";
      selectedModel = freeModels[0]?.id || "";
    }

  }
  if (!["gemini", "groq", "openrouter"].includes(selectedProvider)
    || !selectedModel || selectedModel.length > 300
    || !Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, "Permintaan AI guest tidak valid.");
  }
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > GUEST_MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Permintaan guest terlalu besar. Kurangi teks atau gambar.");
  }
  const messages = body.messages
    .filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
    .slice(-8);
  if (!messages.some((message) => message.role === "user")) {
    throw new HttpError(400, "Permintaan AI guest perlu berisi pesan pengguna.");
  }
  if (messages.reduce((total, message) => total + message.content.length, 0) > 6000) {
    throw new HttpError(413, "Teks AI guest dibatasi 6.000 karakter.");
  }
  const images = messages.flatMap((message) => message.images || []);
  if (images.length > 1 || images.some((image) => typeof image !== "string" || image.length > GUEST_MAX_IMAGE_CHARS)) {
    throw new HttpError(413, "AI guest menerima satu gambar kecil per pesan.");
  }
  if (images.length && !keys.gemini) {
    throw new HttpError(503, "Analisis gambar guest belum tersedia. Admin perlu mengatur Gemini di Worker.");
  }

  if (selectedProvider === "gemini" && !FREE_GEMINI_MODEL_IDS.has(selectedModel)) {
    throw new HttpError(400, "Model Gemini ini tidak termasuk daftar AI gratis yang diizinkan.");
  }
  if (selectedProvider === "groq" && !FREE_GROQ_MODEL_IDS.has(selectedModel)) {
    throw new HttpError(400, "Model Groq ini tidak termasuk daftar AI gratis yang diizinkan.");
  }
  if (selectedProvider === "openrouter") {
    const freeModels = await listOpenRouterModels();
    if (!freeModels.some((model) => model.id === selectedModel)) {
      throw new HttpError(400, "Model ini tidak lagi terverifikasi gratis. Muat ulang daftar model.");
    }
  }
  if (images.length && selectedProvider !== "gemini") {
    throw new HttpError(400, "Model AI gratis yang dipilih tidak mendukung gambar.");
  }

  const normalizedMessages = [
    { role: "system", content: "Kamu adalah AI umum MyAI. Jawab akurat, ringkas, ramah, dan dalam bahasa pengguna. Guest gratis: jangan mengaku memiliki akses web atau data terbaru." },
    ...messages,
  ];
  const providers = [{ provider: selectedProvider, model: selectedModel }];
  if (!images.length) {
    if (keys.gemini) providers.push(...[...FREE_GEMINI_MODEL_IDS].map((model) => ({ provider: "gemini", model })));
    if (keys.groq) providers.push(...[...FREE_GROQ_MODEL_IDS].map((model) => ({ provider: "groq", model })));
  }
  if (!images.length && keys.openrouter) {
    try {
      const freeModels = await listOpenRouterModels();
      const preferred = guestModelsForKeys({ openrouter: keys.openrouter }, freeModels)
        .map((model) => model.id.slice("openrouter::".length));
      providers.push(...preferred.map((model) => ({ provider: "openrouter", model })));
    } catch (error) {
      console.warn("Guest OpenRouter catalog unavailable:", error?.name || "Error");
    }
  }
  const uniqueProviders = providers.filter((item, index, list) =>
    list.findIndex((candidate) => candidate.provider === item.provider && candidate.model === item.model) === index);
  if (!uniqueProviders.length) throw new HttpError(503, "AI gratis belum aktif. Admin perlu menyiapkan Gemini, Groq, atau OpenRouter gratis di Worker.");

  await enforceGuestRateLimit(request, env);
  const trial = await guestTrialCounter(request, env, "reserve");
  if (!trial.reserved) {
    throw new HttpError(429, "Jatah dua jawaban AI gratis sudah habis. Masuk dengan Google untuk melanjutkan.");
  }

  let lastResponse = null;
  for (const { provider, model } of uniqueProviders) {
    try {
      const input = await validateChatBody({ provider, model, messages: normalizedMessages, temperature: 0.5 }, keys);
      input.maxOutputTokens = GUEST_MAX_OUTPUT_TOKENS;
      const response = provider === "gemini"
        ? await sendGeminiRequest(input, keys.gemini, request)
        : await sendOpenAIRequest(request, input, keys[provider]);
      if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set("X-Guest-Remaining", String(trial.remaining));
        headers.set("Access-Control-Expose-Headers", "X-Guest-Remaining");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      lastResponse = response;
    } catch (error) {
      if (error instanceof HttpError) {
        await guestTrialCounter(request, env, "refund");
        throw error;
      }
      const status = Number.isInteger(error?.status) ? error.status : 502;
      lastResponse = jsonResponse({
        error: { message: `${provider}: ${error?.message || "provider tidak dapat dijangkau."}` },
      }, status);
    }
  }
  await guestTrialCounter(request, env, "refund");
  return lastResponse || jsonResponse({ error: { message: "AI Umum Gratis belum dapat menjawab." } }, 503);
}

async function transcribeAudio(request, keys) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk mengirim audio.");
  if (!keys.groq) {
    throw new HttpError(503, "Pengenalan suara cadangan belum tersedia karena provider Groq belum dikonfigurasi di server.");
  }

  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0) {
    throw new HttpError(400, "Audio kosong atau tidak valid. Tekan mikrofon, bicara, lalu tekan lagi.");
  }
  if (audio.size > 15 * 1024 * 1024) {
    throw new HttpError(413, "Audio terlalu besar. Batasi satu giliran suara hingga 60 detik.");
  }

  const payload = new FormData();
  payload.append("file", audio, audio.name || "myai-voice.webm");
  payload.append("model", "whisper-large-v3-turbo");
  payload.append("response_format", "json");
  const language = form.get("language");
  if (typeof language === "string" && /^[a-z]{2,3}$/i.test(language)) {
    payload.append("language", language.toLowerCase());
  }

  let response;
  try {
    response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.groq}` },
      body: payload,
      signal: AbortSignal.timeout(45000),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new HttpError(504, "Transkripsi Groq melewati batas waktu.");
    }
    throw new HttpError(502, "Layanan transkripsi Groq tidak dapat dijangkau.");
  }
  if (!response.ok) {
    throw new HttpError(response.status, `Groq: ${await upstreamErrorMessage(response, keys.groq)}`);
  }
  const result = await response.json();
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new HttpError(502, "Groq Whisper tidak mengembalikan teks.");
  }
  return jsonResponse({ text: result.text.trim() });
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function decodeJwtPart(value) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
  } catch {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
}

async function getFirebaseKey(kid) {
  if (!cachedJwks || Date.now() >= cachedJwksExpiry) {
    const response = await fetch(FIREBASE_JWKS_URL);
    if (!response.ok) throw new HttpError(503, "Kunci verifikasi Firebase tidak dapat dimuat. Coba lagi nanti.");
    const maxAge = Number(response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1]) || 3600;
    cachedJwks = await response.json();
    cachedJwksExpiry = Date.now() + maxAge * 1000;
    importedKeys = new Map();
  }
  if (importedKeys.has(kid)) return importedKeys.get(kid);
  const jwk = cachedJwks.keys?.find((item) => item.kid === kid);
  if (!jwk) throw new HttpError(401, "Sesi Firebase kedaluwarsa. Keluar lalu masuk kembali.");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  importedKeys.set(kid, key);
  return key;
}

async function requireAuthorizedUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Masuk dengan Google terlebih dahulu.");
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(503, "FIREBASE_PROJECT_ID belum diatur pada Cloudflare Worker.");

  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  const jwtHeader = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (jwtHeader.alg !== "RS256" || typeof jwtHeader.kid !== "string") {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
  const key = await getFirebaseKey(jwtHeader.kid);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  const now = Math.floor(Date.now() / 1000);
  if (!valid
    || claims.aud !== projectId
    || claims.iss !== `https://securetoken.google.com/${projectId}`
    || typeof claims.sub !== "string" || !claims.sub
    || !(claims.exp > now)
    || !(claims.iat <= now + 300)) {
    throw new HttpError(401, "Sesi Firebase tidak valid atau kedaluwarsa. Keluar lalu masuk kembali.");
  }
  if (claims.firebase?.sign_in_provider !== "google.com" || claims.email_verified !== true) {
    throw new HttpError(403, "API AI server hanya untuk akun Google dengan email terverifikasi.");
  }

  const allowed = new Set(String(env.AUTHORIZED_EMAILS || "")
    .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) throw new HttpError(503, "Admin belum mengatur secret AUTHORIZED_EMAILS pada Cloudflare Worker.");
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!allowed.has(email)) throw new HttpError(403, "Akun Google ini belum diizinkan memakai API AI server.");
  return claims;
}

function readProviderKeys(raw, env) {
  const keys = {};
  const warnings = [];
  if (typeof raw === "string" && raw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(500, "Konfigurasi AI_PROVIDER_KEYS harus berupa JSON yang valid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(500, "Konfigurasi AI_PROVIDER_KEYS harus berupa objek JSON.");
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!PROVIDERS.includes(name)) {
        warnings.push(`Provider "${name}" di AI_PROVIDER_KEYS tidak didukung Worker dan diabaikan.`);
      } else if (typeof value === "string" && value.trim()) {
        keys[name] = value.trim();
      }
    }
  }
  const individualSecrets = {
    openrouter: env.OPENROUTER_API_KEY,
    gemini: env.GEMINI_API_KEY,
    groq: env.GROQ_API_KEY,
  };
  for (const [name, value] of Object.entries(individualSecrets)) {
    if (typeof value === "string" && value.trim()) keys[name] = value.trim();
  }
  return { keys, warnings };
}

async function readJsonBody(request) {
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > REQUEST_LIMIT_BYTES) {
    throw new HttpError(413, "Ukuran permintaan terlalu besar. Kurangi lampiran atau gambar.");
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > REQUEST_LIMIT_BYTES) {
    throw new HttpError(413, "Ukuran permintaan terlalu besar. Kurangi lampiran atau gambar.");
  }
  if (!raw.trim()) return {};
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Isi permintaan harus berupa JSON yang valid.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Isi permintaan harus berupa objek JSON.");
  }
  return body;
}

async function catalogFetch(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error("Request katalog melewati batas waktu 12 detik.");
    }
    throw new Error("API katalog tidak dapat dijangkau. Periksa koneksi provider.");
  }
}

async function upstreamErrorMessage(response, key = "") {
  const raw = await response.text();
  let message = raw;
  try {
    const parsed = JSON.parse(raw);
    const detail = Array.isArray(parsed) ? parsed[0] : parsed;
    message = detail?.error?.message || detail?.message || detail?.detail || raw;
  } catch {
    message = raw;
  }
  if (typeof message !== "string") message = JSON.stringify(message);
  if (key) message = message.split(key).join("[redacted]");
  return message.slice(0, 1200) || `HTTP ${response.status}`;
}

async function listOpenRouterModels() {
  if (cachedOpenRouterModels && Date.now() < cachedOpenRouterModelsExpiry) return cachedOpenRouterModels;
  const response = await catalogFetch(OPENROUTER_MODELS_URL);
  if (!response.ok) throw new Error(`OpenRouter: ${await upstreamErrorMessage(response)}`);
  const { data = [] } = await response.json();
  const free = [];
  for (const model of data) {
    const modalities = model.architecture?.output_modalities || ["text"];
    if (modalities.some((modality) => modality !== "text") || /safety|guard|:batch/i.test(model.id)) continue;
    const prices = [model.pricing?.prompt, model.pricing?.completion, model.pricing?.request]
      .filter((price) => price !== undefined && price !== null && price !== "")
      .map(Number);
    if (prices.length < 2 || prices.some((price) => price !== 0)) continue;
    free.push({
      id: model.id,
      name: (model.name || model.id).replace(/^[^:]+:\s*/, "").replace(/\s*\(free\)$/i, ""),
    });
  }
  cachedOpenRouterModels = free;
  cachedOpenRouterModelsExpiry = Date.now() + OPENROUTER_CATALOG_TTL_MS;
  return free;
}

async function getModels(request, keys, warnings) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk memuat katalog model.");
  await readJsonBody(request);
  const groups = [];
  const errors = [...warnings];
  if (keys.gemini) {
    groups.push({
      provider: "gemini",
      label: "Google Gemini Gratis",
      tag: "Kuota gratis Google AI Studio",
      models: [...FREE_GEMINI_MODEL_IDS].map((id) => ({ id, name: "Gemini Flash", priceTier: "free", imageSupport: true })),
    });
  }
  if (keys.groq) {
    groups.push({
      provider: "groq",
      label: "Groq Gratis",
      tag: "Kuota gratis Groq",
      models: [...FREE_GROQ_MODEL_IDS].map((id) => ({ id, name: "Qwen3 32B · Groq", priceTier: "free" })),
    });
  }
  if (keys.openrouter) {
    try {
      const models = await listOpenRouterModels();
      if (models.length) {
        groups.push({
          provider: "openrouter",
          label: "OpenRouter Gratis",
          tag: "Model gratis terverifikasi dari katalog OpenRouter",
          models: models.map((model) => ({ ...model, priceTier: "free" })),
        });
      }
    } catch (error) {
      errors.push(error?.message || "OpenRouter: gagal memuat katalog.");
    }
  }
  return jsonResponse({
    providers: PROVIDERS.filter((provider) => Boolean(keys[provider])),
    groups,
    errors,
  });
}

function imageReference(url) {
  if (typeof url !== "string" || (!/^data:image\/[^;]+;base64,/i.test(url) && !/^https:\/\/[^/]/i.test(url))) {
    throw new HttpError(400, "Format lampiran gambar tidak valid.");
  }
  return { type: "image_url", image_url: { url } };
}

async function validateChatBody(body, keys) {
  const provider = body.provider;
  if (!PROVIDERS.includes(provider)) throw new HttpError(400, "Provider AI tidak dikenal.");
  if (!keys[provider]) throw new HttpError(400, `Provider ${provider} belum dikonfigurasi di Cloudflare Worker.`);
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 300) {
    throw new HttpError(400, "Model AI tidak valid.");
  }
  const model = body.model.trim();
  if (body.imageGeneration === true) {
    throw new HttpError(400, "Generasi gambar tidak tersedia pada model gratis server. Gunakan key akun pribadi.");
  }
  if (provider === "gemini" && !FREE_GEMINI_MODEL_IDS.has(model)) {
    throw new HttpError(400, "Model Gemini ini tidak termasuk daftar AI gratis yang diizinkan.");
  }
  if (provider === "groq" && !FREE_GROQ_MODEL_IDS.has(model)) {
    throw new HttpError(400, "Model Groq ini tidak termasuk daftar AI gratis yang diizinkan.");
  }
  if (provider === "openrouter") {
    const freeModels = await listOpenRouterModels();
    if (!freeModels.some((item) => item.id === model)) {
      throw new HttpError(400, "Model ini tidak lagi terverifikasi gratis. Muat ulang daftar model.");
    }
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 120) {
    throw new HttpError(400, "Daftar pesan tidak valid.");
  }
  const messages = body.messages.map((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new HttpError(400, "Format pesan tidak valid.");
    }
    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length > 10) throw new HttpError(400, "Maksimal 10 gambar per pesan.");
    if (images.length && provider === "groq") throw new HttpError(400, "Model Groq gratis tidak mendukung gambar.");
    return {
      role: message.role,
      content: message.content,
      ...(images.length ? { images } : {}),
    };
  });
  const webSearch = body.webSearch === true;
  if (webSearch && provider === "groq") {
    throw new HttpError(400, "Pencarian web memerlukan provider Gemini atau OpenRouter.");
  }
  return {
    provider,
    model,
    messages,
    temperature: Number.isFinite(Number(body.temperature))
      ? Math.max(0, Math.min(2, Number(body.temperature)))
      : 0.7,
    webSearch,
    researchMode: body.researchMode === true,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  };
}

function makeUpstreamSignal(request) {
  const timeout = AbortSignal.timeout(120000);
  if (request.signal && typeof AbortSignal.any === "function") return AbortSignal.any([request.signal, timeout]);
  return timeout;
}

async function providerFetch(url, options, provider) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new HttpError(504, `${provider}: permintaan melewati batas waktu.`);
    }
    throw new HttpError(502, `${provider}: API provider tidak dapat dijangkau.`);
  }
}

async function sendProviderError(response, provider, key) {
  const message = await upstreamErrorMessage(response, key);
  return jsonResponse({ error: { message: `${provider}: ${message}` } }, response.status);
}

function streamResponse(response) {
  return new Response(response.body, {
    status: response.status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": response.headers.get("Content-Type") || "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function geminiRequestBody(input) {
  const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const contents = input.messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: message.content },
      ...(message.images || []).map((image) => {
        const match = typeof image === "string" ? image.match(/^data:([^;]+);base64,(.+)$/) : null;
        if (!match) throw new HttpError(400, "Gemini menerima lampiran gambar dalam format data URL.");
        return { inlineData: { mimeType: match[1], data: match[2] } };
      }),
    ],
  }));
  return {
    contents,
    generationConfig: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens || MAX_OUTPUT_TOKENS,
    },
    ...(input.webSearch ? { tools: [{ googleSearch: {} }] } : {}),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
}

async function sendGeminiRequest(input, key, request) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`;
  const response = await providerFetch(url, {
    method: "POST",
    signal: makeUpstreamSignal(request),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(geminiRequestBody(input)),
  }, "Gemini");
  if (!response.ok) return sendProviderError(response, "Gemini", key);
  return streamResponse(response);
}

function openAIRequestBody(input) {
  const messages = input.messages.map((message) => {
    const { images, ...plainMessage } = message;
    if (!images?.length) return plainMessage;
    return {
      ...plainMessage,
      content: [
        { type: "text", text: message.content },
        ...images.map(imageReference),
      ],
    };
  });
  return {
    model: input.model,
    messages,
    stream: true,
    temperature: input.temperature,
    max_tokens: input.maxOutputTokens || MAX_OUTPUT_TOKENS,
    ...(input.webSearch && input.provider === "openrouter"
      ? { plugins: [{ id: "web", max_results: input.researchMode ? 10 : 5 }] }
      : {}),
  };
}

async function sendOpenAIRequest(request, input, key) {
  const url = OPENAI_ENDPOINTS[input.provider];
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (input.provider === "openrouter") {
    headers["HTTP-Referer"] = request.headers.get("origin") || "https://localhost";
    headers["X-Title"] = "MyAI";
  }
  const body = openAIRequestBody(input);
  const signal = makeUpstreamSignal(request);
  let response = await providerFetch(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  }, input.provider);

  if (input.provider === "groq" && [413, 429].includes(response.status)) {
    const error = await response.clone().text();
    const limit = Number(error.match(/output tokens per minute[^]*?Limit (\d+)/i)?.[1]);
    if (limit) {
      response = await providerFetch(url, {
        method: "POST",
        signal,
        headers,
        body: JSON.stringify({ ...body, max_tokens: Math.min(body.max_tokens, Math.floor(limit * 0.9)) }),
      }, input.provider);
    }
  }
  if (!response.ok) return sendProviderError(response, input.provider, key);
  return streamResponse(response);
}

async function chat(request, keys) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk mengirim chat.");
  const input = await validateChatBody(await readJsonBody(request), keys);
  const key = keys[input.provider];
  if (input.provider === "gemini") return sendGeminiRequest(input, key, request);
  return sendOpenAIRequest(request, input, key);
}

function requireMonidSecret(env) {
  const key = typeof env.MONID_API_KEY === "string" ? env.MONID_API_KEY.trim() : "";
  if (!key) throw new HttpError(503, "Monid belum dikonfigurasi. Admin perlu memasang secret MONID_API_KEY pada Cloudflare Worker.");
  return key;
}

async function monidRequest(request, env, path, method, body) {
  const key = requireMonidSecret(env);
  const response = await fetch(`${MONID_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const contentType = response.headers.get("Content-Type") || "";
  const rawBody = await response.text();
  let responseBody;
  if (contentType.includes("application/json")) {
    try {
      responseBody = JSON.parse(rawBody);
    } catch {
      responseBody = { message: "Respons Monid bukan JSON yang valid." };
    }
  } else {
    responseBody = { message: rawBody.slice(0, 2000) };
  }
  if (!response.ok) {
    const message = typeof responseBody.message === "string"
      ? responseBody.message
      : typeof responseBody.error === "string"
        ? responseBody.error
        : `Monid menolak permintaan (HTTP ${response.status}).`;
    throw new HttpError(response.status, message);
  }
  return jsonResponse(responseBody, response.status);
}

async function monid(request, env, action) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk memakai Monid.");
  const body = await readJsonBody(request);
  if (action === "discover") {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query || query.length > 1000) throw new HttpError(400, "Isi pencarian Monid 1–1000 karakter.");
    const limit = body.limit === undefined ? 5 : Number(body.limit);
    const minScore = body.minScore === undefined ? 0.2 : Number(body.minScore);
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new HttpError(400, "Batas hasil Monid harus 1–40.");
    if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) throw new HttpError(400, "minScore Monid harus 0–1.");
    return monidRequest(request, env, "/discover", "POST", { query, limit, minScore });
  }
  if (action === "inspect") {
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!/^[a-z0-9_-]{1,80}$/i.test(provider)) throw new HttpError(400, "Provider Monid tidak valid.");
    if (!endpoint.startsWith("/") || endpoint.length > 500 || /[\r\n]/.test(endpoint)) {
      throw new HttpError(400, "Endpoint Monid tidak valid.");
    }
    return monidRequest(request, env, "/inspect", "POST", { provider, endpoint });
  }
  if (action === "run") {
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
    if (!/^[a-z0-9_-]{1,80}$/i.test(provider)) throw new HttpError(400, "Provider Monid tidak valid.");
    if (!endpoint.startsWith("/") || endpoint.length > 500 || /[\r\n]/.test(endpoint)) {
      throw new HttpError(400, "Endpoint Monid tidak valid.");
    }
    if (body.input !== undefined && (body.input === null || typeof body.input !== "object" || Array.isArray(body.input))) {
      throw new HttpError(400, "Input endpoint Monid harus berupa objek JSON.");
    }
    return monidRequest(request, env, "/run", "POST", {
      provider,
      endpoint,
      ...(body.input ? { input: body.input } : {}),
    });
  }
  if (action === "get") {
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!/^[a-z0-9_-]{8,100}$/i.test(runId)) throw new HttpError(400, "ID run Monid tidak valid.");
    return monidRequest(request, env, `/runs/${encodeURIComponent(runId)}`, "GET");
  }
  throw new HttpError(404, "Aksi Monid tidak dikenal.");
}

export class GuestTrialCounter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
    const used = (await this.ctx.storage.get("used")) || 0;
    if (action === "status") {
      return Response.json({ remaining: Math.max(0, GUEST_TRIAL_LIMIT - used) });
    }
    if (action === "reserve") {
      if (used >= GUEST_TRIAL_LIMIT) return Response.json({ reserved: false, remaining: 0 });
      await this.ctx.storage.put("used", used + 1);
      return Response.json({ reserved: true, remaining: GUEST_TRIAL_LIMIT - used - 1 });
    }
    if (action === "refund") {
      const next = Math.max(0, used - 1);
      await this.ctx.storage.put("used", next);
      return Response.json({ remaining: GUEST_TRIAL_LIMIT - next });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const pathSegments = new URL(request.url).pathname.split("/").filter(Boolean);
      const route = pathSegments.at(-1) || "";
      const guestRoute = pathSegments.slice(-2).join("/");
      const monidRoute = pathSegments.slice(-2).join("/");
      if (guestRoute === "guest/models" || guestRoute === "guest/chat" || guestRoute === "guest/transcribe") {
        const { keys } = readProviderKeys(env.AI_PROVIDER_KEYS, env);
        if (guestRoute === "guest/models") return await getGuestModels(request, env, keys);
        if (guestRoute === "guest/transcribe") {
          await enforceGuestRateLimit(request, env);
          return await transcribeAudio(request, keys);
        }
        return await guestChat(request, env, keys);
      }
      await requireAuthorizedUser(request, env);
      const { keys, warnings } = readProviderKeys(env.AI_PROVIDER_KEYS, env);
      if (monidRoute.startsWith("monid/")) return await monid(request, env, route);
      if (route === "models") return await getModels(request, keys, warnings);
      if (route === "chat") return await chat(request, keys);
      if (route === "transcribe") return await transcribeAudio(request, keys);
      throw new HttpError(404, "Endpoint AI tidak ditemukan.");
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) console.error("AI Worker request failed:", error?.name || "Error");
      return jsonResponse({
        error: {
          message: error instanceof HttpError ? error.message : "Terjadi kesalahan pada backend AI.",
        },
      }, status);
    }
  },
};
