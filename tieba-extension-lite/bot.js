import { getLiveStatus, getLatestDynamic } from "./bilibili.js";
import { processMessage, handleAdminCommand, checkRecallWords } from "./keyword.js";
import {
  loadSettings, isRoomEnabled, setSubscription, subscriptionStatus,
  subscribedRooms, loadSentState, saveSentState, loadEnabled, appendBotLog,
} from "./storage.js";

/**
 * @全体成员 所需的固定 at_data（来自贴吧客户端抓包，与 interaction.py:21-27 一致）。
 *
 * 注意 at_baidu_uk 是客户端抓到的固定值，portrait 的 -666tb.fake.atAll 说明它是
 * 个特殊占位 UK 而非真实账号。若换账号后 @全体成员 失效，需要重新抓包替换。
 */
export const AT_ALL_DATA = [{
  at_type: "all",
  at_baidu_uk: "9p1Ct7T6O7XSRCsfpUqlKg",
  at_name: "全体成员",
  at_portrait: "-666tb.fake.atAll",
  position: "0",
}];

export const AT_ALL_TEXT = "@全体成员";

// 去除双向控制字符 / 零宽字符，用于可靠的昵称匹配（对应 interaction.py:53）
const INVISIBLE = /[​-‏‪-‮⁠⁦-⁩﻿­]/g;

const HELP_TEXT = [
  "可用命令：",
  "/help          - 显示帮助",
  "/ping          - 测试机器人是否在线",
  "/latest        - 获取最新动态",
  "/sub live      - 订阅直播通知",
  "/sub dynamic   - 订阅动态通知",
  "/unsub live    - 取消订阅直播",
  "/unsub dynamic - 取消订阅动态",
  "/status        - 查看本房间的订阅状态",
].join("\n");

