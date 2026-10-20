import { firebaseConfig } from "./config.js?v=20261019-v5.28";

const FB_BASE = "https://www.gstatic.com/firebasejs/10.12.2";
const LS_KEY = "myai_chats";

export const firebaseEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let fb = null;
let auth = null;
let db = null;
let user = null;
let firebaseInitPromise = null;
let firebaseInitError = null;
let lastSyncError = null;
let lastAuthError = null;

export function consumeAuthError() {
  const error = lastAuthError;
  lastAuthError = null;
  return error;
}

export function consumeSyncError() {
  const error = lastSyncError;
  lastSyncError = null;
  return error;
}

export async function initFirebase(onUserChange) {
  if (!firebaseEnabled) {
    onUserChange(null);
    return;
  }
  firebaseInitError = null;
  firebaseInitPromise = (async () => {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(`${FB_BASE}/firebase-app.js`),
      import(`${FB_BASE}/firebase-auth.js`),
      import(`${FB_BASE}/firebase-firestore.js`),
    ]);
    const app = appMod.initializeApp(firebaseConfig);
    auth = authMod.getAuth(app);
    db = fsMod.getFirestore(app);
    fb = { ...authMod, ...fsMod };
    fb.onAuthStateChanged(auth, (u) => {
      user = u;
      onUserChange(u);
    }, (error) => {
      lastAuthError = error;
    });
    try {
      await fb.getRedirectResult(auth);
    } catch (error) {
      lastAuthError = error;
    }
  })();
  try {
    await firebaseInitPromise;
  } catch (error) {
    firebaseInitError = error;
    throw error;
  }
}

export async function signIn() {
  if ((!fb || !auth) && firebaseInitPromise) {
    try {
      await firebaseInitPromise;
    } catch (error) {
      const reason = error?.message || String(error);
      throw new Error(`Firebase gagal dimuat: ${reason}. Periksa koneksi ke Firebase dan konfigurasi aplikasi.`);
    }
  }
  if (!fb || !auth) {
    const reason = firebaseInitError?.message;
    throw new Error(reason
      ? `Firebase gagal dimuat: ${reason}. Periksa koneksi ke Firebase dan konfigurasi aplikasi.`
      : "Firebase Auth belum diinisialisasi. Muat ulang halaman lalu coba lagi.");
  }
  const provider = new fb.GoogleAuthProvider();
  try {
    return await fb.signInWithPopup(auth, provider);
  } catch (error) {
    if (!["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(error?.code)) {
      throw error;
    }
    await fb.signInWithRedirect(auth, provider);
    return null;
  }
}

export const signOutUser = () => fb.signOut(auth);
export const getAuthToken = () => user ? user.getIdToken() : Promise.resolve("");

const readLocal = () => {
  try {
    const chats = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return chats && typeof chats === "object" && !Array.isArray(chats) ? chats : {};
  } catch {
    return {};
  }
};
const writeLocal = (obj) => localStorage.setItem(LS_KEY, JSON.stringify(obj));
function withTimeout(promise, timeoutMs = 8000) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Firebase tidak memberi konfirmasi tepat waktu.");
      error.code = "sync-timeout";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
const chatsCol = () => fb.collection(db, "users", user.uid, "chats");
const settingsDoc = () => fb.doc(db, "users", user.uid, "private", "settings");

export async function loadCloudSettings() {
  if (!user) return null;
  const snap = await fb.getDoc(settingsDoc());
  return snap.exists() ? snap.data() : null;
}

export async function saveCloudSettings(settings) {
  if (!user) return;
  await fb.setDoc(settingsDoc(), { ...settings, updatedAt: Date.now() });
}

const API_KEY_PROVIDERS = ["gemini", "geminiLive", "groq", "openrouter", "monid"];

export async function loadCloudApiKeys() {
  if (!user) return {};
  const snap = await withTimeout(fb.getDoc(settingsDoc()));
  const saved = snap.exists() ? snap.data().manualApiKeys : null;
  return Object.fromEntries(API_KEY_PROVIDERS.flatMap((provider) => {
    const key = saved?.[provider];
    return typeof key === "string" && key.trim() ? [[provider, key.trim()]] : [];
  }));
}

export async function saveCloudApiKeys(keys) {
  if (!user) throw new Error("Masuk dengan Google untuk menyimpan API key ke akun.");
  if (!fb || !db) throw new Error("Firebase belum siap. Muat ulang halaman dan masuk kembali.");
  const manualApiKeys = Object.fromEntries(API_KEY_PROVIDERS.flatMap((provider) => {
    const key = typeof keys?.[provider] === "string" ? keys[provider].trim() : "";
    return key ? [[provider, key]] : [];
  }));
  await withTimeout(fb.setDoc(settingsDoc(), {
    manualApiKeys,
    updatedAt: Date.now(),
  }, { merge: true }));
}

export async function listChats() {
  if (user) {
    try {
      const snap = await withTimeout(fb.getDocs(fb.query(chatsCol(), fb.orderBy("updatedAt", "desc"))));
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (error) {
      lastSyncError = error;
    }
  }
  return Object.values(readLocal()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveChat(chat) {
  // Firestore menolak nilai undefined; round-trip JSON membuangnya.
  const data = JSON.parse(JSON.stringify(chat));
  const all = readLocal();
  all[data.id] = data;
  writeLocal(all);
  if (user) {
    const { id, ...rest } = data;
    try {
      await withTimeout(fb.setDoc(fb.doc(chatsCol(), id), rest));
    } catch (error) {
      return error;
    }
  }
  return null;
}

export async function deleteChat(id) {
  const all = readLocal();
  delete all[id];
  writeLocal(all);
  if (user) {
    try {
      await withTimeout(fb.deleteDoc(fb.doc(chatsCol(), id)));
    } catch (error) {
      return error;
    }
  }
  return null;
}
