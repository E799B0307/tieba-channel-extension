import { TiebaClient } from "./tieba.js";
import { BUILD, OPERATIONS } from "./runtime-info.js";

const client = new TiebaClient();
const panelUrl = chrome.runtime.getURL("panel.html");
const pendingSends = new Set();
const pendingActions = new Set();

// BLCP 实时推送（撤回/删除事件 type=106、新消息）转发给面板
client.onPush((messages) => {
  chrome.runtime.sendMessage({ type: "blcp-push", messages }).catch(() => {});
  for (const msg of messages) {
    if (msg.removed || (msg.deleted && msg.deleted.length)) {
      console.log("[blcp] 撤回/删除事件:", JSON.stringify(msg).slice(0, 600));
    }
  }
});

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
    case "send-diagnostics":
      return client.sendDiagnostics(message.room, message.accountId);
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
        return await client.send(message.room, message.text, message.accountId, message.replyId, message.atData,
          message.type === "send-image" ? message.upload : null,
          message.type === "send-sticker" ? message.favoriteId : "");
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
