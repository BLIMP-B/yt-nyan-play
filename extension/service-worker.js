// service-worker.js
// - Receives SEND_TO_DISCORD_WEBHOOKS
// - POSTs to each Discord webhook
// - Seeds default destinations into chrome.storage.sync
// - Always responds (prevents UI from getting stuck)

//DEFAULT DESTINATION
const DEFAULT_DESTINATION_LABEL = "公式鯖聞き専チャット";
// Repository edition: configure destinations in the options page.
const DEFAULT_WEBHOOK_URL = "";

function getSync(defaults) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(defaults, (res) => resolve(res || defaults));
    } catch {
      resolve(defaults);
    }
  });
}

function setSync(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set(obj, () => resolve());
    } catch {
      resolve();
    }
  });
}

async function ensureDefaultDestinations() {
  if (!DEFAULT_WEBHOOK_URL) return { ok: true, seeded: false };
  const res = await getSync({ destinations: [] });
  const list = Array.isArray(res.destinations) ? res.destinations : [];

  if (list.length > 0) return { ok: true, seeded: false };

  const seededList = [{
    label: DEFAULT_DESTINATION_LABEL,
    webhookUrl: DEFAULT_WEBHOOK_URL,
    isDefault: true
  }];

  await setSync({ destinations: seededList });
  return { ok: true, seeded: true };
}

async function postToDiscordWebhook(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: String(content ?? "") })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook POST failed: ${res.status} ${res.statusText} ${text}`);
  }
}

// on install/update: seed default if empty
chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultDestinations().catch(() => {});
});

// Messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || !msg.type) {
        sendResponse({ ok: false, ignored: true });
        return;
      }

      if (msg.type === "ENSURE_DEFAULT_DESTINATIONS") {
        const r = await ensureDefaultDestinations();
        sendResponse({ ok: true, seeded: !!r.seeded });
        return;
      }

      if (msg.type !== "SEND_TO_DISCORD_WEBHOOKS") {
        sendResponse({ ok: false, ignored: true });
        return;
      }

      const { webhookUrls, content } = msg;
      if (!Array.isArray(webhookUrls) || webhookUrls.length === 0) {
        sendResponse({ ok: false, error: "No destinations selected." });
        return;
      }

      const results = [];
      for (const url of webhookUrls) {
        try {
          await postToDiscordWebhook(url, content);
          results.push({ url, ok: true });
        } catch (e) {
          results.push({ url, ok: false, error: String(e?.message ?? e) });
        }
      }

      sendResponse({ ok: true, results });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();

  return true; // async sendResponse
});

// Open options when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});