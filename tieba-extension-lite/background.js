import { TiebaClient } from "./tieba.js";
import { addRoom, loadSettings, loadEnabled } from "./storage.js";
import { monitor, handleMessage } from "./bot.js";
import { authorIdFromUserId } from "./protocol.js";
import { BUILD, OPERATIONS } from "./runtime-info.js";

const client = new TiebaClient();
const botClient = new TiebaClient();   // 独立机器人账号（机器人版）
const panelUrl = chrome.runtime.getURL("panel.html");
const pendingSends = new Set();
const pendingActions = new Set();
const botHandledIds = new Set();   // 已喂给机器人的消息 ID（防 BLCP 重连重放导致重复回复）

let botAccount = null;       // 独立机器人账号（loginWithToken 结果），null=未配置/未登录
let botLoginTask = null;     // 机器人账号登录 Promise

// BLCP 实时推送（撤回/删除事件 type=106、新消息）转发给面板
client.onPush((messages) => {
  chrome.runtime.sendMessage({ type: "blcp-push", messages }).catch(() => {});
  for (const msg of messages) {
    if (msg.removed || (msg.deleted && msg.deleted.length)) {
      console.log("[blcp] 撤回/删除事件:", JSON.stringify(msg).slice(0, 600));
    }
  }
  // 机器人：喂给 handleMessage 处理命令/违禁词/@回应（勿 await 阻塞推送转发）
  dispatchToBot(messages).catch((error) => console.warn("[bot] 处理推送失败:", error.message));
});

/**
 * 获取机器人发言上下文（独立 bot 账号）。
 * 返回 { client, account, stateFor(roomId) } 或 null（未配置 bot BDUSS 或登录失败）。
 */
async function getBotContext(settings) {
  const bduss = settings?.botBduss || "";
  if (!bduss) return null;
  if (botAccount && botAccount.token === bduss) {
    return { client: botClient, account: botAccount, stateFor: (roomId) => roomStateFor(settings, roomId) };
  }
  if (botLoginTask && botLoginTask.token === bduss) {
    const account = await botLoginTask.promise;
    return { client: botClient, account, stateFor: (roomId) => roomStateFor(settings, roomId) };
  }
  botLoginTask = { token: bduss, promise: botClient.loginWithToken(bduss).then((account) => {
    botAccount = account;
    botLoginTask = null;
    return account;
  }).catch((error) => {
    botAccount = null;
    botLoginTask = null;
    console.warn("[bot] 机器人账号登录失败:", error.message);
    return null;
  }) };
  const account = await botLoginTask.promise;
  if (!account) return null;
  return { client: botClient, account, stateFor: (roomId) => roomStateFor(settings, roomId) };
}

/** 从 settings.rooms 找 roomId 的 { room, fid }；fid 缺失时返回 null（无法发言） */
function roomStateFor(settings, roomId) {
  const room = (settings.rooms || []).find((entry) => String(entry.roomId) === String(roomId));
  if (!room?.fid) return null;
  return { room: String(room.roomId), fid: String(room.fid) };
}

/**
 * 把实时推送喂给机器人。仅处理已启用房间 + 非本人消息；房间上下文
 * （accountId / authorId）从缓存账号重建，账号未登录或房间未启用时静默跳过。
 */
async function dispatchToBot(messages) {
  if (!(await loadEnabled())) return;
  const account = client.cachedAccount;
  if (!account?.id) return;
  const settings = await loadSettings();
  const authorId = await authorIdFromUserId(account.id);
  const botCtx = await getBotContext(settings);
  for (const message of messages) {
    if (!message || message.removed || (message.deleted && message.deleted.length)) continue;
    if (!message.room || !message.id || !/^\d+$/.test(message.room)) continue;
    if (botHandledIds.has(message.id)) continue;
    botHandledIds.add(message.id);
    if (botHandledIds.size > 500) {
      for (const id of botHandledIds) { botHandledIds.delete(id); if (botHandledIds.size <= 250) break; }
    }
    const room = { room: String(message.room), fid: "", accountId: account.id, authorId };
    if (botCtx) {
      const st = botCtx.stateFor(message.room);
      if (st) room.fid = st.fid;
    }
    await handleMessage(client, message, room, settings, botCtx).catch((error) =>
      console.warn("[bot] 消息处理失败:", error.message));
  }
}

const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.cookies.onChanged.addListener(({ cookie }) => {
  if (cookie.name !== "BDUSS" || !["baidu.com", "tieba.baidu.com", "tiebac.baidu.com", "pim.baidu.com"].includes(cookie.domain.replace(/^\./, ""))) return;
  client.invalidateAccount().finally(() => {
    return chrome.runtime.sendMessage({ type: "account-changed" }).catch(() => {});
  }).catch(() => {});
});

