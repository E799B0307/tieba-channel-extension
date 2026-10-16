import {
  loadSettings, saveSettings, removeRoom, clearSettingsCache,
  loadSubscriptions, loadMarkLog, clearMarkLog, loadEnabled, saveEnabled,
} from "./storage.js";
import { exportViolations } from "./keyword.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

let draft = null;
let toastTimer = 0;

function notify(message, bad = false) {
  clearTimeout(toastTimer);
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  elements.notice.style.background = bad ? "#fdeceb" : "#e7f6ed";
  elements.notice.style.color = bad ? "#c93c35" : "#1a7f42";
  toastTimer = setTimeout(() => { elements.notice.hidden = true; }, 3200);
}

function pill(label, onRemove) {
  const item = document.createElement("li");
  item.className = "pill";
  const text = document.createElement("span");
  text.textContent = label;
  item.append(text);
  if (onRemove) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "×";
    button.setAttribute("aria-label", `移除 ${label}`);
    button.addEventListener("click", onRemove);
    item.append(button);
  }
  return item;
}

function renderRooms() {
  const rooms = draft.rooms || [];
  elements["room-list"].replaceChildren(...rooms.map((room) =>
    pill(`${room.name} · ${room.roomId}`, async () => {
      await removeRoom(room.roomId);
      clearSettingsCache();
      draft.rooms = draft.rooms.filter((entry) => entry.roomId !== room.roomId);
      // 移除房间时，顺带清理该房间的管理员名单
      if (draft.admins && draft.admins[room.roomId]) {
        draft.admins = { ...draft.admins };
        delete draft.admins[room.roomId];
      }
      renderRooms();
      renderSubscriptions();
      renderAdminRooms();
      notify(`已移除房间 ${room.name}`);
    })));
  elements["room-empty"].hidden = rooms.length > 0;
}

function renderBadwords() {
  const words = draft.badwords || [];
  elements["badword-list"].replaceChildren(...words.map((word) =>
    pill(word, () => {
      draft.badwords = draft.badwords.filter((entry) => entry !== word);
      renderBadwords();
      notify(`已移除关键词 ${word}`);
    })));
  elements["badword-empty"].hidden = words.length > 0;
}

function renderRecallWords() {
  const words = draft.recallWords || [];
  elements["recallword-list"].replaceChildren(...words.map((word) =>
    pill(word, () => {
      draft.recallWords = draft.recallWords.filter((entry) => entry !== word);
      renderRecallWords();
      notify(`已移除撤回关键词 ${word}`);
    })));
  elements["recallword-empty"].hidden = words.length > 0;
}

function renderAdminRooms() {
  const rooms = draft.rooms || [];
  const select = elements["admin-room"];
  const current = select.value;
  select.replaceChildren(new Option("选择房间…", ""));
  for (const room of rooms) {
    select.add(new Option(`${room.name} · ${room.roomId}`, room.roomId));
  }
  if (current && rooms.some((room) => room.roomId === current)) select.value = current;
  select.disabled = rooms.length === 0;
  elements["admin-uid"].disabled = rooms.length === 0;
  elements["admin-add"].disabled = rooms.length === 0;
  renderAdmins();
}

function renderAdmins() {
  const rooms = draft.rooms || [];
  const admins = draft.admins || {};
  const list = elements["admin-list"];
  const rows = [];
  for (const room of rooms) {
    const uids = (admins[room.roomId] || []).filter((uid) => Number.isSafeInteger(Number(uid)));
    if (!uids.length) continue;
    const group = document.createElement("li");
    group.className = "admin-group";
    const label = document.createElement("span");
    label.className = "admin-room-label";
    label.textContent = room.name;
    group.append(label);
    for (const uid of uids) {
      const item = document.createElement("span");
      item.className = "pill admin-pill";
      const text = document.createElement("span");
      text.textContent = `UID:${uid}`;
      item.append(text);
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.setAttribute("aria-label", `移除管理员 ${uid}`);
      del.addEventListener("click", () => {
        draft.admins = { ...(draft.admins || {}) };
        draft.admins[room.roomId] = (draft.admins[room.roomId] || []).filter((entry) => entry !== uid);
        if (!draft.admins[room.roomId].length) delete draft.admins[room.roomId];
        renderAdmins();
        notify(`已移除房间「${room.name}」的管理员 UID:${uid}`);
      });
      item.append(del);
      group.append(item);
    }
    rows.push(group);
  }
  list.replaceChildren(...rows);
  elements["admin-empty"].hidden = rows.length > 0;
}

function renderSubscriptions() {
  const known = new Map((draft.rooms || []).map((room) => [String(room.roomId), room.name]));
  loadSubscriptions().then((data) => {
    const rows = [];
    for (const [type, entries] of Object.entries(data)) {
      for (const [roomId, enabled] of Object.entries(entries)) {
        if (!enabled) continue;
        const name = known.get(String(roomId)) || roomId;
        rows.push(pill(`${name} · ${type === "live" ? "直播" : "动态"}`));
      }
    }
    elements["subscription-list"].replaceChildren(...rows);
    elements["subscription-empty"].hidden = rows.length > 0;
  });
}

