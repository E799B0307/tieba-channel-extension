import { BUILD } from "./runtime-info.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const labels = { pending: "结果未知，请人工核对", accepted: "请求受理，等待确认", confirmed: "已确认撤回", forbidden: "无撤回权限", failed: "请求失败或结果未知", cancelled: "配置变更，已取消" };
let current;
let ready = false;

async function api(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...fields });
  if (!result?.ok) throw new Error(result?.error || "操作失败");
  if (result.build !== BUILD) throw new Error("扩展后台版本不一致，请重新加载插件");
  return result.data;
}

function notice(text, bad = false) {
  elements.notice.hidden = false;
  elements.notice.textContent = text;
  elements.notice.classList.toggle("error", bad);
}

function render(data, form = false) {
  current = data;
  elements.status.textContent = data.settings.enabled ? data.status : "已停用";
  elements.stop.disabled = !data.settings.enabled;
  elements.token.placeholder = data.hasToken ? "已保存，留空保持原凭据" : "尚未配置";
  if (form) {
    elements.enabled.checked = data.settings.enabled;
    elements.words.value = data.settings.recallWords.join("\n");
    elements.token.value = "";
    elements["clear-token"].checked = false;
    elements["saved-state"].textContent = "已保存";
  }
  elements.rooms.replaceChildren(...data.settings.rooms.map((room) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${room.name} · ${room.roomId}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.title = `移除 ${room.name}`;
    remove.setAttribute("aria-label", remove.title);
    const icon = document.createElement("img");
    icon.src = "icons/x.svg";
    icon.alt = "";
    remove.append(icon);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try { render(await api("bot-remove-room", { room: room.roomId })); notice("频道已移除"); }
      catch (error) { notice(error.message, true); remove.disabled = false; }
    });
    row.append(name, remove);
    return row;
  }));
  elements["rooms-empty"].hidden = data.settings.rooms.length > 0;
  elements.records.replaceChildren(...data.records.map((entry) => {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    time.textContent = new Date(entry.at).toLocaleString("zh-CN", { hour12: false });
    const room = document.createElement("span");
    room.textContent = entry.name || entry.room;
    time.append(room);
    const message = document.createElement("td");
    message.textContent = entry.id;
    const words = document.createElement("span");
    words.textContent = entry.words.join("、");
    message.append(words);
    const status = document.createElement("td");
    status.textContent = labels[entry.status] || labels.pending;
    status.className = Object.hasOwn(labels, entry.status) ? entry.status : "pending";
    row.append(time, message, status);
    return row;
  }));
  elements["records-empty"].hidden = data.records.length > 0;
}

elements["settings-form"].addEventListener("input", () => { elements["saved-state"].textContent = "有未保存的修改"; });
elements["settings-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!ready) return;
  elements.save.disabled = true;
  const settings = { enabled: elements.enabled.checked, recallWords: elements.words.value.split(/\r?\n/).map((word) => word.trim()).filter(Boolean) };
  if (elements["clear-token"].checked) settings.botBduss = "";
  else if (elements.token.value.trim()) settings.botBduss = elements.token.value.trim();
  try { render(await api("bot-save", { settings }), true); notice("设置已保存"); }
  catch (error) { notice(error.message, true); elements["saved-state"].textContent = "保存失败"; }
  finally { elements.save.disabled = false; }
});
elements.stop.addEventListener("click", async () => {
  if (!ready || !current) return;
  elements.stop.disabled = true;
  try {
    render(await api("bot-save", { settings: { enabled: false, recallWords: current.settings.recallWords } }));
    elements.enabled.checked = false;
    notice("自动撤回已停用");
  } catch (error) { notice(error.message, true); elements.stop.disabled = false; }
});
elements.refresh.addEventListener("click", async () => {
  try { render(await api("bot-settings")); }
  catch (error) { notice(error.message, true); }
});
elements.version.textContent = BUILD;
api("bot-settings").then((data) => { render(data, true); ready = true; elements.save.disabled = false; })
  .catch((error) => notice(error.message, true));