function clean(value) {
  return String(value == null ? "" : value).replace(INVISIBLE, "");
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

/** 构造 @单个用户 所需的 at_data */
export function atDataForUser(message) {
  if (!message?.authorId) return null;
  return [{
    at_type: "user",
    at_baidu_uk: String(message.authorId),
    at_name: String(message.name || ""),
    at_portrait: String(message.portrait || ""),
    position: "0",
  }];
}

/**
 * 是否被 @到。沿用 interaction.py:328-344 的三策略优先级：
 * at_names 匹配 > at_uids 匹配 > 文本匹配。
 *
 * 文本清洗是必须的：贴吧昵称常带零宽/RTL 控制字符，直接 includes 会漏判。
 */
export function isMentioned(message, accountName, accountId) {
  if (message?.atAll) return true;
  const expected = clean(accountName);
  if (expected) {
    if ((message.atNames || []).some((name) => clean(name) === expected)) return true;
    if (clean(message.text || "").includes(`@${expected}`)) return true;
  }
  const numeric = Number(accountId);
  if (Number.isSafeInteger(numeric) && (message.atUids || []).includes(numeric)) return true;
  return false;
}

/** 提取命令正文：去掉 "@昵称" 前缀并归一化空白 */
export function commandText(message, accountName) {
  let text = clean(message?.text || "");
  if (!text) return "";
  const expected = clean(accountName);
  if (expected) text = text.replaceAll(`@${expected}`, " ");
  return text.replace(/^\s+|\s+$/g, "").replace(/\s+/g, " ").trim();
}

/**
 * 处理一条消息。返回 true 表示已消费（已回复或已标记），false 表示与本机器人无关。
 *
 * @param client  TiebaClient 实例（后台 Service Worker 中的共享实例）
 * @param message protocol.js parseMessage 的输出
 * @param room    { room, fid, accountId, authorId } 房间状态
 * @param settings 已加载的配置
 */
export async function handleMessage(client, message, room, settings, botCtx = null) {
  if (!settings || !message || !room) return false;

  const roomId = String(room.room);
  const accountId = String(room.accountId);
  const botAuthorId = String(room.authorId || "");

  // 总开关：任何调用入口都必须遵守（后台与面板都可能触发，不能只靠调用方把关）
  if (!(await loadEnabled())) return false;

  // 与 interaction.py:522-524 对应，只是改用 authorId 判断：
  // 扩展以当前登录用户身份发言，没有独立 bot 账号可供昵称比对
  if (botAuthorId && message.authorId && String(message.authorId) === botAuthorId) return false;

  // 只处理已启用机器人的房间（对应 interaction.py:277 的 TARGET_ROOMS 判断）
  if (!(await isRoomEnabled(roomId))) return false;

  // 跳过系统事件消息（加入频道提示等）和已删除/撤回消息
  if (message.system || message.removed || message.hidden || (message.deleted && message.deleted.length)) return false;

  let reply = null;

  // 1. 管理员命令（/banword /unbanword /listbadwords）
  const admin = await handleAdminCommand({ ...message, senderUid: Number(message.from) || 0 }, roomId, { settings });
  if (admin?.handled) reply = admin.reply;

  // 2. 普通命令（需被 @）
  if (!reply) {
    const command = commandText(message, settings.botName);
    if (command && isMentioned(message, settings.botName, accountId)) {
      reply = await runCommand(command, roomId, settings);
      await appendBotLog({
        room: roomId,
        level: "info",
        text: `收到命令「${command}」（来自 ${message.name}），回复：${(reply || "").slice(0, 120)}`,
      });
    }
  }

  // 3. 违禁词静默标记（不回复，避免刷屏——对应 keyword_filter.py:212）
  if (!reply) {
    const violation = await processMessage(
      { ...message, senderUid: Number(message.from) || 0 }, roomId, { botAuthorId, settings },
    );
    if (violation.handled) {
      await appendBotLog({
        room: roomId,
        level: "warn",
        text: `违禁词命中「${(violation.entry?.words || []).join("、")}」：${message.name}：${(message.text || "").slice(0, 80)}`,
      });
      return true;
    }
  }

  // 4. 撤回关键词：命中后机器人自动撤回该消息（需机器人账号有频道管理权限）
  const recallMatched = checkRecallWords(message.text || "", settings.recallWords || []);
  if (recallMatched.length && botCtx?.client && botCtx?.account) {
    await recallViaBot(botCtx, room, message, recallMatched);
    return true;
  }

  if (reply) {
    await sendReply(client, room, message, reply, botCtx);
    return true;
  }
  return false;
}

/**
 * 机器人自动撤回一条命中关键词的消息。
 * 需 bot 账号已登录（botCtx）且该账号有频道管理权限；失败只记日志不抛错。
 */
async function recallViaBot(botCtx, room, message, matched) {
  try {
    if (!room.fid) { await appendBotLog({ room: room.room, level: "error", text: `撤回失败：缺少房间 fid（请重新添加该频道）` }); return; }
    const result = await botCtx.client.recallAsBot(botCtx.account, { room: room.room, fid: room.fid }, message);
    await appendBotLog({
      room: room.room,
      level: "info",
      text: `已撤回命中「${matched.join("、")}」的消息（msgid ${result.id}）：${message.name}：${(message.text || "").slice(0, 80)}`,
    });
  } catch (error) {
    await appendBotLog({
      room: room.room,
      level: "error",
      text: `撤回失败（命中「${matched.join("、")}」）：${error.message}｜${message.name}：${(message.text || "").slice(0, 60)}`,
    });
  }
}

async function runCommand(command, roomId, settings) {
  const parts = command.split(" ");
  const cmd = parts[0].toLowerCase();

  if (cmd === "/help") return HELP_TEXT;
  if (cmd === "/ping") return "pong!";

  if (cmd === "/latest") {
    const uid = Number(settings?.biliUid) || 0;
    if (!uid) return "⚠️ 尚未配置 B站 UID，请先在设置页填写";
    const dynamic = await getLatestDynamic(uid);
    if (!dynamic.dynamicId) return `⚠️ 获取动态失败: ${dynamic.content}`;
    const suffix = formatTime(dynamic.pubTs);
    return `📢 最新动态：\n${dynamic.content.slice(0, 200)}${suffix ? `\n（${suffix}）` : ""}`;
  }

  if (cmd === "/status") {
    const status = await subscriptionStatus(roomId);
    const live = status.live ? "✅ 已订阅" : "❌ 未订阅";
    const dynamic = status.dynamic ? "✅ 已订阅" : "❌ 未订阅";
    return `📊 当前房间订阅状态：\n直播通知: ${live}\n动态通知: ${dynamic}`;
  }

  if (cmd === "/sub" || cmd === "/unsub") {
    const want = cmd === "/sub";
    if (parts.length !== 2) {
      return `❌ ${want ? "订阅" : "取消订阅"}格式错误，请使用 /sub live 或 /sub dynamic`;
    }
    const type = parts[1].toLowerCase();
    if (type !== "live" && type !== "dynamic") {
      return `❌ ${want ? "订阅" : "取消订阅"}类型错误，请使用 /sub live 或 /sub dynamic`;
    }
    const { changed } = await setSubscription(type, roomId, want);
    if (!changed) {
      return want ? `⚠️ 本房间已经订阅过 ${type} 通知了` : `⚠️ 本房间没有订阅 ${type} 通知`;
    }
    return want ? `✅ 已订阅 ${type} 通知！` : `✅ 已取消订阅 ${type} 通知`;
  }

  return `❓ 未知指令: ${command}，发送 /help 查看帮助`;
}

/**
 * 发送回复。@全体成员 走 at_data 分支，普通回复 @提问者。
 * 对应 interaction.py:274-292 的 send_message / _send_via_lowlevel 合并版。
 *
 * botCtx 为 { client, account, state } 时（独立机器人账号已登录），用机器人账号
 * 身份发言；否则回退到用聊天账号（client.send）。
 */
async function sendReply(client, room, message, reply, botCtx = null) {
  let text = String(reply);
  let atData = null;

  if (text.startsWith(AT_ALL_TEXT)) {
    const rest = text.slice(AT_ALL_TEXT.length).trim();
    atData = AT_ALL_DATA;
    text = rest || " ";
  } else if (message.authorId) {
    atData = atDataForUser(message);
  }

  try {
    let result;
    if (botCtx?.client && botCtx?.account && room.fid) {
      // 独立机器人账号发言（机器人版）：需要 room.fid（由调用方从 settings.rooms 补齐）
      result = await botCtx.client.sendAsBot(botCtx.account, { room: room.room, fid: room.fid }, text, atData);
    } else {
      // 回退：用聊天账号发言（未配置独立 bot 账号时）
      result = await client.send(room.room, text, room.accountId, "", atData);
    }
    await appendBotLog({ room: room.room, level: "info", text: `已发送回复（msgid ${result?.id ?? "?"}）：${text.slice(0, 120)}` });
  } catch (error) {
    console.warn("[bot] 回复发送失败:", error.message);
    await appendBotLog({ room: room.room, level: "error", text: `回复发送失败：${error.message}｜内容：${text.slice(0, 80)}` });
  }
}

/**
 * B站监控轮询。由后台 chrome.alarms 驱动（MV3 下 Service Worker 会被回收，
 * 无法维持 interaction.py:433 那样的常驻 while 循环）。
 *
 * 对应 Python 版的 monitor_bilibili，并修复其两个缺陷：
 * 1. last_live_title 在判断后被无条件覆盖，导致开播推送判断失效
 * 2. 动态消息无条件追加 "..." 后缀，未截断时也加了
 */
export async function monitor(client, { accountId = "", roomIds = [] } = {}, botCtx = null) {
  const enabled = await loadEnabled();
  if (!enabled) return { pushed: 0, error: null };
  if (!accountId || !/^\d+$/.test(String(accountId))) return { pushed: 0, error: "未连接贴吧账号" };

  const settings = await loadSettings();
  const uid = Number(settings.biliUid) || 0;
  if (!uid) return { pushed: 0, error: "未配置 B站 UID" };

  // 只看仍然保留在配置里的房间：房间被移除后残留的订阅不应继续推送
  const available = (roomIds.length ? roomIds : settings.rooms.map((room) => room.roomId)).map(String);

  const state = await loadSentState();
  let pushed = 0;
  const failure = (stage, error) => ({ pushed, error: `${stage}：${error.message}` });

  let liveStatus;
  try {
    liveStatus = await getLiveStatus(uid);
  } catch (error) {
    return failure("读取直播状态", error);
  }
  const [isLiving, title, , liveError] = liveStatus;
  if (liveError) return { pushed, error: `读取直播状态：${liveError}` };

  if (!isLiving) {
    // 下播：清空标题，下次开播才会再推。
    // 修复原 Python 逻辑——它在比较后无条件覆盖 last_live_title，导致开播判断恒为假
    if (state.lastLiveTitle) {
      state.lastLiveTitle = "";
      await saveSentState(state);
    }
  } else if (title && title !== state.lastLiveTitle) {
    const message = `${AT_ALL_TEXT}🎉 然然开播啦！\n${title}\n（${formatTime(Date.now() / 1000)}）`;
    await appendBotLog({ room: "", level: "info", text: `检测到开播：${title}，推送到订阅房间` });
    for (const roomId of await subscribedRooms("live", available)) {
      await sendAnnouncement(client, roomId, accountId, message, botCtx);
      pushed += 1;
    }
    state.lastLiveTitle = title;
    await saveSentState(state);
  }

  let dynamic;
  try {
    dynamic = await getLatestDynamic(uid);
  } catch (error) {
    return failure("读取最新动态", error);
  }

  if (dynamic.dynamicId && dynamic.dynamicId !== state.lastDynamicId) {
    // 修复原 Python 逻辑：只有真正截断时才补 "..."，未截断时保留原文
    const preview = dynamic.content.length > 100 ? `${dynamic.content.slice(0, 100)}...` : dynamic.content;
    const suffix = formatTime(dynamic.pubTs);
    const message = `${AT_ALL_TEXT}📢 然然发布了新动态！\n${preview}${suffix ? `\n（${suffix}）` : ""}`;
    await appendBotLog({ room: "", level: "info", text: `检测到新动态：${preview.slice(0, 80)}，推送到订阅房间` });
    for (const roomId of await subscribedRooms("dynamic", available)) {
      await sendAnnouncement(client, roomId, accountId, message, botCtx);
      pushed += 1;
    }
    state.lastDynamicId = dynamic.dynamicId;
    await saveSentState(state);
  }

  return { pushed, error: null };
}

async function sendAnnouncement(client, roomId, accountId, message, botCtx = null) {
  if (botCtx?.client && botCtx?.account && botCtx.stateFor) {
    const state = botCtx.stateFor(roomId);
    if (state) return sendReply(client, { ...state, accountId, authorId: "" }, { name: "", authorId: "" }, message, botCtx);
  }
  const { state } = await client.roomState(roomId, accountId).catch(() => ({ state: null }));
  if (!state) return false;
  return sendReply(client, state, { name: "", authorId: "" }, message);
}
