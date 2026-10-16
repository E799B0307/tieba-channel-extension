export function md5(text) {
  const source = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((source.length + 9) / 64) * 64);
  padded.set(source);
  padded[source.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, source.length * 8, true);
  view.setUint32(padded.length - 4, Math.floor(source.length / 0x20000000), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [first, second, third, fourth] = state;
    for (let step = 0; step < 64; step += 1) {
      const round = Math.floor(step / 16);
      const mixed = round === 0 ? (second & third) | (~second & fourth)
        : round === 1 ? (fourth & second) | (~fourth & third)
          : round === 2 ? second ^ third ^ fourth : third ^ (second | ~fourth);
      const word = round === 0 ? step : round === 1 ? (5 * step + 1) % 16
        : round === 2 ? (3 * step + 5) % 16 : (7 * step) % 16;
      const sum = (first + mixed + Math.floor(Math.abs(Math.sin(step + 1)) * 0x100000000)
        + view.getUint32(offset + word * 4, true)) | 0;
      const shift = shifts[round * 4 + step % 4];
      const next = (second + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      first = fourth;
      fourth = third;
      third = second;
      second = next;
    }
    [first, second, third, fourth].forEach((value, index) => { state[index] = (state[index] + value) | 0; });
  }
  return state.map((value) => [0, 8, 16, 24].map((shift) => ((value >>> shift) & 255).toString(16).padStart(2, "0")).join("")).join("");
}

export function signed(fields, salt = "") {
  const entries = Object.entries(fields).filter(([key, value]) => key !== "sign" && !Array.isArray(value));
  entries.sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0);
  return { ...fields, sign: md5(entries.map(([key, value]) => `${key}=${value}`).join("") + salt) };
}

export function parseJSON(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) => {
    return /^-?\d{16,}$/.test(token) ? `"${token}"` : token;
  }));
}

export function unpack(value) {
  for (let depth = 0; depth < 8 && typeof value === "string"; depth += 1) {
    try { value = parseJSON(value); } catch { break; }
  }
  return value;
}

export function positiveId(value) {
  const text = String(value || "");
  if (!/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("请输入有效的频道或贴吧 ID");
  return text;
}

export async function authorIdFromUserId(userId) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode("AFD311832EDEEAEF"), "AES-CBC", false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: encoder.encode("2011121211143000") }, key, encoder.encode(String(userId)));
  return btoa(String.fromCharCode(...new Uint8Array(encrypted))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function userIdFromAuthorId(authorId) {
  try {
    if (typeof authorId !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(authorId)) throw new Error();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode("AFD311832EDEEAEF"), "AES-CBC", false, ["decrypt"]);
    const encoded = authorId.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")), (value) => value.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: encoder.encode("2011121211143000") }, key, bytes);
    const id = new TextDecoder().decode(decrypted);
    if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error();
    return id;
  } catch { throw new Error("无法解析原消息作者的账号，请刷新频道后重试"); }
}

export function canRecallMessage(room, message) {
  if (!room || !message?.authorId || message.hidden || message.removed || message.recalled) return false;
  if (message.authorId === room.authorId) return true;
  const actor = Number(room.identityRole);
  const target = Number(message.role ?? 0);
  if (actor === 1) return [0, 1, 2, 4, 64].includes(target);
  return [2, 3].includes(actor) && [0, 64].includes(target);
}

export function messageKey(authorId) {
  const random = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigInt64(0);
  return `${authorId}${BigInt(Date.now()) * 1000n}${random}`;
}

export function messageMetadata(account, state, level, portrait, content = {}, type = 1) {
  const name = { type: 1, text: { short_enable: 1, short_length: 5, short_priority: 1,
    priority: 1, str: account.name, suffix: "...", type: "1" } };
  const mainData = [];
  if (account.vip) {
    mainData.push({ type: 2, icon: { height: 75, width: 75, priority: 2, type: "1",
      url: "https://tieba-ares.cdn.bcebos.com/mis/2023-7/1689061482682/13afea50121d.png",
      schema: "https://tieba.baidu.com/mo/q/hybrid-business-vip/tbvip?customfullscreen=1&nonavigationbar=1" } });
    name.text.text_color = { day: "CAM_X0301", night: "CAM_X0301", type: 2 };
  }
  mainData.push(name);
  if (account.growthLevel != null) mainData.push({ type: 2, icon: {
    height: 15, width: 24, priority: 5, type: "3",
    url: `local://icon/icon_mask_level_usergrouth_${account.growthLevel}?type=webp`,
    schema: "https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&nonavigationbar=1",
  } });
  mainData.push({ type: 2, icon: { height: 12, width: 16, priority: 2, type: "4",
    url: `local://icon/icon_level_${String(level).padStart(2, "0")}?type=webp`,
    schema: `https://tieba.baidu.com/mo/q/wise-bawu-core/forum-level?customfullscreen=1&forum_id=${state.fid}&nonavigationbar=1&obj_locate=5&portrait=${portrait}`,
  } });
  return { main_data: mainData, is_sys_msg: 0, version: "", portrait, robot_role: 0, role: 0,
    send_status: 0, from: "ios", session_id: Number(state.room), type, user_name: account.name,
    content, level, forum_id: Number(state.fid) };
}

