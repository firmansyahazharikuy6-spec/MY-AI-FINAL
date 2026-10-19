import { AI_API_URL, APP_NAME, APP_VERSION } from "./config.js?v=20261019-v5.14";
import {
  firebaseEnabled,
  initFirebase,
  signIn,
  signOutUser,
  getAuthToken,
  loadCloudApiKeys,
  saveCloudApiKeys,
  consumeAuthError,
  consumeSyncError,
  listChats,
  saveChat,
  deleteChat,
} from "./db.js?v=20261019-v5.15.1";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  listGuestModels,
  invalidateGuestModels,
  listManualModels,
  listServerModels,
  streamChat,
} from "./providers.js?v=20261019-v5.14";
import { brandOf } from "./models.js?v=20261019-v5.14";
import { exportAssistantDocument } from "./documents.js?v=20261019-v5.14";

const $ = (id) => document.getElementById(id);
const MODEL_KEY = "myai_model";
const WORK_FOLDERS_KEY = "myai_work_folders";
const DRAFT_KEY = "myai_draft_text";
const POLLINATIONS_GROUP = {
  provider: "pollinations",
  label: "Gambar Gratis",
  tag: "Gratis · Pollinations.ai",
  models: [
    { id: "flux", name: "Flux (Pollinations)", priceTier: "free" },
    { id: "turbo", name: "Turbo (Pollinations)", priceTier: "free" },
  ],
};
const GUEST_FALLBACK_GROUP = {
  provider: "guest",
  label: "AI Gratis · tanpa login",
  tag: "Tanpa akun · dua jawaban per IP sebelum login",
  models: [{ id: "guest-general", name: "AI Umum Gratis", imageSupport: false, priceTier: "free" }],
};
const LOCAL_MODEL_GROUP = {
  provider: "local-webgpu",
  label: "AI Offline · perangkat ini",
  tag: "Unduhan pertama sekitar 2–3 GB · perlu WebGPU",
  models: [{ id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", name: "Qwen2.5 3B · Offline", priceTier: "free" }],
};
const CREATION_FORMATS = {
  pptx: {
    label: "PowerPoint",
    ext: ".pptx",
    icon: "📽️",
    instruction: "Susun presentasi PowerPoint yang matang, runtut, dan sesuai bahasa serta audiens permintaan. Aplikasi MyAI otomatis membuat file .pptx, jadi jangan menolak atau menjelaskan cara membuat file. Format wajib: baris pertama `# Judul Presentasi`; tiap slide memakai `## Judul Slide` dan 3-5 poin `- poin` yang ringkas (idealnya maksimal 18 kata). Buat 6-10 slide kecuali pengguna menentukan jumlahnya. Bangun alur dengan pembuka/konteks, isi berurutan, contoh atau penerapan, lalu kesimpulan/rekomendasi. Gunakan fakta hanya jika yakin; jangan mengarang angka atau sumber. Tanpa blok kode atau teks pembuka/penutup di luar slide.",
  },
  docx: {
    label: "Word",
    ext: ".docx",
    icon: "📘",
    instruction: "Tulis dokumen Word yang lengkap, akurat, dan siap digunakan sesuai tujuan, bahasa, dan audiens permintaan. Aplikasi MyAI otomatis membuat file .docx, jadi jangan menolak atau menjelaskan cara membuat file. Format: baris pertama `# Judul Dokumen`; gunakan `##`/`###` untuk bagian, paragraf yang menjelaskan inti secara tuntas, serta daftar atau tabel Markdown bila membantu. Sertakan konteks, langkah/tindakan, dan penutup yang relevan; jangan mengisi dengan pengulangan atau mengarang fakta. Hasil harus berupa isi final, bukan kerangka, dan tanpa kalimat pembuka seperti 'Berikut adalah...'.",
  },
  xlsx: {
    label: "Excel",
    ext: ".xlsx",
    icon: "📊",
    instruction: "Siapkan spreadsheet Excel yang rapi, konsisten, dan sesuai kebutuhan. Aplikasi MyAI otomatis membuat file .xlsx, jadi jangan menolak atau menjelaskan cara membuat file. Sajikan setiap kumpulan data sebagai tabel Markdown valid dengan header yang jelas; tulis `## Nama Lembar` sebelum tiap tabel agar menjadi lembar terpisah. Pastikan satu baris mewakili satu catatan, nilai tiap kolom konsisten, angka tidak memuat pemisah/satuan (letakkan satuan di header, mis. `Harga (Rp)`), dan tanggal ditulis konsisten. Jika data pengguna tidak tersedia, buat data contoh yang realistis dan tandai sebagai contoh. Jangan mengarang data faktual; penjelasan di luar tabel maksimal 2 kalimat.",
  },
  pdf: {
    label: "PDF",
    ext: ".pdf",
    icon: "📕",
    instruction: "Kamu sedang menulis dokumen PDF. Aplikasi MyAI akan otomatis mengubah jawabanmu menjadi file .pdf yang langsung diunduh pengguna, jadi JANGAN bilang kamu tidak bisa membuat file. Format: baris pertama `# Judul Dokumen`, gunakan `##` untuk bagian, paragraf lengkap, serta daftar atau tabel Markdown bila perlu. Tulis isi lengkap dan siap pakai tanpa kalimat pembuka.",
  },
};
const CREATE_VERB = "(?:buat|buatin|buatkan|bikin|bikinin|bikinkan|susun|susunkan|siapkan|sediakan|tulis|tuliskan|rancang|rancangkan|generate|create|make|design|desain|desainkan|jadikan|ubah|ubahkan|convert|export|ekspor|konversi|simpan|hasilkan)";
const CREATE_VERB_RE = new RegExp(`\\b${CREATE_VERB}\\b`, "gi");
const DOCUMENT_NOUNS = [
  ["pptx", /\b(?:pptx?|power\s?point|presentasi|slides?|slideshow|deck)\b/i],
  ["xlsx", /\b(?:excel|xlsx|xls|spreadsheets?|spread\s+sheet|lembar\s+kerja|google\s+sheets?)\b/i],
  ["docx", /\b(?:docx|ms\.?\s*word|microsoft\s+word|word\s+(?:document|file)|(?:file|dokumen|format|bentuk|versi|ke|jadi|dalam|sebuah|satu)\s+word|word)\b/i],
  ["pdf", /\bpdf\b/i],
];
const IMAGE_NOUN = "(?:gambar|foto|ilustrasi|lukisan|logo|poster|wallpaper|ikon|icon|stiker|sticker|karikatur|kartun|avatar|banner|image|picture|photo|illustration|drawing|painting|artwork)";
const IMAGE_REQUEST_RE = new RegExp(`\\b${CREATE_VERB}\\s+(?:(?:sebuah|satu|seekor|a|an|the|me|aku|saya|kan|in|gue|dong|tolong|lagi|yang)\\s+){0,3}${IMAGE_NOUN}\\b`, "i");
const DRAW_REQUEST_RE = /^(?:tolong\s+|please\s+|coba\s+)?(?:lukis|lukiskan|draw|paint|sketch)\b|\b(?:generate|create)\s+(?:an?\s+)?(?:image|picture|photo)\b|\btext[- ]to[- ]image\b/i;
const NOT_CREATION_RE = /\b(?:cara|bagaimana|gimana|how to|how do|tutorial|kode|code|script|skrip|coding|fungsi|function|rumus|formula|macro|makro|vba|library|css|html|svg|python|javascript)\b/i;
const EXISTING_FILE_RE = /^\s*(?:ini|itu|tersebut|terlampir|yang\s+(?:saya|aku|sudah)|this|that|attached)\b/i;

function detectCreationIntent(text) {
  const value = String(text || "").slice(0, 600);
  if (!value.trim()) return "";
  const verbs = [...value.matchAll(CREATE_VERB_RE)];
  for (const [format, noun] of DOCUMENT_NOUNS) {
    const found = value.match(noun);
    if (!found) continue;
    const nounEnd = found.index + found[0].length;
    if (EXISTING_FILE_RE.test(value.slice(nounEnd))) continue;
    const verb = verbs.filter((match) => match.index < found.index && found.index - match.index <= 90).pop();
    if (!verb) continue;
    if (NOT_CREATION_RE.test(value.slice(0, found.index))) continue;
    // "word" sendiri sering berarti "kata" (mis. "500 word essay"); wajib langsung setelah kata kerja.
    const between = value.slice(verb.index + verb[0].length, found.index);
    if (format === "docx" && /^word$/i.test(found[0]) && !/^\s*(?:(?:sebuah|satu|a|an|me|aku|saya|kan|in|dong|tolong)\s+)*$/i.test(between)) continue;
    return format;
  }
  const imageMatch = value.match(IMAGE_REQUEST_RE) || value.match(DRAW_REQUEST_RE);
  if (imageMatch) {
    const after = value.slice(imageMatch.index + imageMatch[0].length);
    if (EXISTING_FILE_RE.test(after)) return "";
    if (NOT_CREATION_RE.test(value.slice(0, imageMatch.index + imageMatch[0].length))) return "";
    return "image";
  }
  return "";
}
const VISION_MODEL_PATTERN = /vision|vl\b|-vl-|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|gemma-3|llama-4|pixtral|llava|qwen2\.5-vl|qwen3-vl|minicpm-v|grok-4|grok-2-vision|nemotron-nano.*vl|kimi-vl/i;

let settings = loadSettings();
const savedTaskMode = localStorage.getItem("myai_task_mode");
let taskMode = savedTaskMode === "general" ? "auto"
  : ["auto", "chat", "coding", "flash", "pro", "max", "image"].includes(savedTaskMode) ? savedTaskMode
    : "auto";
let currentUser = null;
let manualApiKeys = {};
let chats = [];
let workFolders = loadWorkFolders();
const collapsedWorkFolders = new Set();
let chat = newChat();
let abort = null;
let premiumConfirmResolve = null;
let pendingFiles = [];
let composerMode = "";
let processingFiles = false;
let sendAfterProcessing = false;
let stickToBottom = true;
let speakingMessageId = "";
let recognition = null;
let guestTrialRemaining = null;
let guestTrialVersion = 0;
let voiceConversationEnabled = false;
let voiceSubmitTimer = 0;
let voiceSubmitting = false;
let voiceMuted = false;
let voiceTimerId = 0;
let voiceStartedAt = 0;
let voiceRecognitionFailures = 0;
const VOICE_MAX_RECONNECT_ATTEMPTS = 5;
let voiceRecognitionBlocked = false;
let voiceMicrophonePermissionGranted = false;
let voiceRecognitionRetryTimer = 0;
let voiceRecognitionStarting = false;
let voiceRecognitionStartId = 0;
let videoStream = null;
let videoCaptureInProgress = false;

let modelGroups = [];
let models = new Map();
let serverProviders = [];
let serverApiError = "";
let selected = "";
let modelsToken = 0;
let expandedModelTier = "free";
let expandedModelBrand = "";
let lastAuthUid = null;

const BRAND_STRIP = ["qwen", "deepseek", "gemini", "claude", "gpt", "llama", "mistral", "grok", "kimi", "gemma"];

function newChat(mode = taskMode) {
  return { id: crypto.randomUUID(), title: "Chat baru", taskMode: mode, messages: [], updatedAt: Date.now() };
}

function chatMode(item) {
  return !item.taskMode || item.taskMode === "general" ? "auto" : item.taskMode;
}

function loadWorkFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORK_FOLDERS_KEY) || "[]");
    return Array.isArray(saved)
      ? saved.filter((folder) => folder && typeof folder.id === "string" && typeof folder.name === "string")
      : [];
  } catch {
    return [];
  }
}

function saveWorkFolders() {
  localStorage.setItem(WORK_FOLDERS_KEY, JSON.stringify(workFolders));
}

function restoreChatFolders() {
  let changed = false;
  for (const item of chats) {
    if (!item.folderId || typeof item.folderName !== "string" || !item.folderName.trim()) continue;
    if (!workFolders.some((folder) => folder.id === item.folderId)) {
      workFolders.push({ id: item.folderId, name: item.folderName.trim() });
      changed = true;
    }
  }
  if (changed) {
    try {
      saveWorkFolders();
    } catch (error) {
      toast("Nama folder dari chat tersinkron, tetapi gagal disimpan di browser: " + error.message);
    }
  }
}

// ---------- Logo ----------

function logoEl(text, label, small = false) {
  const span = document.createElement("span");
  span.className = "mlogo" + (small ? " sm" : "");
  const brand = brandOf(text);
  const fallback = () => (span.textContent = (label || "?").trim()[0].toUpperCase());
  if (!brand) {
    fallback();
    return span;
  }
  const img = new Image();
  img.src = brand.src;
  img.alt = "";
  img.loading = "lazy";
  if (brand.mono) img.className = "mono";
  img.onerror = () => {
    img.remove();
    fallback();
  };
  span.append(img);
  return span;
}

// ---------- Rendering ----------

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

let purifyHooked = false;
function hookPurify() {
  if (purifyHooked || !window.DOMPurify) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href") && !node.getAttribute("href").startsWith("#")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifyHooked = true;
}

// Rumus disembunyikan dari marked agar backslash dan underscore LaTeX tidak dirusak.
function extractMath(source) {
  const math = [];
  const stash = (raw, tex, display) => {
    math.push({ raw, tex, display });
    return `%%KX${math.length - 1}%%`;
  };
  const text = source.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g).map((part, index) => {
    if (index % 2) return part;
    return part
      .replace(/\$\$([\s\S]+?)\$\$/g, (raw, tex) => stash(raw, tex, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (raw, tex) => stash(raw, tex, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (raw, tex) => stash(raw, tex, false))
      .replace(/\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)/g, (raw, tex) => stash(raw, tex, false));
  }).join("");
  return { text, math };
}

function renderMath({ raw, tex, display }) {
  if (!window.katex) return escapeHtml(raw);
  try {
    return katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
  } catch {
    return escapeHtml(raw);
  }
}

function md(source) {
  hookPurify();
  const { text, math } = extractMath(source || "");
  const html = DOMPurify.sanitize(marked.parse(text));
  return math.length ? html.replace(/%%KX(\d+)%%/g, (_, index) => renderMath(math[Number(index)])) : html;
}

function thinkingIndicatorHTML(label = "Sedang berpikir") {
  return `<div class="ai-thinking" role="status" aria-live="polite"><span class="ai-thinking-orbit" aria-hidden="true"><i></i></span><span class="ai-thinking-text">${escapeHtml(label)}…</span></div>`;
}

function renderContent(m) {
  let think = m.reasoning || "";
  const text = (m.content || "").replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, t) => {
    think += t;
    return "";
  });
  let html = "";
  if (think.trim()) html += `<details class="think"><summary>Proses berpikir</summary>${md(think)}</details>`;
  html += md(text);
  return html;
}

function appendCitations(body, citations = []) {
  const unique = [...new Map(citations.filter((item) => /^https?:\/\//i.test(item.url)).map((item) => [item.url, item])).values()];
  if (!unique.length) return;
  const section = document.createElement("section");
  section.className = "citations";
  const title = document.createElement("strong");
  title.textContent = "Sumber";
  const list = document.createElement("ul");
  for (const citation of unique) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = new URL(citation.url).href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = citation.title || new URL(citation.url).hostname;
    item.append(link);
    list.append(item);
  }
  section.append(title, list);
  body.append(section);
}

// Sandbox tanpa allow-same-origin membuat localStorage melempar error; shim menjaga skrip proyek tetap jalan.
const PREVIEW_SHIM = `<script>(function(){
function mem(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("__t")}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}});
try{document.cookie}catch(e){try{Object.defineProperty(document,"cookie",{get:function(){return""},set:function(){},configurable:true})}catch(_){}}
window.addEventListener("submit",function(e){var a=e.target&&e.target.getAttribute&&e.target.getAttribute("action");if(!e.defaultPrevented&&!/^https?:/i.test(a||""))e.preventDefault();});
window.addEventListener("click",function(e){var l=e.target&&e.target.closest&&e.target.closest("a[href]");if(!l||e.defaultPrevented||l.target==="_blank")return;var h=l.getAttribute("href")||"";if(h.charAt(0)==="#"){var t=h.length>1&&document.getElementById(decodeURIComponent(h.slice(1)));e.preventDefault();if(t)t.scrollIntoView({behavior:"smooth"});else if(h==="#")window.scrollTo({top:0,behavior:"smooth"});return;}if(!/^(https?:|mailto:|tel:|javascript:)/i.test(h))e.preventDefault();});
function show(m){try{var b=document.getElementById("__myai_err");if(!b){b=document.createElement("div");b.id="__myai_err";b.style.cssText="position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#b42318;color:#fff;font:12px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer";b.title="Klik untuk menutup";b.onclick=function(){b.remove()};(document.body||document.documentElement).appendChild(b);}b.textContent="Error di kode pratinjau: "+m;}catch(_){}}
window.addEventListener("error",function(e){if(e.message)show(e.message+(e.lineno?" (baris "+e.lineno+")":""));});
window.addEventListener("unhandledrejection",function(e){show(String(e.reason&&e.reason.message||e.reason));});
})();<\/script>`;

let previewSource = "";
let previewReturnFocus = null;

function codeBlocksOf(container) {
  return [...(container?.querySelectorAll("pre code") || [])].map((code) => ({
    lang: (code.className.match(/language-([\w+#.-]+)/)?.[1] || "").toLowerCase(),
    source: code.textContent,
  }));
}

function buildPreviewDocument(source, container) {
  let html = String(source || "");
  const blocks = codeBlocksOf(container);
  const css = blocks.filter((block) => ["css", "scss"].includes(block.lang)).map((block) => block.source).join("\n\n");
  const js = blocks.filter((block) => ["js", "javascript", "mjs"].includes(block.lang)).map((block) => block.source).join("\n\n");
  const isLocal = (url) => url && !/^(?:[a-z]+:)?\/\//i.test(url) && !/^data:/i.test(url);
  let usedCss = false;
  let usedJs = false;
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']?([^"'\s>]+)/i)?.[1];
    if (!isLocal(href)) return tag;
    if (css && !usedCss) {
      usedCss = true;
      return `<style>\n${css}\n</style>`;
    }
    return "";
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']?([^"'\s>]+)["']?([^>]*)>\s*<\/script>/gi, (tag, before, src, after) => {
    if (!isLocal(src)) return tag;
    if (js && !usedJs) {
      usedJs = true;
      const module = /type=["']?module/i.test(before + after) ? ' type="module"' : "";
      return `<script${module}>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>`;
    }
    return "";
  });
  if (css && !usedCss && !/<style[\s>]/i.test(html)) {
    const tag = `<style>\n${css}\n</style>`;
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, () => `${tag}\n</head>`) : `${tag}\n${html}`;
  }
  if (js && !usedJs && !/<script[\s>]/i.test(html)) {
    const tag = `<script>\n${js.replace(/<\/script/gi, "<\\/script")}\n</script>`;
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${tag}\n</body>`) : `${html}\n${tag}`;
  }
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${PREVIEW_SHIM}`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${head}`);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${head}</head>`);
  return `<!DOCTYPE html><html lang="id"><head>${head}</head><body>${html}</body></html>`;
}

function openHtmlPreview(source, container) {
  previewReturnFocus = document.activeElement;
  previewSource = buildPreviewDocument(source, container);
  const title = previewSource.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim();
  $("htmlPreviewTitle").textContent = title ? `Pratinjau · ${title}` : "Pratinjau";
  $("htmlPreviewFrame").srcdoc = previewSource;
  const dialog = $("htmlPreviewDialog");
  if (!dialog.open) dialog.showModal();
  $("closeHtmlPreview").focus();
}

