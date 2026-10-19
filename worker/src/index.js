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

export class GuestTrialCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const action = new URL(request.url).pathname.slice(1);
    if (!["status", "reserve", "refund"].includes(action)) return new Response(null, { status: 404 });
    const result = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get("used");
      const used = Number.isInteger(stored) && stored >= 0 ? stored : 0;
      if (action === "reserve") {
        if (used >= GUEST_TRIAL_LIMIT) return { reserved: false, used, remaining: 0 };
        const next = used + 1;
        await transaction.put("used", next);
        return { reserved: true, used: next, remaining: GUEST_TRIAL_LIMIT - next };
      }
      if (action === "refund") {
        const next = Math.max(0, used - 1);
        await transaction.put("used", next);
        return { used: next, remaining: GUEST_TRIAL_LIMIT - next };
      }
      return { used, remaining: Math.max(0, GUEST_TRIAL_LIMIT - used) };
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  }
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length > 16384) {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtJson(value) {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
}

async function loadFirebaseJwks(forceRefresh = false) {
  if (!forceRefresh && cachedJwks && Date.now() < cachedJwksExpiry) return cachedJwks;
  let response;
  try {
    response = await fetch(FIREBASE_JWKS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(503, "Layanan verifikasi login Google sementara tidak tersedia.");
  }
  if (!response.ok) {
    throw new HttpError(503, "Layanan verifikasi login Google sementara tidak tersedia.");
  }
  const result = await response.json();
  if (!Array.isArray(result.keys)) {
    throw new HttpError(503, "Respons verifikasi login Google tidak valid.");
  }

  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/i)?.[1]) || 3600;
  cachedJwks = result.keys;
  cachedJwksExpiry = Date.now() + Math.min(Math.max(maxAge, 60), 86400) * 1000;
  importedKeys = new Map();
  return cachedJwks;
}

async function getFirebaseSigningKey(kid, forceRefresh = false) {
  const keys = await loadFirebaseJwks(forceRefresh);
  const jwk = keys.find((key) => key.kid === kid && key.alg === "RS256");
  if (!jwk) return null;
  if (!importedKeys.has(kid)) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    importedKeys.set(kid, key);
  }
  return importedKeys.get(kid);
}

async function verifyFirebaseIdToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3 || !projectId) {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }

  const header = decodeJwtJson(parts[0]);
  const claims = decodeJwtJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }

  let key = await getFirebaseSigningKey(header.kid);
  if (!key) key = await getFirebaseSigningKey(header.kid, true);
  if (!key) throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !signatureValid
    || claims.aud !== projectId
    || claims.iss !== `https://securetoken.google.com/${projectId}`
    || typeof claims.sub !== "string"
    || !claims.sub
    || !Number.isFinite(claims.exp)
    || claims.exp <= now
    || !Number.isFinite(claims.iat)
    || claims.iat > now + 60
  ) {
    throw new HttpError(401, "Sesi Firebase tidak valid. Keluar lalu masuk kembali.");
  }
  return claims;
}

async function requireAuthorizedUser(request, env) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "Masuk dengan Google terlebih dahulu.");

  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new HttpError(500, "FIREBASE_PROJECT_ID belum diatur pada Worker.");
  const claims = await verifyFirebaseIdToken(token, projectId);
  if (claims.firebase?.sign_in_provider !== "google.com") {
    throw new HttpError(403, "Masuk menggunakan akun Google untuk memakai API AI server.");
  }

  const allowed = new Set(
    String(env.AUTHORIZED_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowed.size) {
    throw new HttpError(503, "Admin belum mengatur secret AUTHORIZED_EMAILS pada Cloudflare Worker.");
  }
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (claims.email_verified !== true || !allowed.has(email)) {
    throw new HttpError(403, "Akun Google ini belum diizinkan memakai API AI server.");
  }
}

