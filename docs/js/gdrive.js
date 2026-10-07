/**
 * gdrive.js — Google Drive import.
 *
 * One-time setup (can't be faked — Google requires an OAuth client):
 *   1. console.cloud.google.com → create a project
 *   2. APIs & Services → Library → enable "Google Drive API"
 *   3. Credentials → Create credentials → OAuth client ID → Web application
 *   4. Authorized JavaScript origins: https://pageturner.pages.dev
 *      (+ http://localhost:8080 for local testing)
 *   5. Paste the client ID below.
 * Client IDs are public by design — they identify the app, they aren't a
 * secret. Until one is set, the import menu's Drive entry shows setup help.
 * Scope used: drive.readonly — Pageturner can read files the user picks,
 * nothing else. Access tokens live only in memory; nothing is persisted.
 */
import { $, openSheet, closeSheet, toast, fmtBytes, progressPill, listSheet } from "./util.js";
import { AUDIO_EXTS, TEXT_EXTS, FOLIATE_EXTS } from "./detect.js";
import { doImport } from "./library.js";

export const GOOGLE_CLIENT_ID = "";

const API = "https://www.googleapis.com/drive/v3";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const IMPORTABLE = new Set([...AUDIO_EXTS, ...TEXT_EXTS, ...FOLIATE_EXTS, "pdf", "cbr", "zip"]);

const ext = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

let token = null;
let client = null;
let gsiLoading = null;

const loadGsi = () => gsiLoading ??= new Promise((res, rej) => {
  const s = document.createElement("script");
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true;
  s.onload = res;
  s.onerror = () => {
    gsiLoading = null;
    rej(new Error("Couldn’t load Google sign-in — check your connection."));
  };
  document.head.append(s);
});

const getToken = () => new Promise((resolve, reject) => {
  if (token) return resolve(token);
  loadGsi().then(() => {
    client ??= window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: () => {},
    });
    client.callback = (r) =>
      r.error ? reject(new Error("Google sign-in was cancelled."))
        : resolve(token = r.access_token);
    client.requestAccessToken({ prompt: "" });
  }).catch(reject);
});

const api = async (path, retry = true) => {
  const res = await fetch(`${API}/${path}`, {
    headers: { Authorization: `Bearer ${await getToken()}` },
  });
  // tokens expire in ~1h — drop it and ask for a fresh one once
  if (res.status === 401 && retry) { token = null; return api(path, false); }
  if (!res.ok) throw new Error(`Drive error ${res.status}`);
  return res.json();
};

// ---------- folder browser ----------

const crumbs = [];         // [{ id, name }] — crumbs[0] is always root
const picked = new Map();  // id → file

const driveRow = (icon, name, sub, onTap, { off = false, on = false } = {}) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "drive-row" + (on ? " picked" : "") + (off ? " off" : "");
  const i = document.createElement("span");
  i.className = "drive-row-icon";
  i.textContent = icon;
  const mid = document.createElement("span");
  mid.className = "drive-row-main";
  const n = document.createElement("span");
  n.className = "drive-row-name";
  n.textContent = name;
  mid.append(n);
  if (sub) {
    const s = document.createElement("span");
    s.className = "drive-row-sub";
    s.textContent = sub;
    mid.append(s);
  }
  b.append(i, mid);
  b.addEventListener("click", onTap);
  return b;
};

const loadFolder = async (crumb) => {
  const list = $("drive-list");
  list.textContent = "";
  list.append(driveRow("…", "Loading", ""));
  const q = crumb.special === "shared"
    ? "sharedWithMe and trashed=false"
    : `'${crumb.id}' in parents and trashed=false`;
  const data = await api(
    `files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)` +
    "&orderBy=folder,name&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&spaces=drive"
  );
  render(crumb, data.files || []);
};

const render = (crumb, items) => {
  const list = $("drive-list");
  list.textContent = "";
  $("drive-path").textContent = crumbs.map((c) => c.name).join(" / ");
  $("drive-back").hidden = crumbs.length <= 1;

  if (crumb.id === "root" && !crumb.special)
    list.append(driveRow("👥", "Shared with me", "", () => {
      crumbs.push({ id: "shared", name: "Shared with me", special: "shared" });
      loadFolder(crumbs[crumbs.length - 1]).catch(fail);
    }));

  let shown = 0;
  for (const f of items) {
    if (f.mimeType === FOLDER) {
      shown++;
      list.append(driveRow("📁", f.name, "", () => {
        crumbs.push({ id: f.id, name: f.name });
        loadFolder(f).catch(fail);
      }));
      continue;
    }
    if (f.mimeType.startsWith("application/vnd.google-apps.")) continue; // Docs/Sheets aren't files
    shown++;
    const e = ext(f.name);
    const ok = IMPORTABLE.has(e);
    const sel = picked.has(f.id);
    list.append(driveRow(ok ? (sel ? "✓" : "📄") : "—", f.name,
      `${e ? "." + e : "file"}${f.size ? " · " + fmtBytes(+f.size) : ""}` +
        (ok ? "" : " — not a supported type"),
      () => {
        if (!ok) return;
        if (picked.has(f.id)) picked.delete(f.id); else picked.set(f.id, f);
        render(crumb, items);
      },
      { off: !ok, on: sel }));
  }
  if (!shown) list.append(driveRow("—", "Empty folder", "", () => {}));

  const n = picked.size;
  $("drive-foot").hidden = !n;
  $("drive-count").textContent = `${n} selected`;
};

const fail = (e) => {
  closeSheet();
  toast(e.message || "Drive load failed", { error: true });
};

const downloadAll = async () => {
  const files = [...picked.values()];
  closeSheet();
  const pill = progressPill(`Downloading ${files.length} file${files.length === 1 ? "" : "s"} from Drive…`);
  try {
    const out = [];
    let i = 0;
    for (const f of files) {
      i++;
      pill.set(`Downloading ${i}/${files.length} — ${f.name}`);
      const res = await fetch(`${API}/files/${f.id}?alt=media`, {
        headers: { Authorization: `Bearer ${await getToken()}` },
      });
      if (!res.ok) throw new Error(`${f.name}: download failed (${res.status})`);
      out.push(new File([await res.blob()], f.name, { type: f.mimeType }));
    }
    pill.set("Importing…");
    await doImport(out);
  } catch (e) {
    toast(e.message || "Drive import failed", { error: true });
  } finally {
    pill.end();
  }
};

export const openDriveBrowser = async () => {
  if (!GOOGLE_CLIENT_ID) {
    listSheet("Google Drive — setup needed", [
      { title: "1 · console.cloud.google.com → new project", value: null },
      { title: "2 · Enable the Google Drive API", value: null },
      { title: "3 · Credentials → OAuth client ID (Web)", value: null },
      { title: "4 · Add this site to JavaScript origins", value: null },
      { title: "5 · Paste the ID into docs/js/gdrive.js", value: null },
    ], () => {}, {
      note: "Google requires every app to register its own OAuth client — it’s a public identifier, not a secret. Full steps are in README → Cloud imports.",
    });
    return;
  }
  picked.clear();
  crumbs.length = 0;
  crumbs.push({ id: "root", name: "My Drive" });
  openSheet("drive-sheet");
  try {
    await getToken();
    await loadFolder(crumbs[0]);
  } catch (e) {
    fail(e);
  }
};

export const initDrive = () => {
  $("drive-back").addEventListener("click", () => {
    if (crumbs.length > 1) {
      crumbs.pop();
      loadFolder(crumbs[crumbs.length - 1]).catch(fail);
    }
  });
  $("drive-import").addEventListener("click", downloadAll);
};