function enhance(body) {
  body.querySelectorAll("pre code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.dataset.enhanced) return;
    pre.dataset.enhanced = "1";
    const lang = (code.className.match(/language-([\w+#.-]+)/)?.[1] || "").toLowerCase();
    if (window.hljs) hljs.highlightElement(code);
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = lang || "kode";
    const actions = document.createElement("div");
    actions.className = "code-actions";
    const source = code.textContent;
    if (["html", "htm", "svg"].includes(lang) || (lang === "xml" && /<svg[\s>]/i.test(source))) {
      const preview = document.createElement("button");
      preview.className = "copy-btn";
      preview.type = "button";
      preview.textContent = "▶ Pratinjau";
      preview.onclick = () => openHtmlPreview(source, body);
      actions.append(preview);
    }
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "Salin";
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(source);
        btn.textContent = "Tersalin!";
      } catch {
        btn.textContent = "Gagal";
      }
      setTimeout(() => (btn.textContent = "Salin"), 1500);
    };
    actions.append(btn);
    head.append(label, actions);
    pre.append(head);
  });
}

function cleanAnswerText(content) {
  return String(content || "").replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
}

function speakableText(content) {
  const holder = document.createElement("div");
  holder.innerHTML = DOMPurify.sanitize(marked.parse(cleanAnswerText(content).replace(/```[\s\S]*?```/g, " (blok kode) ")));
  return holder.textContent.replace(/\s+/g, " ").trim();
}

function stopSpeaking() {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  speakingMessageId = "";
  document.querySelectorAll(".message-tool-btn.speaking").forEach((button) => {
    button.classList.remove("speaking");
    button.textContent = "🔊 Dengarkan";
  });
}

function speakMessage(message, button, onComplete = null) {
  if (!window.speechSynthesis) {
    toast("Browser ini belum mendukung fitur baca suara.");
    return;
  }
  const wasSpeaking = Boolean(message.id) && speakingMessageId === message.id;
  stopSpeaking();
  if (wasSpeaking) return;
  message.id ||= crypto.randomUUID();
  const text = speakableText(message.content);
  if (!text) {
    onComplete?.();
    return;
  }
  const chunks = text.match(/[^.!?。\n]{1,220}(?:[.!?。]+|$)/g) || [text];
  const savedVoiceLanguage = localStorage.getItem("myai_voice_language");
  const language = ["id-ID", "en-US"].includes(savedVoiceLanguage)
    ? savedVoiceLanguage
    : navigator.languages?.[0] || navigator.language || "id-ID";
  const languageBase = language.split(/[-_]/)[0].toLowerCase();
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((item) => item.lang.toLowerCase() === language.toLowerCase())
    || voices.find((item) => item.lang.toLowerCase().startsWith(`${languageBase}-`))
    || null;
  speakingMessageId = message.id;
  if (button) {
    button.classList.add("speaking");
    button.textContent = "■ Berhenti";
  }
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk.trim());
    utterance.lang = voice?.lang || language;
    if (voice) utterance.voice = voice;
    if (index === chunks.length - 1) {
      utterance.onend = () => {
        if (speakingMessageId === message.id) stopSpeaking();
        onComplete?.();
      };
      utterance.onerror = () => onComplete?.();
    }
    speechSynthesis.speak(utterance);
  });
}

function startEditMessage(messageEl, message) {
  if (abort) return;
  const body = messageEl.querySelector(".body");
  const editor = document.createElement("div");
  editor.className = "message-editor";
  const area = document.createElement("textarea");
  area.value = message.content || "";
  area.rows = Math.min(12, Math.max(3, area.value.split("\n").length + 1));
  const actions = document.createElement("div");
  actions.className = "message-editor-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small ghost";
  cancel.textContent = "Batal";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn small primary";
  save.textContent = "Kirim ulang";
  actions.append(cancel, save);
  editor.append(area, actions);
  body.classList.add("hidden");
  messageEl.querySelector(".message-tools")?.classList.add("hidden");
  messageEl.insertBefore(editor, body);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  cancel.onclick = () => renderMessages();
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") renderMessages();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save.click();
  });
  save.onclick = async () => {
    const nextText = area.value.trim();
    if (!nextText || abort) return;
    const index = chat.messages.indexOf(message);
    if (index < 0) return;
    const attachmentContext = typeof message.modelContent === "string" && message.modelContent.startsWith(message.content)
      ? message.modelContent.slice(message.content.length)
      : "";
    message.content = nextText;
    message.modelContent = nextText + attachmentContext;
    const nextIntent = ["coding", "image"].includes(taskMode) ? "" : detectCreationIntent(nextText);
    if (nextIntent) message.intent = nextIntent;
    else delete message.intent;
    chat.messages.splice(index + 1);
    if (index === 0) chat.title = nextText.slice(0, 48);
    stickToBottom = true;
    renderMessages();
    await respond();
  };
}

function appendMessageActions(messageEl, message) {
  if (!messageEl || messageEl.querySelector(".message-tools")) return;
  if (message.role === "user") {
    const tools = document.createElement("div");
    tools.className = "message-tools user-tools";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "message-tool-btn";
    copy.textContent = "⧉";
    copy.title = "Salin pertanyaan";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.content || "");
        toast("Pertanyaan disalin.");
      } catch {
        toast("Clipboard tidak tersedia.");
      }
    };
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "message-tool-btn";
    edit.textContent = "✎";
    edit.title = "Edit lalu kirim ulang";
    edit.onclick = () => startEditMessage(messageEl, message);
    tools.append(copy, edit);
    messageEl.append(tools);
    return;
  }
  if (message.role !== "assistant" || !message.content) return;
  const tools = document.createElement("div");
  tools.className = "message-tools";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-tool-btn";
  copy.textContent = "⧉ Salin";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(cleanAnswerText(message.content));
      copy.textContent = "✓ Tersalin";
      setTimeout(() => { copy.textContent = "⧉ Salin"; }, 1400);
    } catch {
      toast("Clipboard tidak tersedia. Coba buka aplikasi melalui localhost atau HTTPS.");
    }
  };
  tools.append(copy);
  if (!message.error && window.speechSynthesis) {
    const speak = document.createElement("button");
    speak.type = "button";
    speak.className = "message-tool-btn";
    const active = speakingMessageId === message.id;
    speak.classList.toggle("speaking", active);
    speak.textContent = active ? "■ Berhenti" : "🔊 Dengarkan";
    speak.onclick = () => speakMessage(message, speak);
    tools.append(speak);
  }
  if (!message.error) {
    const exportWrap = document.createElement("div");
    exportWrap.className = "message-export";
    const exportToggle = document.createElement("button");
    exportToggle.type = "button";
    exportToggle.className = "message-tool-btn";
    exportToggle.textContent = "↓ Ekspor";
    exportToggle.setAttribute("aria-haspopup", "menu");
    exportToggle.setAttribute("aria-expanded", "false");
    const exportMenu = document.createElement("div");
    exportMenu.className = "message-export-menu hidden";
    exportMenu.setAttribute("role", "menu");
    for (const [format, label] of [["docx", "Word (.docx)"], ["pptx", "PowerPoint (.pptx)"], ["xlsx", "Excel (.xlsx)"], ["pdf", "PDF (.pdf)"]]) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "message-export-option";
      option.setAttribute("role", "menuitem");
      option.textContent = label;
      option.onclick = async () => {
        exportMenu.classList.add("hidden");
        exportToggle.setAttribute("aria-expanded", "false");
        exportToggle.disabled = true;
        exportToggle.textContent = "Menyiapkan…";
        try {
          await exportAssistantDocument({ content: message.content, title: chat.title, citations: message.citations || [] }, format);
          toast(`${label} berhasil dibuat.`);
        } catch (error) {
          console.error("MyAI document export failed:", error);
          const detail = String(error?.message || error || "Kesalahan tidak diketahui").replace(/\s+/g, " ").slice(0, 180);
          toast(`Gagal membuat ${label}: ${detail}. Pastikan koneksi internet aktif dan coba lagi.`);
        } finally {
          exportToggle.disabled = false;
          exportToggle.textContent = "↓ Ekspor";
        }
      };
      exportMenu.append(option);
    }
    exportToggle.onclick = () => {
      const opening = exportMenu.classList.contains("hidden");
      exportMenu.classList.toggle("hidden", !opening);
      exportToggle.setAttribute("aria-expanded", String(opening));
    };
    exportWrap.append(exportToggle, exportMenu);
    tools.append(exportWrap);
  }
  // "Jawab ulang" hanya untuk balasan terakhir, seperti AI pada umumnya.
  if (chat.messages[chat.messages.length - 1] === message) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "message-tool-btn";
    retry.textContent = "↻ Jawab ulang";
    retry.onclick = () => regenerate();
    tools.append(retry);
  }
  messageEl.append(tools);
}

function openFilePreview(name, content = "", image = "") {
  const dialog = $("filePreviewDialog");
  const preview = $("filePreviewContent");
  $("filePreviewTitle").textContent = name || "Pratinjau file";
  preview.replaceChildren();
  if (image && /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,/i.test(image)) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = `Pratinjau ${name}`;
    preview.append(img);
  } else {
    const text = document.createElement("pre");
    text.textContent = content || "Pratinjau isi file tidak tersedia untuk percakapan lama ini.";
    preview.append(text);
  }
  dialog.showModal();
}

function attachmentContent(message, name) {
  const source = typeof message.modelContent === "string" ? message.modelContent : "";
  const marker = `\n\n[File: ${name}]\n`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const contentStart = start + marker.length;
  const nextFile = source.indexOf("\n\n[File: ", contentStart);
  return source.slice(contentStart, nextFile < 0 ? source.length : nextFile);
}