function readProviderKeys(raw, individualSecrets = {}) {
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(500, "Secret AI_PROVIDER_KEYS harus berisi JSON yang valid.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(500, "Secret AI_PROVIDER_KEYS harus berupa objek JSON.");
    }
  }
  const unsupported = Object.keys(parsed).filter((provider) => !PROVIDERS.includes(provider));
  for (const provider of PROVIDERS) {
    if (Object.hasOwn(parsed, provider) && typeof parsed[provider] !== "string") {
      throw new HttpError(500, `Key ${provider} pada AI_PROVIDER_KEYS harus berupa teks.`);
    }
  }
  const keys = Object.fromEntries(
    PROVIDERS.flatMap((provider) => {
      const secretName = `${provider.toUpperCase()}_API_KEY`;
      const individualKey = individualSecrets[secretName];
      if (individualKey !== undefined && typeof individualKey !== "string") {
        throw new HttpError(500, `Secret ${secretName} harus berupa teks.`);
      }
      const key = individualKey?.trim() ||
        (typeof parsed[provider] === "string" ? parsed[provider].trim() : "");
      return key ? [[provider, key]] : [];
    }),
  );
  return {
    keys,
    warnings: unsupported.length
      ? [`Provider yang belum didukung diabaikan: ${unsupported.join(", ")}.`]
      : [],
  };
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > REQUEST_LIMIT_BYTES) {
    throw new HttpError(413, "Ukuran permintaan terlalu besar. Kurangi lampiran atau gambar.");
  }
  if (!request.body) throw new HttpError(400, "Isi permintaan JSON tidak ditemukan.");

  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > REQUEST_LIMIT_BYTES) {
        await reader.cancel().catch((error) => console.warn("Request body cancellation failed:", error?.name || "Error"));
        throw new HttpError(413, "Ukuran permintaan terlalu besar. Kurangi lampiran atau gambar.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Isi permintaan tidak dapat dibaca.");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const raw = new TextDecoder().decode(bytes);
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

function replaceGroup(groups, provider, label, tag, models) {
  const existing = groups.find((group) => group.provider === provider && group.label === label);
  if (!models.length) {
    if (existing) groups.splice(groups.indexOf(existing), 1);
    return;
  }
  if (existing) {
    existing.tag = tag;
    existing.models = models;
  } else {
    groups.push({ provider, label, tag, models });
  }
}

async function catalogFetch(url, options = {}) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    const host = new URL(url).hostname;
    const detail = String(error?.message || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 160);
    console.error(`Catalog request to ${host} failed (${error?.name || "Error"}): ${detail}`);
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
    message = parsed.error?.message || parsed.message || parsed.detail || raw;
  } catch {
    message = raw;
  }
  if (key) message = String(message).split(key).join("[redacted]");
  return String(message).slice(0, 1200) || `HTTP ${response.status}`;
}

function isZeroPrice(value) {
  return (typeof value === "number" && Number.isFinite(value) && value === 0)
    || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) === 0);
}

function isFreeOpenRouterTextModel(model) {
  const pricing = model?.pricing;
  const inputModalities = model?.architecture?.input_modalities;
  const outputModalities = model?.architecture?.output_modalities;
  return typeof model?.id === "string"
    && /:free$/i.test(model.id)
    && pricing
    && typeof pricing === "object"
    && !Array.isArray(pricing)
    && Object.keys(pricing).length > 0
    && Object.values(pricing).every(isZeroPrice)
    && Array.isArray(inputModalities)
    && inputModalities.includes("text")
    && Array.isArray(outputModalities)
    && outputModalities.includes("text")
    && !/content[-\s]?safety|moderation|guard/i.test(`${model.id} ${model.name || ""}`);
}

async function listOpenRouterModels() {
  if (cachedOpenRouterModels && Date.now() < cachedOpenRouterModelsExpiry) {
    return cachedOpenRouterModels;
  }
  const response = await catalogFetch(OPENROUTER_MODELS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter: ${await upstreamErrorMessage(response)}`);
  }
  const result = await response.json();
  if (!Array.isArray(result.data)) {
    throw new Error("OpenRouter mengirim format katalog yang tidak valid.");
  }
  const models = result.data
    .filter(isFreeOpenRouterTextModel)
    .map((model) => ({ id: model.id, name: model.name || model.id }))
    .sort((left, right) => left.name.localeCompare(right.name));
  cachedOpenRouterModels = models;
  cachedOpenRouterModelsExpiry = Date.now() + OPENROUTER_CATALOG_TTL_MS;
  return models;
}

async function verifyOpenRouterKey(key) {
  const response = await catalogFetch("https://openrouter.ai/api/v1/auth/key", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter: ${await upstreamErrorMessage(response, key)}`);
  }
}

