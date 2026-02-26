/* SOOP/CHZZK Live Notifier - MV3 service worker
 * - chrome.alarms 기반 주기 폴링
 * - 오프라인 -> 라이브 전환에서만 알림
 * - 중복 알림 방지(쿨다운 + signature)
 * - 알림 아이콘: 스트리머 프로필(가능하면) / 실패 시 기본 아이콘 폴백
 * - 폴링 지연 축소: 동시 처리(동시성 제한) + 요청 타임아웃 단축
 */

const ALARM_NAME = "poll_live_status";

const DEFAULT_SETTINGS = {
  pollIntervalMin: 1,          // 1~60
  cooldownMin: 10,             // 0~1440
  notifyIfAlreadyLive: false,  // 최초/재시작 시 이미 라이브면 알림 여부
  requestTimeoutMs: 5000,      // ✅ 지연 줄이기: 기본 5초
};

const STORAGE_KEYS = {
  watchlist: "watchlist",
  settings: "settings",
  state: "state",         // key -> { lastIsLive, lastSig, lastTitle, updatedAt }
  notified: "notified",   // key -> { lastNotifiedSig, lastNotifiedAt }
  notifMap: "notifMap",   // notificationId -> { url }
  // key -> { url, fetchedAt, dataUrl, dataFetchedAt }
  // - url: 플랫폼에서 얻은 원본 프로필 이미지 URL(원격)
  // - dataUrl: notifications.iconUrl에 안정적으로 넣기 위한 data: URL(권장)
  avatarCache: "avatarCache",
};

const DEFAULT_ICON_URL = chrome.runtime.getURL("icons/icon128.png");
const AVATAR_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_ICON_MAX_BYTES = 512 * 1024; // 너무 큰 이미지는 dataUrl로 변환/저장하지 않음

// ✅ 폴링 동시성(너무 높이면 API에 부담)
const POLL_CONCURRENCY = 4;

// ✅ storage.notifMap 동시 업데이트 덮어쓰기 방지용 간단 mutex
let notifMapMutex = Promise.resolve();

function clampInt(n, min, max) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ✅ 알림 아이콘용: 이미지 URL -> data URL
 *
 * 최신 MV3/Chrome 환경에서 notifications.create(iconUrl)에 원격 URL을 직접 넣으면
 * "Unable to download all specified images" 에러가 발생할 수 있습니다.
 * 서비스워커에서 이미지를 fetch하여 data: URL로 변환해 넣는 방식이 가장 안정적입니다.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192; // call stack 방지
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchImageAsDataUrl(imageUrl, { timeoutMs = 5000 } = {}) {
  if (!imageUrl) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // ✅ 쿠키/세션을 사용하지 않음(최소 권한/보안 원칙)
    const res = await fetch(imageUrl, {
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`not an image: ${contentType}`);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > AVATAR_ICON_MAX_BYTES) {
      throw new Error(`image too large: ${buf.byteLength} bytes`);
    }

    const b64 = arrayBufferToBase64(buf);
    return `data:${contentType || "image/png"};base64,${b64}`;
  } finally {
    clearTimeout(t);
  }
}

async function getSettings() {
  const { [STORAGE_KEYS.settings]: settings } = await chrome.storage.local.get([STORAGE_KEYS.settings]);
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
          url: "https://www.google.com",
          iconUrl: DEFAULT_ICON_URL,
        });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true; // async response
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const entry = await getNotifMapEntry(notificationId);
  if (entry?.url) chrome.tabs.create({ url: entry.url });
  await deleteNotifMapEntry(notificationId);
});

chrome.notifications.onClosed.addListener(async (notificationId) => {
  await deleteNotifMapEntry(notificationId);
});

