import { appendMessageContent, appendRichText, reactionElement } from "./message-view.js";
import { emoji } from "./emoji/map.js";
import { loadRemoteImage, cancelRemoteImage, clearRemoteImages } from "./media.js";
import { reactionChoices } from "./reactions.js";
import { imageUpload, isDisplayableMessage, canRecallMessage } from "./protocol.js";
import { BUILD, OPERATIONS } from "./runtime-info.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const messages = new Map();
const removed = new Set();
const drafts = new Map();
const confirmations = new Map();
const members = new Map();       // name -> { authorId, portrait, name }
const pendingAts = [];           // 本次待 @ 的成员 [{authorId, name, portrait}]
let account = null;
let forum = null;
let room = null;
let version = 0;
let busy = false;
let sending = false;
let pollingError = false;
let reactionError = false;
let pollRequest = null;
let lastId = "0";
let replyTarget = null;
let refreshTimer = 0;
let toastTimer = 0;
let scrollFrame = 0;
let followBottom = true;
let lastScrollTop = 0;
let touchPosition = 0;
let pointerScrolling = false;
let compositionEnded = 0;
let reactionTarget = null;
let detailRequest = null;
let pendingImage = null;
let imageSelection = 0;
let imageReading = false;
let stickerRequest = 0;
let reactionGeneration = 0;
const reacting = new Set();
const recalls = new Map();
let runtimeReady = false;

function requireReload(backgroundBuild = "旧版") {
  runtimeReady = false;
  elements["runtime-warning"].hidden = false;
  elements["runtime-message"].textContent = `侧栏 ${BUILD}，后台 ${backgroundBuild}。需重新加载插件才能发送和操作消息。`;
  elements["runtime-version"].textContent = `${BUILD} · 等待更新后台`;
}

async function checkRuntime() {
  elements["runtime-version"].textContent = BUILD;
  let result;
  try { result = await chrome.runtime.sendMessage({ type: "runtime-info" }); }
  catch { requireReload("未连接"); return; }
  const info = result?.data;
  runtimeReady = result?.ok && info?.build === BUILD && OPERATIONS.every((operation) => info.operations?.includes(operation));
  elements["runtime-warning"].hidden = !!runtimeReady;
  if (!runtimeReady) requireReload(info?.build);
}

async function api(type, fields = {}) {
  if (OPERATIONS.includes(type) && !runtimeReady) throw new Error("后台尚未更新，请点击上方“重新加载插件”");
  const result = await chrome.runtime.sendMessage({ type, accountId: account?.id, ...fields });
  if (result?.build && result.build !== BUILD) requireReload(result.build);
  if (!result?.ok) throw Object.assign(new Error(result?.error || "插件连接中断，请重新连接"), { code: result?.code });
  return result.data;
}

function resizeInput() {
  elements.text.style.height = "auto";
  elements.text.style.height = `${Math.max(36, Math.min(elements.text.scrollHeight, 96))}px`;
}

function controls() {
  for (const identifier of ["find", "reconnect", "forum"]) elements[identifier].disabled = busy || sending;
  elements.rooms.disabled = busy || sending || !forum?.rooms.length;
  elements.text.disabled = !room || busy || sending;
  elements["emoji-toggle"].disabled = elements.text.disabled;
  elements["at-toggle"].disabled = elements.text.disabled;
  elements["image-toggle"].disabled = elements.text.disabled || imageReading || !runtimeReady;
  elements["sticker-upload"].disabled = elements["image-toggle"].disabled;
  elements["image-cancel"].disabled = sending;
  elements["send-diagnostics"].disabled = !room || busy || sending || !runtimeReady;
  elements["bot-add-room"].disabled = !room || busy || sending || !runtimeReady || forum?.name !== "嘉然";
  if (elements.text.disabled) { toggleEmoji(false); toggleAt(false); toggleStickers(false); }
  elements.send.disabled = !room || busy || sending || imageReading || !runtimeReady || (!pendingImage && !elements.text.value.trim());
  elements.send.textContent = sending ? "发送中…" : "发送";
  elements.text.placeholder = room ? `发消息到「${room.name}」` : "进入频道后开始聊天…";
  for (const button of elements["message-list"].querySelectorAll(".message-action")) {
    const id = button.closest(".message").dataset.messageId;
    button.disabled = busy || sending || !runtimeReady || reacting.has(id) || recalls.has(id)
      || (!button.classList.contains("reaction-trigger") && !messages.get(id)?.key);
  }
  for (const button of elements["message-list"].querySelectorAll(".reaction button")) {
    button.disabled = busy || sending || !runtimeReady || reacting.has(button.closest(".message").dataset.messageId);
  }
  elements.text.disabled ||= !!pendingImage || imageReading;
}

function closeReactions() {
  reactionTarget = null;
  detailRequest = null;
  elements["reaction-picker"].hidden = true;
  elements["reaction-detail"].hidden = true;
}

function chooseReaction(message) {
  if (!room || busy || sending || removed.has(message.id)) return;
  closeReactions();
  toggleEmoji(false);
  toggleAt(false);
  toggleStickers(false);
  reactionTarget = message.id;
  elements["reaction-picker"].hidden = false;
  elements["reaction-search"].value = "";
  renderReactionChoices();
  elements["reaction-search"].focus();
}

