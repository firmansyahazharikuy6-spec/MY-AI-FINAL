import { firebaseConfig } from "./config.js?v=20261019-v5.14";

const FB_BASE = "https://www.gstatic.com/firebasejs/10.12.2";
const LS_KEY = "myai_chats";

export const firebaseEnabled = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let fb = null;
let auth = null;
let db = null;
let user = null;
let lastSyncError = null;
let lastAuthError = null;
const GOOGLE_REDIRECT_PENDING_KEY = "myai_google_redirect_pending";

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

export async function initFirebase(onUserChange, onAuthFailure = () => {}) {
  if (!firebaseEnabled) {
    onUserChange(null);
    return;
  }
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${FB_BASE}/firebase-app.js`),
    import(`${FB_BASE}/firebase-auth.js`),
    import(`${FB_BASE}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  auth = authMod.getAuth(app);
  db = fsMod.getFirestore(app);
  fb = { ...authMod, ...fsMod };
  let resolveInitialAuthState;
  const initialAuthState = new Promise((resolve) => {
    resolveInitialAuthState = resolve;
  });
  let initialAuthStateResolved = false;
  const finishInitialAuthState = (initialUser) => {
    if (initialAuthStateResolved) return;
    initialAuthStateResolved = true;
    resolveInitialAuthState(initialUser);
  };
  let redirectUser = null;
  let hasPublishedAuthState = false;
  let lastPublishedUid = null;
  const publishAuthState = (u) => {
    if (redirectUser && !u) return;
    user = u;
    finishInitialAuthState(u);
    const uid = u?.uid || null;
    if (hasPublishedAuthState && uid === lastPublishedUid) return;
    hasPublishedAuthState = true;
    lastPublishedUid = uid;
    onUserChange(u);
  };
  fb.onAuthStateChanged(auth, (u) => {
    publishAuthState(u);
  }, (error) => {
    lastAuthError = error;
    finishInitialAuthState(null);
    onAuthFailure(error);
  });
  let redirectResult = null;
  let redirectPending = false;
  try {
    redirectPending = sessionStorage.getItem(GOOGLE_REDIRECT_PENDING_KEY) === "1";
  } catch (error) {
    lastAuthError = error;
  }
  try {
    redirectResult = await fb.getRedirectResult(auth);
    if (redirectResult?.user) {
      redirectUser = redirectResult.user;
      publishAuthState(redirectUser);
    }
  } catch (error) {
    lastAuthError = error;
  } finally {
    if (redirectPending) {
      try {
        sessionStorage.removeItem(GOOGLE_REDIRECT_PENDING_KEY);
      } catch (error) {
        lastAuthError ||= error;
      }
    }
  }
  const initialUser = await initialAuthState;
  if (redirectPending && !redirectResult?.user && !initialUser && !lastAuthError) {
    const error = new Error("Google kembali tanpa membuat sesi login. Periksa domain resmi Firebase dan izin cookie/penyimpanan browser.");
    error.code = "auth/redirect-no-user";
    lastAuthError = error;
  }
  return user;
}

export async function signIn() {
  if (!fb || !auth) throw new Error("Firebase Auth belum siap. Tunggu sebentar lalu coba lagi.");
  const provider = new fb.GoogleAuthProvider();
  await fb.setPersistence(auth, fb.browserLocalPersistence);
  try {
    sessionStorage.setItem(GOOGLE_REDIRECT_PENDING_KEY, "1");
  } catch (error) {
    throw new Error(`Browser tidak dapat menyimpan status login untuk proses redirect: ${error.message || String(error)}`);
  }
  try {
    await fb.signInWithRedirect(auth, provider);
  } catch (error) {
    try {
      sessionStorage.removeItem(GOOGLE_REDIRECT_PENDING_KEY);
    } catch (storageError) {
      console.warn("Status redirect login tidak dapat dibersihkan setelah kegagalan:", storageError);
    }
    throw error;
  }
  return null;
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

const API_KEY_PROVIDERS = ["gemini", "groq", "openrouter"];

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
  const manualApiKeys = Object.fromEntries(API_KEY_PROVIDERS.flatMap((provider) => {
    const key = typeof keys?.[provider] === "string" ? keys[provider].trim() : "";
    return key ? [[provider, key]] : [];
  }));
  await withTimeout(fb.setDoc(settingsDoc(), {
    manualApiKeys,
    updatedAt: Date.now(),
  }, { mergeFields: ["manualApiKeys", "updatedAt"] }));
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
