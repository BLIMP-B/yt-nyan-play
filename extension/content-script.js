// UI:
// - Toggle1: 再生 / 無限
// - Toggle2: 最初から / 現在の再生位置から(調整中)
//
// Logic:
// - 無限: marker "無限" + URL -> https://youtu.be/<id>
// - 再生: marker "再生" + URL kept as-is
// - 現在の再生位置から(調整中): append t=<seconds>

const EXT_BUTTON_ID = "nyan-play-share-btn";
const EXT_MODAL_ID = "nyan-play-share-modal";
const ICON_FILE = "furoneko70furoneko70.png";

// Toggle states (persist during tab session)
let playMode = "play";    // "play" | "infinite"
let timeMode = "start";   // "start" | "current"

// SPA helpers
let injectTimer = null;
let mo = null;

// Extension alive guard
function isExtensionAlive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

// Promise-free safe wrappers (always resolve, never reject)
function safeStorageGet(defaults) {
  return new Promise((resolve) => {
    try {
      if (!isExtensionAlive()) return resolve(defaults);

      chrome.storage.sync.get(defaults, (res) => {
        try {
          let hasLastError = false;
          try { hasLastError = !!chrome.runtime.lastError; } catch { hasLastError = true; }

          if (!isExtensionAlive() || hasLastError) return resolve(defaults);
          resolve(res || defaults);
        } catch {
          resolve(defaults);
        }
      });
    } catch {
      resolve(defaults);
    }
  });
}