function renderReactionChoices() {
  const message = messages.get(reactionTarget);
  const choices = new Map(reactionChoices.map((choice) => [choice.image, choice]));
  for (const reaction of message?.reactions || []) {
    if (!choices.has(reaction.image)) choices.set(reaction.image, { name: "频道表情", image: reaction.image });
  }
  const query = elements["reaction-search"].value.trim();
  const buttons = [...choices.values()].filter((choice) => choice.name.includes(query)).map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-choice";
    button.title = choice.name;
    button.setAttribute("aria-label", `贴表情：${choice.name}`);
    const image = document.createElement("img");
    image.alt = "";
    button.append(image);
    if (choice.filename) image.src = new URL(`./emoji/${choice.filename}`, import.meta.url).href;
    else loadRemoteImage(image, choice.image);
    button.addEventListener("click", () => {
      const id = reactionTarget;
      closeReactions();
      applyReaction(id, choice.image, true);
    });
    return button;
  });
  elements["reaction-list"].replaceChildren(...buttons);
}

async function applyReaction(id, image, add) {
  if (!room || busy || sending || reacting.has(id) || removed.has(id)) return;
  const currentVersion = version;
  const destination = room.room;
  reacting.add(id);
  controls();
  try {
    const result = await api("react", { room: destination, id, image, add });
    if (currentVersion !== version || result.room !== room?.room) return;
    reactionGeneration = Math.max(reactionGeneration, result.reactionGeneration || 0);
    render([], [{ id, reactions: result.reactions }]);
    if (!result.confirmed) showError(new Error("贴表情请求已提交，尚未确认结果，请稍后查看"));
    refreshSoon();
  } catch (error) { if (currentVersion === version) showError(error); }
  finally { if (currentVersion === version) { reacting.delete(id); controls(); } }
}

async function showReactionUsers(id, reaction) {
  if (!room || removed.has(id)) return;
  closeReactions();
  toggleEmoji(false);
  toggleAt(false);
  toggleStickers(false);
  detailRequest = { id, image: reaction.image, room: room.room, version, after: 1, users: new Map(), loading: false };
  elements["reaction-detail"].hidden = false;
  elements["reaction-users"].replaceChildren();
  elements["detail-close"].focus();
  await loadReactionUsers();
}

async function loadReactionUsers() {
  const request = detailRequest;
  if (!request || request.loading) return;
  request.loading = true;
  elements["detail-more"].hidden = true;
  elements["detail-status"].textContent = "正在加载…";
  try {
    const result = await api("reaction-detail", { room: request.room, id: request.id, image: request.image, after: request.after });
    if (request !== detailRequest || request.version !== version) return;
    let next = request.after;
    for (const user of result.users) {
      request.users.set(user.id, user);
      next = Math.max(next, user.after + 1);
    }
    const rows = [...request.users.values()].map((user) => {
      const row = document.createElement("div");
      row.className = "reaction-user";
      if (user.avatar) {
        const avatar = document.createElement("img");
        avatar.className = "avatar";
        avatar.alt = "";
        row.append(avatar);
        loadRemoteImage(avatar, user.avatar);
      }
      const name = document.createElement("span");
      name.textContent = user.name;
      if (user.name === "贴吧用户") {
        const id = document.createElement("small");
        id.textContent = user.id;
        name.append(id);
      }
      row.append(name);
      return row;
    });
    elements["reaction-users"].replaceChildren(...rows);
    const more = result.hasMore && next > request.after;
    elements["detail-more"].hidden = !more;
    elements["detail-more"].textContent = "加载更多";
    elements["detail-status"].textContent = rows.length ? `已加载 ${rows.length} 人` : "暂无贴表情记录";
    request.after = next;
  } catch (error) {
    if (request === detailRequest && request.version === version) {
      elements["detail-status"].textContent = error.message;
      elements["detail-more"].textContent = "重试";
      elements["detail-more"].hidden = false;
      if (error.code === "ACCOUNT_CHANGED") showError(error);
    }
  } finally { request.loading = false; }
}

function toggleStickers(open) {
  elements["sticker-picker"].hidden = !open;
  elements["image-toggle"].setAttribute("aria-expanded", String(open));
  if (open) {
    closeReactions();
    toggleEmoji(false);
    toggleAt(false);
    loadStickers();
    elements["sticker-close"].focus();
  } else {
    stickerRequest += 1;
    for (const image of elements["sticker-list"].querySelectorAll("img")) cancelRemoteImage(image);
    elements["sticker-list"].replaceChildren();
  }
}

