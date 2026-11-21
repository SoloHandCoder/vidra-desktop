// Cloud sync through a private (secret) GitHub Gist. Same format as the
// Vidra Android app, so computers and phones share every profile's
// history, saved titles, progress, watched episodes, ratings, lists and stats.
//
// Gist "Streambert sync":
//   streambert-sync.json   { app, version, updatedAt, profiles: [...], deleted: [...] }
//   profile-<id>.json      { version, updatedAt, profile: {id,name,color}, data: { saved, history, … } }
import { mergeProfile, mergeProfileList, same } from "./syncMerge.js";
import { getMeta, readProfileData, writeProfileData, applyProfileList, isPersonalKey } from "../extras/profiles.js";

const API = () => localStorage.getItem("__sb_sync_api") || "https://api.github.com"; // overridable for tests
const DESC = "Streambert sync";
const INDEX = "streambert-sync.json";
const TOKEN_KEY = "githubSyncToken"; // stored with the OS-encrypted secure storage
const STATE_KEY = "__sb_sync";
const BASE = (id) => `__sb_sync_base_${id}`;
const AUTO_MS = 5 * 60 * 1000;
// resume positions of downloaded files are keyed by this device's file paths → not synced
const DEVICE_ONLY = ["localPos_"];
const deviceOnly = (k) => DEVICE_ONLY.some((pre) => k.startsWith(pre));

const listeners = new Set();
let running = null;
let tokenCache = null;

async function getToken() {
  if (tokenCache !== null) return tokenCache;
  try {
    tokenCache = (await window.electron?.secureGet?.(TOKEN_KEY)) || "";
  } catch {
    tokenCache = "";
  }
  return tokenCache;
}
async function setToken(v) {
  tokenCache = v || "";
  try {
    await window.electron?.secureSet?.(TOKEN_KEY, v || "");
  } catch {}
}

function state() {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
  } catch {
    return {};
  }
}
function setState(patch) {
  const s = { ...state(), ...patch };
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
  emit();
  return s;
}
function emit() {
  const st = getStatus();
  listeners.forEach((cb) => cb(st));
}