async function listGeminiModels(key) {
  const response = await catalogFetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    headers: { "x-goog-api-key": key },
  });
  if (!response.ok) throw new Error(`Gemini: ${await upstreamErrorMessage(response, key)}`);
  const { models = [] } = await response.json();
  return models
    .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
    .filter((model) => FREE_GEMINI_MODEL_IDS.has(model.name?.replace(/^models\//, "") || ""))
    .map((model) => ({
      id: model.name.replace(/^models\//, ""),
      name: model.displayName || model.name,
    }))
    .sort((left, right) => right.id.localeCompare(left.id));
}

async function listGroqModels(key) {
  const response = await catalogFetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`Groq: ${await upstreamErrorMessage(response, key)}`);
  const { data = [] } = await response.json();
  return data
    .filter((model) => FREE_GROQ_MODEL_IDS.has(model.id))
    .map((model) => ({ id: model.id, name: model.id }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function loadCatalogs(groups, keys) {
  const jobs = [];
  const errors = [];
  if (keys.gemini) {
    jobs.push({
      provider: "gemini",
      label: "Google Gemini",
      load: () => listGeminiModels(keys.gemini),
      apply: (models) => replaceGroup(groups, "gemini", "Google Gemini Gratis", "Katalog model Flash", models),
    });
  }
  if (keys.groq) {
    jobs.push({
      provider: "groq",
      label: "Groq",
      load: () => listGroqModels(keys.groq),
      apply: (models) => replaceGroup(groups, "groq", "Groq Gratis", "Katalog model gratis", models),
    });
  }

  const results = await Promise.allSettled(jobs.map((job) => job.load()));
  const providers = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      jobs[index].apply(result.value);
      if (result.value.length) providers.push(jobs[index].provider);
    } else {
      errors.push(`${jobs[index].label}: ${result.reason?.message || "gagal memuat katalog."}`);
    }
  });
  return { errors, providers };
}

async function getModels(request, keys, warnings = []) {
  if (request.method !== "POST") throw new HttpError(405, "Gunakan POST untuk memuat katalog model.");
  const body = await readJsonBody(request);
  const groups = [];
  const errors = [...warnings];
  const providers = [];
  if (keys.gemini) {
    groups.push({
      provider: "gemini",
      label: "Google Gemini",
      tag: "Gratis · standby dari server",
      models: [...FREE_GEMINI_MODEL_IDS].map((id) => ({ id, name: "Gemini Flash · gratis" })),
    });
  }
  if (keys.groq) {
    groups.push({
      provider: "groq",
      label: "Groq",
      tag: "Gratis · standby dari server",
      models: [...FREE_GROQ_MODEL_IDS].map((id) => ({ id, name: "Qwen3 32B · gratis" })),
    });
  }
  if (body.includeCatalog === true && keys.openrouter) {
    try {
      await verifyOpenRouterKey(keys.openrouter);
      const models = await listOpenRouterModels();
      replaceGroup(
        groups,
        "openrouter",
        "OpenRouter Gratis",
        "Katalog gratis terverifikasi · kuota OpenRouter berlaku",
        models,
      );
      if (models.length) providers.push("openrouter");
    } catch (error) {
      errors.push(error?.message || "OpenRouter: gagal memuat katalog model gratis.");
    }
  }
  if (body.includeCatalog === true) {
    const catalog = await loadCatalogs(groups, keys);
    errors.push(...catalog.errors);
    providers.push(...catalog.providers);
  }
  return jsonResponse({
    providers: [...new Set(providers)],
    groups: groups.filter((group) => group.models.length),
    errors,
  });
}

function imageReference(url) {
  if (typeof url !== "string" || (!/^data:image\/[^;]+;base64,/i.test(url) && !/^https:\/\/[^/]+/i.test(url))) {
    throw new HttpError(400, "Format lampiran gambar tidak valid.");
  }
  return { type: "image_url", image_url: { url } };
}

async function validateChatBody(body, keys) {
  if (!PROVIDERS.includes(body.provider)) throw new HttpError(400, "Provider AI tidak tersedia dalam mode gratis.");
  if (!keys[body.provider]) {
    const secretName = `${body.provider.toUpperCase()}_API_KEY`;
    throw new HttpError(
      400,
      `Provider ${body.provider} belum diatur. Tambahkan secret ${secretName} atau key "${body.provider}" pada AI_PROVIDER_KEYS.`,
    );
  }
  if (typeof body.model !== "string" || !body.model.trim() || body.model.length > 300) {
    throw new HttpError(400, "Model AI tidak valid.");
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 120) {
    throw new HttpError(400, "Daftar pesan tidak valid.");
  }
  if (body.imageGeneration === true) {
    throw new HttpError(400, "Generasi gambar tidak tersedia dalam mode gratis.");
  }
  if (body.webSearch === true) {
    throw new HttpError(400, "Pencarian web dinonaktifkan dalam mode gratis karena dapat menambah biaya provider.");
  }

  const model = body.model.trim();
  if (body.provider === "openrouter") {
    let freeModels;
    try {
      freeModels = await listOpenRouterModels();
    } catch (error) {
      throw new HttpError(503, `Model gratis OpenRouter tidak dapat diverifikasi: ${error?.message || "katalog tidak tersedia."}`);
    }
    if (!freeModels.some((item) => item.id === model)) {
      throw new HttpError(400, "Model OpenRouter ini tidak lagi terverifikasi gratis. Muat ulang katalog model.");
    }
  }
  if (body.provider === "gemini" && !FREE_GEMINI_MODEL_IDS.has(model)) {
    throw new HttpError(400, "Mode gratis hanya mengizinkan model Gemini Flash.");
  }
  if (body.provider === "groq" && !FREE_GROQ_MODEL_IDS.has(model)) {
    throw new HttpError(400, "Model Groq ini tidak termasuk daftar model gratis yang diizinkan.");
  }

  const messages = body.messages.map((message) => {
    if (!message || !["system", "user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new HttpError(400, "Format pesan tidak valid.");
    }
    if (message.images !== undefined && !Array.isArray(message.images)) {
      throw new HttpError(400, "Format lampiran gambar tidak valid.");
    }
    const images = message.images || [];
    if (images.length > 10) throw new HttpError(400, "Maksimal 10 gambar per pesan.");
    if (images.some((image) => typeof image !== "string" || image.length > REQUEST_LIMIT_BYTES)) {
      throw new HttpError(400, "Format atau ukuran lampiran gambar tidak valid.");
    }
    return { role: message.role, content: message.content, ...(images.length ? { images } : {}) };
  });
  if (!messages.some((message) => message.role === "user")) {
    throw new HttpError(400, "Permintaan harus memiliki setidaknya satu pesan pengguna.");
  }
  if (body.provider !== "gemini" && messages.some((message) => message.images?.length)) {
    throw new HttpError(400, "Analisis gambar pada mode gratis hanya tersedia dengan model Gemini Flash.");
  }
  if (body.provider === "gemini"
    && messages.some((message) => message.images?.some((image) => !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(image)))) {
    throw new HttpError(400, "Lampiran gambar Gemini harus berupa data URL base64.");
  }

  return {
    provider: body.provider,
    model,
    messages,
    temperature: Number.isFinite(Number(body.temperature))
      ? Math.max(0, Math.min(2, Number(body.temperature)))
      : 0.7,
  };
}

function makeUpstreamSignal(request) {
  return AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
}

async function providerFetch(url, options, provider) {
  try {
    return await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(120000) });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new HttpError(504, `${provider}: permintaan melewati batas waktu.`);
    }
    const detail = String(error?.message || "unknown error").replace(/[\r\n]+/g, " ").slice(0, 160);
    console.error(`${provider} upstream request failed (${error?.name || "Error"}): ${detail}`);
    throw new HttpError(502, `${provider}: API provider tidak dapat dijangkau.`);
  }
}