async function loadStickers(refresh = false) {
  if (!room || busy || sending || !runtimeReady) return;
  const request = ++stickerRequest;
  const currentVersion = version;
  for (const image of elements["sticker-list"].querySelectorAll("img")) cancelRemoteImage(image);
  elements["sticker-list"].replaceChildren();
  elements["sticker-status"].textContent = "正在同步收藏表情…";
  elements["sticker-refresh"].disabled = true;
  elements["sticker-retry"].hidden = true;
  elements["sticker-list"].setAttribute("aria-busy", "true");
  try {
    const result = await api("favorite-stickers", { refresh });
    if (request !== stickerRequest || currentVersion !== version) return;
    const buttons = result.stickers.map((sticker, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sticker-choice";
      button.title = `收藏表情 ${index + 1}`;
      button.setAttribute("aria-label", `选择收藏表情 ${index + 1}`);
      const image = document.createElement("img");
      image.alt = `收藏表情 ${index + 1}`;
      button.append(image);
      button.addEventListener("click", () => {
        if (!room || busy || sending || imageReading) return;
        clearImage();
        toggleStickers(false);
        pendingImage = { favoriteId: sticker.id };
        elements["image-name"].textContent = `收藏表情 ${index + 1}`;
        elements["image-preview"].hidden = false;
        loadRemoteImage(elements["preview-image"], sticker.url);
        controls();
        elements.send.focus();
      });
      loadRemoteImage(image, sticker.thumbnail);
      return button;
    });
    elements["sticker-list"].replaceChildren(...buttons);
    elements["sticker-status"].textContent = result.unavailable
      ? `${buttons.length} 个表情，${result.unavailable} 个暂不可用`
      : buttons.length ? `${buttons.length} 个表情` : "暂无收藏表情";
  } catch (error) {
    if (request !== stickerRequest || currentVersion !== version) return;
    elements["sticker-status"].textContent = error.message;
    elements["sticker-retry"].hidden = false;
    if (error.code === "ACCOUNT_CHANGED") showError(error);
  } finally {
    if (request === stickerRequest && currentVersion === version) {
      elements["sticker-refresh"].disabled = false;
      elements["sticker-list"].setAttribute("aria-busy", "false");
    }
  }
}

function clearImage() {
  imageSelection += 1;
  imageReading = false;
  cancelRemoteImage(elements["preview-image"]);
  if (pendingImage?.url) URL.revokeObjectURL(pendingImage.url);
  pendingImage = null;
  elements["preview-image"].removeAttribute("src");
  elements["image-preview"].hidden = true;
  elements["image-file"].value = "";
}

async function selectImage(file) {
  if (!file || !room || busy || sending) return;
  if (!file.size || file.size > 8 * 1024 * 1024) { showError(new Error("请选择 8 MiB 以内的图片")); return; }
  toggleStickers(false);
  clearImage();
  const selection = imageSelection;
  const currentVersion = version;
  imageReading = true;
  controls();
  let url = "";
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    const data = btoa(binary);
    const checked = imageUpload({ data, width: 1, height: 1 });
    url = URL.createObjectURL(new Blob([bytes], { type: checked.type }));
    const preview = new Image();
    preview.src = url;
    await preview.decode();
    const upload = { data, width: preview.naturalWidth, height: preview.naturalHeight };
    imageUpload(upload);
    if (selection !== imageSelection || currentVersion !== version) { URL.revokeObjectURL(url); return; }
    pendingImage = { url, upload };
    elements["preview-image"].src = url;
    elements["image-name"].textContent = file.name || "剪贴板图片";
    elements["image-preview"].hidden = false;
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    if (selection === imageSelection && currentVersion === version) showError(new Error(error.message || "图片无法读取"));
  } finally {
    if (selection === imageSelection && currentVersion === version) { imageReading = false; controls(); }
  }
}

function toggleAt(open) {
  if (open) { closeReactions(); toggleEmoji(false); toggleStickers(false); }
  elements["at-picker"].hidden = !open;
  elements["at-toggle"].setAttribute("aria-expanded", String(open));
  if (open) {
    elements["at-search"].value = "";
    renderAt();
    elements["at-search"].focus();
  }
}

function renderAt() {
  const query = elements["at-search"].value.trim();
  const choices = [...members.values()]
    .filter((m) => !query || m.name.toLowerCase().includes(query.toLowerCase()))
    .map((m) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "at-choice";
      button.title = m.name;
      button.setAttribute("aria-label", m.name);
      const avatar = document.createElement("img");
      avatar.className = "at-avatar";
      avatar.alt = "";
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      avatar.addEventListener("error", () => avatar.remove(), { once: true });
      if (m.portrait) loadRemoteImage(avatar, `https://himg.bdimg.com/sys/portrait/item/${m.portrait}`);
      const name = document.createElement("span");
      name.className = "at-name";
      name.textContent = m.name;
      const id = document.createElement("span");
      id.className = "at-id";
      id.textContent = `ID:${m.authorId}`;
      button.append(avatar, name, id);
      button.addEventListener("click", () => selectAt(m));
      return button;
    });
  elements["at-list"].replaceChildren(...choices);
  elements["at-empty"].hidden = choices.length > 0;
}

function selectAt(member) {
  // 在光标处插入 "@昵称 "（纯文本视觉提示），真正的 at 通过 at_data 在发送时带上
  const token = `@${member.name} `;
  elements.text.setRangeText(token, elements.text.selectionStart, elements.text.selectionEnd, "end");
  if (!pendingAts.some((a) => a.authorId === member.authorId)) {
    pendingAts.push({ authorId: member.authorId, name: member.name, portrait: member.portrait || "" });
  }
  toggleAt(false);
  resizeInput();
  controls();
  elements.text.focus();
}