function record(value) {
  const decoded = unpack(value);
  return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : {};
}

export function isBaiduImage(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.port
      && ["tb.himg.baidu.com", "himg.bdimg.com", "tiebapic.baidu.com", "imgsrc.baidu.com", "imgsa.baidu.com",
        "tieba-ares.cdn.bcebos.com", "tieba-im-middleend.cdn.bcebos.com", "tb2.bdstatic.com"].includes(url.hostname);
  } catch { return false; }
}

export function imageUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.username || url.password) return "";
    if (url.protocol === "http:" && isBaiduImage(url.href)) url.protocol = "https:";
    if (url.hostname === "tb.himg.baidu.com" && isBaiduImage(url.href)) url.hostname = "himg.bdimg.com";
    return url.protocol === "https:" ? url.href : "";
  } catch { return ""; }
}

export function parseReactions(value) {
  return (Array.isArray(value) ? value : []).flatMap((reaction) => {
    const image = imageUrl(reaction?.emoji_content);
    const count = Number(reaction?.reactions_num);
    return image && Number.isSafeInteger(count) && count > 0
      ? [{ image, content: String(reaction.emoji_content), count, reacted: Number(reaction.has_reacted) === 1 }] : [];
  });
}

export function parseReactionUsers(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const id = String(row?.reaction_bduk || "");
    const time = Number(row?.sort_time_us);
    return id && id.length <= 128 ? [{ id, time: Number.isSafeInteger(time) && time > 0 ? time : 0 }] : [];
  });
}

export function parseFavoriteStickers(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)
    || !Array.isArray(data.pic_ids) && !(data.pic_ids == null && Number(data.pic_update_time) === 0)) {
    throw new Error("贴吧返回的收藏表情数据无法识别，请稍后刷新");
  }
  const stickers = new Map();
  let unavailable = 0;
  for (const row of data.pic_ids || []) {
    const pid = String(row?.pic_id || "");
    const url = imageUrl(row?.pic_url);
    const width = Number(row?.width);
    const height = Number(row?.height);
    if (!pid || pid.length > 128 || !isBaiduImage(url)
      || ![width, height].every((size) => Number.isSafeInteger(size) && size > 0 && size <= 65535)) {
      unavailable += 1;
      continue;
    }
    const thumbnail = imageUrl(row.thumbnail);
    const size = [width, height].map((value) => Math.max(1, Math.round(value * 100 / Math.max(width, height)))).join(",");
    const id = `${String(row.pck_id || "0")}:${pid}`;
    stickers.set(id, { id, url, thumbnail: isBaiduImage(thumbnail) ? thumbnail : url,
      width, height, metadata: { big_size: size, bsize: size } });
  }
  return { stickers: [...stickers.values()], unavailable };
}

export function isDisplayableMessage(message) {
  if (message.hidden || message.removed) return false;
  const system = message.system || message.name === "系统"
    || (!message.authorId || message.authorId === "0") && (!message.from || message.from === "0");
  if (system && /(?:进入|加入)(?:了)?[^\n]*(?:频道|房间|聊天室)[!！。\s]*$/.test(message.text || "")) return false;
  return !!(message.text || message.image || message.post || !system);
}

export function imageUpload(upload) {
  if (typeof upload?.data !== "string" || upload.data.length > 12 * 1024 * 1024) throw new Error("请选择 8 MiB 以内的图片");
  let bytes;
  try { bytes = Uint8Array.from(atob(upload.data), (value) => value.charCodeAt(0)); }
  catch { throw new Error("图片读取失败，请重新选择"); }
  if (bytes.length < 12 || bytes.length > 8 * 1024 * 1024) throw new Error("图片为空、损坏或超过 8 MiB");
  const head = String.fromCharCode(...bytes.slice(0, 12));
  let format = "";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) format = "png";
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = "jpeg";
  else if (/^GIF8[79]a/.test(head)) format = "gif";
  else if (head.startsWith("RIFF") && head.slice(8) === "WEBP") format = "webp";
  if (!format) throw new Error("只支持 PNG、JPEG、GIF、WebP 图片");
  const { width, height } = upload;
  if (![width, height].every((size) => Number.isSafeInteger(size) && size > 0 && size <= 65535)) throw new Error("无法读取图片尺寸");
  const size = [width, height].map((value) => Math.max(1, Math.round(value * 100 / Math.max(width, height)))).join(",");
  return { bytes, type: `image/${format}`, format: format === "jpeg" ? "jpg" : format,
    width, height, metadata: { big_size: size, bsize: size } };
}

