/* SOOP/CHZZK Live Notifier - MV3 service worker */

const ALARM_NAME = "poll_live_status";

const DEFAULT_SETTINGS = {
  pollIntervalMin: 1,          // Chrome alarms: 1분 단위 권장
  cooldownMin: 10,             // 같은 방송(같은 signature) 중복 알림 쿨다운
  notifyIfAlreadyLive: false,  // 최초/재시작 시 이미 라이브면 알림 여부
  requestTimeoutMs: 8000
};

const STORAGE_KEYS = {
  watchlist: "watchlist",
  settings: "settings",
  state: "state",          // key -> { lastIsLive, lastSig, lastTitle, updatedAt }
  notified: "notified",    // key -> { lastNotifiedSig, lastNotifiedAt }
  notifMap: "notifMap"     // notificationId -> { url }
};

function clampInt(n, min, max) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function setSettings(next) {
  const current = await getSettings();
  const merged = { ...current, ...(next || {}) };

  merged.pollIntervalMin = clampInt(merged.pollIntervalMin, 1, 60);
  merged.cooldownMin = clampInt(merged.cooldownMin, 0, 60 * 24);
  merged.requestTimeoutMs = clampInt(merged.requestTimeoutMs, 2000, 30000);

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

async function ensureAlarm() {
  const settings = await getSettings();
  const period = clampInt(settings.pollIntervalMin, 1, 60);

  // 기존 알람 갱신 (period 변경 반영)
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
}

chrome.runtime.onInstalled.addListener(async () => {
  await setSettings({});
  await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await pollAll({ reason: "alarm" });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "pollNow") {
        const result = await pollAll({ reason: "manual" });
        sendResponse({ ok: true, result });
        return;
      }

      if (msg?.type === "updateSettings") {
        const merged = await setSettings(msg?.settings || {});
        await ensureAlarm();
        sendResponse({ ok: true, settings: merged });
        return;
      }

      if (msg?.type === "testNotification") {
        await notify({
          title: "테스트 알림",
          message: "알림이 정상 동작합니다.",
          url: "https://www.google.com"
        });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // async
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const { notifMap = {} } = await chrome.storage.local.get([STORAGE_KEYS.notifMap]);
  const entry = notifMap[notificationId];
  if (entry?.url) {
    chrome.tabs.create({ url: entry.url });
  }
  delete notifMap[notificationId];
  await chrome.storage.local.set({ [STORAGE_KEYS.notifMap]: notifMap });
});

chrome.notifications.onClosed.addListener(async (notificationId) => {
  const { notifMap = {} } = await chrome.storage.local.get([STORAGE_KEYS.notifMap]);
  if (notifMap[notificationId]) {
    delete notifMap[notificationId];
    await chrome.storage.local.set({ [STORAGE_KEYS.notifMap]: notifMap });
  }
});

async function pollAll({ reason }) {
  const settings = await getSettings();
  const { watchlist = [] } = await chrome.storage.local.get([STORAGE_KEYS.watchlist]);

  const { state = {} } = await chrome.storage.local.get([STORAGE_KEYS.state]);
  const { notified = {} } = await chrome.storage.local.get([STORAGE_KEYS.notified]);

  let checked = 0;
  let liveNow = 0;
  let notifiedCount = 0;

  for (const item of watchlist) {
    checked += 1;

    const prev = state[item.key]; // 없으면 undefined
    const status = await safeFetchStatus(item, settings, prev);

    if (status.isLive) liveNow += 1;

    const transition = computeTransition({
      prev,
      status,
      settings,
      reason
    });

    if (transition.shouldNotify) {
      const can = canNotify(item.key, status.signature, notified, settings);
      if (can) {
        await notify({
          title: transition.title,
          message: transition.message,
          url: status.url
        });
        notified[item.key] = {
          lastNotifiedSig: status.signature,
          lastNotifiedAt: Date.now()
        };
        notifiedCount += 1;
      }
    }

    state[item.key] = {
      lastIsLive: status.isLive,
      lastSig: status.signature,
      lastTitle: status.title || "",
      updatedAt: Date.now()
    };

    // 너무 빠른 연속 요청 방지(가벼운 딜레이)
    await sleep(250);
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.state]: state,
    [STORAGE_KEYS.notified]: notified
  });

  return { checked, liveNow, notified: notifiedCount };
}

function canNotify(key, sig, notified, settings) {
  const cooldownMs = settings.cooldownMin * 60 * 1000;
  const n = notified[key];
  if (!n) return true;

  // 같은 signature(같은 방송으로 추정)에서 쿨다운 내 재알림 방지
  if (n.lastNotifiedSig === sig && cooldownMs > 0) {
    return Date.now() - (n.lastNotifiedAt || 0) >= cooldownMs;
  }
  return true;
}

