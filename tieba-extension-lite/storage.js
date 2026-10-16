const MAX_MARK_ENTRIES = 2000;

export const DEFAULT_SETTINGS = {
  botName: "",
  botBduss: "",     // 独立机器人账号的 BDUSS（机器人版专用；留空则机器人用当前聊天账号发言）
  biliUid: 0,
  rooms: [],
  badwords: [],     // 违禁词：命中后仅静默记录
  recallWords: [],  // 撤回关键词：命中后机器人自动撤回该消息（需机器人账号有频道管理权限）
  admins: {},
  warnText: "⚠️ 消息含违规关键词，已被记录",
};

let cache = null;
let writeChain = Promise.resolve();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function loadSettings() {
  if (cache) return cache;
  const stored = await chrome.storage.local.get("botSettings");
  const settings = { ...DEFAULT_SETTINGS, ...(stored.botSettings || {}) };
  settings.biliUid = Number(settings.biliUid) || 0;
  settings.rooms = (Array.isArray(settings.rooms) ? settings.rooms : [])
    .filter((entry) => entry && /^[1-9]\d{0,15}$/.test(String(entry.roomId || "")))
    .map((entry) => ({ roomId: String(entry.roomId), name: String(entry.name || entry.roomId), fid: String(entry.fid || "") }));
  settings.rooms = [...new Map(settings.rooms.map((room) => [room.roomId, room])).values()];
  settings.badwords = Array.isArray(settings.badwords)
    ? settings.badwords.filter((word) => typeof word === "string" && word.trim()).map((word) => word.trim())
    : [];
  settings.recallWords = Array.isArray(settings.recallWords)
    ? settings.recallWords.filter((word) => typeof word === "string" && word.trim()).map((word) => word.trim())
    : [];
  settings.admins = settings.admins && typeof settings.admins === "object" && !Array.isArray(settings.admins)
    ? settings.admins : {};
  for (const [key, value] of Object.entries(settings.admins)) {
    settings.admins[key] = (Array.isArray(value) ? value : []).map((uid) => Number(uid)).filter((uid) => Number.isSafeInteger(uid));
  }
  settings.warnText = typeof settings.warnText === "string" ? settings.warnText : DEFAULT_SETTINGS.warnText;
  settings.botBduss = typeof settings.botBduss === "string" ? settings.botBduss.trim() : "";
  cache = settings;
  return cache;
}

function persist() {
  const snapshot = clone(cache);
  writeChain = writeChain.then(
    () => chrome.storage.local.set({ botSettings: snapshot }),
    () => chrome.storage.local.set({ botSettings: snapshot }),
  );
  return writeChain;
}

export async function saveSettings(settings) {
  cache = clone({ ...DEFAULT_SETTINGS, ...settings });
  await persist();
  return cache;
}

export async function addRoom(roomId, name, fid = "") {
  const settings = await loadSettings();
  const id = String(roomId);
  if (settings.rooms.some((room) => room.roomId === id)) {
    // 已存在则补全 fid（首次添加时可能未传）
    const existing = settings.rooms.find((room) => room.roomId === id);
    if (fid && !existing.fid) { existing.fid = String(fid); await persist(); return true; }
    return false;
  }
  settings.rooms.push({ roomId: id, name: String(name || id), fid: String(fid || "") });
  await persist();
  return true;
}

export async function removeRoom(roomId) {
  const settings = await loadSettings();
  const id = String(roomId);
  const remaining = settings.rooms.filter((room) => room.roomId !== id);
  if (remaining.length === settings.rooms.length) return false;
  settings.rooms = remaining;
  await persist();
  return true;
}

export async function isRoomEnabled(roomId) {
  const settings = await loadSettings();
  return settings.rooms.some((room) => room.roomId === String(roomId));
}

// ========== 订阅状态 ==========

const DEFAULT_SUBSCRIPTIONS = { live: {}, dynamic: {} };

export async function loadSubscriptions() {
  const stored = await chrome.storage.local.get("botSubscriptions");
  const data = { ...DEFAULT_SUBSCRIPTIONS, ...(stored.botSubscriptions || {}) };
  for (const type of ["live", "dynamic"]) {
    data[type] = data[type] && typeof data[type] === "object" && !Array.isArray(data[type]) ? data[type] : {};
    for (const [key, value] of Object.entries(data[type])) {
      if (/^[1-9]\d{0,15}$/.test(key)) data[type][key] = value === true;
      else delete data[type][key];
    }
  }
  return data;
}