async function sendProviderError(response, provider, key) {
  const message = await upstreamErrorMessage(response, key);
  return jsonResponse({ error: { message: `${provider}: ${message}` } }, response.status);
}

function streamResponse(upstream) {
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

function geminiRequestBody(messages, temperature, maxOutputTokens = MAX_OUTPUT_TOKENS) {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: message.content },
      ...(message.images || []).map((image) => {
        const match = image.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) throw new HttpError(400, "Gemini menerima lampiran gambar dalam format data URL.");
        return { inlineData: { mimeType: match[1], data: match[2] } };
      }),
    ],
  }));
  return {
    contents,
    generationConfig: { temperature, maxOutputTokens },
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
  };
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
  return { model: input.model, messages, stream: true, temperature: input.temperature, max_tokens: input.maxOutputTokens || MAX_OUTPUT_TOKENS };
}

async function sendGeminiRequest(input, key, request) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`;
  const response = await providerFetch(url, {
    method: "POST",
    signal: makeUpstreamSignal(request),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(geminiRequestBody(input.messages, input.temperature, input.maxOutputTokens)),
  }, "Gemini");
  if (!response.ok) return sendProviderError(response, "Gemini", key);
  return streamResponse(response);
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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const pathSegments = new URL(request.url).pathname.split("/").filter(Boolean);
      const route = pathSegments.at(-1) || "";
      const guestRoute = pathSegments.slice(-2).join("/");
      if (guestRoute === "guest/models" || guestRoute === "guest/chat") {
        const { keys } = readProviderKeys(env.AI_PROVIDER_KEYS, env);
        if (guestRoute === "guest/models") return await getGuestModels(request, env, keys);
        return await guestChat(request, env, keys);
      }
      await requireAuthorizedUser(request, env);
      const { keys, warnings } = readProviderKeys(env.AI_PROVIDER_KEYS, env);
      if (route === "models") return await getModels(request, keys, warnings);
      if (route === "chat") return await chat(request, keys);
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