function toggleEmoji(open) {
  if (open) { closeReactions(); toggleAt(false); toggleStickers(false); }
  elements["emoji-picker"].hidden = !open;
  elements["emoji-toggle"].setAttribute("aria-expanded", String(open));
  if (open) {
    elements["emoji-search"].value = "";
    renderEmoji();
    elements["emoji-search"].focus();
  }
}

function renderEmoji() {
  const query = elements["emoji-search"].value.trim();
  const choices = Object.entries(emoji).filter(([name]) => name.includes(query)).map(([name, filename]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "emoji-choice";
    button.title = name;
    button.setAttribute("aria-label", name);
    const image = document.createElement("img");
    image.src = new URL(`./emoji/${filename}`, import.meta.url).href;
    image.alt = "";
    button.append(image);
    button.addEventListener("click", () => {
      if (elements.text.disabled) return;
      const token = `#(${name})`;
      if (elements.text.value.length - (elements.text.selectionEnd - elements.text.selectionStart) + token.length > elements.text.maxLength) {
        showError(new Error("消息最多 2000 字，请删减后再插入表情"));
        return;
      }
      elements.text.setRangeText(token, elements.text.selectionStart, elements.text.selectionEnd, "end");
      toggleEmoji(false);
      resizeInput();
      controls();
      elements.text.focus();
    });
    return button;
  });
  elements["emoji-list"].replaceChildren(...choices);
  elements["emoji-empty"].hidden = choices.length > 0;
}

function clearError() {
  clearTimeout(toastTimer);
  elements.notice.hidden = true;
  elements.notice.textContent = "";
}

function showNotice(message) {
  clearError();
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  elements.notice.style.background = "#1a7f42";
  toastTimer = setTimeout(clearError, 3500);
}

function showError(error) {
  clearError();
  elements.notice.textContent = error.message;
  elements.notice.hidden = false;
  elements.notice.style.background = "";
  toastTimer = setTimeout(clearError, 3500);
  if (error.code === "ACCOUNT_CHANGED") {
    resetRoom();
    drafts.clear();
    account = null;
    forum = null;
    elements.forum.value = "";
    elements.rooms.replaceChildren(new Option("请重新连接后选择频道", ""));
    elements.account.textContent = "请登录贴吧并重新连接";
    elements.reconnect.title = elements.account.textContent;
    elements.status.textContent = "等待重新连接";
  }
  controls();
}

function clearReply() {
  replyTarget = null;
  elements["reply-bar"].hidden = true;
  elements["reply-name"].textContent = "";
  elements["reply-text"].textContent = "";
}

function selectReply(message) {
  if (!message?.key || busy || sending || removed.has(message.id)) return;
  replyTarget = message;
  elements["reply-name"].textContent = message.name;
  elements["reply-text"].textContent = (message.text || (message.image ? "[图片]" : message.post?.title || "[消息]")).slice(0, 80);
  elements["reply-bar"].hidden = false;
  elements.text.focus();
}

async function promptRecall(message) {
  if (!room || busy || sending || recalls.has(message.id) || removed.has(message.id)
    || !canRecallMessage(room, message)) return;
  const preview = (message.text || "[图片/消息]").slice(0, 40);
  const action = message.authorId === room.authorId ? "撤回自己发送的这条消息？"
    : `以频道管理身份撤回「${message.name}」的这条消息？`;
  if (!window.confirm(`${action}\n\n${preview}`)) return;
  const currentVersion = version;
  const destination = room.room;
  recalls.set(message.id, 0);
  controls();
  try {
    await api("recall", { room: destination, id: message.id });
    if (currentVersion !== version) return;
    if (!removed.has(message.id)) {
      showNotice("撤回请求已提交，等待频道确认");
      recalls.set(message.id, setTimeout(() => {
        if (currentVersion !== version) return;
        recalls.delete(message.id);
        if (!removed.has(message.id)) showError(new Error("尚未收到撤回确认，请在手机端核对；不会自动重试"));
        controls();
      }, 8000));
    }
    refreshSoon();
  } catch (error) {
    if (currentVersion === version) {
      recalls.delete(message.id);
      showError(error);
    }
  } finally { if (currentVersion === version) controls(); }
}

function resetRoom() {
  if (room && account) drafts.set(`${account.id}:${room.room}`, elements.text.value);
  version += 1;
  clearTimeout(refreshTimer);
  for (const timer of confirmations.values()) clearTimeout(timer);
  confirmations.clear();
  for (const timer of recalls.values()) clearTimeout(timer);
  recalls.clear();
  reacting.clear();
  reactionGeneration = 0;
  closeReactions();
  clearImage();
  toggleStickers(false);
  pollRequest = null;
  room = null;
  lastId = "0";
  pollingError = false;
  reactionError = false;
  followBottom = true;
  lastScrollTop = 0;
  messages.clear();
  removed.clear();
  members.clear();
  pendingAts.length = 0;
  clearRemoteImages();
  elements["message-list"].replaceChildren();
  elements.text.value = "";
  clearReply();
  resizeInput();
  elements.empty.hidden = false;
  elements.latest.hidden = true;
  elements["room-title"].textContent = "一起聊聊吧";
  elements.status.textContent = "尚未进入频道";
  controls();
}