function bubble(m) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}${m.error ? " error" : ""}`;
  if (m.role === "assistant" && m.model) {
    const label = document.createElement("div");
    label.className = "label";
    const name = document.createElement("span");
    name.textContent = m.model;
    label.append(logoEl(`${m.modelId || ""} ${m.model}`, m.model, true), name);
    el.append(label);
  }
  const body = document.createElement("div");
  body.className = "body";
  if (m.role === "user") {
    // Migrate older messages that had raw file contents appended to the visible prompt.
    let visibleText = m.content || "";
    let attachmentNames = Array.isArray(m.attachments) ? m.attachments : [];
    if (!attachmentNames.length && typeof visibleText === "string" && /\n\n\[File: [^\]]+\]\n/.test(visibleText)) {
      const firstFile = visibleText.search(/\n\n\[File: [^\]]+\]\n/);
      attachmentNames = [...visibleText.matchAll(/\n\n\[File: ([^\]]+)\]\n/g)].map((match) => match[1]);
      visibleText = visibleText.slice(0, firstFile).trim();
    }
    // Only the question is rendered, as compact file chips. Contents stay in modelContent.
    if (attachmentNames.length) {
      const chips = document.createElement("div");
      chips.className = "message-attachments";
      chips.setAttribute("aria-label", `${attachmentNames.length} file dilampirkan`);
      const details = Array.isArray(m.attachmentDetails)
        ? m.attachmentDetails
        : attachmentNames.map((name) => ({ name }));
      const shown = details.slice(0, 6);
      for (const detail of shown) {
        const fullName = typeof detail === "string" ? detail : detail.name;
        const image = Number.isInteger(detail.imageIndex) ? m.images?.[detail.imageIndex] || "" : "";
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "file-chip" + (image ? " has-thumb" : "");
        chip.title = fullName;
        if (image) {
          const thumb = document.createElement("img");
          thumb.className = "fc-thumb";
          thumb.src = image;
          thumb.alt = "";
          chip.append(thumb);
        } else {
          const icon = document.createElement("span");
          icon.className = "fc-icon";
          icon.textContent = fileIcon(fullName);
          chip.append(icon);
        }
        const label = document.createElement("span");
        label.className = "fc-name";
        label.textContent = String(fullName).split("/").pop();
        chip.append(label);
        chip.onclick = () => openFilePreview(fullName, attachmentContent(m, fullName), image);
        chips.append(chip);
      }
      if (details.length > shown.length) {
        const more = document.createElement("span");
        more.className = "message-attachments-more";
        more.textContent = `+${details.length - shown.length} file lainnya`;
        more.title = attachmentNames.slice(shown.length).join("\n");
        chips.append(more);
      }
      body.append(chips);
    }
    const textEl = document.createElement("span");
    textEl.textContent = visibleText || (attachmentNames.length ? "Tolong analisis lampiran yang saya kirim." : "");
    body.append(textEl);
  } else {
    body.innerHTML = renderContent(m);
    appendCitations(body, m.citations);
    enhance(body);
  }
  el.append(body);
  appendGeneratedImages(body, m);
  appendDocumentCard(body, m);
  appendMessageActions(el, m);
  return el;
}

const FILE_ICONS = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|heic)$/i, "🖼️"],
  [/\.pdf$/i, "📕"],
  [/\.(docx?|odt|rtf)$/i, "📘"],
  [/\.(xlsx?|csv|ods|tsv)$/i, "📊"],
  [/\.(pptx?|odp)$/i, "📽️"],
  [/\.(zip|rar|7z|tar|gz)$/i, "🗜️"],
  [/\.(js|mjs|ts|jsx|tsx|py|java|kt|go|rs|rb|php|c|cpp|cs|h|swift|css|scss|html?|vue|svelte|json|sql|ya?ml|xml|sh|toml|ini)$/i, "📜"],
];

function fileIcon(name) {
  return (FILE_ICONS.find(([pattern]) => pattern.test(String(name))) || [null, "📄"])[1];
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadImage(src, filename) {
  try {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    window.open(src, "_blank", "noopener");
  }
}

function appendGeneratedImages(body, message) {
  const sources = [...(message.generatedImages || [])];
  [...new Set(sources)].forEach((src, index) => {
    if (!/^(https:\/\/|data:image\/)/i.test(src)) return;
    const figure = document.createElement("figure");
    figure.className = "generated-figure";
    const image = document.createElement("img");
    image.className = "generated-image";
    image.src = src;
    image.alt = `Gambar hasil ${index + 1}`;
    image.loading = "lazy";
    image.onclick = () => window.open(src, "_blank", "noopener");
    const download = document.createElement("button");
    download.type = "button";
    download.className = "btn small";
    download.textContent = "↓ Unduh gambar";
    download.onclick = () => downloadImage(src, `myai-gambar-${Date.now()}.jpg`);
    figure.append(image, download);
    body.append(figure);
  });
}

function appendDocumentCard(body, message) {
  const format = CREATION_FORMATS[message.document?.format];
  if (!format) return null;
  const card = document.createElement("div");
  card.className = "doc-card";
  const icon = document.createElement("span");
  icon.className = "doc-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = format.icon;
  const text = document.createElement("span");
  text.className = "doc-card-text";
  const name = document.createElement("b");
  name.textContent = `File ${format.label} siap`;
  const detail = document.createElement("span");
  detail.textContent = `Dibuat otomatis dari jawaban ini · ${format.ext}`;
  text.append(name, detail);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn small primary";
  button.textContent = `↓ Unduh ${format.ext}`;
  button.onclick = () => downloadDocument(message, button);
  card.append(icon, text, button);
  body.append(card);
  return button;
}

async function downloadDocument(message, button) {
  const format = CREATION_FORMATS[message.document?.format];
  if (!format) return;
  const idleLabel = `↓ Unduh ${format.ext}`;
  if (button) {
    button.disabled = true;
    button.textContent = "Menyiapkan…";
  }
  try {
    await exportAssistantDocument({ content: message.content, title: chat.title, citations: message.citations || [] }, message.document.format);
    toast(`File ${format.label} (${format.ext}) berhasil dibuat dan diunduh.`);
  } catch (error) {
    console.error("MyAI document export failed:", error);
    const detail = String(error?.message || error || "Kesalahan tidak diketahui").replace(/\s+/g, " ").slice(0, 180);
    toast(`Gagal membuat file ${format.label}: ${detail}. Periksa koneksi internet lalu tekan "${idleLabel}" lagi.`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = idleLabel;
    }
  }
}

function renderWelcome() {
  const wrap = document.createElement("div");
  wrap.className = "welcome";
  wrap.innerHTML = `<img src="assets/mark.svg" alt="" class="welcome-logo" /><h1>Halo! Aku <span class="brand-name"></span></h1><p class="muted">Asisten AI pribadimu. Tulis pertanyaan untuk memulai.</p>`;
  wrap.querySelector(".brand-name").textContent = APP_NAME;
  const strip = document.createElement("div");
  strip.className = "brand-strip";
  strip.setAttribute("aria-label", "Logo model AI yang tersedia");
  for (const brand of BRAND_STRIP) strip.append(logoEl(brand, brand));
  const quick = document.createElement("div");
  quick.className = "quick-create";
  quick.setAttribute("aria-label", "Buat cepat");
  for (const [icon, label, prompt] of [
    ["▧", "Buat gambar", "Buatkan gambar "],
    ["📽️", "Buat PPT", "Buatkan presentasi PowerPoint tentang "],
    ["📘", "Buat Word", "Buatkan dokumen Word tentang "],
    ["📊", "Buat Excel", "Buatkan file Excel berisi "],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-create-btn";
    const iconEl = document.createElement("span");
    iconEl.setAttribute("aria-hidden", "true");
    iconEl.textContent = icon;
    button.append(iconEl, document.createTextNode(label));
    button.onclick = () => {
      if (["coding", "image"].includes(taskMode)) setTaskMode("auto", false);
      const input = $("input");
      input.value = prompt;
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      input.focus();
      input.setSelectionRange(prompt.length, prompt.length);
      saveDraft();
      updateSendBtn();
    };
    quick.append(button);
  }
  wrap.append(strip, quick);
  $("messages").append(wrap);
}

function renderMessages() {
  $("messages").innerHTML = "";
  const empty = !chat.messages.length;
  $("chatWrap").classList.toggle("empty", empty);
  if (empty) renderWelcome();
  else for (const m of chat.messages) $("messages").append(bubble(m));
  updateTopbar();
  stickToBottom = true;
  scrollBottom(true);
}

function scrollBottom(force = false) {
  const box = $("messages");
  const wrap = $("chatWrap");
  if (!force && !stickToBottom) {
    $("scrollDown").classList.remove("hidden");
    return;
  }
  if (wrap.classList.contains("empty")) wrap.scrollTop = wrap.scrollHeight;
  box.scrollTop = box.scrollHeight;
  $("scrollDown").classList.add("hidden");
}

function updateTopbar() {
  const hasMessages = chat.messages.length > 0;
  $("chatTitle").textContent = hasMessages ? chat.title : "";
  $("chatTitle").title = hasMessages ? chat.title : "";
  $("shareChat").classList.toggle("hidden", !hasMessages);
  $("exportChat").classList.toggle("hidden", !hasMessages);
}

function chatAsMarkdown(item) {
  const lines = [`# ${item.title}`, "", `_Diekspor dari ${APP_NAME} · ${new Date(item.updatedAt || Date.now()).toLocaleString("id-ID")}_`, ""];
  for (const message of item.messages || []) {
    if (message.role === "user") {
      lines.push("## 🧑 Kamu", "", message.content || "");
      if (message.attachments?.length) lines.push("", `_Lampiran: ${message.attachments.join(", ")}_`);
    } else {
      lines.push(`## 🤖 ${message.model || APP_NAME}`, "", cleanAnswerText(message.content));
      for (const src of message.generatedImages || []) lines.push("", `![Gambar](${src})`);
      const citations = (message.citations || []).filter((citation) => citation?.url);
      if (citations.length) lines.push("", "Sumber:", ...citations.map((citation) => `- [${citation.title || citation.url}](${citation.url})`));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function downloadText(filename, text, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function safeFilename(name) {
  return String(name || "chat").replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 60) || "chat";
}

function renderChatList() {
  const list = $("chatList");
  list.innerHTML = "";
  const query = $("chatSearch").value.trim().toLowerCase();
  const visibleChats = chats.filter((item) => !query
    || String(item.title || "").toLowerCase().includes(query)
    || (item.messages || []).some((message) => String(message.content || "").toLowerCase().includes(query)));
  if (!visibleChats.length) {
    const empty = document.createElement("p");
    empty.className = "chat-list-empty";
    empty.textContent = query ? "Tidak ada chat yang cocok." : "Belum ada riwayat chat.";
    list.append(empty);
  }

  const renameChat = async (c) => {
    const nextTitle = prompt("Ganti nama chat:", c.title)?.trim();
    if (!nextTitle || nextTitle === c.title) return;
    const updated = { ...c, title: nextTitle.slice(0, 80) };
    const syncError = await saveChat(durableChat(updated));
    chats = chats.map((existing) => existing.id === c.id ? { ...existing, title: updated.title } : existing);
    if (chat.id === c.id) chat.title = updated.title;
    if (syncError) notifySyncError("Nama chat diganti di perangkat, sinkron cloud tertunda", syncError);
    renderChatList();
    updateTopbar();
  };

  const renderChatItem = (c, parent) => {
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === chat.id ? " active" : "");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = c.title;
    title.title = c.title;
    title.ondblclick = (event) => {
      event.stopPropagation();
      void renameChat(c);
    };
    const rename = document.createElement("button");
    rename.className = "chat-folder-action";
    rename.type = "button";
    rename.title = "Ganti nama";
    rename.setAttribute("aria-label", `Ganti nama chat "${c.title}"`);
    rename.textContent = "✎";
    rename.onclick = (event) => {
      event.stopPropagation();
      void renameChat(c);
    };
    const move = document.createElement("button");
    move.className = "chat-folder-action";
    move.type = "button";
    move.title = "Pindahkan ke folder kerja";
    move.setAttribute("aria-label", `Pindahkan chat "${c.title}" ke folder kerja`);
    move.textContent = "▰";
    const moveMenu = document.createElement("div");
    moveMenu.className = "chat-folder-menu hidden";
    moveMenu.setAttribute("role", "menu");
    moveMenu.onclick = (event) => event.stopPropagation();
    const moveToFolder = async (folderId) => {
      const folder = workFolders.find((item) => item.id === folderId);
      const updated = { ...c, folderId: folderId || "", folderName: folder?.name || "" };
      try {
        const syncError = await saveChat(durableChat(updated));
        chats = chats.map((existing) => existing.id === c.id ? updated : existing);
        if (chat.id === c.id) {
          chat.folderId = updated.folderId;
          chat.folderName = updated.folderName;
        }
        if (syncError) notifySyncError("Chat dipindahkan di perangkat, sinkron cloud tertunda", syncError);
        renderChatList();
      } catch (error) {
        toast("Gagal memindahkan chat: " + error.message);
      }
    };
    const addMoveOption = (label, folderId) => {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitem");
      option.textContent = label;
      option.onclick = (event) => {
        event.stopPropagation();
        void moveToFolder(folderId);
      };
      moveMenu.append(option);
    };
    addMoveOption("Obrolan biasa", "");
    for (const folder of workFolders) addMoveOption(folder.name, folder.id);
    if (!workFolders.length) {
      const empty = document.createElement("span");
      empty.className = "chat-folder-empty";
      empty.textContent = "Buat folder kerja dulu";
      moveMenu.append(empty);
    }
    move.onclick = (event) => {
      event.stopPropagation();
      const wasOpen = !moveMenu.classList.contains("hidden");
      document.querySelectorAll(".chat-folder-menu").forEach((menu) => menu.classList.add("hidden"));
      moveMenu.classList.toggle("hidden", wasOpen);
    };
    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.title = "Hapus";
    del.textContent = "✕";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus chat "${c.title}"?`)) return;
      let syncError;
      try {
        syncError = await deleteChat(c.id);
      } catch (error) {
        toast("Gagal menghapus chat dari browser: " + error.message);
        return;
      }
      if (syncError) notifySyncError("Chat dihapus dari perangkat, penghapusan cloud tertunda", syncError);
      chats = chats.filter((x) => x.id !== c.id);
      if (c.id === chat.id) chat = newChat(taskMode);
      renderChatList();
      renderMessages();
    };
    item.append(title, rename, move, del, moveMenu);
    item.onclick = () => {
      if (abort) return;
      stopSpeaking();
      chat = structuredClone(c);
      chat.taskMode = chatMode(chat);
      renderChatList();
      renderMessages();
      closeSidebar();
    };
    parent.append(item);
  };

  const renderSection = (label, sectionChats, { folder = null, canCollapse = false } = {}) => {
    const section = document.createElement("section");
    section.className = "chat-section";
    const heading = document.createElement("div");
    heading.className = "chat-section-heading";
    if (canCollapse) {
      const toggle = document.createElement("button");
      toggle.className = "chat-section-toggle";
      toggle.type = "button";
      const collapsed = collapsedWorkFolders.has(folder.id);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.textContent = `${collapsed ? "›" : "⌄"} ${label} (${sectionChats.length})`;
      toggle.onclick = () => {
        if (collapsed) collapsedWorkFolders.delete(folder.id);
        else collapsedWorkFolders.add(folder.id);
        renderChatList();
      };
      heading.append(toggle);
      const remove = document.createElement("button");
      remove.className = "chat-folder-remove";
      remove.type = "button";
      remove.title = `Hapus folder "${folder.name}"`;
      remove.setAttribute("aria-label", `Hapus folder "${folder.name}"`);
      remove.textContent = "×";
      remove.onclick = async () => {
        if (!confirm(`Hapus folder "${folder.name}"? Chat di dalamnya akan kembali ke obrolan biasa.`)) return;
        const movedChats = chats.filter((item) => item.folderId === folder.id);
        try {
          for (const movedChat of movedChats) {
            const updated = { ...movedChat, folderId: "", folderName: "" };
            const syncError = await saveChat(durableChat(updated));
            if (syncError) notifySyncError("Folder dihapus di perangkat, sinkron cloud tertunda", syncError);
            chats = chats.map((existing) => existing.id === updated.id ? updated : existing);
            if (chat.id === updated.id) {
              chat.folderId = "";
              chat.folderName = "";
            }
          }
          workFolders = workFolders.filter((item) => item.id !== folder.id);
          collapsedWorkFolders.delete(folder.id);
          saveWorkFolders();
          renderChatList();
        } catch (error) {
          toast("Gagal menghapus folder: " + error.message);
        }
      };
      heading.append(remove);
    } else {
      const labelElement = document.createElement("span");
      labelElement.textContent = `${label} (${sectionChats.length})`;
      heading.append(labelElement);
    }
    section.append(heading);
    if (!canCollapse || !collapsedWorkFolders.has(folder.id)) {
      const content = document.createElement("div");
      content.className = "chat-section-content";
      for (const sectionChat of sectionChats) renderChatItem(sectionChat, content);
      section.append(content);
    }
    list.append(section);
  };

  for (const folder of workFolders) {
    renderSection(folder.name, visibleChats.filter((item) => item.folderId === folder.id), { folder, canCollapse: true });
  }
  const unfiledChats = visibleChats
    .filter((item) => !workFolders.some((folder) => folder.id === item.folderId))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const buckets = [
    ["Hari ini", (time) => time >= startOfToday],
    ["Kemarin", (time) => time >= startOfToday - day],
    ["7 hari terakhir", (time) => time >= startOfToday - 7 * day],
    ["30 hari terakhir", (time) => time >= startOfToday - 30 * day],
    ["Lebih lama", () => true],
  ];
  const grouped = new Map(buckets.map(([label]) => [label, []]));
  for (const item of unfiledChats) {
    const [label] = buckets.find(([, test]) => test(item.updatedAt || 0));
    grouped.get(label).push(item);
  }
  for (const [label, items] of grouped) if (items.length) renderSection(label, items);
}

function openWorkFolderDialog() {
  $("workFolderError").classList.add("hidden");
  $("workFolderName").value = "";
  $("workFolderDialog").showModal();
  $("workFolderName").focus();
}

function createWorkFolder(event) {
  event.preventDefault();
  const normalized = $("workFolderName").value.trim();
  if (!normalized) {
    $("workFolderError").textContent = "Nama folder tidak boleh kosong.";
    $("workFolderError").classList.remove("hidden");
    return;
  }
  if (normalized.length > 60) {
    $("workFolderError").textContent = "Nama folder maksimal 60 karakter.";
    $("workFolderError").classList.remove("hidden");
    return;
  }
  if (workFolders.some((folder) => folder.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    $("workFolderError").textContent = "Folder dengan nama tersebut sudah ada.";
    $("workFolderError").classList.remove("hidden");
    return;
  }
  workFolders.push({ id: crypto.randomUUID(), name: normalized });
  try {
    saveWorkFolders();
  } catch (error) {
    workFolders.pop();
    $("workFolderError").textContent = "Folder gagal disimpan di browser: " + error.message;
    $("workFolderError").classList.remove("hidden");
    return;
  }
  $("workFolderDialog").close();
  renderChatList();
}

function renderAccount(user) {
  const box = $("account");
  box.innerHTML = "";
  if (!firebaseEnabled) {
    box.textContent = "Mode lokal (Firebase belum disetel)";
    return;
  }
  if (!user) {
    const btn = document.createElement("button");
    btn.className = "btn block";
    btn.textContent = "Masuk dengan Google";
    btn.onclick = async () => {
      try {
        await signIn();
      } catch (e) {
        if (/popup-closed-by-user|cancelled-popup-request|cancelled/.test(e.code || e.message)) return;
        toast("Gagal masuk: " + explainFirebaseAuthError(e));
      }
    };
    box.append(btn);
    return;
  }
  if (user.photoURL) {
    const img = document.createElement("img");
    img.src = user.photoURL;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    box.append(img);
  }
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = user.displayName || user.email;
  const out = document.createElement("button");
  out.className = "btn small ghost";
  out.textContent = "Keluar";
  out.onclick = () => signOutUser();
  box.append(name, out);
}

let toastTimer;
function hideToast() {
  const t = $("toast");
  t.classList.add("hidden");
  if (t.matches?.(":popover-open")) t.hidePopover();
}
function toast(msg, variant = "") {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("welcome-toast", variant === "welcome");
  t.classList.remove("hidden");
  if (typeof t.showPopover === "function") {
    // Popover masuk top layer sehingga tetap terlihat di atas dialog modal yang terbuka.
    if (!t.hasAttribute("popover")) t.setAttribute("popover", "manual");
    if (t.matches(":popover-open")) t.hidePopover();
    t.showPopover();
  }
  t.onclick = hideToast;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, Math.min(12000, 4000 + String(msg).length * 40));
}

function explainAIError(error) {
  const message = error?.message || String(error);
  const status = Number(message.match(/(?:^|\s)(\d{3}):/)?.[1]);
  if (/jatah dua jawaban|dua jawaban.*habis|guest.*login/i.test(message)) {
    return "Jatah dua jawaban gratis tanpa login sudah habis. Masuk dengan Google untuk melanjutkan.";
  }
  if (status === 401 && /api.?key|invalid key|expired|unauthorized|authentication/i.test(message)) {
    return "API key ditolak atau kedaluwarsa. MyAI sedang mencari provider Gratis lain.";
  }
  if (status === 401 && /^(?:HTTP\s+)?401:\s*(?:OpenRouter|Gemini|Groq):/i.test(message)) {
    return "API key provider ditolak. Periksa key di secret AI_PROVIDER_KEYS pada Cloudflare.";
  }
  if (status === 401) return "Akses ditolak. Periksa sesi login Google dan konfigurasi Cloudflare Worker.";
  if (status === 403 && /^(?:HTTP\s+)?403:\s*(?:OpenRouter|Gemini|Groq):/i.test(message)) {
    return "Provider menolak permintaan atau model ini tidak tersedia untuk akun provider.";
  }
  if (status === 403) return "Email ini belum diizinkan memakai API server.";
  if (status === 404 && /^(?:HTTP\s+)?404:\s*(?:OpenRouter|Gemini|Groq):/i.test(message)) {
    return `Provider tidak menyediakan model ini. Detail: ${message.replace(/^(?:HTTP\s+)?404:\s*/i, "")}`;
  }
  if (status === 404) return "Model tidak ditemukan atau tidak tersedia untuk akun ini. Pilih model lain.";
  if (status === 402) return "Kuota atau masa layanan provider habis. MyAI sedang mencari provider Gratis lain.";
  if (status === 429) return "Kuota/rate limit provider tercapai. MyAI sedang mencari provider Gratis lain.";
  if (/quota|billing|expired|payment required|insufficient balance/i.test(message)) {
    return "Kuota, saldo, atau masa layanan provider habis. MyAI sedang mencari provider Gratis lain.";
  }
  if (/failed to fetch|networkerror|load failed|api cloudflare pages tidak dapat dijangkau|koneksi ke api cloudflare pages melewati/i.test(message)) {
    return "API Cloudflare Pages tidak dapat dijangkau. Periksa koneksi jaringan dan status website.";
  }
  if (/cors/i.test(message)) return "Browser memblokir koneksi ke Cloudflare Worker. Periksa URL Worker dan pengaturan CORS.";
  return message;
}

// ---------- Pemilih model ----------

function updateModelBtn() {
  const m = models.get(selected);
  const logo = $("modelBtnLogo");
  if (!m) {
    logo.replaceWith(Object.assign(document.createElement("span"), { id: "modelBtnLogo", className: "mlogo", textContent: "?" }));
    $("modelBtnName").textContent = modelGroups.length ? "Pilih model" : "Model belum tersedia";
    $("modelBtnTier").textContent = "";
    return;
  }
  const el = logoEl(`${m.id} ${m.name}`, m.name);
  el.id = "modelBtnLogo";
  logo.replaceWith(el);
  $("modelBtnName").textContent = m.name;
  const group = modelGroups.find((item) => `${item.provider}::${item.label}` === `${m.provider}::${m.groupLabel}`);
  const cost = modelPriceTier(m, group || {}) === "free" ? "GRATIS" : "CEK TARIF";
  const category = modelTierCategory(m, group || {});
  $("modelBtnTier").textContent = `${category.toUpperCase()} · ${cost}`;
  $("modelBtnTier").className = `model-btn-tier ${category}`;
}

function isCodingModel(model) {
  return /coder|coding|codegemma|codestral|devstral|starcoder|programmer/i.test(`${model.id} ${model.name}`)
    || modelTokens(model).has("code");
}

function isPaidModel(model) {
  if (model.priceTier === "free") return false;
  if (["premium", "check"].includes(model.priceTier)) return true;
  return /premium|berbayar/i.test(`${model.groupLabel || ""} ${model.tag || ""}`);
}

function confirmPremiumModel(model) {
  if (!isPaidModel(model)) return Promise.resolve(true);
  const dialog = $("premiumConfirmDialog");
  if (dialog.open || premiumConfirmResolve) return Promise.resolve(false);
  $("premiumConfirmMessage").textContent = `${model.name} (${model.groupLabel || model.provider}) memiliki biaya atau tarif yang tidak dapat dipastikan aplikasi.`;
  return new Promise((resolve) => {
    premiumConfirmResolve = resolve;
    dialog.showModal();
  });
}

function finishPremiumConfirm(accepted) {
  const resolve = premiumConfirmResolve;
  premiumConfirmResolve = null;
  const dialog = $("premiumConfirmDialog");
  if (dialog.open) dialog.close();
  resolve?.(accepted);
}

function modelBrand(model) {
  const identity = `${model.id || ""} ${model.name || ""}`.toLowerCase();
  const brands = [
    [/nvidia|nemotron/, "NVIDIA"],
    [/claude|anthropic/, "Anthropic"],
    [/gemini|gemma|google/, "Google"],
    [/qwen|qwq/, "Qwen"],
    [/gpt|openai|\bo[134](-|\s|$)/, "OpenAI"],
    [/deepseek/, "DeepSeek"],
    [/grok|x-ai/, "xAI"],
    [/kimi|moonshot/, "Moonshot / Kimi"],
    [/llama|meta[-/]/, "Meta"],
    [/mistral|ministral|mixtral|codestral|devstral/, "Mistral"],
    [/glm|z-ai|zhipu/, "Z.ai / GLM"],
    [/minimax/, "MiniMax"],
    [/cohere|command-/, "Cohere"],
    [/perplexity|sonar/, "Perplexity"],
    [/phi|microsoft/, "Microsoft"],
    [/granite|ibm/, "IBM"],
    [/nova|amazon/, "Amazon"],
  ];
  return brands.find(([pattern]) => pattern.test(identity))?.[1] || "Lainnya";
}

function modelPriceTier(model, group) {
  if (model.priceTier === "free") return "free";
  if (["premium", "check"].includes(model.priceTier)) return "premium";
  return /gratis|free|allowlist/i.test(`${group.tag || ""} ${group.label || ""}`) ? "free" : "premium";
}

function modelTierCategory(model, group) {
  if (modelPriceTier(model, group) === "free") return "free";
  if (isMaxModel(model)) return "max";
  if (isProModel(model)) return "pro";
  return "basic";
}

const MODEL_TIER_LABELS = {
  free: "Free · biaya provider Rp0*",
  basic: "Basic · ringan dan cepat",
  pro: "Pro · kemampuan lanjutan",
  max: "Max · model paling kuat",
};

function modelIdSlug(model) {
  const id = String(model?.id || "").toLowerCase();
  return (id.includes("/") ? id.slice(id.indexOf("/") + 1) : id).replace(/:free$/i, "");
}

function modelTokens(model) {
  return new Set(modelIdSlug(model).split(/[^a-z0-9.]+/).filter(Boolean));
}

function modelParameterCount(model) {
  const matches = modelIdSlug(model).matchAll(/(?:^|[-_.])(\d+(?:\.\d+)?)([bt])(?=$|[-_.])/g);
  return Math.max(0, ...[...matches].map((match) => Number(match[1]) * (match[2] === "t" ? 1000 : 1)));
}

function isFastModel(model) {
  const tokens = modelTokens(model);
  return ["flash", "fast", "mini", "lite", "haiku", "instant", "small", "nano"].some((token) => tokens.has(token))
    || (modelParameterCount(model) > 0 && modelParameterCount(model) <= 10);
}

function isProModel(model) {
  const tokens = modelTokens(model);
  return ["reasoning", "reasoner", "qwq", "r1", "pro", "thinking"].some((token) => tokens.has(token))
    || (modelParameterCount(model) >= 20 && modelParameterCount(model) < 100);
}

function isMaxModel(model) {
  const tokens = modelTokens(model);
  return modelParameterCount(model) >= 70
    || ["ultra", "super", "opus", "large"].some((token) => tokens.has(token));
}

function matchesModeModel(mode, model) {
  if (mode === "coding") return isCodingModel(model);
  if (mode === "flash") return isFastModel(model);
  if (mode === "pro") return isProModel(model);
  return true;
}

function modelModeScore(mode, model) {
  const tokens = modelTokens(model);
  const size = modelParameterCount(model);
  const reasoning = ["reasoning", "reasoner", "qwq", "r1"].some((token) => tokens.has(token));
  const fast = isFastModel(model);
  const coding = isCodingModel(model);

  if (mode === "coding") return (coding ? 10000 : 0) + size;
  if (mode === "flash") {
    return (tokens.has("flash") ? 1000 : 0)
      + (tokens.has("lite") || tokens.has("mini") || tokens.has("instant") ? 300 : 0)
      + (fast ? Math.max(0, 100 - size) : 0);
  }
  if (mode === "pro") {
    return (reasoning ? 1500 : 0)
      + (tokens.has("pro") ? 300 : 0)
      + (size >= 20 && size < 100 ? 400 + size : size >= 100 ? 100 : 0)
      - (isMaxModel(model) ? 250 : 0)
      - (fast ? 500 : 0);
  }
  if (mode === "max") {
    return size * 10
      + (reasoning ? 200 : 0)
      + (["ultra", "super", "opus", "large"].some((token) => tokens.has(token)) ? 500 : 0)
      - (fast ? 100 : 0);
  }
  return (size >= 20 && size < 70 ? 1000 + size : size >= 70 ? 400 + size : size >= 10 ? 500 + size : size ? 100 + size : 0)
    - (coding ? 600 : 0)
    - (fast ? 300 : 0)
    - (reasoning ? 200 : 0)
    - (isMaxModel(model) ? 200 : 0);
}

function recommendedModel(mode, available) {
  const candidates = [...available].filter((key) => !isPaidModel(models.get(key)));
  return candidates.sort((left, right) => {
    const rightScore = modelModeScore(mode, models.get(right)) + (models.get(right)?.provider === "openrouter" ? 2 : 0);
    const leftScore = modelModeScore(mode, models.get(left)) + (models.get(left)?.provider === "openrouter" ? 2 : 0);
    const scoreDifference = rightScore - leftScore;
    return scoreDifference || left.localeCompare(right);
  })[0] || "";
}

function modelGroupsForTask(mode = taskMode) {
  const chatGroups = modelGroups.filter((group) => !["openrouter-image", "pollinations"].includes(group.provider));
  if (mode === "image") {
    return modelGroups.filter((group) => group.provider === "pollinations");
  }
  if (mode === "coding") {
    const codingGroups = chatGroups
      .map((group) => ({ ...group, models: group.models.filter(isCodingModel) }))
      .filter((group) => group.models.length);
    if (codingGroups.length) return codingGroups;
  }
  if (mode === "flash" || mode === "pro") {
    const matchedGroups = chatGroups
      .map((group) => ({ ...group, models: group.models.filter((model) => matchesModeModel(mode, model)) }))
      .filter((group) => group.models.length);
    if (matchedGroups.length) return matchedGroups;
  }
  return chatGroups;
}

function renderModelList() {
  const q = $("modelSearch").value.trim().toLowerCase();
  const list = $("modelList");
  list.innerHTML = "";
  let count = 0;
  const visibleGroups = modelGroupsForTask();
  if (taskMode === "coding" && !modelGroups.some((group) => group.models.some(isCodingModel))) {
    const note = document.createElement("div");
    note.className = "model-empty";
    note.textContent = "Belum ada model khusus coding di katalog. Model umum tersedia sebagai fallback.";
    list.append(note);
  }

  const renderModelItem = ({ group, model }) => {
    const value = `${group.provider}::${model.id}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-item" + (value === selected ? " selected" : "");
    btn.setAttribute("role", "option");
    btn.dataset.value = value;
    const text = document.createElement("span");
    text.className = "mi-text";
    const name = document.createElement("span");
    name.className = "mi-name";
    name.textContent = model.name;
    const tier = modelPriceTier(model, group);
    const price = document.createElement("span");
    price.className = `model-price-badge ${tier}`;
    price.textContent = tier === "free" ? "GRATIS" : "PREMIUM / CEK TARIF";
    const source = document.createElement("span");
    source.className = "model-source";
    source.textContent = `${group.label} · ${group.tag || ""}`;
    const sub = document.createElement("span");
    sub.className = "mi-sub";
    sub.textContent = model.id;
    text.append(name, price, source, sub);
    btn.append(logoEl(`${model.id} ${model.name}`, model.name), text);
    btn.onclick = () => selectModel(value);
    list.append(btn);
    count++;
  };

  const tiers = new Map(["free", "basic", "pro", "max"].map((tier) => [tier, new Map()]));
  for (const group of visibleGroups) {
    for (const model of group.models) {
      const brand = modelBrand(model);
      const tier = modelTierCategory(model, group);
      const searchable = `${model.name} ${model.id} ${group.label} ${brand}`.toLowerCase();
      if (q && !searchable.includes(q)) continue;
      const brands = tiers.get(tier);
      if (!brands.has(brand)) brands.set(brand, []);
      brands.get(brand).push({ group, model });
    }
  }

  for (const [tier, brands] of tiers) {
    const tierCount = [...brands.values()].reduce((total, items) => total + items.length, 0);
    if (!tierCount) continue;
    const tierKey = tier;
    const tierExpanded = Boolean(q) || expandedModelTier === tierKey;
    const tierButton = document.createElement("button");
    tierButton.type = "button";
    tierButton.className = `model-tier-head ${tier}`;
    tierButton.setAttribute("aria-expanded", String(tierExpanded));
    const freeCount = [...brands.values()].flat().filter(({ group, model }) => modelPriceTier(model, group) === "free").length;
    const costNote = freeCount === tierCount ? "gratis*" : `${freeCount} gratis* · sisanya cek tarif`;
    tierButton.textContent = `${MODEL_TIER_LABELS[tier]} · ${tierCount} model (${costNote})`;
    tierButton.onclick = (event) => {
      event.stopPropagation();
      expandedModelTier = expandedModelTier === tierKey ? "" : tierKey;
      renderModelList();
    };
    list.append(tierButton);
    if (!tierExpanded) continue;

    for (const [brand, items] of [...brands.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const brandKey = `${tier}::${brand}`;
      const brandExpanded = Boolean(q) || expandedModelBrand === brandKey;
      const brandButton = document.createElement("button");
      brandButton.type = "button";
      brandButton.className = "model-brand-head";
      brandButton.setAttribute("aria-expanded", String(brandExpanded));
      brandButton.append(logoEl(brand, brand, true));
      const label = document.createElement("span");
      label.className = "model-brand-label";
      label.textContent = brand;
      const brandCount = document.createElement("span");
      brandCount.className = "model-brand-count";
      brandCount.textContent = String(items.length);
      brandButton.append(label, brandCount);
      brandButton.onclick = (event) => {
        event.stopPropagation();
        expandedModelBrand = expandedModelBrand === brandKey ? "" : brandKey;
        renderModelList();
      };
      list.append(brandButton);
      if (brandExpanded) items.forEach(renderModelItem);
    }
  }
  if (!count) {
    const hasHiddenModels = visibleGroups.some((group) => group.models.length > 0);
    if (!hasHiddenModels || q) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = taskMode === "image"
        ? "Model gambar belum tersedia."
        : modelGroups.length > 1 ? "Model tidak ditemukan." : "Belum ada model. Masuk Google atau simpan API key lewat menu +.";
      list.append(empty);
    }
  }
}

function selectModel(value) {
  selected = value;
  localStorage.setItem(MODEL_KEY, value);
  localStorage.setItem(`myai_model_${taskMode}`, value);
  localStorage.setItem(`myai_model_manual_${taskMode}`, "1");
  updateModelBtn();
  closeModelMenu();
}

function openModelMenu() {
  $("modelMenu").classList.remove("hidden");
  $("modelBtn").setAttribute("aria-expanded", "true");
  $("modelSearch").value = "";
  expandedModelTier = "free";
  expandedModelBrand = "";
  const visibleGroups = modelGroupsForTask();
  const selectedModel = models.get(selected);
  const selectedGroup = visibleGroups.find((group) => group.models.some((model) => `${group.provider}::${model.id}` === selected));
  if (selectedModel && selectedGroup) {
    expandedModelTier = modelTierCategory(selectedModel, selectedGroup);
    expandedModelBrand = `${expandedModelTier}::${modelBrand(selectedModel)}`;
  }
  renderModelList();
  $("modelList").querySelector(".selected")?.scrollIntoView({ block: "center" });
  $("modelSearch").focus();
}

function closeModelMenu() {
  $("modelMenu").classList.add("hidden");
  $("modelBtn").setAttribute("aria-expanded", "false");
}

function closeComposerMenus(except = "") {
  if (except !== "attach") {
    $("attachMenu").classList.add("hidden");
    $("attachBtn").setAttribute("aria-expanded", "false");
  }
  if (except !== "mode") {
    $("taskModeMenu").classList.add("hidden");
    $("taskModeBtn").setAttribute("aria-expanded", "false");
  }
  if (except !== "model") closeModelMenu();
}

async function loadModels(preferredProvider = "", includeCatalog = false) {
  const token = ++modelsToken;
  const requestedGuestTrialVersion = guestTrialVersion;
  $("modelBtnName").textContent = "Memuat model…";
  let server = { providers: [], groups: [], errors: [] };
  if (currentUser && AI_API_URL) {
    try {
      server = await listServerModels(await getAuthToken(), {
        includeCatalog,
      });
    } catch (error) {
      server.errors = [`API server: ${error.message || error}`];
    }
  }
  let guest = { groups: [], errors: [], remaining: null };
  if (!currentUser && AI_API_URL) {
    try {
      guest = await listGuestModels();
    } catch (error) {
      guest.errors = [error.message || String(error)];
    }
  }
  const manual = await listManualModels(manualApiKeys);
  if (token !== modelsToken) return { activeModel: null, errors: [] };
  if (!currentUser) {
    if (guestTrialRemaining === null && guestTrialVersion === requestedGuestTrialVersion) {
      guestTrialRemaining = guest.remaining;
    }
  } else {
    guestTrialRemaining = null;
  }
  serverProviders = server.providers;
  serverApiError = currentUser && !AI_API_URL
    ? "URL API Cloudflare Pages belum diatur di js/config.js."
    : server.errors.join(" | ");
  const guestGroups = !currentUser && !guest.groups.some((group) => group.provider === "guest")
    ? [GUEST_FALLBACK_GROUP]
    : guest.groups;
  const localGroups = globalThis.navigator?.gpu ? [LOCAL_MODEL_GROUP] : [];
  const groups = [...guestGroups, ...server.groups, ...manual.groups, ...localGroups, POLLINATIONS_GROUP];
  const errors = [...guest.errors, ...server.errors, ...manual.errors];
  modelGroups = groups;
  models = new Map();
  for (const g of groups) {
    for (const m of g.models) models.set(`${g.provider}::${m.id}`, { ...m, provider: g.provider, groupLabel: g.label, tag: g.tag });
  }
  const saved = localStorage.getItem(MODEL_KEY);
  const savedForTask = localStorage.getItem(`myai_model_${taskMode}`);
  const available = new Set(modelGroupsForTask().flatMap((group) => group.models.map((model) => `${group.provider}::${model.id}`)));
  const preferred = preferredProvider
    ? [...models.keys()].find((key) => key.startsWith(`${preferredProvider}::`) && available.has(key))
    : "";
  const codingPreferred = taskMode === "coding"
    ? [...available].find((key) => isCodingModel(models.get(key)) && !isPaidModel(models.get(key)))
    : "";
  const hasManualModeModel = localStorage.getItem(`myai_model_manual_${taskMode}`) === "1";
  const modePreferred = hasManualModeModel && available.has(savedForTask) && !isPaidModel(models.get(savedForTask))
    ? savedForTask
    : recommendedModel(taskMode, available);
  const anonymousPreferred = !currentUser
    ? preferred || [...available].find((key) => models.get(key)?.provider === "guest")
    : "";
  selected = anonymousPreferred || preferred || modePreferred || codingPreferred ||
    (available.has(selected) && !isPaidModel(models.get(selected))
      ? selected
      : available.has(saved) && !isPaidModel(models.get(saved))
        ? saved
        : available.values().find((key) => !isPaidModel(models.get(key))) || "");
  if (selected) localStorage.setItem(MODEL_KEY, selected);
  updateModelBtn();
  if ($("voiceLiveDialog").open) $("voiceLiveModel").textContent = models.get(selected)?.name || APP_NAME;
  if (!$("modelMenu").classList.contains("hidden")) renderModelList();
  if ($("apiDialog").open) updateApiDialog();
  if (errors.length) console.warn("Sebagian sumber model tidak tersedia; memakai model yang ada.", errors);
  $("refreshModelsBtn").classList.toggle("hidden", !currentUser);
  return { activeModel: models.get(selected) || null, errors };
}

async function refreshModelCatalog() {
  if (!currentUser) {
    toast("Masuk dengan Google untuk memuat katalog API server.");
    return;
  }
  const button = $("refreshModelsBtn");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Memuat model…";
  try {
    const { errors } = await loadModels("", true);
    const count = modelGroups
      .filter((group) => group.tag.startsWith("Katalog"))
      .reduce((total, group) => total + group.models.length, 0);
    toast(errors.length
      ? `Katalog parsial: ${count} model dimuat. ${errors.join(" | ")}`
      : `Katalog model berhasil dimuat: ${count} model.`);
  } catch (error) {
    toast("Gagal memuat katalog model: " + (error.message || error));
  } finally {
    button.disabled = false;
    button.textContent = "Muat model lain";
  }
}

// ---------- Chat ----------

function showProgress(report) {
  $("progress").classList.remove("hidden");
  $("progressFill").style.width = `${Math.round((report.progress || 0) * 100)}%`;
  $("progressText").textContent = report.text || "Memuat model…";
}

function setBusy(busy) {
  const btn = $("sendBtn");
  btn.textContent = busy ? "■" : "↑";
  btn.setAttribute("aria-label", busy ? "Hentikan" : "Kirim");
  btn.title = busy ? "Hentikan jawaban" : "Kirim pesan";
  btn.classList.toggle("danger", busy);
  btn.classList.toggle("primary", !busy);
  if (!busy) updateSendBtn();
  else {
    btn.disabled = false;
    btn.classList.remove("idle", "ready");
  }
}

function autosize() {
  const input = $("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

// Tombol kirim tampak nonaktif (abu) saat tidak ada yang bisa dikirim,
// seperti composer AI pada umumnya.
function updateSendBtn() {
  const btn = $("sendBtn");
  if (!btn || abort) return;
  const canSend = Boolean($("input").value.trim() || pendingFiles.length);
  btn.disabled = !canSend;
  btn.classList.toggle("idle", !canSend);
  btn.classList.toggle("ready", canSend);
}

function setComposerMode(mode) {
  if (["image", "web", "research"].includes(mode)) {
    toast("Generasi gambar dan pencarian web dinonaktifkan agar provider tidak menimbulkan biaya.");
    mode = "";
  }
  composerMode = mode;
  const imageModeActive = !mode && taskMode === "image";
  $("modeStatus").classList.toggle("hidden", !mode && !imageModeActive);
  $("modeLabel").textContent = imageModeActive
    ? "Mode Gambar gratis via Pollinations.ai. Prompt dikirim ke layanan publik — jangan tulis data pribadi."
    : mode === "research"
      ? "Riset web aktif. Biaya pencarian dapat berlaku."
      : mode === "web"
        ? "Pencarian web aktif. Biaya pencarian dapat berlaku."
        : "";
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, $("input")?.value || ""); } catch { /* storage may be disabled */ }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
    for (const mode of ["auto", "chat", "coding", "flash", "pro", "max", "image"]) {
      for (const suffix of ["_text", "_files", ""]) localStorage.removeItem(`myai_draft_${mode}${suffix}`);
    }
  } catch { /* storage may be disabled */ }
}