export function getStatus() {
  const s = state();
  return {
    connected: !!s.login && !!s.hasToken,
    login: s.login || null,
    lastSync: s.lastSync || null,
    lastError: s.lastError || null,
    auto: s.auto !== false,
    syncing: !!running,
  };
}
export function onStatus(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function gh(path, { method = "GET", body, tok } = {}) {
  tok = tok ?? (await getToken());
  const res = await fetch(API() + path, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401) throw new Error("GitHub rejected the token (expired or revoked).");
  if (res.status >= 400) throw new Error(data?.message ? `GitHub: ${data.message}` : `GitHub error ${res.status}`);
  return { data, headers: res.headers };
}

// data other Streambert apps keep in a profile that this version doesn't know
// yet: passed through untouched so a desktop sync never drops it
const foreign = (data) =>
  Object.fromEntries(Object.entries(data || {}).filter(([k]) => !isPersonalKey(k) && !deviceOnly(k)));

// ── public API ───────────────────────────────────────────────────────────────
export async function connect(tok) {
  tok = String(tok || "").trim();
  if (!tok) throw new Error("Paste a GitHub token first.");
  const { data: user, headers } = await gh("/user", { tok });
  const scopes = headers.get("x-oauth-scopes");
  if (scopes && !scopes.split(/,\s*/).includes("gist")) throw new Error('This token is missing the "gist" permission.');
  await setToken(tok);
  let gistId = null;
  for (let page = 1; page <= 5 && !gistId; page++) {
    const { data: gists } = await gh(`/gists?per_page=100&page=${page}`);
    if (!Array.isArray(gists) || !gists.length) break;
    const hit = gists.find((g) => g.description === DESC && g.files?.[INDEX]);
    if (hit) gistId = hit.id;
  }
  setState({ login: user?.login || "GitHub", gistId, hasToken: true, lastError: null });
  return syncNow();
}

export async function disconnect() {
  await setToken("");
  for (const p of getMeta().list) localStorage.removeItem(BASE(p.id));
  localStorage.removeItem(STATE_KEY);
  emit();
}

export function setAuto(v) {
  setState({ auto: !!v });
}

async function readGist(id) {
  const { data } = await gh(`/gists/${id}`);
  const files = {};
  for (const [name, f] of Object.entries(data?.files || {})) {
    let content = f.content;
    if (f.truncated && f.raw_url) content = await (await fetch(f.raw_url)).text();
    try {
      files[name] = JSON.parse(content);
    } catch {}
  }
  return files;
}

/** One full sync of every profile. Safe to call often (does nothing while a sync runs). */
export function syncNow() {
  if (running) return running;
  running = (async () => {
    if (!(await getToken())) return;
    await doSync();
    setState({ lastSync: Date.now(), lastError: null });
  })()
    .catch((e) => setState({ lastError: String(e?.message || e) }))
    .finally(() => {
      running = null;
      emit();
    });
  emit();
  return running;
}

async function doSync() {
  let remote = {};
  if (state().gistId) {
    try {
      remote = await readGist(state().gistId);
    } catch (e) {
      if (/Not Found/.test(String(e?.message))) setState({ gistId: null });
      else throw e;
    }
  }
  const meta = getMeta();
  const localIndex = {
    profiles: meta.list.map(({ id, name, color, editedAt, kids, ageLimit }) => ({ id, name, color, editedAt, ...(kids ? { kids: true, ageLimit } : {}) })),
    deleted: meta.deleted || [],
  };
  const remoteIndex = remote[INDEX] || { profiles: [], deleted: [] };
  const mergedList = mergeProfileList(localIndex, remoteIndex, meta.current);
  applyProfileList(mergedList.profiles, mergedList.deleted);

  const now = Date.now();
  const outFiles = {};
  let currentChanged = false;
  for (const p of mergedList.profiles) {
    const fname = `profile-${p.id}.json`;
    const base = JSON.parse(localStorage.getItem(BASE(p.id)) || "{}");
    const all = readProfileData(p.id);
    const devOnly = {}, local = {};
    for (const [k, v] of Object.entries(all)) (deviceOnly(k) ? devOnly : local)[k] = v;
    const remoteRaw = remote[fname]?.data || {};
    const remoteData = Object.fromEntries(Object.entries(remoteRaw).filter(([k]) => isPersonalKey(k) && !deviceOnly(k)));
    const merged = mergeProfile(base, local, remoteData);
    if (!same(merged, local)) {
      if (writeProfileData(p.id, { ...merged, ...devOnly })) currentChanged = true;
    }
    if (!same(merged, remoteData) || !remote[fname]) {
      outFiles[fname] = {
        content: JSON.stringify({
          version: 1,
          updatedAt: now,
          profile: { id: p.id, name: p.name, color: p.color },
          data: { ...foreign(remoteRaw), ...merged },
        }),
      };
    }
    localStorage.setItem(BASE(p.id), JSON.stringify(merged));
  }
  for (const id of mergedList.deleted) {
    if (remote[`profile-${id}.json`]) outFiles[`profile-${id}.json`] = null; // delete file
    localStorage.removeItem(BASE(id));
  }
  if (
    !same(mergedList, { profiles: remoteIndex.profiles || [], deleted: remoteIndex.deleted || [] }) ||
    !remote[INDEX] ||
    Object.keys(outFiles).length
  ) {
    outFiles[INDEX] = {
      content: JSON.stringify({ app: "streambert", version: 1, updatedAt: now, ...mergedList }, null, 1),
    };
  }

  if (Object.keys(outFiles).length) {
    if (!state().gistId) {
      const files = Object.fromEntries(Object.entries(outFiles).filter(([, v]) => v));
      const { data } = await gh("/gists", { method: "POST", body: { description: DESC, public: false, files } });
      setState({ gistId: data.id });
    } else {
      await gh(`/gists/${state().gistId}`, { method: "PATCH", body: { files: outFiles } });
    }
  }
  if (currentChanged) window.dispatchEvent(new Event("streambert:sync-applied"));
}

/** Auto sync: on start, every 5 minutes, and when the window is hidden / closed. */
export function initCloudSync() {
  const auto = () => getStatus().connected && getStatus().auto && syncNow();
  setTimeout(auto, 5000);
  setInterval(auto, AUTO_MS);
  let lastBack = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) auto();
    // back in the app: pick up what happened on your other devices
    else if (Date.now() - lastBack > 60000) {
      lastBack = Date.now();
      auto();
    }
  });
  window.addEventListener("beforeunload", () => {
    if (getStatus().connected && getStatus().auto) syncNow();
  });
}
