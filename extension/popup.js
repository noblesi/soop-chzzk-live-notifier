const $ = (id) => document.getElementById(id);

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

async function render() {
  const { watchlist = [], state = {} } = await chrome.storage.local.get(["watchlist", "state"]);

  const ul = $("list");
  ul.innerHTML = "";

  let liveCount = 0;

  for (const item of watchlist) {
    const st = state[item.key];
    const isLive = !!st?.lastIsLive;
    if (isLive) liveCount += 1;

    const li = document.createElement("li");
    const name = item.name || item.id;

    li.innerHTML = `
      <strong>${name}</strong>
      <span class="tag">${item.platform}</span>
      <span class="tag">${isLive ? "LIVE" : "OFF"}</span>
      <div class="muted">${st?.lastTitle ? st.lastTitle : ""}</div>
      <div class="muted">${st?.updatedAt ? `업데이트 ${formatTime(st.updatedAt)}` : ""}</div>
    `;
    ul.appendChild(li);
  }

  $("summary").textContent = watchlist.length
    ? `(${liveCount}/${watchlist.length} LIVE)`
    : "(등록된 채널 없음)";
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
$("openOptions").addEventListener("click", async (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

render();