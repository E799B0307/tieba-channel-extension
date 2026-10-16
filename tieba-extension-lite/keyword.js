import { loadSettings, saveSettings, appendMarkLog, loadMarkLog } from "./storage.js";

function clean(value) {
  return String(value == null ? "" : value).trim();
}

export function checkBadwords(text, badwords) {
  const source = String(text == null ? "" : text).toLowerCase();
  if (!source) return [];
  return badwords
    .map((word) => clean(word))
    .filter((word) => word && source.includes(word.toLowerCase()));
}

/** 检测是否命中撤回关键词（与 checkBadwords 同逻辑，独立列表） */
export function checkRecallWords(text, recallWords) {
  return checkBadwords(text, recallWords);
}

export function isAdmin(uid, roomId, admins) {
  const numeric = Number(uid);
  if (!Number.isSafeInteger(numeric)) return false;
  const list = admins?.[String(roomId)] || [];
  return list.some((entry) => Number(entry) === numeric);
}

export function formatMarkEntries(roomId, senderName, senderUid, text, matched, roomName = "") {
  const timestamp = new Date().toLocaleString("zh-CN", { hour12: false });
  const room = roomName ? `${roomName}(${roomId})` : String(roomId);
  return [{
    time: timestamp,
    room,
    roomId: String(roomId),
    name: clean(senderName) || "?",
    uid: Number(senderUid) || 0,
    words: matched.slice(),
    text: String(text == null ? "" : text),
  }];
}

export async function recordViolation(roomId, senderName, senderUid, text, matched, roomName) {
  const entries = formatMarkEntries(roomId, senderName, senderUid, text, matched, roomName);
  await appendMarkLog(entries);
  return entries[0];
}

export async function exportViolations() {
  const list = await loadMarkLog();
  return list
    .map((entry) => [
      `[${entry.time}] 房间 ${entry.room}`,
      `  用户: ${entry.name} (UID: ${entry.uid})`,
      `  关键词: ${(entry.words || []).join("、")}`,
      `  消息: ${entry.text}`,
      "",
    ].join("\n"))
    .join("\n");
}

/**
 * 处理单条消息，返回 true 表示"已消费"，阻止后续命令处理。
 *
 * 对应 Python 版 keyword_filter.process_message。两个移植差异：
 * 1. 关键词来自扩展的 settings.badwords，而非 badwords.json
 * 2. bot 自身判定改用 authorId 比对——扩展只能以当前登录用户身份发言，
 *    没有独立 bot 账号，昵称比对不再可靠（见 interaction.py:524 的同类逻辑）
 */
export async function processMessage(msg, roomId, { botAuthorId = "", settings = null } = {}) {
  const resolved = settings || (await loadSettings());
  const senderUid = msg?.senderUid ?? msg?.from ?? 0;

  if (botAuthorId && msg?.authorId && String(msg.authorId) === String(botAuthorId)) return { handled: false, reason: "self" };

  const text = String(msg?.text || "");
  if (!text.trim()) return { handled: false, reason: "empty" };

  const matched = checkBadwords(text, resolved.badwords || []);
  if (!matched.length) return { handled: false, reason: "clean", admin: isAdmin(senderUid, roomId, resolved.admins) };

  const roomName = (resolved.rooms || []).find((room) => String(room.roomId) === String(roomId))?.name || "";
  const entry = await recordViolation(roomId, msg?.name, senderUid, text, matched, roomName);
  return { handled: true, reason: "matched", entry, warnText: resolved.warnText };
}

export async function handleAdminCommand(msg, roomId, { settings = null, botAuthorId = "" } = {}) {
  const resolved = settings || (await loadSettings());
  let text = clean(msg?.text || "");
  if (!text) return null;

  // 去掉 "@xxx " 前缀，命令正文从第一个空格之后开始
  if (text.startsWith("@")) {
    const space = text.indexOf(" ");
    if (space > 0) text = text.slice(space).trim();
  }

  const parts = text.split(/\s+/);
  if (!parts.length) return null;
  const command = parts[0].toLowerCase();
  if (!["/banword", "/unbanword", "/listbadwords"].includes(command)) return null;

  const senderUid = Number(msg?.senderUid ?? 0);
  if (!isAdmin(senderUid, roomId, resolved.admins)) {
    // 静默消费，不回复"无权"提示：扩展以本人账号发言，任何人发的管理命令都回复
    // 等于开放刷屏入口（Python 版有独立 bot 账号，风险不同，这里修掉）
    return { handled: true, reply: null };
  }

  const badwords = (resolved.badwords || []).slice();

  if (command === "/banword" && parts.length >= 2) {
    const word = parts.slice(1).join(" ").trim();
    if (badwords.includes(word)) return { handled: true, reply: `⚠️ 关键词「${word}」已存在`, unchanged: true };
    badwords.push(word);
    await save({ badwords });
    return { handled: true, reply: `✅ 已添加关键词：${word}`, badwords };
  }

  if (command === "/unbanword" && parts.length >= 2) {
    const word = parts.slice(1).join(" ").trim();
    const index = badwords.indexOf(word);
    if (index < 0) return { handled: true, reply: `⚠️ 关键词「${word}」不存在`, unchanged: true };
    badwords.splice(index, 1);
    await save({ badwords });
    return { handled: true, reply: `✅ 已移除关键词：${word}`, badwords };
  }

  if (command === "/listbadwords") {
    return {
      handled: true,
      reply: badwords.length
        ? `📋 当前关键词（${badwords.length}个）：${badwords.join("、")}`
        : "📋 当前无关键词",
      unchanged: true,
    };
  }

  return null;
}

async function save(patch) {
  await saveSettings({ ...(await loadSettings()), ...patch });
}