function restoreDraft() {
  const input = $("input");
  let text = "";
  try {
    text = localStorage.getItem(DRAFT_KEY) ?? localStorage.getItem(`myai_draft_${taskMode}_text`) ?? "";
  } catch { /* storage may be disabled */ }
  input.value = text;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  updateSendBtn();
}

function setTaskMode(mode, notify = true) {
  if (!["auto", "chat", "coding", "flash", "pro", "max", "image"].includes(mode)) return;
  if (abort && mode !== taskMode) {
    if (notify) toast("Selesaikan atau hentikan jawaban sebelum berpindah mode.");
    return;
  }
  const previousModel = models.get(selected);
  taskMode = mode;
  localStorage.setItem("myai_task_mode", mode);
  const modeLabels = { auto: "Umum", chat: "Ngobrol", coding: "Coding", flash: "Flash", pro: "Pro", max: "Max", image: "Gambar" };
  const modeIcons = { auto: "✦", chat: "💬", coding: "{ }", flash: "ϟ", pro: "◇", max: "◆", image: "▧" };
  $("taskModeLabel").textContent = modeLabels[mode];
  $("taskModeIcon").textContent = modeIcons[mode];
  $("taskModeMenu").classList.add("hidden");
  $("taskModeBtn").setAttribute("aria-expanded", "false");
  document.querySelectorAll("#taskModeMenu [data-mode]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  });
  setComposerMode("");
  const available = modelGroupsForTask().flatMap((group) => group.models.map((model) => `${group.provider}::${model.id}`));
  const saved = localStorage.getItem(`myai_model_${mode}`);
  const hasManualModeModel = localStorage.getItem(`myai_model_manual_${mode}`) === "1";
  const preferredModel = hasManualModeModel && available.includes(saved) && !isPaidModel(models.get(saved))
    ? saved
    : mode === "image" ? available[0] : recommendedModel(mode, available);
  const autoSwitchFromPaid = mode === "max" && isPaidModel(previousModel);
  selected = autoSwitchFromPaid
    ? preferredModel || available.find((key) => !isPaidModel(models.get(key))) || ""
    : hasManualModeModel && available.includes(saved) && !isPaidModel(models.get(saved))
      ? saved
      : preferredModel || (available.includes(selected) && !isPaidModel(models.get(selected))
        ? selected
        : available.find((key) => !isPaidModel(models.get(key))) || "");
  if (selected) {
    localStorage.setItem(MODEL_KEY, selected);
    localStorage.setItem(`myai_model_${mode}`, selected);
  }
  updateModelBtn();
  if (!$("modelMenu").classList.contains("hidden")) renderModelList();
  const input = $("input");
  chat.taskMode = mode;
  closeSidebar();
  if (notify) input.focus();
  $("input").placeholder = mode === "coding"
    ? "Jelaskan masalah coding yang ingin diselesaikan…"
    : mode === "image"
      ? "Deskripsikan gambar yang ingin dibuat…"
      : mode === "chat"
        ? "Mulai ngobrol tentang apa saja…"
      : mode === "flash"
        ? "Tulis pertanyaan singkat…"
        : mode === "pro" || mode === "max"
          ? "Jelaskan tugas yang perlu dianalisis…"
          : "Tanyakan apa saja…";
  if (notify && autoSwitchFromPaid) toast(`Model berbayar dialihkan ke opsi Max lain: ${models.get(selected)?.name || "model tersedia"}.`);
}

// File contents and uploaded images can be large or private; they stay in memory
// for follow-up prompts during this tab session and are not synced.
function durableChat(item) {
  const copy = structuredClone(item);
  for (const message of copy.messages || []) {
    delete message.modelContent;
    delete message.images;
    if (Array.isArray(message.generatedImages)) {
      message.generatedImages = message.generatedImages.filter((src) => /^https:\/\//i.test(src));
    }
  }
  return copy;
}

async function persist() {
  chat.updatedAt = Date.now();
  try {
    const syncError = await saveChat(durableChat(chat));
    if (syncError) notifySyncError("Chat tersimpan di perangkat, sinkron cloud tertunda", syncError);
  } catch (e) {
    toast("Gagal menyimpan chat: " + e.message);
  }
  chats = [structuredClone(chat), ...chats.filter((c) => c.id !== chat.id)];
  renderChatList();
  updateTopbar();
}

async function send(text) {
  text = text.trim();
  if ((!text && !pendingFiles.length) || abort) return;
  const chosenModel = models.get(selected);
  if (!currentUser && chosenModel?.provider === "guest" && guestTrialRemaining === 0) {
    openLoginPrompt("Jatah dua jawaban AI gratis tanpa login sudah digunakan. Masuk dengan Google untuk melanjutkan.");
    return;
  }
  if (chosenModel && !await confirmPremiumModel(chosenModel)) return;
  const submittedText = text;
  const filesForMessage = pendingFiles.slice();
  const visiblePrompt = submittedText || "Tolong analisis lampiran yang saya kirim.";
  // Keep context compact and predictable for providers with smaller context windows.
  const MAX_ATTACHMENT_CONTEXT_CHARS = 240000;
  let usedContextChars = 0;
  let contextWasTrimmed = false;
  const fileContext = filesForMessage.map((file) => {
    const raw = typeof file.content === "string" ? file.content : "[Lampiran visual]";
    const remaining = Math.max(0, MAX_ATTACHMENT_CONTEXT_CHARS - usedContextChars);
    const content = raw.slice(0, remaining);
    if (content.length < raw.length) contextWasTrimmed = true;
    usedContextChars += content.length;
    return `\n\n[File: ${file.name}]\n${content}`;
  }).join("");
  const modelPrompt = `${visiblePrompt}${fileContext}`;

  const input = $("input");
  if (input.value.trim() === submittedText) {
    input.value = "";
    input.style.height = "auto";
  }
  const allImages = filesForMessage.flatMap((file) => file.images || []);
  const images = allImages.slice(0, 10);
  if (allImages.length > images.length) toast("Maksimal 10 gambar dikirim dalam satu pertanyaan; gambar sisanya dilewati.");
  let imageIndex = 0;
  const attachmentDetails = filesForMessage.slice(0, 120).map((file) => {
    const fileImageIndex = file.images?.length && imageIndex < images.length ? imageIndex : null;
    imageIndex += file.images?.length || 0;
    return { name: file.name, imageIndex: fileImageIndex };
  });
  setComposerMode("");

  if (!chat.messages.length) chat.title = visiblePrompt.slice(0, 48) || "Analisis lampiran";
  const intent = ["coding", "image"].includes(taskMode) ? "" : detectCreationIntent(submittedText);
  chat.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    content: visiblePrompt,
    modelContent: modelPrompt,
    images,
    attachments: filesForMessage.map((file) => file.name).slice(0, 120),
    attachmentDetails,
    ...(intent ? { intent } : {}),
  });
  pendingFiles = [];
  renderAttachmentList();
  clearDraft();
  updateSendBtn();
  stickToBottom = true;
  if (contextWasTrimmed) toast("Sebagian isi lampiran dipotong agar permintaan tetap ringkas untuk model.");
  await respond();
}

