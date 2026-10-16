const DYNAMIC_API = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space";
const LIVE_API = "https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld";
const TIMEOUT = 15000;

// B站自动生成的动态类型，非用户主动发布，不推送
const SKIP_DYNAMIC_TYPES = new Set(["DYNAMIC_TYPE_LIVE_RCMD", "DYNAMIC_TYPE_LIVE"]);

function text(value) {
  return String(value == null ? "" : value).trim();
}

function field(target, key, fallback = null) {
  const value = target && typeof target === "object" ? target[key] : null;
  return value == null ? fallback : value;
}

async function fetchJSON(url, operation) {
  let response;
  let body;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(TIMEOUT) });
    body = await response.text();
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    throw new Error(timedOut ? `${operation}超时` : `${operation}失败，请检查网络或代理设置`);
  }
  if (!response.ok) throw new Error(`${operation}失败（HTTP ${response.status}）`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`${operation}失败：B站返回了无法识别的数据`);
  }
  if (Number(data.code) !== 0) throw new Error(`${operation}失败：${data.message || "请求被拒绝"}`);
  return data.data || {};
}

function extractDynamicText(item) {
  if (!item || typeof item !== "object") return "[非文本动态]";
  const modules = field(item, "modules", {});
  const dynamic = field(modules, "module_dynamic", {});
  const major = field(dynamic, "major", {});
  const type = field(major, "type", "");
  const parts = [];

  const description = field(dynamic, "desc");
  if (description?.text) parts.push(description.text);

  if (type === "MAJOR_TYPE_OPUS") {
    const summary = field(field(major, "opus", {}), "summary", {});
    if (summary.text) parts.push(summary.text);
  } else if (type === "MAJOR_TYPE_DRAW") {
    for (const entry of field(field(major, "draw", {}), "items", [])) {
      if (entry?.description) parts.push(entry.description);
    }
  } else if (type === "MAJOR_TYPE_ARCHIVE") {
    const archive = field(major, "archive", {});
    if (archive.title) parts.push(archive.title);
  } else if (type === "MAJOR_TYPE_COMMON") {
    const common = field(major, "common", {});
    if (common.description) parts.push(common.description);
  }

  const additional = field(dynamic, "additional", {});
  const addType = field(additional, "type", "");
  if (addType === "ADDITIONAL_TYPE_RESERVE") {
    const reserve = field(additional, "reserve", {});
    if (reserve.title) parts.push(reserve.title);
  } else if (addType === "ADDITIONAL_TYPE_VOTE") {
    const vote = field(additional, "vote", {});
    if (vote.title) parts.push(vote.title);
  } else if (addType === "ADDITIONAL_TYPE_GOODS") {
    const goods = field(additional, "goods", {});
    if (goods.title) parts.push(goods.title);
  }

  return parts.length ? parts.join(" | ") : "[非文本动态]";
}

/**
 * 查询直播状态。
 *
 * 返回 [isLiving, title, roomId, errorMessage]。异常时不抛错，交由监控循环记日志并继续
 * （对应 interaction.py:28-40 的 get_live_status 容错语义）
 */
export async function getLiveStatus(uid) {
  try {
    const data = await fetchJSON(`${LIVE_API}?mid=${encodeURIComponent(uid)}`, "读取直播状态");
    const isLiving = Number(data.roomStatus) === 1;
    return [isLiving, isLiving ? text(data.title) : "", Number(data.roomid) || 0, null];
  } catch (error) {
    return [false, "", 0, error.message];
  }
}

/**
 * 查询最新动态。
 *
 * 返回 { dynamicId, content, pubTs, type }；出错时 dynamicId 为 null，content 为错误信息
 *
 * 修复原 Python 版的一个缺陷：原实现取返回列表的首项，而 B站 API 的 items 不保证按
 * 时间排序；这里改为遍历所有条目、取 pub_ts 最大的非直播动态。
 *
 * 已知风险：B站接口对匿名请求偶发返回 412，且 fetch 无法自定义 User-Agent/Referer
 * （二者均为浏览器保留头部）。上线前需拿真实 UID 验证，必要时改用
 * declarativeNetRequest 补头部，或让 Python 侧代为拉取。
 */
export async function getLatestDynamic(uid, skipLiveTypes = true) {
  let data;
  try {
    data = await fetchJSON(`${DYNAMIC_API}?host_mid=${encodeURIComponent(uid)}&offset=&need_top=0&platform=web`, "读取最新动态");
  } catch (error) {
    return { dynamicId: null, content: error.message, pubTs: 0, type: "" };
  }
  const items = Array.isArray(data.items) ? data.items : [];
  let best = null;
  for (const item of items) {
    const type = field(item, "type", "");
    if (skipLiveTypes && SKIP_DYNAMIC_TYPES.has(type)) continue;
    const author = field(field(item, "modules", {}), "module_author", {});
    const pubTs = Number(author.pub_ts) || 0;
    if (!best || pubTs > best.pubTs) {
      best = { dynamicId: String(field(item, "id_str", "")), content: extractDynamicText(item), pubTs, type };
    }
  }
  if (best) return best;
  return { dynamicId: null, content: items.length ? "无动态数据（仅直播动态）" : "无动态数据", pubTs: 0, type: "" };
}