async function initialize() {
  busy = true;
  resetRoom();
  clearError();
  const currentVersion = version;
  try {
    await checkRuntime();
    if (currentVersion !== version) return;
    const data = await api("initialize");
    if (currentVersion !== version) return;
    if (account && account.id !== data.account.id) drafts.clear();
    account = data.account;
    elements.account.textContent = `已登录 · ${account.name}`;
    elements.reconnect.title = elements.account.textContent;
    elements.forum.value = data.context.name || elements.forum.value || data.lastForum;
    if (elements.forum.value) await findRooms();
  } catch (error) {
    if (currentVersion === version) showError(error);
  } finally {
    busy = false;
    controls();
  }
}

async function findRooms() {
  busy = true;
  resetRoom();
  clearError();
  const currentVersion = version;
  forum = null;
  elements.rooms.replaceChildren(new Option("正在查找频道…", ""));
  try {
    if (!account) throw new Error("请先登录贴吧并点击「重新连接」");
    const data = await api("rooms", { forum: elements.forum.value });
    if (currentVersion !== version) return;
    forum = data;
    elements.rooms.replaceChildren(new Option(data.rooms.length ? "选择一个频道…" : "这个吧暂时没有可用频道", ""));
    for (const channel of data.rooms) elements.rooms.add(new Option(channel.name, channel.id));
  } catch (error) {
    if (currentVersion === version) {
      elements.rooms.replaceChildren(new Option("未能加载频道", ""));
      showError(error);
    }
  } finally {
    busy = false;
    controls();
  }
}

async function enterRoom(roomId, fid) {
  busy = true;
  resetRoom();
  clearError();
  const currentVersion = version;
  elements.status.textContent = "正在进入…";
  try {
    if (!account) throw new Error("请先登录贴吧并点击「重新连接」");
    const data = await api("enter", { room: roomId, fid });
    if (currentVersion !== version) return;
    room = data;
    elements["room-title"].textContent = data.name;
    elements["room-title"].title = `频道 ID：${data.room}`;
    elements.text.value = drafts.get(`${account.id}:${room.room}`) || "";
    resizeInput();
    elements.rooms.value = data.room;
    await poll();
    if (currentVersion === version && data.permissionError) showError(new Error("未能读取频道管理权限，请重新选择频道后再使用管理撤回"));
  } catch (error) {
    if (currentVersion === version) { elements.status.textContent = "进入失败"; showError(error); }
  } finally {
    busy = false;
    controls();
  }
}

function messageElement(message) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.messageId = message.id;

  // 系统事件消息（撤回通知等）：无正文、无头像、发送者为系统/空
  // 渲染为居中的灰色系统气泡，不显示回复/删除按钮
  const isSystem = message.system && !message.image && !message.post;
  if (isSystem) {
    article.classList.add("system");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text || message.reply || "";
    article.append(bubble);
    return article;
  }

  if (message.authorId && message.authorId === room.authorId) article.classList.add("self");
  const meta = document.createElement("div");
  meta.className = "meta";
  const author = document.createElement("strong");
  author.textContent = message.name;
  author.title = message.name;
  const time = document.createElement("time");
  const date = new Date(message.time * 1000);
  if (Number.isFinite(date.getTime())) {
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    time.title = date.toLocaleString("zh-CN");
  }
  if (message.avatar) {
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.alt = "";
    avatar.loading = "lazy";
    avatar.referrerPolicy = "no-referrer";
    avatar.addEventListener("error", () => avatar.remove(), { once: true });
    meta.append(avatar);
    loadRemoteImage(avatar, message.avatar);
  }
  meta.append(author);
  if (message.level != null) {
    const level = document.createElement("span");
    level.className = "level";
    level.textContent = `Lv.${message.level}`;
    level.title = `本吧等级 ${message.level}`;
    meta.append(level);
  }
  if (message.vip) {
    const vip = document.createElement("span");
    vip.className = "vip";
    vip.textContent = "会员";
    meta.append(vip);
  }
  meta.append(time);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  article.append(meta, bubble);
  if (removed.has(message.id)) {
    article.classList.add("removed");
    bubble.textContent = "该消息已被删除或撤回";
  } else {
    if (message.authorId || message.from && message.from !== "0") {
      const reply = document.createElement("button");
      reply.type = "button";
      reply.className = "message-action";
      reply.textContent = "↩ 回复";
      reply.title = message.key ? "引用这条消息" : "这条历史消息缺少回复标识";
      reply.disabled = busy || sending || !message.key;
      reply.addEventListener("click", () => selectReply(messages.get(message.id)));
      meta.append(reply);
      const react = document.createElement("button");
      react.type = "button";
      react.className = "message-action reaction-trigger";
      const reactIcon = document.createElement("img");
      reactIcon.src = "icons/smile-plus.svg";
      reactIcon.alt = "";
      react.append(reactIcon);
      react.title = "给这条消息贴表情";
      react.setAttribute("aria-label", "给这条消息贴表情");
      react.addEventListener("click", () => chooseReaction(messages.get(message.id)));
      meta.append(react);
    }
    if (canRecallMessage(room, message)) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "message-action";
      const recallIcon = document.createElement("img");
      recallIcon.src = "icons/undo-2.svg";
      recallIcon.alt = "";
      del.append(recallIcon);
      del.title = message.authorId === room.authorId ? "撤回自己发送的消息" : "以频道管理身份撤回此消息";
      del.setAttribute("aria-label", del.title);
      del.disabled = busy || sending;
      del.addEventListener("click", () => promptRecall(message));
      meta.append(del);
    }
    if (message.reply) {
      const quote = document.createElement("blockquote");
      appendRichText(quote, message.reply);
      bubble.append(quote);
    }
    appendMessageContent(bubble, message);
    const reactions = reactionsFor(message.id, message.reactions);
    if (reactions) article.append(reactions);
  }
  return article;
}