function supportsImages(model) {
  if (!model) return false;
  if (["gemini", "manual-gemini"].includes(model.provider)) return true;
  if (model.provider === "guest") return Boolean(model.imageSupport);
  if (["manual-openrouter", "manual-groq"].includes(model.provider)) return VISION_MODEL_PATTERN.test(`${model.id} ${model.name}`);
  return false;
}

function contextBudget(model) {
  if (["gemini", "manual-gemini"].includes(model.provider)) return 600000;
  if (model.provider === "guest") return 5800;
  if (model.provider === "local-webgpu") return 3800;
  return 90000;
}

// Ambil riwayat dari pesan terbaru ke belakang sampai anggaran karakter model habis.
function buildHistory(model, includeImages) {
  const budget = contextBudget(model);
  const usable = chat.messages.filter((message) => !message.error && ["user", "assistant"].includes(message.role)
    && (message.role === "user" || cleanAnswerText(message.content)));
  const history = [];
  let used = 0;
  let imagesLeft = includeImages ? 10 : 0;
  let trimmed = false;
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    const isLatest = index === usable.length - 1;
    let content = cleanAnswerText(typeof message.modelContent === "string" ? message.modelContent : message.content);
    const remaining = budget - used;
    if (content.length > remaining) {
      trimmed = true;
      if (isLatest) {
        content = content.slice(0, Math.max(1000, remaining - 80)) + "\n\n[...isi lampiran dipotong agar muat di konteks model]";
      } else {
        const visible = cleanAnswerText(message.content);
        if (visible.length > remaining) break;
        content = visible;
      }
    }
    const entry = { role: message.role, content };
    if (imagesLeft > 0 && message.images?.length && usable.length - index <= 6) {
      entry.images = message.images.slice(0, imagesLeft);
      imagesLeft -= entry.images.length;
    }
    used += content.length;
    history.unshift(entry);
  }
  while (history.length && history[0].role !== "user") history.shift();
  return { history, trimmed };
}

function systemContext() {
  const parts = [];
  if (settings.systemPrompt) parts.push(settings.systemPrompt);
  const deviceLocale = navigator.languages?.find((language) => typeof language === "string" && language.trim()) || navigator.language || "id-ID";
  const languageCode = deviceLocale.split(/[-_]/)[0];
  let deviceLanguage = deviceLocale;
  try {
    deviceLanguage = new Intl.DisplayNames(["en"], { type: "language" }).of(languageCode) || deviceLocale;
  } catch {}
  parts.push(`Bahasa jawaban default: gunakan bahasa utama perangkat/browser pengguna (${deviceLanguage}; locale ${deviceLocale}). Tetap ikuti permintaan eksplisit pengguna untuk menjawab dalam bahasa lain. Pertahankan nama, kutipan, kode, dan istilah teknis sebagaimana mestinya.`);
  if (taskMode === "chat") {
    parts.push("Mode Ngobrol aktif. Jadilah teman bicara AI yang hangat, santai, suportif, dan penuh perhatian tanpa berpura-pura sebagai manusia. Tanggapi maksud dan perasaan pengguna dengan wajar, ingat konteks percakapan yang tersedia, ajukan pertanyaan lanjutan yang relevan bila membantu, dan jangan membuat setiap balasan terasa seperti esai atau daftar. Tetap jujur tentang ketidakpastian dan jangan mengada-ada.");
  }
  parts.push(`Waktu pengguna saat ini: ${new Date().toLocaleString("id-ID", { dateStyle: "full", timeStyle: "short" })}.`);
  if (settings.about?.trim()) parts.push(`Informasi tentang pengguna (gunakan hanya bila relevan):\n${settings.about.trim()}`);
  const modeInstructions = {
    coding: "Mode Coding aktif. Utamakan solusi teknis yang benar, kode siap pakai, penjelasan singkat, dan sebutkan asumsi atau risiko. Gunakan blok kode dengan bahasa yang sesuai.",
    flash: "Mode Flash aktif. Jawab langsung, ringkas, dan fokus pada inti. Gunakan daftar hanya jika membantu.",
    pro: "Mode Pro aktif. Analisis permintaan dengan cermat, susun jawaban terstruktur, jelaskan asumsi, dan verifikasi detail penting sebelum menyimpulkan.",
    max: "Mode Max aktif. Berikan jawaban paling menyeluruh yang dapat dilakukan model terpilih; periksa alternatif, batasan, dan risiko sebelum merekomendasikan tindakan.",
  };
  if (modeInstructions[taskMode]) parts.push(modeInstructions[taskMode]);
  return { role: "system", content: parts.join("\n\n") };
}

// Bangun konteks dari pesan yang sudah ada (pesan terakhir harus dari pengguna),
// lalu streaming jawaban asisten. Dipakai oleh send(), edit, dan "Jawab ulang".
async function respond() {
  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== "user") return;

  const requestMode = composerMode;
  const webSearch = requestMode === "web" || requestMode === "research";
  const intent = last.intent || "";
  const imageGeneration = taskMode === "image" || intent === "image";
  const documentFormat = !imageGeneration && CREATION_FORMATS[intent] ? intent : "";
  const selectedModel = models.get(selected);
  let m = imageGeneration
    ? selectedModel?.provider === "pollinations" ? selectedModel : { ...POLLINATIONS_GROUP.models[0], provider: "pollinations", groupLabel: POLLINATIONS_GROUP.label }
    : selectedModel;
  if (intent === "image" && taskMode !== "image") {
    toast(`${selectedModel?.name || "Model aktif"} tidak bisa membuat gambar — otomatis memakai ${m.name}.`);
  }
  const latestHasImages = !imageGeneration && Boolean(last.images?.length);

  const failInline = async (message) => {
    chat.messages.push({ id: crypto.randomUUID(), role: "assistant", content: `**${message}**`, error: true, model: APP_NAME });
    renderMessages();
    await persist();
  };
  if (webSearch) {
    await failInline("Pencarian web dinonaktifkan agar tidak memakai layanan berbayar.");
    return;
  }
  if (!m && !latestHasImages && !currentUser) {
    m = { ...GUEST_FALLBACK_GROUP.models[0], provider: "guest", groupLabel: GUEST_FALLBACK_GROUP.label };
  }
  if (!m) {
    await failInline("Belum ada model AI yang aktif, jadi pertanyaanmu belum bisa dijawab.");
    toast("Belum ada model aktif. Masuk Google atau tambahkan API key melalui menu +.");
    return;
  }
  if (latestHasImages && !supportsImages(m)) {
    const vision = [...models.values()]
      .filter((model) => supportsImages(model) && !isPaidModel(model))
      .sort((left, right) => Number(right.provider.includes("gemini")) - Number(left.provider.includes("gemini")))[0];
    if (!vision) {
      await failInline("Analisis gambar memerlukan model yang mendukung gambar (mis. Gemini). Tambahkan API key Gemini lewat menu + atau masuk dengan Google.");
      return;
    }
    toast(`${m.name} tidak bisa membaca gambar. Jawaban ini memakai ${vision.name}.`);
    m = vision;
  }
  const manualProvider = m.provider.startsWith("manual-");
  const keylessProvider = ["guest", "local-webgpu"].includes(m.provider);
  if (!manualProvider && !keylessProvider && !imageGeneration && !currentUser) {
    await failInline("Masuk dengan Google untuk memakai API AI server, atau simpan key provider di menu +.");
    return;
  }
  const { history, trimmed } = buildHistory(m, supportsImages(m));
  const hasImages = history.some((message) => message.images?.length);
  // Instruksi ditaruh di pesan pengguna (bukan system) karena mode guest membuang pesan system.
  const withDocumentInstruction = (items, model) => {
    if ((!documentFormat && model.provider !== "guest") || !items.length) return items;
    const copy = items.slice();
    const latest = copy[copy.length - 1];
    const instructions = [];
    if (model.provider === "guest") instructions.push(systemContext().content);
    if (documentFormat) instructions.push(CREATION_FORMATS[documentFormat].instruction);
    copy[copy.length - 1] = {
      ...latest,
      content: `${instructions.join("\n\n")}\n\nPermintaan pengguna:\n${latest.content}`,
    };
    return copy;
  };

  const reply = { id: crypto.randomUUID(), role: "assistant", content: "", reasoning: "", model: m.name, modelId: m.id };
  chat.messages.push(reply);
  renderMessages();

  const body = $("messages").lastElementChild.querySelector(".body");
  const workingLabel = imageGeneration
    ? "Sedang melukis gambar"
    : documentFormat ? `Sedang menyusun ${CREATION_FORMATS[documentFormat].label}` : "Sedang menyiapkan jawaban";
  body.innerHTML = thinkingIndicatorHTML(workingLabel);

  abort = new AbortController();
  setBusy(true);
  let frame = 0;
  let completed = false;
  const runModel = async (model) => {
    const authToken = model.provider.startsWith("manual-") || ["guest", "local-webgpu", "pollinations"].includes(model.provider) ? "" : await getAuthToken();
    const baseHistory = model === m ? history : buildHistory(model, false).history;
    const context = [systemContext(), ...withDocumentInstruction(baseHistory, model)];
    const stream = streamChat(model.provider, model.id, context, {
      settings,
      authToken,
      manualApiKeys,
      temperature: Number(settings.temperature),
      onProgress: showProgress,
      webSearch,
      researchMode: requestMode === "research",
      imageGeneration,
    }, abort.signal);
    for await (const chunk of stream) {
      $("progress").classList.add("hidden");
      if (chunk.notice) toast(chunk.notice);
      if (Number.isInteger(chunk.guestRemaining) && chunk.guestRemaining >= 0 && chunk.guestRemaining <= 2) {
        guestTrialRemaining = chunk.guestRemaining;
        guestTrialVersion++;
      }
      if (chunk.progress) showProgress(chunk.progress);
      if (chunk.content) reply.content += chunk.content;
      if (chunk.reasoning) reply.reasoning += chunk.reasoning;
      if (chunk.citation) (reply.citations ||= []).push(chunk.citation);
      if (chunk.image) (reply.generatedImages ||= []).push(chunk.image);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const hasOutput = Boolean(reply.content || reply.reasoning);
        body.innerHTML = hasOutput
          ? renderContent(reply) + '<span class="typing"></span>'
          : thinkingIndicatorHTML(imageGeneration ? "Sedang melukis gambar" : "Sedang berpikir");
        scrollBottom();
      });
    }
    if (!reply.content && !reply.reasoning && !reply.generatedImages?.length) {
      throw new Error("Provider menutup stream tanpa mengirim jawaban.");
    }
  };
  try {
    try {
      await runModel(m);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      const candidates = [];
      const seen = new Set([`${m.provider}::${modelBrand(m)}`]);
      const alternatives = !imageGeneration && !webSearch && !hasImages
        ? [...models.values()]
          .filter((model) => model.id !== m.id || model.provider !== m.provider)
          .filter((model) => !["openrouter-image", "modelscope", "pollinations"].includes(model.provider) && !isPaidModel(model))
          .sort((left, right) => {
            const providerPriority = Number(left.provider === m.provider) - Number(right.provider === m.provider);
            const brandPriority = Number(modelBrand(left) === modelBrand(m)) - Number(modelBrand(right) === modelBrand(m));
            return providerPriority || brandPriority || left.name.localeCompare(right.name);
          })
        : [];
      for (const candidate of alternatives) {
        const key = `${candidate.provider}::${modelBrand(candidate)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
        if (candidates.length === 3) break;
      }
      if (imageGeneration) {
        candidates.push(...POLLINATIONS_GROUP.models
          .filter((model) => m.provider !== "pollinations" || model.id !== m.id)
          .map((model) => ({ ...model, provider: "pollinations", groupLabel: POLLINATIONS_GROUP.label })));
        if (manualApiKeys.gemini) {
          candidates.push({ id: "gemini-image", name: "Gemini Image (key akun)", provider: "manual-gemini-image", groupLabel: "Gemini · key akun" });
        }
      }
      if (!candidates.length) {
        throw new Error(`Model utama (${m.name || m.id}) gagal: ${explainAIError(error)}. Tidak ada model Gratis lain yang siap.`);
      }

      const fallbackErrors = [];
      let recovered = false;
      for (const fallback of candidates) {
        reply.content = "";
        reply.reasoning = "";
        reply.citations = [];
        reply.generatedImages = [];
        reply.model = fallback.name;
        reply.modelId = fallback.id;
        toast(`${m.name || "Model utama"} sedang tidak tersedia — beralih otomatis ke ${fallback.name}…`);
        try {
          await runModel(fallback);
          const fallbackKey = `${fallback.provider}::${fallback.id}`;
          if (models.has(fallbackKey) && (!imageGeneration || taskMode === "image")) selectModel(fallbackKey);
          recovered = true;
          break;
        } catch (fallbackError) {
          if (fallbackError.name === "AbortError") throw fallbackError;
          fallbackErrors.push(`${fallback.name}: ${explainAIError(fallbackError)}`);
        }
      }
      if (!recovered) {
        throw new Error(
          `Model utama (${m.name || m.id}) gagal: ${explainAIError(error)}. ` +
          `Cadangan Gratis juga gagal: ${fallbackErrors.join("; ")}`,
        );
      }
    }
    completed = true;
  } catch (e) {
    if (e.name !== "AbortError") {
      if (m.provider === "guest" && /jatah dua jawaban|sudah habis/i.test(e.message || "")) {
        guestTrialRemaining = 0;
        guestTrialVersion++;
      }
      reply.error = true;
      const message = explainAIError(e);
      reply.content += `\n\n**Tidak dapat menjawab:** ${message}`;
      toast(message);
    }
  } finally {
    cancelAnimationFrame(frame);
    abort = null;
    setBusy(false);
    $("progress").classList.add("hidden");
    if (!reply.content && !reply.reasoning && !reply.generatedImages?.length) reply.content = "_(dihentikan)_";
    if (completed && documentFormat && cleanAnswerText(reply.content)) reply.document = { format: documentFormat };
    body.innerHTML = renderContent(reply);
    appendCitations(body, reply.citations);
    appendGeneratedImages(body, reply);
    body.parentElement.classList.toggle("error", !!reply.error);
    enhance(body);
    const downloadButton = appendDocumentCard(body, reply);
    appendMessageActions(body.parentElement, reply);
    scrollBottom();
    await persist();
    if (reply.document) downloadDocument(reply, downloadButton);
    if (!currentUser && guestTrialRemaining === 0 && m.provider === "guest") {
      window.setTimeout(() => openLoginPrompt("Uji coba gratis selesai. Masuk dengan Google untuk lanjut menggunakan model Basic."), 900);
    }
    if (settings.autoSpeak && !reply.error && reply.content && !imageGeneration && !documentFormat) {
      speakMessage(reply, body.parentElement.querySelector(".message-tools .message-tool-btn:nth-child(2)"));
    }
  }
}

// Jawab ulang: hapus balasan asisten terakhir, lalu minta jawaban baru
// untuk pertanyaan pengguna yang sama (konteks lampiran ikut terbawa).
async function regenerate() {
  if (abort) return;
  const chosenModel = models.get(selected);
  if (chosenModel && !await confirmPremiumModel(chosenModel)) return;
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") {
    chat.messages.pop();
  }
  if (!chat.messages.length) return;
  renderMessages();
  await respond();
}

function syncErrorMessage(error) {
  const code = error?.code || "";
  if (/permission-denied$/.test(code)) {
    return "Firestore menolak akses riwayat. Pastikan Rules mengizinkan path users/{uid}/chats/{chatId} untuk UID yang login.";
  }
  if (/unauthenticated$/.test(code)) return "Sesi Firebase tidak valid. Keluar lalu masuk kembali.";
  if (/unavailable|network-request-failed$/.test(code)) return "Firestore tidak dapat dijangkau. Periksa koneksi internet lalu coba lagi.";
  if (/failed-precondition$/.test(code)) return "Firestore belum siap. Pastikan database Firestore sudah dibuat di Firebase Console.";
  return error?.message || String(error);
}

const reportedSyncErrors = new Set();
function notifySyncError(prefix, error) {
  const code = error?.code || error?.message || "unknown";
  if (/sync-timeout|unavailable|network-request-failed|deadline-exceeded/.test(code) || !navigator.onLine) {
    console.warn(`${prefix} (sinkronisasi cloud akan dicoba lagi saat menyimpan berikutnya)`, error);
    return;
  }
  if (reportedSyncErrors.has(code)) return;
  reportedSyncErrors.add(code);
  toast(`${prefix}: ${syncErrorMessage(error)}`);
}

// ---------- Sidebar (mobile) ----------

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("backdrop").classList.remove("show");
}

// ---------- Init ----------

function applyTheme(theme) {
  const chosen = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = chosen;
  localStorage.setItem("myai_theme", chosen);
  const label = chosen === "dark" ? "☀️" : "🌙";
  ["themeToggle", "landingTheme"].forEach((id) => {
    const el = $(id);
    if (el) { el.textContent = label; el.title = chosen === "dark" ? "Aktifkan tema terang" : "Aktifkan tema gelap"; }
  });
}

function enterApp() {
  $("landing").classList.add("hidden");
  if ($("loginDialog").open) $("loginDialog").close();
}

function openLoginPrompt(message = "") {
  if (message) {
    $("loginError").textContent = message;
    $("loginError").classList.remove("hidden");
  } else {
    $("loginError").classList.add("hidden");
  }
  if (!$("loginDialog").open) $("loginDialog").showModal();
}

function explainFirebaseAuthError(error) {
  if (error?.code === "auth/unauthorized-domain") {
    return `Domain "${location.hostname}" belum diizinkan Firebase. Buka Firebase Console → Authentication → Settings → Authorized domains, lalu tambahkan hostname tersebut (tanpa http:// atau port).`;
  }
  if (error?.code === "auth/network-request-failed") {
    return "Koneksi ke Firebase/Google gagal. Periksa internet atau coba jaringan lain; jangan buat ulang API key provider untuk masalah login.";
  }
  if (error?.code === "auth/web-storage-unsupported") {
    return "Browser membatasi penyimpanan yang diperlukan untuk login. Aktifkan cookie dan penyimpanan situs, lalu coba lagi.";
  }
  if (error?.code === "auth/redirect-no-user") {
    return "Google kembali tanpa menyelesaikan login. Periksa koneksi, izinkan cookie/penyimpanan situs, dan pastikan domain aplikasi terdaftar di Firebase Authentication → Authorized domains.";
  }
  if (error?.code === "auth/too-many-requests") {
    return "Firebase membatasi percobaan login sementara. Tunggu beberapa menit sebelum mencoba kembali.";
  }
  if (error?.code === "auth/operation-not-allowed") {
    return "Google sign-in belum diaktifkan. Aktifkan Google di Firebase Console → Authentication → Sign-in method.";
  }
  if (error?.code === "auth/invalid-api-key") {
    return "Firebase Web API key tidak valid. Periksa firebaseConfig di js/config.js.";
  }
  const message = String(error?.message || "");
  if (error?.code === "auth/invalid-oauth-client-id" || /invalid_client|oauth client (was not found|not found)/i.test(message)) {
    return "Google OAuth client Firebase tidak valid atau tidak ditemukan. Periksa Google sign-in provider di Firebase Console dan OAuth Web client pada Google Cloud; membuat API key AI baru tidak memperbaiki OAuth.";
  }
  return message || "Coba lagi.";
}

async function handleGoogleLogin() {
  if (!firebaseEnabled) {
    $("loginError").textContent = "Firebase belum dikonfigurasi. Periksa js/config.js.";
    $("loginError").classList.remove("hidden");
    return;
  }
  try {
    const credential = await signIn();
    if (credential?.user) enterApp();
  } catch (e) {
    if (/popup-closed-by-user|cancelled-popup-request|cancelled/.test(e.code || e.message)) return;
    $("loginError").textContent = "Gagal masuk: " + explainFirebaseAuthError(e);
    $("loginError").classList.remove("hidden");
  }
}

const SERVER_PROVIDER_LABELS = {
  gemini: "Google Gemini",
  groq: "Groq",
  openrouter: "OpenRouter",
};

function updateApiDialog() {
  const status = $("apiKeyStatus");
  const savedProviders = Object.keys(manualApiKeys).filter((provider) => manualApiKeys[provider]);
  status.textContent = currentUser
    ? `Key manual tersimpan di akun ini: ${savedProviders.length ? savedProviders.join(", ") : "belum ada"}.` +
      (serverProviders.length ? ` Provider server aktif: ${serverProviders.map((provider) => SERVER_PROVIDER_LABELS[provider] || provider).join(", ")}.` : "") +
      (serverApiError ? ` Status server: ${serverApiError}` : "")
    : "Masuk dengan Google untuk menyimpan API key manual pada akun.";
  $("manualApiForm").querySelectorAll("input, select, button").forEach((element) => {
    element.disabled = !currentUser;
  });
  updateManualApiKeyActions();
}

function openApiDialog() {
  $("apiDialog").showModal();
  updateApiDialog();
}

function updateManualApiKeyActions() {
  const provider = $("manualApiProvider").value;
  const exists = Boolean(manualApiKeys[provider]);
  $("manualApiKey").placeholder = exists ? "Key tersimpan; isi untuk mengganti" : "Tempel API key";
  $("removeManualApiKey").classList.toggle("hidden", !exists);
}

async function persistManualApiKeys(nextKeys) {
  await saveCloudApiKeys(nextKeys);
  manualApiKeys = nextKeys;
  await loadModels();
  updateApiDialog();
}

async function saveManualApiKey(event) {
  event.preventDefault();
  const provider = $("manualApiProvider").value;
  const key = $("manualApiKey").value.trim();
  if (!key) {
    toast("Masukkan API key terlebih dahulu.");
    return;
  }
  const button = $("saveManualApiKey");
  button.disabled = true;
  try {
    await persistManualApiKeys({ ...manualApiKeys, [provider]: key });
    $("manualApiKey").value = "";
    toast("API key tersimpan di akun Google dan katalog sedang diperbarui.");
  } catch (error) {
    toast("Gagal menyimpan API key: " + (error.message || error));
  } finally {
    button.disabled = !currentUser;
    updateManualApiKeyActions();
  }
}

async function removeManualApiKey() {
  const provider = $("manualApiProvider").value;
  const nextKeys = { ...manualApiKeys };
  delete nextKeys[provider];
  try {
    await persistManualApiKeys(nextKeys);
    toast("API key dihapus dari akun ini.");
  } catch (error) {
    toast("Gagal menghapus API key: " + (error.message || error));
  }
}

const MAX_FILE_CHARS = 100000;
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
const SHEETJS_URL = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm";
const PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168";
const BINARY_FILE_PATTERN = /^(pdf|docx|xlsx|xls|ods|pptx|odt|odp|zip|png|jpe?g|gif|webp|bmp|heic|heif|avif|mp4|webm|mov|m4v|ogv|mkv)$/;
const IMAGE_FILE_PATTERN = /^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/;
const VIDEO_FILE_PATTERN = /^(mp4|webm|mov|m4v|ogv|mkv)$/;
const ZIP_READABLE = /^(txt|md|markdown|csv|tsv|json|jsonl|html?|xml|svg|js|mjs|cjs|ts|jsx|tsx|vue|svelte|css|scss|less|py|rb|php|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|bash|zsh|sql|ya?ml|toml|ini|cfg|conf|env\.example|log|rtf|tex|docx|xlsx|xls|ods|pptx|odt|odp|pdf)$/;

function limitText(text) {
  const clean = String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (clean.length <= MAX_FILE_CHARS) return clean;
  return `${clean.slice(0, MAX_FILE_CHARS)}\n\n[…isi dipotong: ${(clean.length - MAX_FILE_CHARS).toLocaleString("id-ID")} karakter berikutnya tidak disertakan]`;
}

function blobToDataUrl(blob, name) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`${name}: gagal dibaca.`));
    reader.readAsDataURL(blob);
  });
}