function safeStorageSet(obj) {
  return new Promise((resolve) => {
    try {
      if (!isExtensionAlive()) return resolve();

      chrome.storage.sync.set(obj, () => {
        try { void chrome.runtime.lastError; } catch {}
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function safeSendMessage(payload) {
  return new Promise((resolve) => {
    try {
      if (!isExtensionAlive()) return resolve({ ok: false, error: "context invalidated" });

      chrome.runtime.sendMessage(payload, (resp) => {
        try {
          let hasLastError = false;
          try { hasLastError = !!chrome.runtime.lastError; } catch { hasLastError = true; }

          if (!isExtensionAlive() || hasLastError) {
            return resolve({ ok: false, error: "context invalidated" });
          }
          resolve(resp || { ok: true });
        } catch {
          resolve({ ok: false, error: "context invalidated" });
        }
      });
    } catch {
      resolve({ ok: false, error: "context invalidated" });
    }
  });
}

// Page detection
function isWatchPage() {
  return location.pathname === "/watch" && new URLSearchParams(location.search).has("v");
}
function isShortsPage() {
  return location.pathname.startsWith("/shorts/");
}

// Title extraction
function normalizeDocTitle(raw) {
  return String(raw || "").replace(/\s-\sYouTube\s*$/i, "").trim();
}
function getVideoTitle() {
  const watchTitle =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
    document.querySelector("#title h1 yt-formatted-string")?.textContent?.trim() ||
    document.querySelector("ytd-watch-metadata h1 yt-formatted-string")?.textContent?.trim();
  if (watchTitle) return watchTitle;

  const shortsTitle =
    document.querySelector("ytd-reel-player-header-renderer yt-formatted-string")?.textContent?.trim() ||
    document.querySelector("ytd-reel-player-header-renderer h2")?.textContent?.trim() ||
    document.querySelector("ytd-reel-video-renderer yt-formatted-string")?.textContent?.trim();
  if (shortsTitle) return shortsTitle;

  const metaTitle = document.querySelector('meta[name="title"]')?.getAttribute("content")?.trim();
  if (metaTitle) return metaTitle;

  return normalizeDocTitle(document.title);
}

// Button containers
function findWatchButtonsContainer() {
  return (
    document.querySelector("#top-level-buttons-computed") ||
    document.querySelector("#menu-container #top-level-buttons-computed") ||
    document.querySelector("ytd-menu-renderer.ytd-watch-metadata #top-level-buttons-computed") ||
    document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
    document.querySelector("ytd-video-primary-info-renderer #top-level-buttons-computed") ||
    document.querySelector("ytd-menu-renderer.ytd-watch-metadata > div") ||
    null
  );
}

function findShortsButtonsContainer() {
  const modern =
    document.querySelector("ytd-reel-video-renderer #actions") ||
    document.querySelector("ytd-reel-video-renderer");

  if (modern) return modern;

  const actionBar =
    document.querySelector("reel-action-bar-view-model") ||
    document.querySelector("ytd-reel-player-overlay-renderer reel-action-bar-view-model");

  if (actionBar) return actionBar;

  return null;
}

// Destinations (no seeding here; background handles it)
async function getDestinations() {
  const res = await safeStorageGet({ destinations: [] });
  return Array.isArray(res.destinations) ? res.destinations : [];
}

// Time helpers
function getCurrentSeconds() {
  const v = document.querySelector("video");
  const t = v?.currentTime;
  if (typeof t === "number" && isFinite(t)) return Math.max(0, Math.floor(t));
  return 0;
}

function withTimeParam(urlStr, seconds) {
  try {
    const u = new URL(urlStr);
    u.searchParams.set("t", String(Math.max(0, Math.floor(seconds || 0))));
    return u.toString();
  } catch {
    const s = Math.max(0, Math.floor(seconds || 0));
    return urlStr.includes("?") ? `${urlStr}&t=${s}` : `${urlStr}?t=${s}`;
  }
}

// youtu.be conversion helpers
function extractVideoId(urlStr) {
  try {
    const u = new URL(urlStr);

    if (u.hostname === "youtu.be") {
      const id = u.pathname.replace(/^\/+/, "").split("/")[0];
      return id || null;
    }

    const host = u.hostname.replace(/^www\./, "");
    const isYoutubeHost =
      host === "youtube.com" || host === "m.youtube.com" || host.endsWith(".youtube.com");
    if (!isYoutubeHost) return null;

    if (u.pathname === "/watch") return u.searchParams.get("v") || null;

    if (u.pathname.startsWith("/shorts/")) {
      const id = u.pathname.split("/")[2];
      return id || null;
    }

    if (u.pathname.startsWith("/embed/")) {
      const id = u.pathname.split("/")[2];
      return id || null;
    }

    return null;
  } catch {
    return null;
  }
}

function toYoutuBeUrl(urlStr) {
  const id = extractVideoId(urlStr);
  if (!id) return urlStr;
  return `https://youtu.be/${id}`;
}

// Webhook masking (do not expose full URL in UI)
function maskWebhookUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname;
    const parts = u.pathname.split("/").filter(Boolean);

    const last = parts[parts.length - 1] || "";
    const keep = last.slice(-4);
    const maskedLast = keep ? `****${keep}` : "****";

    const shownParts = parts.slice(0, 2);
    if (shownParts.length) {
      return `${host}/${shownParts.join("/")}/${maskedLast}`;
    }
    return `${host}/${maskedLast}`;
  } catch {
    const s = String(url || "");
    if (s.length <= 8) return "****";
    return `****${s.slice(-4)}`;
  }
}

// Modal base
function ensureModalBase() {
  let root = document.getElementById(EXT_MODAL_ID);
  if (root) return root;

  root = document.createElement("div");
  root.id = EXT_MODAL_ID;
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.zIndex = "999999";
  root.style.display = "none";

  const overlay = document.createElement("div");
  overlay.style.position = "absolute";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(0,0,0,0.6)";
  overlay.addEventListener("click", closeShareModal);

  const panel = document.createElement("div");
  panel.style.position = "absolute";
  panel.style.left = "50%";
  panel.style.top = "50%";
  panel.style.transform = "translate(-50%, -50%)";
  panel.style.width = "min(520px, calc(100vw - 24px))";
  panel.style.maxHeight = "min(70vh, 640px)";
  panel.style.overflow = "hidden";
  panel.style.borderRadius = "16px";
  panel.style.background = "var(--yt-spec-menu-background, #0f0f0f)";
  panel.style.border = "1px solid rgba(255,255,255,0.12)";
  panel.style.boxShadow = "0 20px 60px rgba(0,0,0,0.55)";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.style.padding = "14px 16px";
  header.style.borderBottom = "1px solid rgba(255,255,255,0.10)";
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "center";

  const title = document.createElement("div");
  title.textContent = "Discordで再生";
  title.style.fontSize = "16px";
  title.style.fontWeight = "700";
  title.style.color = "var(--yt-spec-text-primary, #fff)";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.fontSize = "20px";
  closeBtn.style.width = "32px";
  closeBtn.style.height = "32px";
  closeBtn.style.borderRadius = "10px";
  closeBtn.style.border = "1px solid rgba(255,255,255,0.12)";
  closeBtn.style.background = "transparent";
  closeBtn.style.color = "var(--yt-spec-text-primary, #fff)";
  closeBtn.style.cursor = "pointer";
  closeBtn.addEventListener("click", closeShareModal);

  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.id = `${EXT_MODAL_ID}-body`;
  body.style.padding = "12px 16px";
  body.style.overflow = "auto";
  body.style.maxHeight = "calc(min(70vh, 640px) - 120px)";

  const footer = document.createElement("div");
  footer.style.padding = "12px 16px";
  footer.style.borderTop = "1px solid rgba(255,255,255,0.10)";
  footer.style.display = "flex";
  footer.style.gap = "10px";
  footer.style.justifyContent = "flex-end";

  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  cancel.style.padding = "10px 12px";
  cancel.style.borderRadius = "12px";
  cancel.style.border = "1px solid rgba(255,255,255,0.18)";
  cancel.style.background = "transparent";
  cancel.style.color = "var(--yt-spec-text-primary, #fff)";
  cancel.style.cursor = "pointer";
  cancel.addEventListener("click", closeShareModal);

  const send = document.createElement("button");
  send.id = `${EXT_MODAL_ID}-send`;
  send.textContent = "送信";
  send.style.padding = "10px 14px";
  send.style.borderRadius = "12px";
  send.style.border = "1px solid rgba(255,255,255,0.18)";
  send.style.background = "rgba(255,255,255,0.16)";
  send.style.color = "var(--yt-spec-text-primary, #fff)";
  send.style.cursor = "pointer";

  footer.appendChild(cancel);
  footer.appendChild(send);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  root.appendChild(overlay);
  root.appendChild(panel);
  document.documentElement.appendChild(root);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeShareModal();
  });

  return root;
}

function closeShareModal() {
  const root = document.getElementById(EXT_MODAL_ID);
  if (root) root.style.display = "none";
}

// History
async function saveHistory(text, webhookUrls) {
  const res = await safeStorageGet({ history: [] });
  const history = Array.isArray(res.history) ? res.history : [];

  // Save ONLY masked representations (never raw URLs)
  const maskedWebhookUrls = Array.isArray(webhookUrls)
    ? webhookUrls.map((u) => maskWebhookUrl(u)).filter(Boolean)
    : [];

  history.unshift({
    text,
    time: new Date().toISOString(),
    webhookUrls: maskedWebhookUrls
  });

  if (history.length > 50) history.pop();
  await safeStorageSet({ history });
}

// Send button state
function setSendBtnState(sendBtn, state) {
  if (!sendBtn) return;
  if (state === "sending") {
    sendBtn.disabled = true;
    sendBtn.textContent = "送信中...";
    sendBtn.style.opacity = "0.7";
    sendBtn.style.cursor = "not-allowed";
  } else {
    sendBtn.disabled = false;
    sendBtn.textContent = "送信";
    sendBtn.style.opacity = "1";
    sendBtn.style.cursor = "pointer";
  }
}

// Segmented toggles
function buildSegmentedToggle({ leftLabel, rightLabel, value, onChange }) {
  const wrap = document.createElement("div");
  wrap.style.display = "inline-flex";
  wrap.style.borderRadius = "999px";
  wrap.style.border = "1px solid rgba(255,255,255,0.16)";
  wrap.style.background = "rgba(255,255,255,0.06)";
  wrap.style.overflow = "hidden";

  const mkBtn = (label, v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.padding = "8px 12px";
    b.style.fontSize = "13px";
    b.style.fontWeight = "700";
    b.style.border = "none";
    b.style.cursor = "pointer";
    b.style.background = "transparent";
    b.style.color = "rgba(255,255,255,0.75)";
    b.style.whiteSpace = "nowrap";

    const apply = () => {
      const selected = value() === v;
      b.style.background = selected ? "rgba(255,255,255,0.16)" : "transparent";
      b.style.color = selected ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.75)";
    };

    b.addEventListener("click", () => onChange(v));
    b.__apply = apply;
    apply();
    return b;
  };

  const left = mkBtn(leftLabel, "left");
  const right = mkBtn(rightLabel, "right");

  wrap.appendChild(left);
  wrap.appendChild(right);

  wrap.__refresh = () => {
    left.__apply?.();
    right.__apply?.();
  };

  return wrap;
}

// Open modal
async function openShareModal() {
  if (!isExtensionAlive()) return;

  await safeSendMessage({ type: "ENSURE_DEFAULT_DESTINATIONS" });

  const root = ensureModalBase();
  const body = document.getElementById(`${EXT_MODAL_ID}-body`);
  const sendBtn = document.getElementById(`${EXT_MODAL_ID}-send`);

  setSendBtnState(sendBtn, "ready");

  const safeTitle = (getVideoTitle()?.trim() || "NO TITLE");
  const destinations = await getDestinations();

  body.innerHTML = "";

  const togglesRow = document.createElement("div");
  togglesRow.style.display = "flex";
  togglesRow.style.alignItems = "center";
  togglesRow.style.justifyContent = "space-between";
  togglesRow.style.gap = "10px";
  togglesRow.style.marginBottom = "12px";
  togglesRow.style.flexWrap = "wrap";

  const playToggle = buildSegmentedToggle({
    leftLabel: "再生",
    rightLabel: "無限",
    value: () => (playMode === "play" ? "left" : "right"),
    onChange: (v) => {
      playMode = (v === "left") ? "play" : "infinite";
      playToggle.__refresh?.();
      updatePreview();
    }
  });

  const timeToggle = buildSegmentedToggle({
    leftLabel: "最初から",
    rightLabel: "現在の再生位置から(調整中)",
    value: () => (timeMode === "start" ? "left" : "right"),
    onChange: (v) => {
      timeMode = (v === "left") ? "start" : "current";
      timeToggle.__refresh?.();
      updatePreview();
    }
  });

  togglesRow.appendChild(playToggle);
  togglesRow.appendChild(timeToggle);
  body.appendChild(togglesRow);

  const preview = document.createElement("div");
  preview.style.padding = "10px 12px";
  preview.style.borderRadius = "12px";
  preview.style.border = "1px solid rgba(255,255,255,0.12)";
  preview.style.background = "rgba(255,255,255,0.06)";
  preview.style.marginBottom = "12px";
  preview.style.color = "var(--yt-spec-text-secondary, rgba(255,255,255,0.8))";
  preview.style.fontSize = "13px";

  const previewTitle = document.createElement("div");
  previewTitle.textContent = "送信内容";
  previewTitle.style.fontWeight = "700";
  previewTitle.style.color = "var(--yt-spec-text-primary,#fff)";
  previewTitle.style.marginBottom = "6px";

  const previewText = document.createElement("div");
  previewText.style.wordBreak = "break-all";
  previewText.style.whiteSpace = "pre-wrap";

  preview.appendChild(previewTitle);
  preview.appendChild(previewText);
  body.appendChild(preview);

  function computeContentForSend() {
    let url = location.href;

    if (playMode === "infinite") {
      url = toYoutuBeUrl(url);
    }

    if (timeMode === "current") {
      url = withTimeParam(url, getCurrentSeconds());
    }

    const marker = (playMode === "infinite") ? "無限" : "再生";
    return `${url}${marker}\n**【${safeTitle.toUpperCase()}】**`;
  }

  function updatePreview() {
    previewText.textContent = computeContentForSend();
  }

  updatePreview();

  if (!destinations.length) {
    const empty = document.createElement("div");
    empty.style.padding = "12px";
    empty.style.borderRadius = "12px";
    empty.style.border = "1px dashed rgba(255,255,255,0.18)";
    empty.style.color = "var(--yt-spec-text-secondary, rgba(255,255,255,0.8))";
    empty.style.fontSize = "13px";
    empty.innerHTML =
      `<div style="font-weight:700;color:var(--yt-spec-text-primary,#fff);margin-bottom:6px;">宛先が未設定です</div>` +
      `<div>拡張機能のオプションで、送信先（Webhook URL）を追加してください。</div>`;
    body.appendChild(empty);
    sendBtn.onclick = () => {};
    root.style.display = "block";
    return;
  }

  const listWrap = document.createElement("div");
  listWrap.style.display = "flex";
  listWrap.style.flexDirection = "column";
  listWrap.style.gap = "8px";

  const destMap = new Map(); // id -> webhookUrl

  destinations.forEach((d, idx) => {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "10px";
    row.style.padding = "10px 10px";
    row.style.border = "1px solid rgba(255,255,255,0.10)";
    row.style.borderRadius = "12px";
    row.style.cursor = "pointer";

    const cb = document.createElement("input");
    cb.type = "checkbox";

    const id = `d${idx}_${Math.random().toString(36).slice(2, 8)}`;
    cb.dataset.destId = id;

    const url = d.webhookUrl || "";
    if (typeof url === "string" && url.startsWith("http")) {
      destMap.set(id, url);
    }

    cb.style.transform = "scale(1.1)";

    const name = document.createElement("div");
    name.textContent = d.label || `宛先${idx + 1}`;
    name.style.color = "var(--yt-spec-text-primary, #fff)";
    name.style.fontWeight = "700";

    const sub = document.createElement("div");
    sub.textContent = maskWebhookUrl(d.webhookUrl || "");
    sub.style.color = "rgba(255,255,255,0.65)";
    sub.style.fontSize = "12px";
    sub.style.wordBreak = "break-all";

    const meta = document.createElement("div");
    meta.style.display = "flex";
    meta.style.flexDirection = "column";
    meta.appendChild(name);
    meta.appendChild(sub);

    row.appendChild(cb);
    row.appendChild(meta);
    listWrap.appendChild(row);
  });

  body.appendChild(listWrap);

  sendBtn.onclick = async () => {
    if (!isExtensionAlive()) {
      setSendBtnState(sendBtn, "ready");
      return;
    }

    const checked = Array.from(body.querySelectorAll('input[type="checkbox"]:checked'));

    const webhookUrls = checked
      .map((x) => destMap.get(x.dataset.destId))
      .filter((u) => typeof u === "string" && u.startsWith("http"));

    if (!webhookUrls.length) return;

    const contentToSend = computeContentForSend();
    setSendBtnState(sendBtn, "sending");

    const timeoutId = setTimeout(() => setSendBtnState(sendBtn, "ready"), 8000);

    const resp = await safeSendMessage({
      type: "SEND_TO_DISCORD_WEBHOOKS",
      webhookUrls,
      content: contentToSend
    });

    clearTimeout(timeoutId);

    if (!resp || resp.ok === false) {
      setSendBtnState(sendBtn, "ready");
      return;
    }

    try {
      await saveHistory(contentToSend, webhookUrls);
    } finally {
      setSendBtnState(sendBtn, "ready");
      closeShareModal();
    }
  };

  root.style.display = "block";
}

// Button injection
function buildButton() {
  const btn = document.createElement("button");
  btn.id = EXT_BUTTON_ID;
  btn.type = "button";

  let iconUrl = "";
  try {
    iconUrl = isExtensionAlive() ? chrome.runtime.getURL(ICON_FILE) : "";
  } catch {
    iconUrl = "";
  }

  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "再生";
    img.width = 18;
    img.height = 18;
    img.style.width = "18px";
    img.style.height = "18px";
    img.style.borderRadius = "6px";
    img.style.objectFit = "cover";
    btn.appendChild(img);
  }

  const label = document.createElement("span");
  label.textContent = "再生";
  btn.appendChild(label);

  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.gap = "8px";
  btn.style.borderRadius = "999px";
  btn.style.padding = "8px 14px";
  btn.style.marginRight = "8px";
  btn.style.border = "1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1))";
  btn.style.background = "var(--yt-spec-badge-chip-background, rgba(255,255,255,0.08))";
  btn.style.color = "var(--yt-spec-text-primary, #fff)";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "14px";
  btn.style.fontWeight = "600";
  btn.style.whiteSpace = "nowrap";
  btn.style.userSelect = "none";

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "var(--yt-spec-10-percent-layer, rgba(255,255,255,0.14))";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "var(--yt-spec-badge-chip-background, rgba(255,255,255,0.08))";
  });

  btn.addEventListener("click", () => openShareModal());
  return btn;
}

