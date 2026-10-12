let editId = null;
document.getElementById('transferAccount').addEventListener('click', async () => {
  const button = document.getElementById('transferAccount'), input = document.getElementById('accountCode'), status = document.getElementById('accountStatus');
  try {
    NyanAccountLink.parse(input.value);
    // Invoke immediately in the click handler so Chrome retains the user gesture.
    const permission = chrome.permissions.request({ permissions: ['cookies'], origins: ['http://127.0.0.1/*'] });
    button.disabled = true; status.textContent = '接続しています…';
    if (!await permission) throw new Error('ログイン引き継ぎが許可されませんでした。');
    const result = await chrome.runtime.sendMessage({ type: 'TRANSFER_YOUTUBE_SESSION', code: input.value.trim() });
    if (!result?.ok) throw new Error(result?.error || '接続を確認できませんでした。');
    input.value = ''; status.textContent = 'YouTubeのログイン情報を引き継ぎました。にゃんとーくで再生をお試しください。';
  } catch (e) { status.textContent = e.message; }
  finally { button.disabled = false; }
});
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isWebhook = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && ['discord.com','discordapp.com'].includes(u.hostname) && /^\/api\/webhooks\/\d+\/[\w-]+$/.test(u.pathname); } catch { return false; } };

function uid() {
  return Date.now();
}

async function load() {
  const res = await chrome.storage.sync.get("destinations");
  return res.destinations || [];
}

async function save(list) {
  await chrome.storage.sync.set({ destinations: list });
}

function el(id) {
  return document.getElementById(id);
}

// Webhook masking (do not expose full URL in UI)
function maskWebhookUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname;
    const parts = u.pathname.split("/").filter(Boolean);

    // Keep only last 4 chars of the last path segment
    const last = parts[parts.length - 1] || "";
    const keep = last.slice(-4);
    const maskedLast = keep ? `****${keep}` : "****";

    // Show host + first 2 path segments + masked last
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

// Webhook URL sanitize
function sanitizeWebhookUrl(url) {
  if (!url) return url;
  return String(url).replace(/^<|>$/g, "");
}

// Default destination guard
function isDefaultDestination(item) {
  return item?.isDefault === true || item?.isDefault === "true";
}

// Password toggle
function setWebhookVisibility(isVisible) {
  const input = el("webhookUrl");
  const btn = el("toggleWebhook");
  if (!input || !btn) return;

  input.type = isVisible ? "text" : "password";

  // CSS: .toggleBtn.on / .toggleBtn.off
  if (isVisible) {
    btn.textContent = "非表示";
    btn.classList.add("on");
    btn.classList.remove("off");
  } else {
    btn.textContent = "表示";
    btn.classList.add("off");
    btn.classList.remove("on");
  }
}

