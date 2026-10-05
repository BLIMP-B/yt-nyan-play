let editId = null;

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

    if (!label || !webhookUrl) {
      alert("入力してください");
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
        <strong>${item.label}</strong>
        <div class="url">${maskWebhookUrl(item.webhookUrl)}</div>
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
        <div class="url" style="white-space:pre-wrap;">${item.text}</div>
        <small>${date}</small>
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

      sendBtn.onclick = () => {
        const checked = Array.from(destDiv.querySelectorAll("input:checked"))
          .map(x => x.value);

        if (!checked.length) {
          alert("送信先を選択してください");
          return;
        }

        chrome.runtime.sendMessage({
          type: "SEND_TO_DISCORD_WEBHOOKS",
          webhookUrls: checked,
          content: item.text
        });

        alert("送信しました ");
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