function reactionsFor(id, reactions) {
  return reactionElement(reactions,
    (reaction) => applyReaction(id, reaction.image, !reaction.reacted),
    (reaction) => showReactionUsers(id, reaction));
}

function updateReactions(article, reactions) {
  if (article.classList.contains("removed")) return;
  const old = article.querySelector(".reactions");
  if (old?.dataset.signature === JSON.stringify(reactions || [])) return;
  const fresh = reactionsFor(article.dataset.messageId, reactions);
  if (old && fresh) old.replaceWith(fresh);
  else if (old) old.remove();
  else if (fresh) article.append(fresh);
}

function render(incoming, reactionUpdates = []) {
  const list = elements["message-list"];
  const viewportTop = elements.messages.getBoundingClientRect().top;
  const anchor = followBottom ? null : [...list.children].find((element) => element.getBoundingClientRect().bottom > viewportTop);
  const anchorOffset = anchor?.getBoundingClientRect().top;
  const existing = new Map([...list.children].map((element) => [element.dataset.messageId, element]));
  for (const message of incoming) {
    for (const identifier of message.deleted || []) removed.add(identifier);
    if (!/^\d+$/.test(message.id)) continue;
    if (!isDisplayableMessage(message)) { messages.delete(message.id); continue; }
    if (!messages.has(message.id)) messages.set(message.id, message);
    else if (message.key) messages.get(message.id).key = message.key;
    // 收集成员：可 @ 已发言的用户（authorId = baidu_uk，portrait 用于构造 at_data）
    if (message.authorId && message.name && message.authorId !== room?.authorId) {
      members.set(message.name, { authorId: message.authorId, name: message.name, portrait: message.portrait || "" });
    }
    if (confirmations.has(message.id)) {
      clearTimeout(confirmations.get(message.id));
      confirmations.delete(message.id);
    }
  }
  for (const id of removed) {
    clearTimeout(recalls.get(id));
    recalls.delete(id);
    if (detailRequest?.id === id || reactionTarget === id) closeReactions();
  }
  for (const update of reactionUpdates) {
    const message = messages.get(update.id);
    if (message) message.reactions = update.reactions || [];
  }
  const ordered = [...messages.values()].sort((first, second) => BigInt(first.id) < BigInt(second.id) ? -1 : 1);
  while (ordered.length > 300) messages.delete(ordered.shift().id);
  for (const [identifier, element] of existing) if (!messages.has(identifier)) element.remove();
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index];
    let element = existing.get(message.id);
    if (!element || removed.has(message.id) && !element.classList.contains("removed")) {
      const replacement = messageElement(message);
      if (element) element.replaceWith(replacement);
      element = replacement;
    } else updateReactions(element, message.reactions);
    if (list.children[index] !== element) list.insertBefore(element, list.children[index] || null);
  }
  if (replyTarget && removed.has(replyTarget.id)) clearReply();
  controls();
  elements.empty.hidden = messages.size > 0;
  if (followBottom) scrollLatest();
  else {
    if (anchor?.isConnected) elements.messages.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    lastScrollTop = elements.messages.scrollTop;
    elements.latest.hidden = nearBottom();
  }
}

async function poll() {
  if (!room || pollRequest) return;
  const request = { version, room: room.room, again: false };
  pollRequest = request;
  try {
    const data = await api("messages", { room: request.room, after: lastId });
    if (request.version !== version || data.room !== room?.room) return;
    for (const id of data.deleted || []) removed.add(id);
    const freshReactions = (data.reactionGeneration || 0) >= reactionGeneration;
    reactionGeneration = Math.max(reactionGeneration, data.reactionGeneration || 0);
    render(data.messages, freshReactions ? data.reacts : []);
    for (const message of data.messages) {
      if (/^\d+$/.test(message.id) && BigInt(message.id) > BigInt(lastId)) lastId = message.id;
    }
    pollingError = false;
    elements.status.textContent = "";
    if (data.reactionError && !reactionError) showError(new Error("贴表情加载失败，稍后自动重试"));
    reactionError = !!data.reactionError;
  } catch (error) {
    if (request.version !== version) return;
    elements.status.textContent = "连接中断 · 正在重试";
    if (!pollingError || error.code === "ACCOUNT_CHANGED") showError(error);
    pollingError = true;
  } finally {
    if (pollRequest === request) {
      pollRequest = null;
      if (request.again) refreshSoon(0);
    }
  }
}