async function canvasToJpeg(canvas, quality, name) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error(`${name}: gambar gagal dikompres.`);
  return blobToDataUrl(blob, name);
}

function isGuestModel() {
  return models.get(selected)?.provider === "guest";
}

function videoVisionAvailable() {
  return [...models.values()].some((model) => supportsImages(model));
}

function guestImageLimitReached() {
  if (!isGuestModel()) return false;
  const chatImages = chat.messages.reduce((total, message) => total + (message.images?.length || 0), 0);
  const pendingImages = pendingFiles.reduce((total, file) => total + (file.images?.length || 0), 0);
  return chatImages + pendingImages >= 1;
}

function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.01) {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error("Browser gagal mendekode frame video.")); }, 10000);
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadeddata", onData);
        video.removeEventListener("error", onError);
      };
      const onData = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("Browser gagal membaca frame video.")); };
      video.addEventListener("loadeddata", onData, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("Browser gagal membaca frame video.")); };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = time;
  });
}

async function createVideoContactSheet(video, frames, name) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 640;
  const context = canvas.getContext("2d");
  if (!context || !video.videoWidth || !video.videoHeight) {
    throw new Error(`${name}: tidak ada frame video yang dapat dibaca.`);
  }
  context.fillStyle = "#f4f5f7";
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (Number.isFinite(frame.time)) await seekVideo(video, frame.time);
    else if (frame.waitMs) await new Promise((resolve) => setTimeout(resolve, frame.waitMs));
    const x = index % 2 * 512;
    const y = Math.floor(index / 2) * 320;
    context.fillStyle = "#fff";
    context.fillRect(x + 5, y + 5, 502, 310);
    context.fillStyle = "#20242c";
    context.font = "14px system-ui, sans-serif";
    context.fillText(frame.label, x + 13, y + 24);
    const maxWidth = 486;
    const maxHeight = 272;
    const scale = Math.min(maxWidth / video.videoWidth, maxHeight / video.videoHeight);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    context.fillStyle = "#111";
    context.fillRect(x + 13, y + 31, maxWidth, maxHeight);
    context.drawImage(video, x + 13 + (maxWidth - width) / 2, y + 31 + (maxHeight - height) / 2, width, height);
  }
  return canvasToJpeg(canvas, isGuestModel() ? 0.68 : 0.78, name);
}

async function readVideo(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name}: video maksimal 20 MB.`);
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`${file.name}: video terlalu lama dibuka.`)), 15000);
      video.addEventListener("loadedmetadata", () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`${file.name}: format video tidak dapat dibaca browser.`)); }, { once: true });
      video.src = url;
      video.load();
    });
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error(`${file.name}: durasi video tidak valid.`);
    if (video.duration > 180) throw new Error(`${file.name}: durasi video maksimal 3 menit.`);
    const lastTime = Math.max(0, video.duration - 0.05);
    const frames = Array.from({ length: 4 }, (_, index) => ({
      time: Math.min(lastTime, video.duration * index / 3),
      label: `Cuplikan ${index + 1} · ${Math.min(lastTime, video.duration * index / 3).toFixed(1)} dtk`,
    }));
    const image = await createVideoContactSheet(video, frames, file.name);
    return {
      name: file.name,
      size: file.size,
      content: `[Video berdurasi ${video.duration.toFixed(1)} detik. Empat cuplikan diambil di perangkat ini dan diringkas menjadi satu gambar untuk dianalisis.]`,
      images: [image],
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function stopVideoCamera() {
  if (videoStream) {
    videoStream.getTracks().forEach((track) => track.stop());
    videoStream = null;
  }
  const video = $("videoPreview");
  if (video) video.srcObject = null;
  $("videoPreviewWrap")?.classList.add("hidden");
  const captureButton = $("captureVideoFrames");
  captureButton?.classList.add("hidden");
  if (captureButton) captureButton.disabled = true;
  $("startVideoCamera")?.classList.remove("hidden");
}

async function startVideoCamera() {
  if (!window.isSecureContext) {
    toast("Kamera memerlukan HTTPS atau localhost.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("Browser ini belum mendukung akses kamera.");
    return;
  }
  const button = $("startVideoCamera");
  button.disabled = true;
  $("videoStatus").textContent = "Meminta izin kamera…";
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const preview = $("videoPreview");
    preview.srcObject = videoStream;
    await preview.play();
    $("videoPreviewWrap").classList.remove("hidden");
    const captureButton = $("captureVideoFrames");
    captureButton.classList.remove("hidden");
    captureButton.disabled = false;
    button.classList.add("hidden");
    $("videoStatus").textContent = "Kamera aktif. Ambil cuplikan untuk menganalisis empat frame selama sekitar 3 detik.";
  } catch (error) {
    stopVideoCamera();
    $("videoStatus").textContent = "Tidak dapat membuka kamera.";
    toast(`Kamera tidak dapat dibuka: ${error.message || error}`);
  } finally {
    button.disabled = false;
  }
}

async function captureLiveVideo() {
  if (!videoStream || videoCaptureInProgress) return;
  if (!videoVisionAvailable()) {
    toast("Analisis video memerlukan model yang mendukung gambar. Pilih atau aktifkan model vision terlebih dahulu.");
    return;
  }
  if (guestImageLimitReached()) {
    toast("Mode tamu hanya menerima satu gambar atau cuplikan video per chat. Mulai chat baru atau masuk dengan Google.");
    return;
  }
  videoCaptureInProgress = true;
  const button = $("captureVideoFrames");
  button.disabled = true;
  const frames = [];
  try {
    const preview = $("videoPreview");
    for (let index = 0; index < 4; index++) {
      if (!videoStream?.active) throw new Error("Kamera berhenti sebelum cuplikan selesai.");
      $("videoStatus").textContent = `Mengambil cuplikan ${index + 1} dari 4…`;
      frames.push({ waitMs: index ? 950 : 0, label: `Cuplikan langsung ${index + 1}` });
    }
    const image = await createVideoContactSheet(preview, frames, "Cuplikan kamera");
    pendingFiles.push({
      name: "Cuplikan video dari kamera",
      size: 0,
      content: "[Empat cuplikan video dari kamera diambil di perangkat ini dan diringkas menjadi satu gambar.]",
      images: [image],
    });
    renderAttachmentList();
    if (!$("input").value.trim()) $("input").value = $("videoPrompt").value.trim();
    autosize();
    saveDraft();
    updateSendBtn();
    $("videoDialog").close();
    toast("Cuplikan video siap. Periksa pertanyaan lalu tekan Kirim untuk membagikan gambar cuplikan ke model vision.");
  } catch (error) {
    $("videoStatus").textContent = error.message || "Cuplikan video gagal dibuat.";
    toast(`Gagal mengambil cuplikan video: ${error.message || error}`);
  } finally {
    videoCaptureInProgress = false;
    if (button.isConnected) button.disabled = false;
  }
}

async function readSpreadsheet(file, buffer) {
  const module = await import(SHEETJS_URL);
  const XLSX = module.read ? module : module.default;
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  return workbook.SheetNames.slice(0, 30).map((sheetName) => {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], { blankrows: false });
    return `[Lembar: ${sheetName}]\n${csv}`;
  }).join("\n\n");
}

async function readOfficeZip(file, ext, buffer) {
  const JSZip = (await import(JSZIP_URL)).default;
  const archive = await JSZip.loadAsync(buffer);
  const readXml = async (path) => {
    const entry = archive.file(path);
    return entry ? new DOMParser().parseFromString(await entry.async("text"), "application/xml") : null;
  };
  const textNodes = (xml, tag) => [...(xml?.getElementsByTagNameNS("*", tag) || [])].map((node) => node.textContent).join("");
  if (ext === "docx") {
    const xml = await readXml("word/document.xml");
    return [...(xml?.getElementsByTagNameNS("*", "p") || [])]
      .map((paragraph) => textNodes(paragraph, "t"))
      .filter(Boolean)
      .join("\n");
  }
  if (ext === "pptx") {
    const slides = Object.keys(archive.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((left, right) => Number(left.match(/slide(\d+)/)[1]) - Number(right.match(/slide(\d+)/)[1]));
    const parts = [];
    for (const path of slides.slice(0, 150)) {
      const xml = await readXml(path);
      const paragraphs = [...(xml?.getElementsByTagNameNS("*", "p") || [])]
        .map((paragraph) => textNodes(paragraph, "t"))
        .filter(Boolean);
      parts.push(`[Slide ${path.match(/slide(\d+)/)[1]}]\n${paragraphs.join("\n")}`);
    }
    return parts.join("\n\n");
  }
  if (ext === "odt" || ext === "odp") {
    const xml = await readXml("content.xml");
    return [...(xml?.getElementsByTagName("*") || [])]
      .filter((node) => node.localName === "p" || node.localName === "h")
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join("\n");
  }
  const sharedXml = await readXml("xl/sharedStrings.xml");
  const shared = [...(sharedXml?.getElementsByTagNameNS("*", "si") || [])].map((item) => textNodes(item, "t"));
  const sheets = Object.keys(archive.files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).sort();
  const parts = [];
  for (const path of sheets) {
    const xml = await readXml(path);
    const rows = [...(xml?.getElementsByTagNameNS("*", "row") || [])].map((row) =>
      [...row.getElementsByTagNameNS("*", "c")].map((cell) => {
        const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent || textNodes(cell, "t");
        return cell.getAttribute("t") === "s" ? shared[Number(value)] || "" : value;
      }).join("\t"));
    parts.push(`[Lembar ${path.split("/").pop()}]\n${rows.join("\n")}`);
  }
  return parts.join("\n\n");
}

async function readPdf(file, buffer) {
  const pdfjs = await import(`${PDFJS_BASE}/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: buffer }).promise;
  } catch (error) {
    if (error?.name === "PasswordException") throw new Error(`${file.name}: PDF dilindungi kata sandi. Buka kuncinya dulu lalu unggah lagi.`);
    throw new Error(`${file.name}: PDF rusak atau tidak dapat dibuka.`);
  }
  const pageLimit = Math.min(doc.numPages, 60);
  const pages = [];
  for (let n = 1; n <= pageLimit; n++) {
    const page = await doc.getPage(n);
    const data = await page.getTextContent();
    const text = data.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").replace(/[ \t]{2,}/g, " ");
    pages.push(`[Halaman ${n}]\n${text.trim()}`);
  }
  let content = pages.join("\n\n");
  if (doc.numPages > pageLimit) content += `\n\n[PDF memiliki ${doc.numPages} halaman; hanya ${pageLimit} halaman pertama yang dibaca]`;
  const textChars = content.replace(/\[Halaman \d+\]|\s/g, "").length;
  if (textChars >= 40 * Math.min(pageLimit, 3)) return { content };

  const maxImages = isGuestModel() ? 1 : 3;
  const images = [];
  for (let n = 1; n <= Math.min(doc.numPages, maxImages); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(base.width, base.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    images.push(await canvasToJpeg(canvas, 0.75, file.name));
  }
  return {
    content: `${content}\n\n[PDF ini tampaknya hasil scan/gambar. ${images.length} halaman pertama dilampirkan sebagai gambar agar model vision dapat membacanya.]`,
    images,
  };
}