async function pollAll({ reason }) {
  const settings = await getSettings();

  const [
    { [STORAGE_KEYS.watchlist]: watchlist = [] },
    { [STORAGE_KEYS.state]: state = {} },
    { [STORAGE_KEYS.notified]: notified = {} },
    { [STORAGE_KEYS.avatarCache]: avatarCache = {} },
  ] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.watchlist]),
    chrome.storage.local.get([STORAGE_KEYS.state]),
    chrome.storage.local.get([STORAGE_KEYS.notified]),
    chrome.storage.local.get([STORAGE_KEYS.avatarCache]),
  ]);

  const t0 = Date.now();

  const results = await mapPool(watchlist, POLL_CONCURRENCY, async (item) => {
    const prev = state[item.key];
    const status = await safeFetchStatus(item, settings, prev);

    let didNotify = false;

    const transition = computeTransition({ prev, status, settings });
    if (transition.shouldNotify) {
      if (canNotify(item.key, status.signature, notified, settings)) {
        const avatarIconUrl = await getAvatarIconUrl(item, avatarCache);
        await notify({
          title: transition.title,
          message: transition.message,
          url: status.url,
          iconUrl: avatarIconUrl || DEFAULT_ICON_URL,
        });

        notified[item.key] = { lastNotifiedSig: status.signature, lastNotifiedAt: Date.now() };
        didNotify = true;
      }
    }

    state[item.key] = {
      lastIsLive: status.isLive,
      lastSig: status.signature,
      lastTitle: status.title || "",
      updatedAt: Date.now(),
    };

    return { isLive: status.isLive, didNotify };
  });

  const checked = watchlist.length;
  const liveNow = results.filter((r) => r?.isLive).length;
  const notifiedCount = results.filter((r) => r?.didNotify).length;

  await chrome.storage.local.set({
    [STORAGE_KEYS.state]: state,
    [STORAGE_KEYS.notified]: notified,
    [STORAGE_KEYS.avatarCache]: avatarCache,
  });

  console.log(
    `[poll] reason=${reason} checked=${checked} live=${liveNow} notified=${notifiedCount} ` +
      `in ${Date.now() - t0}ms (timeout=${settings.requestTimeoutMs}ms, concurrency=${POLL_CONCURRENCY})`
  );

  return { checked, liveNow, notified: notifiedCount };
}

function canNotify(key, sig, notified, settings) {
  const cooldownMs = settings.cooldownMin * 60 * 1000;
  const n = notified[key];
  if (!n) return true;

  if (n.lastNotifiedSig === sig && cooldownMs > 0) {
    return Date.now() - (n.lastNotifiedAt || 0) >= cooldownMs;
  }
  return true;
}

function computeTransition({ prev, status, settings }) {
  const isFirstSeen = !prev;

  // 최초 인식/재시작 때 이미 LIVE면, 옵션이 false면 알리지 않음
  if (isFirstSeen && status.isLive && !settings.notifyIfAlreadyLive) {
    return { shouldNotify: false };
  }

  const prevLive = !!prev?.lastIsLive;
  const nowLive = !!status.isLive;

  // ✅ 오프라인 -> 라이브 전환에서만 알림
  if (!prevLive && nowLive) {
    const who = status.displayName || status.id;
    const title = `${who} 방송 시작!`;
    const message = status.title ? status.title : "라이브가 시작되었습니다.";
    return { shouldNotify: true, title, message };
  }

  return { shouldNotify: false };
}

