import { imageUrl, isBaiduImage } from "./protocol.js";

const maximumBytes = 8 * 1024 * 1024;
const waiting = new Map();
const pending = new Map();
const objectUrls = new Set();

function rasterType(bytes) {
  const prefix = [...bytes.slice(0, 12)];
  if (prefix.slice(0, 8).join() === "137,80,78,71,13,10,26,10") return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  const text = String.fromCharCode(...prefix);
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "image/webp";
  return "";
}

async function downloadImage(image, source) {
  const controller = new AbortController();
  pending.set(image, controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(source, { credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      cache: "no-store", signal: controller.signal });
    if (!response.ok || !response.body || Number(response.headers.get("Content-Length")) > maximumBytes) throw new Error("图片不可用");
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximumBytes) { await reader.cancel(); throw new Error("图片过大"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const type = rasterType(bytes);
    if (!type) throw new Error("不支持的图片格式");
    if (pending.get(image) !== controller || !image.isConnected) return;
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
    objectUrls.add(objectUrl);
    const release = () => { URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl); };
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    image.src = objectUrl;
  } catch {
    if (pending.get(image) === controller && image.isConnected) image.dispatchEvent(new Event("error"));
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (pending.get(image) === controller) pending.delete(image);
  }
}

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const source = waiting.get(entry.target);
    waiting.delete(entry.target);
    observer.unobserve(entry.target);
    if (source) downloadImage(entry.target, source);
  }
}, { rootMargin: "200px" });

export function loadRemoteImage(image, value) {
  const source = imageUrl(value);
  if (!source || !isBaiduImage(source)) return;
  waiting.set(image, source);
  observer.observe(image);
}

export function cancelRemoteImage(image) {
  observer.unobserve(image);
  waiting.delete(image);
  pending.get(image)?.abort();
  pending.delete(image);
}

export function clearRemoteImages() {
  observer.disconnect();
  waiting.clear();
  for (const controller of pending.values()) controller.abort();
  pending.clear();
  for (const source of objectUrls) URL.revokeObjectURL(source);
  objectUrls.clear();
}