async function readImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: gambar tidak dapat dibuka browser ini. Ubah ke PNG/JPG lalu coba lagi.`);
  }
  const guestImage = isGuestModel();
  const maxImageSide = guestImage ? 1024 : 1600;
  const scale = Math.min(1, maxImageSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(`${file.name}: browser tidak dapat menyiapkan gambar.`);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dimensions = `${bitmap.width}×${bitmap.height}px`;
  bitmap.close();
  const image = await canvasToJpeg(canvas, guestImage ? 0.7 : 0.8, file.name);
  return { content: `[Gambar dilampirkan untuk dianalisis — ${dimensions}]`, images: [image] };
}

function stripRtf(text) {
  return text
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\{\\\*[^{}]*}/g, "")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
}

async function readZip(file, buffer, depth) {
  const JSZip = (await import(JSZIP_URL)).default;
  const archive = await JSZip.loadAsync(buffer);
  const entries = Object.values(archive.files).filter((entry) => !entry.dir
    && !entry.name.startsWith("__MACOSX/")
    && !entry.name.split("/").some((part) => part.startsWith(".") || part === "node_modules"));
  if (!entries.length) throw new Error(`${file.name}: ZIP kosong atau hanya berisi file tersembunyi.`);
  const results = [];
  const readable = entries.filter((entry) => ZIP_READABLE.test(entry.name.split(".").pop().toLowerCase()) || (depth === 0 && /\.zip$/i.test(entry.name)));
  for (const entry of readable.slice(0, 60)) {
    const blob = await entry.async("blob");
    const nested = new File([blob], entry.name.split("/").pop());
    try {
      const parsed = await readUploadedFile(nested, depth + 1);
      results.push(`[Isi arsip: ${entry.name}]\n${parsed.content}`);
    } catch { /* skip unreadable entries inside archive */ }
  }
  if (!results.length) throw new Error(`${file.name}: ZIP terbaca, tetapi tidak ada dokumen teks/kode/PDF yang didukung.`);
  const listing = entries.slice(0, 200).map((entry) => `- ${entry.name}`).join("\n");
  const note = readable.length > 60 ? `\n[Hanya 60 dari ${readable.length} file yang dibaca]` : "";
  return `[Daftar isi arsip (${entries.length} file)]\n${listing}${note}\n\n${results.join("\n\n")}`;
}

async function readUploadedFile(file, depth = 0) {
  const ext = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "";
  const binary = BINARY_FILE_PATTERN.test(ext) || file.type?.startsWith("video/");
  const limitMb = binary ? 20 : 8;
  if (file.size > limitMb * 1024 * 1024) {
    throw new Error(`${file.name}: terlalu besar (${formatBytes(file.size)}). Maksimal ${limitMb} MB.`);
  }
  if (!file.size) throw new Error(`${file.name}: file kosong.`);
  if (ext === "doc" || ext === "ppt") {
    throw new Error(`${file.name}: format .${ext} lama belum didukung. Simpan ulang sebagai .${ext}x atau PDF.`);
  }
  const result = { name: file.name, size: file.size, content: "" };
  if (file.type?.startsWith("video/") || VIDEO_FILE_PATTERN.test(ext)) {
    return readVideo(file);
  }
  if (IMAGE_FILE_PATTERN.test(ext) || file.type.startsWith("image/") && ext !== "svg") {
    return { ...result, ...await readImage(file) };
  }
  const buffer = binary ? await file.arrayBuffer() : null;
  if (ext === "pdf") {
    const parsed = await readPdf(file, buffer);
    return { ...result, content: limitText(parsed.content), ...(parsed.images?.length ? { images: parsed.images } : {}) };
  }
  if (["xlsx", "xls", "ods"].includes(ext)) {
    let content = "";
    try {
      content = await readSpreadsheet(file, buffer);
    } catch (error) {
      if (ext !== "xlsx") throw new Error(`${file.name}: spreadsheet gagal dibaca (${error.message || error}).`);
      content = await readOfficeZip(file, ext, buffer);
    }
    if (!content.replace(/\[Lembar[^\]]*\]|[,\s]/g, "")) throw new Error(`${file.name}: spreadsheet kosong.`);
    return { ...result, content: limitText(content) };
  }
  if (["docx", "pptx", "odt", "odp"].includes(ext)) {
    let content;
    try {
      content = await readOfficeZip(file, ext, buffer);
    } catch {
      throw new Error(`${file.name}: dokumen rusak atau bukan format Office yang valid.`);
    }
    if (!content.trim()) throw new Error(`${file.name}: tidak ada teks yang dapat dibaca (mungkin hanya berisi gambar).`);
    return { ...result, content: limitText(content) };
  }
  if (ext === "zip") {
    if (depth > 1) throw new Error(`${file.name}: arsip bersarang terlalu dalam.`);
    return { ...result, content: limitText(await readZip(file, buffer, depth)) };
  }
  let content = await file.text();
  if (content.includes("\u0000")) throw new Error(`${file.name}: format biner ini belum didukung.`);
  if (ext === "rtf") content = stripRtf(content);
  return { ...result, content: limitText(content) };
}

function renderAttachmentList() {
  const wrap = $("attachmentList");
  if (!wrap) return;
  wrap.replaceChildren();
  wrap.classList.toggle("hidden", pendingFiles.length === 0);
  const visibleCount = pendingFiles.length > 5 ? 3 : pendingFiles.length;
  pendingFiles.slice(0, visibleCount).forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "attachment-preview";
    const displayName = String(file.name || "Lampiran").split("/").pop();
    if (file.images?.[0]) {
      const thumb = document.createElement("img");
      thumb.className = "attachment-thumb";
      thumb.src = file.images[0];
      thumb.alt = "";
      name.append(thumb);
      chip.classList.add("has-thumb");
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.textContent = fileIcon(displayName);
      name.append(icon);
    }
    const label = document.createElement("span");
    label.className = "attachment-label";
    const title = document.createElement("span");
    title.className = "attachment-name";
    title.textContent = displayName;
    label.append(title);
    if (file.size) {
      const size = document.createElement("small");
      size.className = "attachment-size";
      size.textContent = formatBytes(file.size);
      label.append(size);
    }
    name.append(label);
    name.title = `${file.name || "Lampiran"} — klik untuk pratinjau`;
    name.onclick = () => openFilePreview(file.name, file.content, file.images?.[0] || "");
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "×"; remove.title = "Hapus lampiran";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `Hapus ${displayName}`);
    remove.onclick = () => { pendingFiles.splice(index, 1); renderAttachmentList(); };
    chip.append(name, remove); wrap.append(chip);
  });
  if (pendingFiles.length > visibleCount) {
    const more = document.createElement("span");
    more.className = "attachment-chip attachment-more";
    more.textContent = `+ ${pendingFiles.length - visibleCount} file lainnya`;
    more.title = pendingFiles.slice(visibleCount).map((file) => file.name).join("\n");
    wrap.append(more);
  }
  if (pendingFiles.length > 1) {
    const clear = document.createElement("button");
    clear.className = "attachment-clear-all";
    clear.type = "button";
    clear.textContent = "Hapus semua";
    clear.onclick = () => { pendingFiles = []; renderAttachmentList(); };
    wrap.append(clear);
  }
  updateSendBtn();
}

function bindEvents() {
  applyTheme(localStorage.getItem("myai_theme") || "light");
  setTaskMode(taskMode, false);
  restoreDraft();
  $("taskModeBtn").onclick = (event) => {
    event.stopPropagation();
    const menu = $("taskModeMenu");
    const opening = menu.classList.contains("hidden");
    closeComposerMenus(opening ? "mode" : "");
    menu.classList.toggle("hidden", !opening);
    $("taskModeBtn").setAttribute("aria-expanded", String(!menu.classList.contains("hidden")));
  };
  document.querySelectorAll("#taskModeMenu [data-mode]").forEach((button) => {
    button.onclick = () => setTaskMode(button.dataset.mode);
  });
  $("chatSearch").addEventListener("input", renderChatList);
  $("addWorkFolder").onclick = openWorkFolderDialog;
  $("workFolderForm").addEventListener("submit", createWorkFolder);
  $("closeWorkFolderDialog").onclick = () => $("workFolderDialog").close();
  $("cancelWorkFolder").onclick = () => $("workFolderDialog").close();
  $("searchChats").onclick = () => {
    const search = $("chatSearch");
    search.classList.toggle("hidden");
    if (search.classList.contains("hidden")) {
      search.value = "";
      renderChatList();
    } else {
      search.focus();
    }
  };
  $("openImageMode").onclick = () => setTaskMode("image");
  $("openFiles").onclick = () => $("fileInput").click();
  $("themeToggle").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("landingTheme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("landingLogin").onclick = () => {
    openLoginPrompt();
  };
  $("landingGuest").onclick = async () => {
    enterApp();
    pendingFiles = [];
    renderAttachmentList();
    setTaskMode("auto", false);
    await loadModels("guest");
    if (!currentUser && guestTrialRemaining === 0) {
      openLoginPrompt("Jatah dua jawaban AI gratis tanpa login sudah digunakan. Masuk dengan Google untuk melanjutkan.");
    }
    $("input").focus();
  };
  $("loginGoogle").onclick = handleGoogleLogin;
  $("closeLogin").onclick = () => $("loginDialog").close();
  $("closeFilePreview").onclick = () => $("filePreviewDialog").close();
  $("closeApiDialog").onclick = () => $("apiDialog").close();
  $("closePremiumConfirm").onclick = () => finishPremiumConfirm(false);
  $("cancelPremiumConfirm").onclick = () => finishPremiumConfirm(false);
  $("acceptPremiumConfirm").onclick = () => finishPremiumConfirm(true);
  $("premiumConfirmDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    finishPremiumConfirm(false);
  });
  $("manualApiForm").addEventListener("submit", saveManualApiKey);
  $("manualApiProvider").addEventListener("change", updateManualApiKeyActions);
  $("removeManualApiKey").onclick = removeManualApiKey;

  const input = $("input");
  const attachMenu = $("attachMenu");
  $("attachBtn").onclick = (event) => {
    event.stopPropagation();
    const opening = attachMenu.classList.contains("hidden");
    closeComposerMenus(opening ? "attach" : "");
    attachMenu.classList.toggle("hidden", !opening);
    $("attachBtn").setAttribute("aria-expanded", String(!attachMenu.classList.contains("hidden")));
  };
  attachMenu.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    attachMenu.classList.add("hidden");
    $("attachBtn").setAttribute("aria-expanded", "false");
    const action = button.dataset.action;
    if (action === "image") $("imageInput").click();
    if (action === "video") {
      $("videoStatus").textContent = videoVisionAvailable()
        ? "Video maksimal 3 menit dan 20 MB. Empat frame akan diringkas menjadi satu gambar."
        : "Belum ada model vision yang tersedia. Aktifkan atau pilih model yang mendukung gambar sebelum mengirim cuplikan.";
      $("videoDialog").showModal();
    }
    if (action === "file") $("fileInput").click();
    if (action === "folder") $("folderInput").click();
    if (action === "api") openApiDialog();
  });
  $("chooseVideoFile").onclick = () => $("videoInput").click();
  $("startVideoCamera").onclick = startVideoCamera;
  $("captureVideoFrames").onclick = captureLiveVideo;
  $("closeVideoDialog").onclick = () => $("videoDialog").close();
  $("videoDialog").addEventListener("close", stopVideoCamera);
  $("videoInput").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!$("input").value.trim()) {
      $("input").value = $("videoPrompt").value.trim();
      autosize();
      saveDraft();
    }
    $("videoDialog").close();
    await processFiles([file]);
  });
  $("clearMode").onclick = () => setComposerMode("");
  document.addEventListener("click", (event) => {
    if (!attachMenu.contains(event.target) && event.target !== $("attachBtn")) {
      attachMenu.classList.add("hidden");
      $("attachBtn").setAttribute("aria-expanded", "false");
    }
  });
  const processFiles = async (fileList) => {
    if (processingFiles) {
      toast("Lampiran sedang diproses. Tunggu sampai selesai.");
      return;
    }
    const isImageFile = (file) => /\.(?:png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(file.name || "") || file.type?.startsWith("image/");
    const isVideoFile = (file) => VIDEO_FILE_PATTERN.test((file.name || "").split(".").pop().toLowerCase()) || file.type?.startsWith("video/");
    let guestNotice = "";
    if (models.get(selected)?.provider === "guest") {
      let imageSlots = guestImageLimitReached() ? 0 : 1;
      const picked = [...fileList];
      const allowed = picked.filter((file) => {
        if (!isImageFile(file) && !isVideoFile(file)) return true;
        if (imageSlots > 0) { imageSlots--; return true; }
        return false;
      });
      if (allowed.length < picked.length) guestNotice = " Mode tamu hanya menerima 1 gambar atau cuplikan video per chat; masuk dengan Google untuk lebih banyak.";
      if (!allowed.length) {
        toast("Mode tamu hanya menerima 1 gambar atau cuplikan video per chat. Buat obrolan baru atau masuk dengan Google.");
        return;
      }
      fileList = allowed;
    }
    const MAX_FILES_PER_BATCH = 100;
    const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
    const blockedPath = /(^|\/)(?:node_modules|\.git|vendor|dist|build|coverage|\.next|\.nuxt|target|__pycache__|\.venv|venv)(?:\/|$)/i;
    const sensitivePath = /(^|\/)(?:\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|id_ed25519(?:\.[^/]*)?|credentials(?:\.[^/]*)?|secrets?\.(?:json|ya?ml)|[^/]+\.(?:pem|key|p12|pfx))$/i;
    const hiddenNoise = /(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
    const pathOf = (file) => file.relativePath || file.webkitRelativePath || file.name;
    const all = [...fileList];
    let sensitiveCount = 0;
    let duplicateCount = 0;
    const candidates = all.filter((file) => {
      const path = pathOf(file);
      if (sensitivePath.test(path)) { sensitiveCount++; return false; }
      if (blockedPath.test(path) || hiddenNoise.test(path)) return false;
      if (pendingFiles.some((pending) => pending.name === path && (!pending.size || pending.size === file.size))) {
        duplicateCount++;
        return false;
      }
      return true;
    });
    let skipped = all.length - candidates.length - duplicateCount - sensitiveCount;
    const files = [];
    let totalBytes = 0;
    for (const file of candidates) {
      if (files.length >= MAX_FILES_PER_BATCH || totalBytes + file.size > MAX_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      files.push(file);
      totalBytes += file.size;
    }
    if (!files.length) {
      if (duplicateCount) toast("File itu sudah dilampirkan.");
      else if (sensitiveCount) toast("File rahasia (.env, kunci privat, kredensial) sengaja tidak dikirim demi keamanan.");
      else toast(all.length ? "Tidak ada file yang didukung di pilihan itu. Metadata dan folder dependensi dilewati." : "Tidak ada file yang dipilih.");
      return;
    }

    processingFiles = true;
    const progressWrap = $("attachmentProcessing");
    const progressLabel = $("attachmentProcessingText");
    const attachButton = $("attachBtn");
    progressWrap?.classList.remove("hidden");
    if (attachButton) attachButton.disabled = true;
    const addedFiles = [];
    const errors = [];
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (progressLabel) progressLabel.textContent = `Membaca ${index + 1} dari ${files.length} · ${file.name.split("/").pop()}`;
        try {
          const parsed = await readUploadedFile(file);
          parsed.name = pathOf(file) || parsed.name;
          pendingFiles.push(parsed);
          addedFiles.push(parsed);
        } catch (err) {
          skipped++;
          if (errors.length < 3) errors.push(err.message || `${file.name}: gagal dibaca`);
        }
      }

      renderAttachmentList();
      const folderSelected = files.some((file) => /\//.test(pathOf(file)));
      const source = folderSelected ? "Folder" : "Lampiran";
      let summary = addedFiles.length
        ? `${source} siap: ${addedFiles.length} file.`
        : "Tidak ada file yang berhasil dibaca.";
      if (skipped) summary += ` ${skipped} dilewati.`;
      if (duplicateCount) summary += ` ${duplicateCount} sudah ada.`;
      if (sensitiveCount) summary += ` ${sensitiveCount} file rahasia tidak dikirim.`;
      if (errors.length) summary += ` ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} lainnya)` : ""}`;
      if (addedFiles.length && models.get(selected)?.provider === "guest" && addedFiles.some((file) => file.content.length > 4000)) {
        summary += " Mode tamu: isi file panjang akan dipotong; masuk dengan Google untuk file besar.";
      }
      toast(summary + guestNotice);
      input.focus();
    } finally {
      processingFiles = false;
      progressWrap?.classList.add("hidden");
      if (attachButton) attachButton.disabled = false;
      if (progressLabel) progressLabel.textContent = "Membaca file…";
      updateSendBtn();
      if (sendAfterProcessing) {
        sendAfterProcessing = false;
        send(input.value);
      }
    }
  };
  $("fileInput").addEventListener("change", async (event) => {
    await processFiles(event.target.files);
    event.target.value = "";
  });
  $("imageInput").addEventListener("change", async (event) => {
    await processFiles(event.target.files);
    event.target.value = "";
  });
  $("folderInput").addEventListener("change", async (event) => {
    await processFiles(event.target.files);
    event.target.value = "";
  });
  const autosize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  };
  input.addEventListener("input", () => {
    autosize();
    saveDraft();
    updateSendBtn();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      const sendKey = settings.enterToSend ? !e.shiftKey : (e.ctrlKey || e.metaKey);
      if (!sendKey) return;
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  input.addEventListener("paste", async (event) => {
    const data = event.clipboardData;
    if (!data?.files?.length || data.getData("text/plain").trim()) return;
    event.preventDefault();
    const stamp = new Date().toISOString().slice(11, 19).replaceAll(":", "");
    const pasted = [...data.files].map((file, index) => {
      if (!file.type.startsWith("image/") || (file.name && file.name !== "image.png")) return file;
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      return new File([file], `tempel-${stamp}${index ? `-${index + 1}` : ""}.${ext}`, { type: file.type });
    });
    await processFiles(pasted);
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (abort) {
      abort.abort();
      return;
    }
    if (processingFiles) {
      // File masih dibaca: antrekan pengiriman, kirim otomatis begitu selesai.
      sendAfterProcessing = true;
      const progressLabel = $("attachmentProcessingText");
      if (progressLabel && !/dikirim/.test(progressLabel.textContent)) {
        progressLabel.textContent += " — pesan terkirim otomatis setelah selesai";
      }
      return;
    }
    send(input.value);
  });
  $("newChat").onclick = () => {
    if (abort) return;
    stopSpeaking();
    chat = newChat(taskMode);
    renderChatList();
    renderMessages();
    closeSidebar();
    input.focus();
  };

  const collectDroppedFiles = async (dataTransfer) => {
    const entries = [...(dataTransfer.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry?.())
      .filter(Boolean);
    if (!entries.length || entries.every((entry) => entry.isFile)) return [...dataTransfer.files];
    const files = [];
    const walk = async (entry, prefix) => {
      if (files.length >= 300) return;
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
        if (file) {
          file.relativePath = prefix + file.name;
          files.push(file);
        }
        return;
      }
      if (/^(node_modules|\.git|dist|build|\.next|__pycache__|\.venv|venv)$/i.test(entry.name)) return;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    };
    for (const entry of entries) await walk(entry, "");
    return files;
  };
  let dragDepth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  const showDrop = (visible) => $("dropOverlay").classList.toggle("hidden", !visible);
  document.addEventListener("dragenter", (event) => {
    if (!hasFiles(event) || !$("landing").classList.contains("hidden")) return;
    event.preventDefault();
    dragDepth++;
    showDrop(true);
  });
  document.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showDrop(false);
  });
  document.addEventListener("drop", async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    showDrop(false);
    if (!$("landing").classList.contains("hidden")) return;
    const files = await collectDroppedFiles(event.dataTransfer);
    if (files.length) await processFiles(files);
  });

  const messagesEl = $("messages");
  messagesEl.addEventListener("scroll", () => {
    stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    $("scrollDown").classList.toggle("hidden", stickToBottom);
  }, { passive: true });
  $("scrollDown").onclick = () => {
    stickToBottom = true;
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
    $("scrollDown").classList.add("hidden");
  };

  $("shareChat").onclick = async () => {
    if (!chat.messages.length) return;
    try {
      await navigator.clipboard.writeText(chatAsMarkdown(chat));
      toast("Percakapan disalin ke clipboard.");
    } catch {
      toast("Browser menolak akses clipboard. Gunakan tombol unduh.");
    }
  };
  $("exportChat").onclick = () => {
    if (!chat.messages.length) return;
    downloadText(`${safeFilename(chat.title || "percakapan")}.md`, chatAsMarkdown(chat));
  };
  $("reloadHtmlPreview").onclick = () => {
    $("htmlPreviewFrame").srcdoc = "";
    requestAnimationFrame(() => { $("htmlPreviewFrame").srcdoc = previewSource; });
  };
  $("downloadHtmlPreview").onclick = () => {
    const title = previewSource.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]?.trim() || "pratinjau";
    const clean = previewSource.replace(PREVIEW_SHIM, "");
    downloadText(`${safeFilename(title)}.html`, clean, "text/html");
  };
  const htmlPreviewDialog = $("htmlPreviewDialog");
  $("closeHtmlPreview").onclick = () => htmlPreviewDialog.close();
  htmlPreviewDialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    htmlPreviewDialog.close();
  });
  htmlPreviewDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    htmlPreviewDialog.close();
  });
  htmlPreviewDialog.addEventListener("close", () => {
    $("htmlPreviewFrame").srcdoc = "";
    if (previewReturnFocus instanceof HTMLElement && previewReturnFocus.isConnected) previewReturnFocus.focus();
    previewReturnFocus = null;
  });
  for (const id of ["htmlPreviewDialog", "filePreviewDialog", "videoDialog"]) {
    const dialog = $(id);
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialog.close();
    });
  }

  const fillPersonalizationForm = (values) => {
    $("settingAbout").value = values.about || "";
    $("settingSystemPrompt").value = values.systemPrompt || "";
  };
  $("openPersonalization").onclick = () => {
    fillPersonalizationForm(settings);
    closeSidebar();
    $("personalizationDialog").showModal();
  };
  $("closePersonalization").onclick = () => $("personalizationDialog").close();
  $("resetPersonalization").onclick = () => fillPersonalizationForm({ ...DEFAULT_SETTINGS, showPaid: settings.showPaid });
  $("personalizationForm").addEventListener("submit", (event) => {
    event.preventDefault();
    settings = {
      ...settings,
      about: $("settingAbout").value.trim().slice(0, 1500),
      systemPrompt: $("settingSystemPrompt").value.trim() || DEFAULT_SETTINGS.systemPrompt,
    };
    saveSettings(settings);
    settings = loadSettings();
    $("personalizationDialog").close();
    toast("Personalisasi AI disimpan.");
  });
  $("exportAllChats").onclick = () => {
    const data = chats.map(durableChat);
    if (chat.messages.length && !chats.some((item) => item.id === chat.id)) data.unshift(durableChat(chat));
    if (!data.length) {
      toast("Belum ada chat untuk diunduh.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`myai-chat-${stamp}.json`, JSON.stringify({ app: APP_NAME, version: APP_VERSION, exportedAt: new Date().toISOString(), chats: data }, null, 2), "application/json");
  };
  $("clearAllChats").onclick = async () => {
    if (abort) {
      toast("Hentikan jawaban dulu sebelum menghapus chat.");
      return;
    }
    if (!chats.length) {
      toast("Belum ada chat tersimpan.");
      return;
    }
    if (!confirm(`Hapus ${chats.length} chat secara permanen? Tindakan ini tidak dapat dibatalkan.`)) return;
    let failed = 0;
    for (const item of chats.slice()) {
      try {
        const syncError = await deleteChat(item.id);
        if (syncError) failed++;
      } catch {
        failed++;
      }
    }
    chats = [];
    stopSpeaking();
    chat = newChat(taskMode);
    renderChatList();
    renderMessages();
    $("personalizationDialog").close();
    toast(failed ? `Chat lokal dihapus; ${failed} chat gagal dihapus dari cloud.` : "Semua chat dihapus.");
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("micBtn");
  const voiceDialog = $("voiceLiveDialog");
  const languageSelect = $("voiceLanguageSelect");
  const savedVoiceLanguage = localStorage.getItem("myai_voice_language");
  languageSelect.value = ["auto", "id-ID", "en-US"].includes(savedVoiceLanguage) ? savedVoiceLanguage : "auto";
  const voiceLanguage = () => {
    let language = languageSelect.value === "auto"
      ? navigator.languages?.[0] || navigator.language || "id-ID"
      : languageSelect.value;
    if (language.toLowerCase() === "id") language = "id-ID";
    if (language.toLowerCase() === "en") language = "en-US";
    try {
      return Intl.getCanonicalLocales(language)[0] || "id-ID";
    } catch {
      return "id-ID";
    }
  };
  const setVoiceStatus = (state, status, transcript = "") => {
    voiceDialog.dataset.state = state;
    $("voiceLiveStatus").textContent = status;
    $("voiceLiveTranscript").textContent = transcript;
  };
  const showVoiceRetry = (visible) => $("voiceLiveRetryBtn").classList.toggle("hidden", !visible);
  const updateVoiceTimer = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - voiceStartedAt) / 1000));
    const format = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    $("voiceLiveTimer").textContent = `${format(elapsed)} / 10:00`;
    if (elapsed >= 600) {
      toast("Sesi Voice Live berakhir setelah 10 menit.");
      endVoiceLive();
    }
  };
  const syncVoiceControls = () => {
    mic.classList.toggle("active", voiceConversationEnabled);
    mic.setAttribute("aria-pressed", String(voiceConversationEnabled));
    mic.setAttribute("aria-label", voiceConversationEnabled ? "Voice Live sedang aktif" : "Mulai Voice Live");
    mic.title = voiceConversationEnabled ? "Buka Voice Live" : "Mulai Voice Live";
    $("voiceLiveMuteBtn").classList.toggle("muted", voiceMuted);
    $("voiceLiveMuteBtn").setAttribute("aria-pressed", String(voiceMuted));
    $("voiceLiveMuteBtn").setAttribute("aria-label", voiceMuted ? "Nyalakan mikrofon" : "Matikan mikrofon sementara");
    $("voiceLiveMuteBtn").title = voiceMuted ? "Nyalakan mikrofon" : "Matikan mikrofon sementara";
    $("voiceLiveMuteBtn").textContent = voiceMuted ? "🔇" : "🎙";
  };
  const startRecognition = async ({ installLocal = false, requireLocal = false } = {}) => {
    if (!SpeechRecognition || !voiceConversationEnabled || voiceMuted || recognition || voiceRecognitionStarting || voiceSubmitting || voiceRecognitionBlocked) return;
    voiceRecognitionStarting = true;
    const startId = ++voiceRecognitionStartId;
    if (!voiceMicrophonePermissionGranted && navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        voiceMicrophonePermissionGranted = true;
      } catch (error) {
        voiceRecognitionStarting = false;
        if (startId !== voiceRecognitionStartId) return;
        voiceRecognitionBlocked = true;
        const message = error.name === "NotAllowedError" || error.name === "SecurityError"
          ? "Izin mikrofon ditolak. Buka situs di Chrome/Edge, pilih ikon pengaturan situs di kiri alamat, ubah Mikrofon menjadi Izinkan, lalu muat ulang halaman."
          : error.name === "NotFoundError" || error.name === "DevicesNotFoundError"
            ? "Mikrofon tidak ditemukan. Sambungkan mikrofon, lalu tekan Coba lagi."
            : `Mikrofon tidak dapat diakses: ${error.message || String(error)}`;
        setVoiceStatus("unsupported", "Mikrofon tidak dapat diakses", message);
        showVoiceRetry(true);
        console.error("Voice microphone permission could not be obtained:", error);
        return;
      }
    }
    if (startId !== voiceRecognitionStartId || !voiceConversationEnabled || voiceMuted || voiceSubmitting) {
      if (startId === voiceRecognitionStartId) voiceRecognitionStarting = false;
      return;
    }
    const language = voiceLanguage();
    let processLocally = false;
    if (typeof SpeechRecognition.available === "function") {
      try {
        let availability = await SpeechRecognition.available({ langs: [language], processLocally: true });
        if (availability === "downloadable" && installLocal && typeof SpeechRecognition.install === "function") {
          setVoiceStatus("connecting", "Menyiapkan pengenalan suara lokal", `Paket bahasa ${language} akan diunduh ke perangkat.`);
          const installed = await SpeechRecognition.install({ langs: [language] });
          if (!installed) throw new Error(`Paket pengenalan suara ${language} tidak dapat dipasang.`);
          availability = await SpeechRecognition.available({ langs: [language], processLocally: true });
        }
        processLocally = availability === "available";
        if (requireLocal && !processLocally && availability === "unavailable") {
          throw new Error(`Pengenalan suara lokal tidak tersedia untuk bahasa ${language} di browser ini.`);
        }
      } catch (error) {
        if (requireLocal) {
          voiceRecognitionStarting = false;
          if (startId !== voiceRecognitionStartId) return;
          voiceRecognitionBlocked = true;
          setVoiceStatus("unsupported", "Pengenalan suara lokal tidak dapat disiapkan", error.message || String(error));
          showVoiceRetry(true);
          console.error("On-device speech recognition could not be prepared:", error);
          return;
        }
        console.warn("On-device speech recognition is unavailable; using browser recognition:", error);
      }
    } else if (installLocal) {
      console.info("On-device speech recognition is not supported by this browser.");
    }
    if (startId !== voiceRecognitionStartId || !voiceConversationEnabled || voiceMuted || voiceSubmitting) {
      if (startId === voiceRecognitionStartId) voiceRecognitionStarting = false;
      return;
    }
    voiceRecognitionStarting = false;
    let instance;
    try {
      instance = new SpeechRecognition();
    } catch (error) {
      voiceRecognitionBlocked = true;
      setVoiceStatus("unsupported", "Pengenalan suara tidak dapat dimulai", error.message || String(error));
      showVoiceRetry(true);
      console.error("Speech recognition could not be created:", error);
      return;
    }
    recognition = instance;
    let recognitionError = "";
    instance.lang = language;
    if (typeof SpeechRecognition.available === "function") instance.processLocally = processLocally;
    instance.interimResults = true;
    instance.continuous = true;
    const baseText = input.value ? `${input.value.replace(/\s+$/, "")} ` : "";
    instance.onstart = () => setVoiceStatus("listening", "Aku mendengarkan");
    instance.onresult = (event) => {
      let finalText = "";
      let interim = "";
      for (const result of event.results) {
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      const recognizedText = finalText + interim;
      if (recognizedText.trim()) voiceRecognitionFailures = 0;
      input.value = baseText + recognizedText;
      autosize();
      saveDraft();
      updateSendBtn();
      $("voiceLiveTranscript").textContent = recognizedText;
      if (voiceConversationEnabled && finalText.trim()) {
        clearTimeout(voiceSubmitTimer);
        voiceSubmitTimer = window.setTimeout(submitVoiceTurn, 1100);
      }
    };
    instance.onerror = (event) => {
      recognitionError = event.error;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        voiceRecognitionBlocked = true;
        const message = event.error === "not-allowed"
          ? "Akses mikrofon diblokir. Izinkan mikrofon untuk situs ini di pengaturan browser, lalu coba lagi."
          : "Layanan pengenalan suara tidak tersedia. Coba Chrome atau Edge terbaru dan periksa koneksi internet.";
        setVoiceStatus("unsupported", "Pengenalan suara tidak tersedia", message);
        showVoiceRetry(true);
      } else if (event.error === "audio-capture") {
        voiceRecognitionBlocked = true;
        setVoiceStatus("unsupported", "Mikrofon tidak dapat digunakan", "Pastikan mikrofon terhubung dan tidak sedang dipakai aplikasi lain, lalu coba lagi.");
        showVoiceRetry(true);
      } else if (event.error === "network") {
        voiceRecognitionFailures++;
        setVoiceStatus("connecting", "Menyambungkan kembali suara", "MyAI mencoba kembali otomatis.");
        showVoiceRetry(false);
      } else if (event.error !== "aborted" && event.error !== "no-speech") {
        voiceRecognitionBlocked = true;
        setVoiceStatus("unsupported", "Pengenalan suara terhenti", "Coba lagi atau gunakan Chrome/Edge terbaru dengan izin mikrofon aktif.");
        showVoiceRetry(true);
      }
    };
    instance.onend = () => {
      if (recognition === instance) recognition = null;
      syncVoiceControls();
      if (recognitionError === "network") {
        if (voiceRecognitionFailures >= VOICE_MAX_RECONNECT_ATTEMPTS) {
          voiceRecognitionBlocked = true;
          setVoiceStatus("connecting", "Koneksi suara terputus", "Tidak dapat tersambung setelah beberapa kali mencoba. Periksa koneksi internet, lalu coba lagi.");
          showVoiceRetry(true);
        } else {
          setVoiceStatus("connecting", "Menyambungkan kembali suara", "MyAI akan mencoba kembali otomatis.");
          showVoiceRetry(false);
        }
      }
      if (voiceConversationEnabled && !voiceSubmitting && !voiceMuted && !voiceRecognitionBlocked) {
        const delay = recognitionError === "network"
          ? Math.min(15000, 800 * (2 ** Math.min(voiceRecognitionFailures - 1, 5)))
          : 500;
        clearTimeout(voiceRecognitionRetryTimer);
        voiceRecognitionRetryTimer = window.setTimeout(() => {
          voiceRecognitionRetryTimer = 0;
          startRecognition();
        }, delay);
      } else if (voiceConversationEnabled && voiceMuted) {
        setVoiceStatus("paused", "Mikrofon dijeda");
      }
    };
    try {
      instance.start();
    } catch (error) {
      recognition = null;
      voiceRecognitionBlocked = true;
      setVoiceStatus("unsupported", "Mikrofon tidak dapat dimulai", "Browser menolak memulai pengenalan suara. Periksa izin mikrofon, lalu coba lagi.");
      showVoiceRetry(true);
      syncVoiceControls();
      console.error("Speech recognition could not start:", error);
    }
  };
  async function submitVoiceTurn() {
    if (!voiceConversationEnabled || voiceSubmitting) return;
    voiceSubmitTimer = 0;
    const spokenText = input.value.trim();
    if (!spokenText) return;
    voiceSubmitting = true;
    setVoiceStatus("thinking", "Sedang berpikir", spokenText);
    recognition?.stop();
    let answer = null;
    try {
      const messageCount = chat.messages.length;
      await send(spokenText);
      if (chat.messages.length > messageCount) answer = chat.messages[chat.messages.length - 1];
    } catch (error) {
      console.error("Voice conversation turn failed:", error);
      setVoiceStatus("listening", "Belum terkirim", "Ucapkan lagi untuk mencoba kembali.");
    }
    const resumeListening = () => {
      voiceSubmitting = false;
      if (voiceConversationEnabled && !voiceMuted) startRecognition();
    };
    if (answer?.role === "assistant" && answer.content && !answer.error && voiceConversationEnabled) {
      setVoiceStatus("speaking", "MyAI sedang berbicara", answer.content);
      speakMessage(answer, null, resumeListening);
    } else if (answer?.role === "assistant" && answer.error) {
      voiceSubmitting = false;
      const detail = cleanAnswerText(answer.content).replace(/\*\*/g, "").slice(0, 600);
      setVoiceStatus("unsupported", "MyAI tidak dapat menjawab", detail);
    } else {
      resumeListening();
    }
  }
  function endVoiceLive() {
    voiceConversationEnabled = false;
    voiceMuted = false;
    voiceSubmitting = false;
    clearTimeout(voiceSubmitTimer);
    clearTimeout(voiceRecognitionRetryTimer);
    voiceSubmitTimer = 0;
    voiceRecognitionRetryTimer = 0;
    clearInterval(voiceTimerId);
    voiceTimerId = 0;
    recognition?.stop();
    recognition = null;
    voiceRecognitionStartId++;
    voiceRecognitionStarting = false;
    voiceRecognitionBlocked = false;
    voiceMicrophonePermissionGranted = false;
    voiceRecognitionFailures = 0;
    showVoiceRetry(false);
    stopSpeaking();
    $("voiceLiveSettings").classList.add("hidden");
    $("voiceLiveSettingsBtn").setAttribute("aria-expanded", "false");
    syncVoiceControls();
    if (voiceDialog.open) voiceDialog.close();
  }
  const startVoiceLive = () => {
    if (!window.isSecureContext) {
      toast("Voice Live memerlukan HTTPS atau localhost.");
      return;
    }
    if (voiceConversationEnabled) {
      voiceDialog.showModal();
      return;
    }
    voiceConversationEnabled = true;
    voiceMuted = false;
    voiceSubmitting = false;
    voiceRecognitionFailures = 0;
    voiceRecognitionBlocked = false;
    showVoiceRetry(false);
    voiceStartedAt = Date.now();
    $("voiceLiveTimer").textContent = "00:00 / 10:00";
    $("voiceLiveModel").textContent = models.get(selected)?.name || "MyAI";
    $("voiceLiveSettings").classList.add("hidden");
    $("voiceLiveSettingsBtn").setAttribute("aria-expanded", "false");
    syncVoiceControls();
    if (voiceDialog.open) voiceDialog.close();
    voiceDialog.showModal();
    voiceTimerId = window.setInterval(updateVoiceTimer, 1000);
    updateVoiceTimer();
    if (!SpeechRecognition) {
      setVoiceStatus("unsupported", "Browser belum mendukung pengenalan suara", "Coba Chrome atau Edge terbaru melalui HTTPS.");
      return;
    }
    setVoiceStatus("listening", "Meminta izin mikrofon");
    startRecognition({ installLocal: true });
  };
  $("voiceLiveRetryBtn").onclick = () => {
    if (!voiceConversationEnabled || voiceMuted || !SpeechRecognition) return;
    clearTimeout(voiceRecognitionRetryTimer);
    voiceRecognitionRetryTimer = 0;
    voiceRecognitionFailures = 0;
    voiceRecognitionBlocked = false;
    showVoiceRetry(false);
    setVoiceStatus("listening", "Menyambungkan mikrofon");
    startRecognition({ installLocal: true, requireLocal: true });
  };
  $("endVoiceLive").onclick = endVoiceLive;
  $("voiceLiveMuteBtn").onclick = () => {
    if (!voiceConversationEnabled) return;
    voiceMuted = !voiceMuted;
    syncVoiceControls();
    if (voiceMuted) {
      recognition?.stop();
      setVoiceStatus("paused", "Mikrofon dijeda");
    } else {
      startRecognition();
    }
  };
  $("voiceLiveSettingsBtn").onclick = (event) => {
    event.stopPropagation();
    const settings = $("voiceLiveSettings");
    const opening = settings.classList.contains("hidden");
    settings.classList.toggle("hidden", !opening);
    $("voiceLiveSettingsBtn").setAttribute("aria-expanded", String(opening));
  };
  $("voiceLiveDialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    endVoiceLive();
  });
  $("voiceLiveDialog").addEventListener("click", (event) => {
    if (event.target === voiceDialog) endVoiceLive();
  });
  languageSelect.addEventListener("change", () => {
    localStorage.setItem("myai_voice_language", languageSelect.value);
    if (voiceConversationEnabled && !voiceMuted && !voiceSubmitting) {
      if (voiceRecognitionStarting) {
        voiceRecognitionStartId++;
        voiceRecognitionStarting = false;
        startRecognition();
      } else {
        recognition?.stop();
      }
    }
  });
  mic.title = "Mulai Voice Live";
  mic.setAttribute("aria-label", "Mulai Voice Live");
  mic.onclick = startVoiceLive;

  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      $("newChat").click();
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      const search = $("chatSearch");
      search.classList.remove("hidden");
      if (window.matchMedia("(max-width: 800px)").matches) {
        $("sidebar").classList.add("open");
        $("backdrop").classList.add("show");
      } else {
        document.querySelector(".app").classList.remove("sidebar-collapsed");
      }
      search.focus();
      search.select();
    } else if (event.key === "Escape" && abort && !document.querySelector("dialog[open]")) {
      abort.abort();
    }
  });

  $("modelBtn").onclick = (event) => {
    event.stopPropagation();
    if ($("modelMenu").classList.contains("hidden")) {
      closeComposerMenus("model");
      openModelMenu();
    } else {
      closeModelMenu();
    }
  };
  $("refreshModelsBtn").onclick = refreshModelCatalog;
  $("modelSearch").addEventListener("input", renderModelList);
  $("modelSearch").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = $("modelList").querySelector(".model-item");
      if (first) selectModel(first.dataset.value);
    }
  });
  document.addEventListener("click", (e) => {
    if (!$("modelPicker").contains(e.target)) closeModelMenu();
    if (!$ ("taskModePicker").contains(e.target)) {
      $("taskModeMenu").classList.add("hidden");
      $("taskModeBtn").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelMenu();
      attachMenu.classList.add("hidden");
      $("attachBtn").setAttribute("aria-expanded", "false");
      $("taskModeMenu").classList.add("hidden");
      $("taskModeBtn").setAttribute("aria-expanded", "false");
    }
  });

  $("toggleSidebar").onclick = () => {
    const app = document.querySelector(".app");
    const sidebar = $("sidebar");
    if (window.matchMedia("(max-width: 800px)").matches) {
      sidebar.classList.toggle("open");
      $("backdrop").classList.toggle("show", sidebar.classList.contains("open"));
    } else {
      app.classList.toggle("sidebar-collapsed");
    }
    $("toggleSidebar").setAttribute("aria-expanded", String(window.matchMedia("(max-width: 800px)").matches
      ? sidebar.classList.contains("open")
      : !app.classList.contains("sidebar-collapsed")));
  };
  $("backdrop").onclick = closeSidebar;
}