async function saveSubscriptions(data) {
  const snapshot = { live: { ...data.live }, dynamic: { ...data.dynamic } };
  await chrome.storage.local.set({ botSubscriptions: snapshot });
  return snapshot;
}

export async function setSubscription(type, roomId, enabled) {
  if (type !== "live" && type !== "dynamic") return null;
  const data = await loadSubscriptions();
  const id = String(roomId);
  const changed = data[type][id] !== enabled;
  if (changed) data[type][id] = enabled;
  else return { changed: false, data };
  await saveSubscriptions(data);
  return { changed: true, data };
}

export async function subscriptionStatus(roomId) {
  const data = await loadSubscriptions();
  const id = String(roomId);
  return { live: data.live[id] === true, dynamic: data.dynamic[id] === true };
}

export async function subscribedRooms(type, availableRoomIds) {
  const data = await loadSubscriptions();
  const allowed = new Set((availableRoomIds || []).map((roomId) => String(roomId)));
  return Object.entries(data[type] || {})
    .filter(([roomId, enabled]) => enabled === true && allowed.has(roomId))
    .map(([roomId]) => roomId);
}

// ========== 推送去重状态（防止重启后重复刷屏）==========

const DEFAULT_SENT_STATE = { lastDynamicId: "", lastLiveTitle: "" };

export async function loadSentState() {
  const stored = await chrome.storage.local.get("botSentState");
  const state = { ...DEFAULT_SENT_STATE, ...(stored.botSentState || {}) };
  state.lastDynamicId = String(state.lastDynamicId || "");
  state.lastLiveTitle = String(state.lastLiveTitle || "");
  return state;
}

export async function saveSentState(state) {
  const snapshot = {
    lastDynamicId: String(state.lastDynamicId || ""),
    lastLiveTitle: String(state.lastLiveTitle || ""),
  };
  await chrome.storage.local.set({ botSentState: snapshot });
  return snapshot;
}

// ========== 违规记录（追加模式，替代原 标记.log）==========

export async function loadMarkLog() {
  const stored = await chrome.storage.local.get("botMarkLog");
  return Array.isArray(stored.botMarkLog) ? stored.botMarkLog : [];
}

export async function appendMarkLog(entries) {
  const list = await loadMarkLog();
  list.push(...entries);
  const trimmed = list.length > MAX_MARK_ENTRIES ? list.slice(-MAX_MARK_ENTRIES) : list;
  await chrome.storage.local.set({ botMarkLog: trimmed });
  return trimmed;
}

export async function clearMarkLog() {
  await chrome.storage.local.remove("botMarkLog");
}

// ========== 机器人活动日志（命令响应/推送/发送结果，供面板查看）==========

const MAX_BOT_LOG = 300;

/** 追加一条机器人活动记录。entry: { time, room, level, text } level: "info"|"warn"|"error" */
export async function appendBotLog(entry) {
  const stored = await chrome.storage.local.get("botActivityLog");
  const list = Array.isArray(stored.botActivityLog) ? stored.botActivityLog : [];
  list.push({
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    room: String(entry.room || ""),
    level: entry.level === "warn" || entry.level === "error" ? entry.level : "info",
    text: String(entry.text || ""),
  });
  const trimmed = list.length > MAX_BOT_LOG ? list.slice(-MAX_BOT_LOG) : list;
  await chrome.storage.local.set({ botActivityLog: trimmed });
  return trimmed;
}

export async function loadBotLog() {
  const stored = await chrome.storage.local.get("botActivityLog");
  return Array.isArray(stored.botActivityLog) ? stored.botActivityLog : [];
}

export async function clearBotLog() {
  await chrome.storage.local.remove("botActivityLog");
}

// ========== 开关 ==========

export async function loadEnabled() {
  const stored = await chrome.storage.local.get("botEnabled");
  return stored.botEnabled === true;
}

export async function saveEnabled(enabled) {
  const value = enabled === true;
  await chrome.storage.local.set({ botEnabled: value });
  return value;
}

// ========== 变更通知 ==========

/** 设置变更后清缓存，使后续 loadSettings() 重新读盘 */
export function clearSettingsCache() {
  cache = null;
}