async function safeFetchStatus(item, settings, prev) {
  try {
    const result = await withTimeout(fetchStatus(item), settings.requestTimeoutMs);
    return {
      platform: item.platform,
      id: item.id,
      key: item.key,
      displayName: item.name || "",
      isLive: !!result.isLive,
      title: result.title || "",
      signature: result.signature || (result.isLive ? "LIVE" : "OFF"),
      url: result.url || buildDefaultUrl(item),
    };
  } catch (e) {
    // ✅ 실패 시 이전 상태 유지(OFF 오판으로 중복 알림 방지)
    return {
      platform: item.platform,
      id: item.id,
      key: item.key,
      displayName: item.name || "",
      isLive: !!prev?.lastIsLive,
      title: prev?.lastTitle || "",
      signature: prev?.lastSig || "UNKNOWN",
      url: buildDefaultUrl(item),
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

/** CHZZK: live-status */
async function fetchChzzk(channelId) {
  const urls = [
    `https://api.chzzk.naver.com/polling/v2/channels/${channelId}/live-status`,
    `https://api.chzzk.naver.com/polling/v1/channels/${channelId}/live-status`,
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

      return { isLive, title, signature, url: `https://chzzk.naver.com/live/${channelId}` };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("CHZZK fetch failed");
}

/** SOOP: player_live_api.php */
async function fetchSoop(streamerId) {
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
    is_revive: "false",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  const ch = json?.CHANNEL || {};
  const resultCode = Number(ch.RESULT);

  const isLive = resultCode === 1;
  const title = ch.TITLE || "";
  const bno = ch.BNO || ch.PBNO || "";
  const signature = isLive ? `LIVE:${bno || title}` : "OFF";

  return { isLive, title, signature, url: `https://play.sooplive.co.kr/${streamerId}` };
}

/** ✅ 알림: 프로필 아이콘 시도 -> 실패 시 기본 아이콘 폴백 */
async function notify({ title, message, url, iconUrl }) {
  const notificationId = `live:${Date.now()}:${Math.random().toString(16).slice(2)}`;

  // 1) 먼저 전달된 아이콘(프로필 등)로 시도
  let createdId = await createNotification({
    notificationId,
    title,
    message,
    iconUrl: iconUrl || DEFAULT_ICON_URL,
  });

  // 2) 이미지 다운로드 실패 등으로 create가 실패하면 기본 아이콘으로 재시도
  if (!createdId && iconUrl && iconUrl !== DEFAULT_ICON_URL) {
    createdId = await createNotification({
      notificationId,
      title,
      message,
      iconUrl: DEFAULT_ICON_URL,
    });
  }

  if (!createdId) return;

  await upsertNotifMap(createdId, url);
}

async function createNotification({ notificationId, title, message, iconUrl }) {
  return await new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl,
        title,
        message: message || "",
      },
      (id) => {
        if (chrome.runtime.lastError) {
          console.error("[notify] create failed:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        console.log("[notify] created:", id);
        resolve(id);
      }
    );
  });
}

/** notifMap: 동시성 안전 업데이트 */
async function withNotifMapLock(fn) {
  notifMapMutex = notifMapMutex.then(
    async () => {
      try {
        await fn();
      } catch (e) {
        console.warn("[notifMap] lock fn failed:", String(e?.message || e));
      }
    },
    async () => {
      try {
        await fn();
      } catch (e) {
        console.warn("[notifMap] lock fn failed:", String(e?.message || e));
      }
    }
  );
  await notifMapMutex;
}

async function upsertNotifMap(notificationId, url) {
  await withNotifMapLock(async () => {
    const { [STORAGE_KEYS.notifMap]: notifMap = {} } = await chrome.storage.local.get([STORAGE_KEYS.notifMap]);
    notifMap[notificationId] = { url };
    await chrome.storage.local.set({ [STORAGE_KEYS.notifMap]: notifMap });
  });
}

async function getNotifMapEntry(notificationId) {
  const { [STORAGE_KEYS.notifMap]: notifMap = {} } = await chrome.storage.local.get([STORAGE_KEYS.notifMap]);
  return notifMap[notificationId] || null;
}

async function deleteNotifMapEntry(notificationId) {
  await withNotifMapLock(async () => {
    const { [STORAGE_KEYS.notifMap]: notifMap = {} } = await chrome.storage.local.get([STORAGE_KEYS.notifMap]);
    if (notifMap[notificationId]) {
      delete notifMap[notificationId];
      await chrome.storage.local.set({ [STORAGE_KEYS.notifMap]: notifMap });
    }
  });
}

/** ✅ 스트리머 프로필 이미지 URL 가져오기 + 캐시 */
async function getAvatarIconUrl(item, avatarCache) {
  try {
    const cached = avatarCache[item.key] || {};
    const now = Date.now();

    // 1) dataUrl 캐시(알림 iconUrl에 그대로 사용)
    if (cached.dataUrl && cached.dataFetchedAt && now - cached.dataFetchedAt < AVATAR_CACHE_TTL_MS) {
      return cached.dataUrl;
    }

    // 2) 프로필 원본 URL 캐시(플랫폼 API/HTML에서 얻은 값)
    let url = null;
    if (cached.url && cached.fetchedAt && now - cached.fetchedAt < AVATAR_CACHE_TTL_MS) {
      url = cached.url;
    } else {
      if (item.platform === "chzzk") url = await fetchChzzkAvatarUrl(item.id);
      if (item.platform === "soop") url = await fetchSoopAvatarUrl(item.id);

      if (url) avatarCache[item.key] = { ...cached, url, fetchedAt: now };
    }

    if (!url) return null;

    // 3) 원격 URL -> data URL 변환 (이게 되어야 notifications.create가 안정적으로 성공)
    const dataUrl = await fetchImageAsDataUrl(url, { timeoutMs: 5000 });
    if (!dataUrl) return null;

    avatarCache[item.key] = { ...(avatarCache[item.key] || cached), dataUrl, dataFetchedAt: now };
    return dataUrl;
  } catch (e) {
    console.warn("[avatar] failed:", String(e?.message || e));
    return null;
  }
}

/** CHZZK: channel info -> channelImageUrl */
async function fetchChzzkAvatarUrl(channelId) {
  const res = await fetch(`https://api.chzzk.naver.com/service/v1/channels/${channelId}`);
  if (!res.ok) throw new Error(`CHZZK channel info HTTP ${res.status}`);

  const json = await res.json();
  const content = json?.content || {};
  const img = content.channelImageUrl;
  if (!img) return null;

  return String(img);
}

/** SOOP: station page HTML og:image */
async function fetchSoopAvatarUrl(bjid) {
  const res = await fetch(`https://play.sooplive.co.kr/${encodeURIComponent(bjid)}`);
  if (!res.ok) throw new Error(`SOOP station HTML HTTP ${res.status}`);

  const html = await res.text();

  const m1 = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  const m2 = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  const url = (m1?.[1] || m2?.[1] || "").trim();

  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}

/** 동시성 제한 map(pool) */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** 단순 타임아웃 래퍼(AbortController 미사용) */
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