async function pageContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://tieba.baidu.com/")) return {};
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: "page-context" });
  } catch {
    return { name: new URL(tab.url).searchParams.get("kw") || "" };
  }
}

async function dispatch(message) {
  await storageReady;
  if (message.type === "runtime-info") return { build: BUILD, operations: OPERATIONS };
  if (message.type !== "initialize" && (typeof message.accountId !== "string" || !/^\d+$/.test(message.accountId))) {
    throw Object.assign(new Error("请先连接当前网页登录账号"), { code: "ACCOUNT_CHANGED" });
  }
  switch (message.type) {
    case "initialize": {
      const [account, context, preferences] = await Promise.all([
        client.account(), pageContext(), chrome.storage.local.get("lastForum"),
      ]);
      const lastForum = preferences.lastForum?.accountId === account.id ? preferences.lastForum.name : "";
      return { account: client.publicAccount(account), context, lastForum };
    }
    case "account-check":
      return client.checkAccount(message.accountId);
    case "rooms":
      return client.rooms(message.forum, message.accountId);
    case "enter":
      return client.enter(message.room, message.fid, message.accountId);
    case "messages":
      return client.messages(message.room, message.accountId, message.after);
    case "favorite-stickers":
      return client.favoriteStickers(message.accountId, message.refresh === true);
    case "send":
    case "send-image":
    case "send-sticker": {
      if (message.type === "send-sticker" && (typeof message.favoriteId !== "string" || !message.favoriteId || message.favoriteId.length > 260)) {
        throw new Error("请选择收藏表情");
      }
      const key = `${message.accountId}:${message.room}`;
      if (pendingSends.has(key)) throw new Error("上一条消息还在发送，请稍候");
      pendingSends.add(key);
      try {
        const result = await client.send(message.room, message.text, message.accountId, message.replyId, message.atData,
          message.type === "send-image" ? message.upload : null,
          message.type === "send-sticker" ? message.favoriteId : "");
        // 发送受理诊断：记录 msgid + 关键参数，用于排查"受理但未回显"的风控丢弃
        console.log("[send] 已受理:", JSON.stringify({ msgid: result?.id, room: message.room, type: message.type, ts: Date.now() }));
        return result;
      } finally {
        pendingSends.delete(key);
      }
    }
    case "reaction-detail":
      return client.reactionDetail(message.room, message.id, message.image, message.accountId, message.after);
    case "react":
    case "recall": {
      const key = `${message.accountId}:${message.room}:${message.id}`;
      if (pendingActions.has(key)) throw new Error("这条消息正在处理，请稍候");
      pendingActions.add(key);
      try {
        return message.type === "recall"
          ? await client.recall(message.room, message.accountId, message.id)
          : await client.react(message.room, message.id, message.image, message.add, message.accountId);
      } finally { pendingActions.delete(key); }
    }
    case "add-room": {
      const added = await addRoom(message.room, message.name, message.fid || "");
      await client.ensureJoined(message.room, message.accountId).catch(() => {});
      return { added, name: message.name, room: message.room };
    }
    default:
      throw new Error("不支持的操作");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object") return false;
  if (message.type === "open-chat" && sender.tab?.id && sender.url?.startsWith("https://tieba.baidu.com/")) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false, error: "请点击浏览器工具栏中的插件图标打开聊天室" }),
    );
    return true;
  }
  if (sender.url !== panelUrl) return false;
  dispatch(message).then(
    (data) => sendResponse({ ok: true, build: BUILD, data }),
    (error) => sendResponse({ ok: false, build: BUILD, error: error.message || "请求失败，请重试", code: error.code || "" }),
  );
  return true;
});

/* ================= B站监控（chrome.alarms 驱动，MV3 SW 会被回收，无法常驻循环） ================= */

const MONITOR_ALARM = "bili-monitor";

async function runMonitor() {
  try {
    if (!(await loadEnabled())) return;
    const settings = await loadSettings();
    if (!settings.biliUid) return;
    let accountId = client.cachedAccount?.id || "";
    if (!accountId) {
      try { accountId = (await client.account("")).id || ""; }
      catch { accountId = ""; }
    }
    if (!accountId) return;
    const roomIds = settings.rooms.map((room) => room.roomId);
    await Promise.all(roomIds.map((roomId) => client.ensureJoined(roomId, accountId).catch(() => {})));
    const botCtx = await getBotContext(settings);
    const result = await monitor(client, { accountId, roomIds }, botCtx);
    if (result.error) console.warn("[monitor]", result.error);
    if (result.pushed) console.log("[monitor] 已推送", result.pushed, "条通知");
  } catch (error) {
    console.warn("[monitor] 执行失败:", error.message);
  }
}

chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MONITOR_ALARM) runMonitor();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(MONITOR_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
});
