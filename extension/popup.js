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

function buildDefaultUrl(item) {
  if (item.platform === "chzzk") return `https://chzzk.naver.com/live/${item.id}`;
  if (item.platform === "soop") return `https://play.sooplive.co.kr/${item.id}`;
  return "https://www.google.com";
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

async function render() {
  const { watchlist = [], state = {} } = await chrome.storage.local.get(["watchlist", "state"]);
  const root = $("list");
  root.innerHTML = "";

  let liveCount = 0;

  for (const item of watchlist) {
    const st = state[item.key];
    const isLive = !!st?.lastIsLive;
    if (isLive) liveCount += 1;

    const name = item.name || item.id;
    const title = st?.lastTitle || "";
    const updated = st?.updatedAt ? `업데이트 ${formatTime(st.updatedAt)}` : "";
    const url = buildDefaultUrl(item);

    const div = document.createElement("div");
    div.className = "item";

    div.innerHTML = `
      <div class="item-top">
        <div class="item-left">
          <strong class="item-name">${escapeHtml(name)}</strong>
          <span class="pill ${escapeHtml(item.platform)}">
            <span class="dot"></span>${escapeHtml(platformLabel(item.platform))}
          </span>
        </div>
        <span class="status ${isLive ? "live" : "off"}">${isLive ? "LIVE" : "OFF"}</span>
      </div>

      ${title ? `<div class="item-title">${escapeHtml(title)}</div>` : ""}

      <div class="item-meta">
        <span>${escapeHtml(updated)}</span>
        <a href="#" data-open="${escapeHtml(url)}">열기</a>
      </div>
    `;

    root.appendChild(div);
  }

  $("summary").textContent = watchlist.length
    ? `(${liveCount}/${watchlist.length} LIVE)`
    : "(등록된 채널 없음)";

  root.querySelectorAll("a[data-open]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.getAttribute("data-open");
      if (url) chrome.tabs.create({ url });
    });
  });
}

async function pollNow() {
  $("summary").textContent = "체크 중...";
  const res = await chrome.runtime.sendMessage({ type: "pollNow" });
  if (res?.ok) {
    const r = res.result;
    $("summary").textContent = `완료: 라이브 ${r.liveNow} / 알림 ${r.notified}`;
  } else {
    $("summary").textContent = `실패: ${res?.error || "unknown"}`;
  }
  await render();
}

$("pollNow").addEventListener("click", pollNow);

$("openOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();