function refreshSoon(delay = 300) {
  clearTimeout(refreshTimer);
  const currentVersion = version;
  refreshTimer = setTimeout(() => {
    if (currentVersion !== version || !room) return;
    if (pollRequest) pollRequest.again = true;
    else poll();
  }, delay);
}

function nearBottom() {
  return elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 80;
}

function scrollLatest() {
  followBottom = true;
  elements.messages.scrollTop = elements.messages.scrollHeight;
  lastScrollTop = elements.messages.scrollTop;
  elements.latest.hidden = true;
}

function followLayout() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    if (followBottom) scrollLatest();
    else elements.latest.hidden = nearBottom();
  });
}

function watchConfirmation(identifier, currentVersion) {
  if (!identifier || messages.has(identifier)) return;
  const check = async () => {
    if (currentVersion !== version || !confirmations.has(identifier)) return;
    await poll();
    if (currentVersion !== version || !confirmations.has(identifier)) return;
    if (pollRequest || pollingError) {
      confirmations.set(identifier, setTimeout(check, 4000));
      return;
    }
    confirmations.delete(identifier);
    showError(new Error("收到发送回执，但未确认消息送达。请下载发送诊断，避免重复发送"));
  };
  clearTimeout(confirmations.get(identifier));
  confirmations.set(identifier, setTimeout(check, 30000));
}

async function sendMessage() {
  if (!room || busy || sending || imageReading || (!pendingImage && !elements.text.value.trim())) return;
  const currentVersion = version;
  const text = elements.text.value;
  const destination = room.room;
  const replyId = replyTarget?.id || "";
  const picture = pendingImage;
  // 本次待 @ 的成员转成 at_data（at_type:"user"）
  const atData = pendingAts.map((m, i) => ({
    at_type: "user",
    at_baidu_uk: String(m.authorId),
    at_name: String(m.name),
    at_portrait: String(m.portrait || ""),
    position: String(i),
  }));
  sending = true;
  resizeInput();
  clearError();
  scrollLatest();
  controls();
  try {
    const result = await api(picture?.favoriteId ? "send-sticker" : picture ? "send-image" : "send", {
      room: destination, text, replyId, atData, upload: picture?.upload, favoriteId: picture?.favoriteId,
    });
    if (currentVersion !== version) return;
    if (picture) clearImage();
    else {
      elements.text.value = "";
      drafts.delete(`${account.id}:${destination}`);
      pendingAts.length = 0;
    }
    clearReply();
    resizeInput();
    refreshSoon();
    watchConfirmation(result.id, currentVersion);
  } catch (error) {
    if (currentVersion === version) showError(error);
  } finally {
    sending = false;
    controls();
    if (currentVersion === version) elements.text.focus();
  }
}

