import { imageUrl, isBaiduImage } from "./protocol.js";
import { emoji } from "./emoji/map.js";
import { loadRemoteImage } from "./media.js";

export function appendRichText(container, text) {
  for (const part of String(text).split(/(#\([^()\n]{1,30}\))/g)) {
    const name = part.startsWith("#(") ? part.slice(2, -1) : "";
    const filename = Object.hasOwn(emoji, name) ? emoji[name] : null;
    if (!filename) {
      container.append(document.createTextNode(part));
      continue;
    }
    const image = document.createElement("img");
    image.className = "inline-emoji";
    image.src = new URL(`./emoji/${filename}`, import.meta.url).href;
    image.alt = part;
    image.title = part.slice(2, -1);
    image.addEventListener("error", () => image.replaceWith(document.createTextNode(part)), { once: true });
    container.append(image);
  }
}

function link(url, className) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.className = className;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

function mediaElement(url, thumbnail, label, className) {
  const original = imageUrl(url);
  if (!original) return null;
  const preview = imageUrl(thumbnail) || original;
  const container = document.createElement("span");
  container.className = className;
  const anchor = link(original, "media-link");
  const load = () => {
    const image = document.createElement("img");
    image.alt = label;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "media-fallback";
      fallback.textContent = `${label}加载失败，点击查看原图 ↗`;
      image.replaceWith(fallback);
    }, { once: true });
    anchor.replaceChildren(image);
    container.replaceChildren(anchor);
    loadRemoteImage(image, preview);
  };
  if (isBaiduImage(preview) && isBaiduImage(original)) load();
  else {
    anchor.textContent = `查看外部${label}（${new URL(original).hostname}）↗`;
    container.append(anchor);
  }
  return container;
}

export function appendMessageContent(container, message) {
  if (message.text) {
    const text = document.createElement("span");
    text.className = "message-text";
    appendRichText(text, message.text);
    container.append(text);
  }
  if (message.image) {
    const media = mediaElement(message.image, message.thumbnail, message.sticker ? "表情" : "图片", message.sticker ? "message-sticker" : "message-image");
    if (media) container.append(media);
  }
  if (message.post) {
    const card = link(message.post.url, "post-card");
    const label = document.createElement("span");
    label.className = "post-label";
    label.textContent = "转发帖子 ↗";
    const title = document.createElement("strong");
    title.textContent = message.post.title;
    card.append(label, title);
    if (message.post.summary) {
      const summary = document.createElement("span");
      summary.className = "post-summary";
      appendRichText(summary, message.post.summary);
      card.append(summary);
    }
    const source = document.createElement("span");
    source.className = "post-source";
    source.textContent = [message.post.forum && `${message.post.forum}吧`, message.post.author].filter(Boolean).join(" · ");
    card.append(source);
    container.append(card);
    if (message.post.image) {
      const media = mediaElement(message.post.image, message.post.image, "帖子图片", "message-image");
      if (media) container.append(media);
    }
  }
  if (!message.text && !message.image && !message.post) {
    const fallback = document.createElement("span");
    fallback.textContent = message.hasReaction ? "[原消息内容不可用]" : "[暂不支持的消息类型]";
    container.append(fallback);
  }
}

export function reactionElement(items, onReact, onDetail) {
  if (!items?.length) return null;
  const reactions = document.createElement("div");
  reactions.className = "reactions";
  reactions.dataset.signature = JSON.stringify(items);
  reactions.setAttribute("aria-label", "贴表情");
  for (const reaction of items) {
    const item = document.createElement("span");
    item.className = `reaction${reaction.reacted ? " reacted" : ""}`;
    const media = document.createElement("button");
    media.type = "button";
    media.className = "reaction-image";
    media.title = reaction.reacted ? "取消贴表情" : "贴同款表情";
    media.setAttribute("aria-label", media.title);
    media.setAttribute("aria-pressed", String(reaction.reacted));
    media.addEventListener("click", () => onReact(reaction));
    const source = imageUrl(reaction.image);
    if (source && isBaiduImage(source)) {
      const image = document.createElement("img");
      image.alt = "表情";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { media.textContent = "表情"; }, { once: true });
      media.append(image);
      loadRemoteImage(image, source);
    } else media.textContent = "表情";
    item.append(media);
    const count = document.createElement("button");
    count.type = "button";
    count.className = "reaction-count";
    count.textContent = String(reaction.count);
    count.title = "查看谁贴了表情";
    count.setAttribute("aria-label", `${reaction.count} 人贴了表情，查看名单`);
    count.addEventListener("click", () => onDetail(reaction));
    item.append(count);
    reactions.append(item);
  }
  return reactions;
}