function computeTransition({ prev, status, settings, reason }) {
  const isFirstSeen = !prev;

  // 최초 상태 수집 시, 이미 라이브인 경우 알림을 낼지 여부
  if (isFirstSeen && status.isLive && !settings.notifyIfAlreadyLive) {
    return { shouldNotify: false };
  }

  const prevLive = !!prev?.lastIsLive;
  const nowLive = !!status.isLive;

  // 오프라인 -> 온라인: 알림
  if (!prevLive && nowLive) {
    const who = status.displayName || status.id;
    const title = `${who} 방송 시작!`;
    const message = status.title ? status.title : "라이브가 시작되었습니다.";
    return { shouldNotify: true, title, message };
  }

  // 라이브 중인데 방송 signature가 바뀐 경우(방송 재시작/다른 방송으로 전환 등)
  // 이건 “옵션”으로 알림해도 되지만 MVP에서는 과도할 수 있어 기본 OFF.
  // 필요하면 여기서 true로 켜면 됨.
  if (prevLive && nowLive && prev?.lastSig && status.signature && prev.lastSig !== status.signature) {
    // 현재는 알림 안 함
    return { shouldNotify: false };
  }

  return { shouldNotify: false };
}

async function safeFetchStatus(item, settings, prev) {
  try {
    const result = await withTimeout(fetchStatus(item), settings.requestTimeoutMs);

    // 공통 필드 보정
    return {
      platform: item.platform,
      id: item.id,
      key: item.key,
      displayName: item.name || "",
      isLive: !!result.isLive,
      title: result.title || "",
      signature: result.signature || (result.isLive ? "LIVE" : "OFF"),
      url: result.url || buildDefaultUrl(item)
    };
  } catch (e) {
    // 실패 시: 이전 상태를 유지하기 위해 OFF로 만들지 않고 "unknown"처럼 처리할 수도 있으나,
    // MVP에서는 단순하게 OFF로 취급하지 않고 "상태 불명"으로 저장만 갱신.
    return {
      platform: item.platform,
      id: item.id,
      key: item.key,
      displayName: item.name || "",
      // 실패 시 이전 상태 유지(중복 알림 방지)
      isLive: !!prev?.lastIsLive,
      title: prev?.lastTitle || "",
      signature: prev?.lastSig || "UNKNOWN",
      url: buildDefaultUrl(item)
    };
  }
}

function buildDefaultUrl(item) {
  if (item.platform === "chzzk") return `https://chzzk.naver.com/live/${item.id}`;
  if (item.platform === "soop") return `https://play.sooplive.co.kr/${item.id}`;
  return "https://www.google.com";
}

async function fetchStatus(item) {
  if (item.platform === "chzzk") return await fetchChzzk(item.id);
  if (item.platform === "soop") return await fetchSoop(item.id);
  throw new Error(`unknown platform: ${item.platform}`);
}

async function fetchChzzk(channelId) {
  // v2 시도 -> 실패하면 v1
  const urls = [
    `https://api.chzzk.naver.com/polling/v2/channels/${channelId}/live-status`,
    `https://api.chzzk.naver.com/polling/v1/channels/${channelId}/live-status`
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const content = json?.content || {};
      const status = String(content.status || "").toUpperCase();
      const isLive = status === "OPEN";
      const title = content.liveTitle || "";
      const signature = isLive ? `OPEN:${title}` : "OFF";

      return {
        isLive,
        title,
        signature,
        url: `https://chzzk.naver.com/live/${channelId}`
      };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("CHZZK fetch failed");
}

async function fetchSoop(streamerId) {
  // soop-extension 방식과 동일한 기본 body (bid + options)
  const url = `https://live.sooplive.co.kr/afreeca/player_live_api.php?bjid=${encodeURIComponent(streamerId)}`;

  const body = new URLSearchParams({
    bid: streamerId,
    type: "live",
    pwd: "",
    player_type: "html5",
    stream_type: "common",
    quality: "HD",
    mode: "landing",
    from_api: "0",
    is_revive: "false"
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const ch = json?.CHANNEL || {};

  const resultCode = Number(ch.RESULT);
  const isLive = resultCode === 1;

  const title = ch.TITLE || "";
  const bno = ch.BNO || ch.PBNO || "";
  const signature = isLive ? `LIVE:${bno || title}` : "OFF";

  return {
    isLive,
    title,
    signature,
    url: `https://play.sooplive.co.kr/${streamerId}`
  };
}

async function notify({ title, message, url }) {
  const notificationId = `live:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  chrome.runtime.getURL("icons/icon128.png");

  const createdId = await new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl,
        title,
        message: message || ""
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.error("[notify] create failed:", chrome.runtime.lastError.message);
          resolve(null);
        } else {
          console.log("[notify] created:", id);
          resolve(id);
        }
      }
    );
  });

  if (!createdId) return;

  const { notifMap = {} } = await chrome.storage.local.get(["notifMap"]);
  notifMap[createdId] = { url };
  await chrome.storage.local.set({ notifMap });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}