elements["forum-form"].addEventListener("submit", (event) => { event.preventDefault(); if (!busy && !sending) findRooms(); });
elements.rooms.addEventListener("change", () => {
  if (elements.rooms.value) enterRoom(elements.rooms.value, forum.fid);
  else resetRoom();
});
elements.reconnect.addEventListener("click", initialize);
elements["bot-settings"].addEventListener("click", () => chrome.runtime.openOptionsPage().catch(showError));
elements["bot-add-room"].addEventListener("click", async () => {
  if (!room) return;
  elements["bot-add-room"].disabled = true;
  try {
    await api("bot-add-room", { room: room.room });
    await chrome.runtime.openOptionsPage();
  } catch (error) { showError(error); }
  finally { controls(); }
});
elements["send-diagnostics"].addEventListener("click", async () => {
  const currentVersion = version;
  try {
    const diagnostics = await api("send-diagnostics", { room: room.room });
    if (currentVersion !== version) return;
    const blob = new Blob([JSON.stringify({ build: BUILD, ...diagnostics }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tieba-send-diagnostics.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (currentVersion === version) showError(error);
  }
});
elements["reload-extension"].addEventListener("click", () => {
  if ((pendingImage || elements.text.value.trim()) && !window.confirm("重新加载会清空未发送的文字和图片，确定继续？")) return;
  elements["reload-extension"].disabled = true;
  try { chrome.runtime.reload(); }
  catch (error) { elements["reload-extension"].disabled = false; showError(error); }
});
elements["emoji-toggle"].addEventListener("click", () => toggleEmoji(elements["emoji-picker"].hidden));
elements["emoji-close"].addEventListener("click", () => { toggleEmoji(false); elements.text.focus(); });
elements["emoji-search"].addEventListener("input", renderEmoji);
elements["emoji-search"].addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
elements["image-toggle"].addEventListener("click", () => toggleStickers(elements["sticker-picker"].hidden));
elements["sticker-close"].addEventListener("click", () => { toggleStickers(false); elements["image-toggle"].focus(); });
elements["sticker-refresh"].addEventListener("click", () => loadStickers(true));
elements["sticker-retry"].addEventListener("click", () => loadStickers(true));
elements["sticker-upload"].addEventListener("click", () => { toggleStickers(false); elements["image-file"].click(); });
elements["image-file"].addEventListener("change", () => selectImage(elements["image-file"].files[0]));
elements["image-cancel"].addEventListener("click", () => { clearImage(); controls(); elements.text.focus(); });
elements.compose.addEventListener("paste", (event) => {
  const file = [...(event.clipboardData?.items || [])].find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
  if (file && !busy && !sending && room) { event.preventDefault(); selectImage(file); }
});
elements["reaction-close"].addEventListener("click", closeReactions);
elements["detail-close"].addEventListener("click", closeReactions);
elements["detail-more"].addEventListener("click", loadReactionUsers);
elements["reaction-search"].addEventListener("input", renderReactionChoices);
elements["reaction-search"].addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
elements["at-toggle"].addEventListener("click", () => toggleAt(elements["at-picker"].hidden));
elements["at-close"].addEventListener("click", () => { toggleAt(false); elements.text.focus(); });
elements["at-search"].addEventListener("input", renderAt);
elements["at-search"].addEventListener("keydown", (event) => { if (event.key === "Enter") event.preventDefault(); });
document.addEventListener("click", (event) => {
  if (!elements["emoji-picker"].contains(event.target) && !elements["emoji-toggle"].contains(event.target)) toggleEmoji(false);
  if (!elements["at-picker"].contains(event.target) && !elements["at-toggle"].contains(event.target)) toggleAt(false);
  if (!elements["sticker-picker"].contains(event.target) && !elements["image-toggle"].contains(event.target)) toggleStickers(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeReactions();
  if (event.key === "Escape" && !elements["emoji-picker"].hidden) {
    event.preventDefault();
    toggleEmoji(false);
    elements["emoji-toggle"].focus();
  }
  if (event.key === "Escape" && !elements["at-picker"].hidden) {
    event.preventDefault();
    toggleAt(false);
    elements["at-toggle"].focus();
  }
  if (event.key === "Escape" && !elements["sticker-picker"].hidden) {
    event.preventDefault();
    toggleStickers(false);
    elements["image-toggle"].focus();
  }
});
elements.compose.addEventListener("submit", (event) => { event.preventDefault(); sendMessage(); });
elements.text.addEventListener("input", () => { resizeInput(); controls(); });
elements.text.addEventListener("compositionend", () => { compositionEnded = Date.now(); });
elements.text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && Date.now() - compositionEnded >= 60) {
    event.preventDefault();
    sendMessage();
  }
});
elements["reply-cancel"].addEventListener("click", clearReply);
elements.latest.addEventListener("click", scrollLatest);
elements.messages.addEventListener("scroll", () => {
  const top = elements.messages.scrollTop;
  if (pointerScrolling && top < lastScrollTop - 1 || nearBottom()) followBottom = nearBottom();
  lastScrollTop = top;
  elements.latest.hidden = followBottom || nearBottom();
}, { passive: true });
elements.messages.addEventListener("pointerdown", () => { pointerScrolling = true; });
window.addEventListener("pointerup", () => { pointerScrolling = false; });
window.addEventListener("pointercancel", () => { pointerScrolling = false; });
elements.messages.addEventListener("wheel", (event) => { if (event.deltaY < 0) followBottom = false; }, { passive: true });
elements.messages.addEventListener("keydown", (event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) followBottom = false; });
elements.messages.addEventListener("touchstart", (event) => { touchPosition = event.touches[0]?.clientY || 0; }, { passive: true });
elements.messages.addEventListener("touchmove", (event) => {
  const position = event.touches[0]?.clientY || 0;
  if (position > touchPosition) followBottom = false;
  touchPosition = position;
}, { passive: true });
elements.messages.addEventListener("load", followLayout, true);
elements.messages.addEventListener("error", followLayout, true);
const layoutObserver = new ResizeObserver(followLayout);
layoutObserver.observe(elements["message-list"]);
layoutObserver.observe(elements.messages);
const pollTimer = setInterval(poll, 4000);
let checkingAccount = false;
const accountTimer = setInterval(async () => {
  if (!account || busy || checkingAccount) return;
  const currentVersion = version;
  checkingAccount = true;
  try {
    await api("account-check");
  } catch (error) {
    if (currentVersion === version && error.code === "ACCOUNT_CHANGED") showError(error);
  } finally { checkingAccount = false; }
}, 4000);
window.addEventListener("pagehide", () => {
  version += 1;
  clearInterval(pollTimer);
  clearInterval(accountTimer);
  clearTimeout(refreshTimer);
  clearTimeout(toastTimer);
  for (const timer of confirmations.values()) clearTimeout(timer);
  for (const timer of recalls.values()) clearTimeout(timer);
  clearImage();
  cancelAnimationFrame(scrollFrame);
  layoutObserver.disconnect();
  clearRemoteImages();
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("background.js")) {
    if (message?.type === "account-changed") {
      showError(Object.assign(new Error("贴吧登录状态已变化，请重新连接聊天室"), { code: "ACCOUNT_CHANGED" }));
    } else if (message?.type === "blcp-push" && room) {
      const incoming = (message.messages || []).filter((entry) =>
        entry.room === room.room || !entry.room && entry.deleted?.some((id) => messages.has(id)));
      render(incoming);
      refreshSoon();
    }
  }
});
initialize();