export function parseMessage(raw) {
  raw = record(raw);
  const content = record(raw.content);
  const detail = record(content.text);
  const metadata = record(detail.ext);
  const mainData = Array.isArray(metadata.main_data) ? metadata.main_data : [];
  const displayName = mainData.find((item) => Number(item?.type) === 1 && item.text?.str)?.text.str;
  const level = metadata.level ?? mainData.map((item) => String(item?.icon?.url || "").match(/icon_level_(\d+)/)?.[1]).find(Boolean);
  const portrait = String(detail.portrait || metadata.portrait || "");
  const decodedBody = unpack(detail.content_body);
  const body = record(decodedBody);
  const event = record(detail.data);
  const service = record(event.service_info);
  const configuration = record(service.msg_conf);
  const thread = record(service.thread_info);
  const sender = record(service.user_from);
  const removed = String(detail.type) === "106";
  const reply = record(detail.re_data);
  const replyBody = unpack(reply.re_content_body);
  const atData = Array.isArray(detail.at_data) ? detail.at_data : [];
  const atNames = [];
  const atUids = [];
  let atAll = false;
  for (const at of atData) {
    if (!at || typeof at !== "object") continue;
    if (at.at_type === "all") atAll = true;
    else if (at.at_type === "user") {
      if (at.at_name) atNames.push(String(at.at_name));
      const uid = at.uid != null ? at.uid : at.at_uid;
      const numeric = Number(uid);
      if (Number.isSafeInteger(numeric) && numeric !== 0) atUids.push(numeric);
    }
  }
  const image = imageUrl(body.url || body.emoji_content || body.pic_url);
  const media = Array.isArray(thread.media) ? thread.media : [];
  const abstract = Array.isArray(thread.richAbstract) ? thread.richAbstract : [];
  const post = /^[1-9]\d{0,19}$/.test(String(thread.id || "")) ? {
    url: `https://tieba.baidu.com/p/${thread.id}`,
    title: String(thread.title || "查看转发的帖子"),
    forum: String(record(thread.forumInfo).name || ""),
    author: String(record(thread.author).nameShow || record(thread.author).name || ""),
    summary: abstract.filter((part) => Number(part?.type) === 0 && typeof part?.text === "string").map((part) => part.text).join("").slice(0, 300),
    image: media.map((part) => imageUrl(part?.smallPic || part?.small_pic || part?.src || part?.url || part?.bigPic)).find(Boolean) || "",
  } : null;
  const text = typeof decodedBody === "string" ? decodedBody : String(body.text || detail.show_content || detail.low_version_content
    || (!post && (configuration.show_content || configuration.low_version_content)) || "");
  const system = Object.keys(configuration).length > 0 || (!Number(raw.from_user) && !detail.baidu_uk);
  // Empty control packets must not become synthetic chat notifications.
  const emptyEvent = (system || !detail.baidu_uk) && !text && !image && !post;
  const joined = system && /(?:进入|加入)(?:了)?[^\n]*(?:频道|房间|聊天室)[!！。\s]*$/.test(text);
  const contentType = String(detail.content_type || "0");
  const nativeType = /^[1-9]\d{0,5}$/.test(String(metadata.type)) ? String(metadata.type)
    : /^[0-3]$/.test(contentType) ? String(Number(contentType) + 1) : "0";
  return {
    id: String(raw.msgid || ""), time: Number(raw.create_time || 0),
    key: String(raw.msg_key || detail.msg_key || ""), contentType,
    msgType: nativeType, role: Number(metadata.robot_role) === 1 ? 64 : Number(metadata.role || 0), system, removed,
    room: String(detail.room_id || service.chatroom_id || ""),
    from: String(raw.from_user || ""), authorId: String(detail.baidu_uk || sender.uk || ""),
    name: String(displayName || detail.name || metadata.user_name || detail.user_name || sender.username || (Number(raw.from_user) ? "贴吧用户" : "系统")),
    portrait,
    avatar: isBaiduImage(portrait) ? imageUrl(portrait) : (portrait && /^[\w.-]+(?:\?t=\d+)?$/.test(portrait) ? `https://himg.bdimg.com/sys/portrait/item/${portrait}` : ""),
    level: level != null && /^\d{1,2}$/.test(String(level)) ? Number(level) : null,
    vip: Number(detail.vip) > 0,
    text,
    image, thumbnail: imageUrl(body.thumbnail) || image,
    sticker: !!body.emoji_content,
    post, hasReaction: Number(detail.has_reaction) === 1, reactions: [],
    reply: typeof replyBody === "string" ? replyBody : String(replyBody?.text || (replyBody?.url ? "[图片]" : "")),
    atNames, atUids, atAll,
    hidden: removed || emptyEvent || joined
      || configuration.is_visible != null && Number(configuration.is_visible) === 0,
    deleted: removed && Array.isArray(event.msgids) ? event.msgids.map(String) : [],
  };
}