function initWebhookToggle() {
  const btn = el("toggleWebhook");
  const input = el("webhookUrl");
  if (!btn || !input) return;

  input.type = "password";
  setWebhookVisibility(false);

  btn.addEventListener("click", () => {
    const nowVisible = input.type !== "password";
    setWebhookVisibility(!nowVisible);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  if (!el("list")) return;
  init();
});

function init() {
  const addBtn = el("add");
  const updateBtn = el("update");

  initWebhookToggle();

  addBtn?.addEventListener("click", async () => {
    const label = el("label")?.value?.trim();
    const webhookUrl = el("webhookUrl")?.value?.trim();

    if (!label || !isWebhook(webhookUrl)) {
      alert("表示名とDiscordのWebhook URLを入力してください。");
      return;
    }

    const list = await load();

    list.push({
      id: uid(),
      label,
      webhookUrl
    });

    await save(list);

    el("label").value = "";
    el("webhookUrl").value = "";
    setWebhookVisibility(false);

    render();
  });

  updateBtn?.addEventListener("click", async () => {
    const label = el("label")?.value?.trim();
    const webhookUrl = el("webhookUrl")?.value?.trim();

    const list = await load();

    if (!label || !isWebhook(webhookUrl)) { alert("表示名とDiscordのWebhook URLを入力してください。"); return; }

    const newList = list.map(item => {
      if (item.id === editId) {
        return { ...item, label, webhookUrl };
      }
      return item;
    });

    await save(newList);

    editId = null;

    el("label").value = "";
    el("webhookUrl").value = "";
    setWebhookVisibility(false);

    el("add").style.display = "inline-block";
    el("update").style.display = "none";

    render();
  });

  render();
  renderHistory();
  initOrigins();
}

async function render() {
  const list = await load();
  const root = el("list");
  if (!root) return;

  root.innerHTML = "";

  list.forEach(item => {
    const div = document.createElement("div");
    div.className = "item";

    const isDefault = isDefaultDestination(item);

    div.innerHTML = `
      <div class="meta">
        <strong>${escapeHtml(item.label)}</strong>
        <div class="url">${escapeHtml(maskWebhookUrl(item.webhookUrl))}</div>
      </div>

      ${isDefault ? `
        <div class="actions">
          <span class="badge-lock">固定</span>
        </div>
      ` : `
        <div class="actions">
          <button class="edit">編集</button>
          <button class="delete">削除</button>
        </div>
      `}
    `;

    if (!isDefault) {
      div.querySelector(".delete").onclick = async () => {
        const newList = list.filter(x => x.id !== item.id);
        await save(newList);
        render();
      };

      div.querySelector(".edit").onclick = () => {
        el("label").value = item.label;
        el("webhookUrl").value = item.webhookUrl;

        setWebhookVisibility(false);

        editId = item.id;

        el("add").style.display = "none";
        el("update").style.display = "inline-block";
      };
    }

    root.appendChild(div);
  });
}

async function renderHistory() {
  const res = await chrome.storage.sync.get("history");
  const history = res.history || [];

  const root = el("historyList");
  if (!root) return;

  root.innerHTML = "";

  history.forEach((item, index) => {
    const div = document.createElement("div");
    div.className = "item";

    const date = new Date(item.time).toLocaleString();

    div.innerHTML = `
      <div class="meta">
        <div class="url" style="white-space:pre-wrap;">${escapeHtml(item.text)}</div>
        <small>${escapeHtml(date)}</small>
      </div>

      <div class="actions">
        <button class="select">送信先選択</button>
        <button class="deleteHistory">削除</button>
      </div>

      <div class="destinations" style="display:none;"></div>
    `;

    div.querySelector(".select").onclick = async () => {
      const destDiv = div.querySelector(".destinations");
      destDiv.innerHTML = "";
      destDiv.style.display = "block";

      const destinations = await load();

      destinations.forEach(d => {
        const label = document.createElement("label");
        label.style.display = "block";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = d.webhookUrl;

        label.appendChild(cb);

        const masked = maskWebhookUrl(d.webhookUrl);
        label.append(` ${d.label} (${masked})`);

        destDiv.appendChild(label);
      });

      const sendBtn = document.createElement("button");
      sendBtn.textContent = "送信";

      sendBtn.onclick = async () => {
        const checked = Array.from(destDiv.querySelectorAll("input:checked"))
          .map(x => x.value);

        if (!checked.length) {
          alert("送信先を選択してください");
          return;
        }

        sendBtn.disabled = true;
        const result = await chrome.runtime.sendMessage({
          type: "SEND_TO_DISCORD_WEBHOOKS",
          webhookUrls: checked,
          content: item.text
        });

        sendBtn.disabled = false;
        alert(result?.results?.map(r => `${destinations.find(d => d.webhookUrl === r.url)?.label || "送信先"}: ${r.ok ? "送信完了" : r.error || "送信失敗"}`).join("\n") || result?.error || "結果を確認できませんでした。");
      };

      destDiv.appendChild(sendBtn);
    };

    div.querySelector(".deleteHistory").onclick = async () => {
      history.splice(index, 1);
      await chrome.storage.sync.set({ history });
      renderHistory();
    };

    root.appendChild(div);
  });
}
async function initOrigins() {
  el('allowOrigin').onclick = async () => {
    let origin;
    try { const u = new URL(el('extraOrigin').value.trim()); if (u.protocol !== 'https:' || u.username || u.password || u.hostname.includes('*')) throw new Error(); origin = u.origin + '/*'; }
    catch { el('originStatus').textContent = 'https://で始まるサイトURLを入力してください。'; return; }
    try {
      const granted = await chrome.permissions.request({origins:[origin]});
      if (granted) { await chrome.runtime.sendMessage({type:'REGISTER_ADDITIONAL_SITES'}); el('originStatus').textContent = '許可しました。対象サイトのタブを再読み込みしてください。'; }
      else el('originStatus').textContent = '許可されませんでした。';
    } catch { el('originStatus').textContent = 'サイトを許可できませんでした。'; }
    renderOrigins();
  };
  renderOrigins();
}
async function renderOrigins() {
  const fixed = new Set(chrome.runtime.getManifest().host_permissions);
  const origins = (await chrome.permissions.getAll()).origins || [];
  const root = el('originList'); root.replaceChildren();
  for (const origin of origins.filter(x => !fixed.has(x) && x !== 'https://*/*' && x.startsWith('https://'))) {
    const row = document.createElement('div'); row.className = 'item';
    const label = document.createElement('span'); label.textContent = origin;
    const remove = document.createElement('button'); remove.textContent = '許可を解除';
    remove.onclick = async () => { await chrome.permissions.remove({origins:[origin]}); await chrome.runtime.sendMessage({type:'REGISTER_ADDITIONAL_SITES'}); renderOrigins(); };
    row.append(label, remove); root.append(row);
  }
}
