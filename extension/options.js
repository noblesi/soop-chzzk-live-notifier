const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function platformLabel(platform) {
  return platform === "chzzk" ? "치지직" : platform === "soop" ? "SOOP" : platform;
}

function makeKey(platform, id) {
  return `${platform}:${id}`;
}

function parseIdFromInput(platform, raw) {
  const s = (raw || "").trim();
  if (!s) return "";

  try {
    const u = new URL(s);
    const host = u.hostname;
    if (platform === "chzzk") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0] === "live") return parts[1];
      if (parts.length >= 1) return parts[0];
    }
    if (platform === "soop") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (host.startsWith("play.sooplive.co.kr") && parts.length >= 1) return parts[0];
      if (host.endsWith("sooplive.co.kr") && parts.length >= 2 && parts[0] === "station") return parts[1];
      if (parts.length >= 1) return parts[0];
    }
  } catch {
    // URL이 아니면 그대로 id로 간주
  }
  return s;
}

function buildDefaultUrl(item) {
  if (item.platform === "chzzk") return `https://chzzk.naver.com/live/${item.id}`;
  if (item.platform === "soop") return `https://play.sooplive.co.kr/${item.id}`;
  return "https://www.google.com";
}

function showStatus(text) {
  $("status").textContent = text || "";
  if (text) setTimeout(() => ($("status").textContent = ""), 2000);
}

async function loadSettings() {
  const { settings } = await chrome.storage.local.get(["settings"]);
  const s = settings || {};
  $("pollIntervalMin").value = s.pollIntervalMin ?? 1;
  $("cooldownMin").value = s.cooldownMin ?? 10;
  $("notifyIfAlreadyLive").checked = !!s.notifyIfAlreadyLive;
}

async function saveSettings() {
  const next = {
    pollIntervalMin: Number($("pollIntervalMin").value),
    cooldownMin: Number($("cooldownMin").value),
    notifyIfAlreadyLive: $("notifyIfAlreadyLive").checked,
  };
  const res = await chrome.runtime.sendMessage({ type: "updateSettings", settings: next });
  if (res?.ok) showStatus("저장 완료");
  else showStatus(`저장 실패: ${res?.error || "unknown"}`);
}

async function loadList() {
  const { watchlist = [] } = await chrome.storage.local.get(["watchlist"]);
  renderList(watchlist);
}

function renderList(watchlist) {
  const tbody = $("list");
  tbody.innerHTML = "";

  for (const item of watchlist) {
    const tr = document.createElement("tr");
    const pLabel = platformLabel(item.platform);

    tr.innerHTML = `
      <td>
        <span class="pill ${escapeHtml(item.platform)}">
          <span class="dot"></span>${escapeHtml(pLabel)}
        </span>
      </td>
      <td><code>${escapeHtml(item.id)}</code></td>
      <td>${escapeHtml(item.name || "")}</td>
      <td style="text-align:right; white-space:nowrap;">
        <a href="#" data-open="${escapeHtml(item.key)}">열기</a>
        &nbsp;
        <button class="danger small" data-key="${escapeHtml(item.key)}">삭제</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button[data-key]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.getAttribute("data-key");
      const { watchlist = [] } = await chrome.storage.local.get(["watchlist"]);
      const next = watchlist.filter((x) => x.key !== key);
      await chrome.storage.local.set({ watchlist: next });
      renderList(next);
    });
  });

  tbody.querySelectorAll("a[data-open]").forEach((a) => {
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const key = a.getAttribute("data-open");
      const { watchlist = [] } = await chrome.storage.local.get(["watchlist"]);
      const item = watchlist.find((x) => x.key === key);
      if (!item) return;
      chrome.tabs.create({ url: buildDefaultUrl(item) });
    });
  });
}

async function addItem() {
  const platform = $("platform").value;
  const raw = $("channelId").value;
  const id = parseIdFromInput(platform, raw);
  const name = $("displayName").value.trim();

  if (!id) return;

  const key = makeKey(platform, id);
  const { watchlist = [] } = await chrome.storage.local.get(["watchlist"]);

  if (watchlist.some((x) => x.key === key)) {
    showStatus("이미 등록됨");
    return;
  }

  watchlist.push({ platform, id, name, key, addedAt: Date.now() });
  await chrome.storage.local.set({ watchlist });

  $("channelId").value = "";
  $("displayName").value = "";
  renderList(watchlist);
  showStatus("추가됨");
}

async function pollNow() {
  const res = await chrome.runtime.sendMessage({ type: "pollNow" });
  if (res?.ok) {
    const r = res.result;
    showStatus(`체크 완료: ${r.checked}개 / 라이브 ${r.liveNow} / 알림 ${r.notified}`);
  } else {
    showStatus(`체크 실패: ${res?.error || "unknown"}`);
  }
}

async function testNotification() {
  const res = await chrome.runtime.sendMessage({ type: "testNotification" });
  if (res?.ok) showStatus("테스트 알림 전송");
  else showStatus(`실패: ${res?.error || "unknown"}`);
}

$("addBtn").addEventListener("click", addItem);
$("saveSettingsBtn").addEventListener("click", saveSettings);
$("pollNowBtn").addEventListener("click", pollNow);
$("testNotifBtn").addEventListener("click", testNotification);

(async function init() {
  await loadSettings();
  await loadList();
})();