async function refreshPreview() {
  const list = await loadMarkLog();
  elements["violation-preview"].hidden = list.length === 0;
  if (list.length) {
    elements["violation-preview"].textContent = list
      .slice(-30)
      .map((entry) => `[${entry.time}] 房间 ${entry.room} · ${entry.name}(${entry.uid}) · ${(entry.words || []).join("、")}`)
      .join("\n");
  }
}

async function save() {
  const uid = elements["bili-uid"].value.trim();
  if (uid && !/^\d{1,15}$/.test(uid)) return notify("B站 UID 必须是数字", true);
  draft.botName = elements["bot-name"].value.trim();
  draft.botBduss = elements["bot-bduss"].value.trim();
  draft.biliUid = uid;
  draft.warnText = elements["warn-text"].value.trim();
  try {
    await saveSettings(draft);
    notify("设置已保存");
  } catch (error) {
    notify(`保存失败：${error.message}`, true);
  }
}

function download(name, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

elements["bot-enabled"].addEventListener("change", async () => {
  const value = elements["bot-enabled"].checked;
  try {
    await saveEnabled(value);
    notify(value ? "机器人已启用" : "机器人已停用");
  } catch (error) {
    elements["bot-enabled"].checked = !value;
    notify(`开关保存失败：${error.message}`, true);
  }
});

elements.save.addEventListener("click", save);
elements["badword-add"].addEventListener("click", () => {
  const word = elements["badword-input"].value.trim();
  if (!word) return;
  if ((draft.badwords || []).includes(word)) return notify(`关键词「${word}」已存在`, true);
  draft.badwords = [...(draft.badwords || []), word];
  elements["badword-input"].value = "";
  renderBadwords();
});
elements["badword-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); elements["badword-add"].click(); }
});
elements["recallword-add"].addEventListener("click", () => {
  const word = elements["recallword-input"].value.trim();
  if (!word) return;
  if ((draft.recallWords || []).includes(word)) return notify(`撤回关键词「${word}」已存在`, true);
  draft.recallWords = [...(draft.recallWords || []), word];
  elements["recallword-input"].value = "";
  renderRecallWords();
});
elements["recallword-input"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); elements["recallword-add"].click(); }
});
elements["admin-room"].addEventListener("change", renderAdmins);
elements["admin-add"].addEventListener("click", () => {
  const roomId = elements["admin-room"].value;
  const uidRaw = elements["admin-uid"].value.trim();
  if (!roomId) return notify("请先选择房间", true);
  if (!/^\d{1,20}$/.test(uidRaw)) return notify("UID 必须是数字", true);
  const uid = Number(uidRaw);
  if (!Number.isSafeInteger(uid)) return notify("UID 数值超出范围", true);
  draft.admins = { ...(draft.admins || {}) };
  const list = draft.admins[roomId] || [];
  if (list.includes(uid)) return notify(`该房间已存在管理员 UID:${uid}`, true);
  draft.admins[roomId] = [...list, uid];
  elements["admin-uid"].value = "";
  renderAdmins();
  notify(`已添加管理员 UID:${uid}`);
});
elements["admin-uid"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); elements["admin-add"].click(); }
});
elements["violation-export"].addEventListener("click", async () => {
  const content = await exportViolations();
  if (!content.trim()) return notify("暂无违规记录", true);
  const stamp = new Date().toISOString().slice(0, 10);
  download(`标记-${stamp}.log`, content);
});
elements["violation-clear"].addEventListener("click", async () => {
  if (!window.confirm("确定要清空全部违规记录吗？此操作不可撤销。")) return;
  await clearMarkLog();
  await refreshPreview();
  notify("违规记录已清空");
});

async function initialize() {
  draft = await loadSettings();
  elements["bot-enabled"].checked = await loadEnabled();
  elements["bot-name"].value = draft.botName || "";
  elements["bot-name"].placeholder = "与贴吧显示名一致";
  elements["bot-bduss"].value = draft.botBduss || "";
  elements["bili-uid"].value = draft.biliUid ? String(draft.biliUid) : "";
  elements["warn-text"].value = draft.warnText || "";
  renderRooms();
  renderBadwords();
  renderRecallWords();
  renderAdminRooms();
  renderSubscriptions();
  await refreshPreview();
}

initialize().catch((error) => notify(`设置加载失败：${error.message}`, true));

// 侧边栏「添加到机器人」等操作更新了配置时，设置页实时刷新房间列表
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.botSettings || !draft) return;
  loadSettings().then((fresh) => {
    draft = fresh;
    renderRooms();
    renderAdminRooms();
    renderSubscriptions();
  }).catch(() => {});
});