function ensureButtonHealthy() {
  const existing = document.getElementById(EXT_BUTTON_ID);
  if (existing && !existing.isConnected) {
    existing.remove();
    return null;
  }
  return existing;
}

function injectButtonIfNeeded() {
  if (!isExtensionAlive()) return;

  const existing = document.getElementById(EXT_BUTTON_ID);
  if (existing && existing.isConnected) return;

  let container = findWatchButtonsContainer() || findShortsButtonsContainer();
  if (!container) return;

  const btn = buildButton();

  if (!document.getElementById(EXT_BUTTON_ID)) {
    container.prepend(btn);
  }
}

// Boot / cleanup
function clearInjectTimer() {
  if (injectTimer) {
    clearInterval(injectTimer);
    injectTimer = null;
  }
}

function scheduleInjectBurst() {
  clearInjectTimer();
  let tries = 0;
  injectTimer = setInterval(() => {
    injectButtonIfNeeded();
    tries += 1;
    if (tries >= 10) clearInjectTimer();
  }, 300);
}

function cleanup() {
  clearInjectTimer();
  if (mo) {
    try { mo.disconnect(); } catch {}
    mo = null;
  }
}

function boot() {
  injectButtonIfNeeded();
  scheduleInjectBurst();

  mo = new MutationObserver(() => injectButtonIfNeeded());
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("yt-navigate-finish", () => {
    scheduleInjectBurst();
  });

  window.addEventListener("yt-page-data-updated", () => {
    scheduleInjectBurst();
  });

  document.addEventListener("yt-action", () => {
    scheduleInjectBurst();
  });

  window.addEventListener("popstate", () => {
    scheduleInjectBurst();
  });

  window.addEventListener("pagehide", cleanup);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") cleanup();
  });
}

boot();
``