async function main() {
  document.title = `${APP_NAME} | Chat AI untuk bekerja, belajar, dan berkarya`;
  $("appName").textContent = APP_NAME;
  $("appVersion").textContent = "v" + APP_VERSION;
  bindEvents();
  renderMessages();
  try {
    await initFirebase(async (user) => {
      const uid = user?.uid || null;
      if (uid !== lastAuthUid) {
        lastAuthUid = uid;
        invalidateGuestModels();
        guestTrialVersion++;
        guestTrialRemaining = null;
        modelsToken++;
      }
      currentUser = user;
      manualApiKeys = {};
      renderAccount(user);
      if (user) {
        enterApp();
        const welcomedUid = localStorage.getItem("myai_welcome_uid");
        if (welcomedUid !== user.uid) {
          localStorage.setItem("myai_welcome_uid", user.uid);
          toast(`✨ Selamat datang di MyAI, ${user.displayName || "teman"}!`, "welcome");
        }
      }
      if (user) {
        try {
          manualApiKeys = await loadCloudApiKeys();
        } catch (error) {
          notifySyncError("API key akun belum termuat", error);
        }
      }
      if (currentUser?.uid !== user?.uid) return;
      try {
        chats = await listChats();
        restoreChatFolders();
        const syncError = consumeSyncError();
        if (syncError) {
          notifySyncError("Riwayat cloud belum termuat; chat di perangkat ini ditampilkan", syncError);
        }
      } catch (e) {
        chats = [];
        console.warn("Gagal memuat riwayat:", e);
      }
      chat = newChat(taskMode);
      renderChatList();
      renderMessages();
      await loadModels();
    }, (error) => {
      consumeAuthError();
      toast("Login Google belum selesai: " + explainFirebaseAuthError(error));
    });
    const authError = consumeAuthError();
    if (authError) toast("Login Google belum selesai: " + explainFirebaseAuthError(authError));
  } catch (error) {
    console.warn("Firebase tidak dapat dimuat; aplikasi berjalan dalam mode lokal.", error);
    currentUser = null;
    renderAccount(null);
    chats = await listChats().catch(() => []);
    restoreChatFolders();
    renderChatList();
    await loadModels();
  }
}

main().catch((e) => {
  console.error(e);
  toast("Gagal memulai aplikasi: " + e.message);
});
