import { md5, signed, parseJSON, positiveId, parseMessage, parseReactions, parseReactionUsers, parseFavoriteStickers, authorIdFromUserId, userIdFromAuthorId, canRecallMessage, messageKey, messageMetadata, imageUpload, imageUrl, isBaiduImage } from "./protocol.js";
import { isCatalogReaction } from "./reactions.js";
import { BLCPClient, CHAT_SDK_VERSION as BLCP_SDK_VERSION, CHAT_VERSION as BLCP_CHAT_VERSION } from "./blcp.js";
import { cuidGalaxy2, c3Aid } from "./crypto.js";

const APP_VERSION = "22.12.1.0";
const SDK_VERSION = 11220030;
const APP_ID = 10773430;

function accountError(message) {
  return Object.assign(new Error(message), { code: "ACCOUNT_CHANGED" });
}

async function request(url, options = {}, operation = "连接贴吧") {
  let response;
  let body;
  try {
    response = await fetch(url, { ...options, credentials: "include", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15000) });
    body = await response.text();
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    const message = timedOut
      ? `${operation}超时，请稍后重试`
      : `${operation}失败，无法连接 ${new URL(url).hostname}，请检查网络或代理设置`;
    throw Object.assign(new Error(message), { code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR" });
  }
  if (response.type === "opaqueredirect") {
    throw Object.assign(new Error(`${operation}失败：贴吧接口发生重定向，请更新插件后重试`), { code: "API_REDIRECT" });
  }
  if (!response.ok) throw new Error(`${operation}失败（HTTP ${response.status}）`);
  let data;
  try { data = parseJSON(body); } catch { throw new Error(`${operation}失败：贴吧返回了无法识别的数据，请稍后重试`); }
  for (const field of ["error_code", "err_code", "no"]) {
    if (data[field] != null && Number(data[field]) !== 0) {
      throw new Error(`${operation}失败（${data[field]}）：${data.error_msg || data.err_msg || data.error || "请求被拒绝"}`);
    }
  }
  return data;
}

export class TiebaClient {
  constructor() {
    this.cachedAccount = null;
    this.loginTask = null;
    this.deviceTask = null;
    this.accountGeneration = 0;
    this.reactionCache = new Map();
    this.reactionGeneration = 0;
    this.historyCache = new Map();
    this.stickerCache = null;
    this.blcp = null;          // BLCPClient 单例（懒连接）
    this.blcpAccount = null;   // BLCP 已登录对应的 token
    this.blcpTask = null;      // 连接+登录 Promise
  }

  invalidateAccount() {
    this.accountGeneration += 1;
    this.cachedAccount = null;
    this.loginTask = null;
    this.reactionCache.clear();
    this.reactionGeneration += 1;
    this.historyCache.clear();
    this.stickerCache = null;
    // 账号变化时断开 BLCP，下次按新账号重连
    if (this.blcp) { try { this.blcp.close(); } catch {} this.blcp = null; }
    this.blcpAccount = null;
    this.blcpTask = null;
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    return Promise.all([chrome.storage.session.clear(), chrome.storage.local.remove("lastForum")]);
  }

  /** 获取（或懒建立）BLCP 连接，返回已登录的 BLCPClient */
  async getBlcp(account) {
    if (this.blcp && this.blcp.status === 1 && this.blcpAccount === account.token) return this.blcp;
    if (this.blcpTask) return this.blcpTask;
    this.blcpTask = (async () => {
      // 生成设备参数（android_id / uuid），BLCP 登录必需
      const stored = await chrome.storage.local.get("blcpDevice");
      let dev = stored.blcpDevice;
      if (!dev || !dev.android_id || !dev.uuid) {
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        dev = {
          android_id: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""),
          uuid: crypto.randomUUID(),
        };
        await chrome.storage.local.set({ blcpDevice: dev });
      }
      const cg = await cuidGalaxy2(dev.android_id);
      const ca = await c3Aid(dev.android_id, dev.uuid);

      const client = new BLCPClient({ bduss: account.token, cuidGalaxy2: cg, c3Aid: ca, zId: "", sampleId: "" });
      await client.connect();
      await client.login();
      this.blcp = client;
      this.blcpAccount = account.token;
      this._startHeartbeat(client);
      this._wirePush(client, account);
      return client;
    })().catch((error) => {
      this.blcpTask = null;
      if (this.blcp) { try { this.blcp.close(); } catch {} this.blcp = null; }
      this.blcpAccount = null;
      throw error;
    });
    try {
      const client = await this.blcpTask;
      this.blcpTask = null;
      return client;
    } catch (error) {
      this.blcpTask = null;
      throw error;
    }
  }

  /** 心跳保活：每 5 秒发一次，维持 BLCP 长连接（也顺带维持 SW 存活） */
  _startHeartbeat(client) {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this.blcp === client && client.status === 1) {
        client.heartbeat().catch(() => {});
      }
    }, 5000);
  }

  /**
   * 注册 BLCP 实时推送（notify）处理器。
   * aiotieba 的 get_chat_message_queue() 即靠此拿到「几乎所有消息」，
   * 包括撤回/删除事件（type=106）、@全体成员等——REST 轮询拿不到这些。
   * handler 收到解析后的消息数组 [{...parseMessage}, ...]（含 removed/deleted 标记）。
   */
  onPush(handler) {
    this._pushHandler = handler;
  }

  /** 处理 BLCP notify：解析消息并回调（供 getBlcp 内部注册） */
  _wirePush(client, account) {
    if (client._pushWired) return;
    client._pushWired = true;
    client.onMessage((packet) => {
      if (!this._pushHandler || !packet || this.blcp !== client || account.generation !== this.accountGeneration) return;
      try {
        const list = Array.isArray(packet) ? packet : (packet.messages || []);
        const parsed = list.map((raw) => parseMessage(raw));
        for (const message of parsed) {
          for (const [key, history] of this.historyCache) {
            if (!key.startsWith(`${account.id}:`) || message.room && key !== `${account.id}:${message.room}`) continue;
            for (const id of message.deleted) {
              if (history.has(id)) history.get(id).recalled = true;
            }
            if (message.room && /^[1-9]\d{0,19}$/.test(message.id)) {
              const previous = history.get(message.id);
              history.set(message.id, { ...message, reactions: previous?.reactions || [], recalled: previous?.recalled });
              if (history.size > 600) history.delete(history.keys().next().value);
            }
          }
        }
        if (parsed.length) this._pushHandler(parsed);
      } catch (error) {
        console.warn("[blcp] notify 解析失败:", error.message, JSON.stringify(packet).slice(0, 300));
      }
    });
  }

  async verifyAccount(account, expectedId) {
    const [cookie, chatCookie] = await Promise.all([
      chrome.cookies.get({ url: "https://tieba.baidu.com/", name: "BDUSS" }),
      chrome.cookies.get({ url: "https://pim.baidu.com/", name: "BDUSS" }),
    ]);
    if (account.generation !== this.accountGeneration || cookie?.value !== account.token
      || chatCookie?.value !== account.token || (expectedId && String(expectedId) !== account.id)) {
      throw accountError("贴吧登录状态已变化，请重新连接聊天室");
    }
  }

  async checkAccount(expectedId) {
    const account = this.cachedAccount;
    if (!account || account.id !== String(expectedId)) throw accountError("请重新连接当前网页登录账号");
    try {
      await this.verifyAccount(account, expectedId);
    } catch (error) {
      if (this.cachedAccount === account) await this.invalidateAccount();
      throw error;
    }
    return this.publicAccount(account);
  }

  async device() {
    if (!this.deviceTask) {
      this.deviceTask = (async () => {
        const stored = await chrome.storage.local.get("deviceId");
        if (stored.deviceId) return stored.deviceId;
        const deviceId = crypto.randomUUID().replaceAll("-", "").toUpperCase() + "|0";
        await chrome.storage.local.set({ deviceId });
        return deviceId;
      })().catch((error) => { this.deviceTask = null; throw error; });
    }
    return this.deviceTask;
  }

  async app(path, fields, operation) {
    return request(`https://tiebac.baidu.com${path}`, {
      method: "POST", body: new URLSearchParams(signed(fields, "tiebaclient!!!")),
    }, operation);
  }

  async im(path, fields, operation, accountType = true) {
    const deviceId = await this.device();
    const body = signed({ appid: APP_ID, app_version: APP_VERSION, sdk_version: SDK_VERSION,
      timestamp: Math.floor(Date.now() / 1000), ...(accountType ? { account_type: 1 } : {}), device_id: deviceId, ...fields });
    return request(`https://pim.baidu.com/rest/3.0/im/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, operation);
  }

  publicAccount(account) {
    return { id: account.id, name: account.name };
  }

  async account(expectedId) {
    const generation = this.accountGeneration;
    const [cookie, chatCookie] = await Promise.all([
      chrome.cookies.get({ url: "https://tieba.baidu.com/", name: "BDUSS" }),
      chrome.cookies.get({ url: "https://pim.baidu.com/", name: "BDUSS" }),
    ]);
    if (generation !== this.accountGeneration) throw accountError("贴吧登录状态已变化，请重新连接聊天室");
    if (!cookie?.value) {
      await this.invalidateAccount();
      throw accountError("请先在贴吧网页版登录，然后点击「重新连接」");
    }
    if (chatCookie?.value !== cookie.value) {
      await this.invalidateAccount();
      throw accountError("聊天服务与贴吧的登录状态不同，请退出贴吧并重新登录");
    }
    if (!this.cachedAccount || this.cachedAccount.token !== cookie.value || Date.now() - this.cachedAccount.created > 300000) {
      if (!this.loginTask || this.loginTask.token !== cookie.value) {
        const token = cookie.value;
        this.loginTask = { token, promise: this.app("/c/s/login", { bdusstoken: token, _client_version: APP_VERSION }, "验证登录状态").then(async (data) => {
          if (!data.user?.id) throw accountError("贴吧登录已失效，请重新登录");
          const profile = await this.app("/c/u/user/profile", {
            BDUSS: token, _client_version: APP_VERSION, _client_type: 2, uid: String(data.user.id), need_post_count: 1, pn: 1,
          }, "读取当前账号资料");
          const user = profile.user;
          if (!user?.id || String(user.id) !== String(data.user.id)) throw accountError("账号资料与登录身份不一致，请重新连接");
          const growthLevel = user.user_growth?.level_id;
          return { token, generation, id: String(user.id), name: String(user.name_show || user.name || data.user.name || "贴吧用户"),
            originId: data.user.trigger_id, tbs: String(data.anti?.tbs || ""),
            portrait: String(user.portrait || data.user.portrait || "").split("?")[0],
            vip: Number(user.is_mem) > 0,
            growthLevel: growthLevel != null && /^\d{1,3}$/.test(String(growthLevel)) ? Number(growthLevel) : null,
            created: Date.now() };
        }) };
      }
      const task = this.loginTask;
      try {
        const account = await task.promise;
        await this.verifyAccount(account, expectedId);
        this.cachedAccount = account;
      } finally {
        if (this.loginTask === task) this.loginTask = null;
      }
    }
    const account = this.cachedAccount;
    await this.verifyAccount(account, expectedId);
    return account;
  }

  /**
   * 用显式 BDUSS 登录（独立机器人账号用），不读取浏览器 cookie。
   * 返回与 account() 相同结构的 account 对象；token 失效时抛 ACCOUNT_CHANGED。
   * 机器人版专用：让机器人以独立账号身份发言。
   */
  async loginWithToken(token) {
    if (!token || typeof token !== "string") throw accountError("机器人账号 BDUSS 为空");
    const generation = this.accountGeneration;
    const data = await this.app("/c/s/login", { bdusstoken: token, _client_version: APP_VERSION }, "验证机器人账号");
    if (!data.user?.id) throw accountError("机器人账号 BDUSS 已失效，请重新填写");
    const profile = await this.app("/c/u/user/profile", {
      BDUSS: token, _client_version: APP_VERSION, _client_type: 2, uid: String(data.user.id), need_post_count: 1, pn: 1,
    }, "读取机器人账号资料");
    const user = profile.user;
    if (!user?.id || String(user.id) !== String(data.user.id)) throw accountError("机器人账号资料与登录身份不一致");
    const growthLevel = user.user_growth?.level_id;
    return {
      token, generation,
      id: String(user.id),
      name: String(user.name_show || user.name || data.user.name || "贴吧用户"),
      originId: data.user.trigger_id,
      tbs: String(data.anti?.tbs || ""),
      portrait: String(user.portrait || data.user.portrait || "").split("?")[0],
      vip: Number(user.is_mem) > 0,
      growthLevel: growthLevel != null && /^\d{1,3}$/.test(String(growthLevel)) ? Number(growthLevel) : null,
      created: Date.now(),
    };
  }

  async rooms(forum, expectedId) {
    const account = await this.account(expectedId);    const name = typeof forum === "string" ? forum.trim() : "";
    if (!name || name.length > 100) throw new Error("请输入贴吧名称");
    const resolved = await this.app("/c/f/frs/frsBottom", { kw: name }, "查找贴吧");
    if (!resolved.forum?.id) throw new Error("没有找到这个贴吧，请检查吧名后重试");
    const fid = positiveId(resolved.forum.id);
    const data = await this.app("/c/f/chat/getRoomListByFid", {
      BDUSS: account.token, _client_version: "12.68.1.0", call_from: "frs", fid,
    }, "加载频道列表");
    await this.verifyAccount(account, expectedId);
    const listed = (data.data?.list || []).flatMap((group) => group.room_list || []).map((room) => ({
      id: positiveId(room.room_id), name: String(room.room_info?.name || room.room_id),
    }));
    const rooms = [...new Map(listed.map((room) => [room.id, room])).values()];
    await chrome.storage.session.set({ [`forum:${fid}`]: { accountId: account.id, rooms } });
    await chrome.storage.local.set({ lastForum: { accountId: account.id, name } });
    await this.verifyAccount(account, expectedId);
    return { fid, name, rooms };
  }

  async enter(roomId, forumId, expectedId) {
    const room = positiveId(roomId);
    const fid = positiveId(forumId);
    const account = await this.account(expectedId);
    const saved = (await chrome.storage.session.get(`forum:${fid}`))[`forum:${fid}`];
    const selected = saved?.accountId === account.id && saved.rooms.find((channel) => channel.id === room);
    if (!selected) throw new Error("频道列表已失效，请重新查找贴吧并选择频道");
    const data = await this.im("chatroom/enter_chatroom_client", { room_id: Number(room), cuid: await this.device() }, "进入频道");
    await this.verifyAccount(account, expectedId);
    if (!data.room_info) throw new Error("无法进入该频道，请检查频道 ID 和当前账号权限");
    if (data.room_info.room_id != null && String(data.room_info.room_id) !== room) throw new Error("返回的频道与所选频道不一致，请重新查找频道");
    const authorId = data.baidu_uk || await authorIdFromUserId(account.id);
    const previous = (await chrome.storage.session.get(`room:${room}`))[`room:${room}`];
    const roomState = { room, fid, accountId: account.id, authorId: String(authorId),
      name: selected.name, sentKeys: previous?.accountId === account.id ? previous.sentKeys || {} : {} };
    try {
      Object.assign(roomState, await this.roomPermissions(roomState, account, expectedId));
    } catch (error) {
      if (error.code === "ACCOUNT_CHANGED") throw error;
      roomState.identityRole = null;
      roomState.permissionError = true;
    }
    this.reactionCache.clear();
    await chrome.storage.session.set({ [`room:${room}`]: roomState });
    // BLCP joinChatRoom（service3/method201）：发送消息的前置条件，
    // aiotieba 在 send 前总是先 join；未 join 时 method185 返回 err_code=5
    try {
      const blcp = await this.getBlcp(account);
      if (!blcp.joinedRooms) blcp.joinedRooms = new Set();
      if (!blcp.joinedRooms.has(room)) {
        await blcp.joinChatRoom(Number(room));
        blcp.joinedRooms.add(room);
      }
    } catch (error) {
      // join 失败不阻断进入频道（收消息走 REST 拉取），但发送可能报错，留日志
      console.warn("[blcp] joinChatRoom 失败:", error.message);
    }
    await this.verifyAccount(account, expectedId);
    return roomState;
  }

  /**
   * 确保已加入指定房间的 BLCP 实时通道（不校验频道列表，供机器人后台使用）。
   * 返回 true 表示已 join；账号未登录时返回 false。失败不抛错，交由调用方忽略。
   */
  async ensureJoined(roomId, expectedId) {
    const room = positiveId(roomId);
    try {
      const account = await this.account(expectedId);
      const blcp = await this.getBlcp(account);
      if (!blcp.joinedRooms) blcp.joinedRooms = new Set();
      if (!blcp.joinedRooms.has(room)) {
        await blcp.joinChatRoom(Number(room));
        blcp.joinedRooms.add(room);
      }
      return true;
    } catch (error) {
      console.warn("[blcp] ensureJoined 失败:", error.message);
      return false;
    }
  }

  async roomState(roomId, expectedId) {
    const room = positiveId(roomId);
    const account = await this.account(expectedId);
    const stored = await chrome.storage.session.get(`room:${room}`);
    await this.verifyAccount(account, expectedId);
    const state = stored[`room:${room}`];
    if (!state || state.accountId !== account.id) throw accountError("请重新选择频道后继续聊天");
    return { state, account };
  }

  async roomPermissions(state, account, expectedId) {
    await this.verifyAccount(account, expectedId);
    const result = await this.app("/c/f/chat/getChatRoomDetail", {
      BDUSS: account.token, _client_version: APP_VERSION, chatroom_id: state.room, last_msg_id: "0", last_time: "0",
    }, "读取频道管理权限");
    await this.verifyAccount(account, expectedId);
    const detail = result.data;
    if (!/^[0-4]$/.test(String(detail?.user_info?.identity_role))
      || detail.basic_info?.id != null && String(detail.basic_info.id) !== state.room
      || detail.basic_info?.forum_id != null && String(detail.basic_info.forum_id) !== state.fid) {
      throw new Error("频道管理权限数据无效，请重新选择频道");
    }
    return { identityRole: Number(detail.user_info.identity_role) };
  }

  history(state, account) {
    const key = `${account.id}:${state.room}`;
    if (!this.historyCache.has(key)) {
      this.historyCache.set(key, new Map());
      if (this.historyCache.size > 6) this.historyCache.delete(this.historyCache.keys().next().value);
    }
    return this.historyCache.get(key);
  }

  async messages(roomId, expectedId, after = "0") {
    if (typeof after !== "string" || !/^\d{1,20}$/.test(after)) throw new Error("消息游标无效，请重新选择频道");
    const { state, account } = await this.roomState(roomId, expectedId);
    const history = this.history(state, account);
    const data = await this.im("fetch_mcast_msg_client", {
      mcast_id: Number(state.room), msgid_begin: 0, msgid_end: "9223372036854775807", count: history.size ? -40 : -80,
      category: 4, device_type: 2, from_action: 1,
      ext_info: JSON.stringify({ last_callback_msg_id: 0, cast_id: 0, local_ts: 0, latest_msg_id: 0 }),
    }, "读取频道消息");
    await this.verifyAccount(account, expectedId);
    const incoming = (data.messages || []).map(parseMessage).filter((message) => /^\d+$/.test(message.id) && (!message.room || message.room === state.room));
    const incomingIds = new Set(incoming.map((message) => message.id));
    for (const message of incoming) {
      const previous = history.get(message.id);
      if (!message.key && message.authorId === state.authorId) message.key = state.sentKeys?.[message.id] || "";
      message.key ||= previous?.key || "";
      message.hasReaction ||= !!previous?.hasReaction;
      message.recalled = previous?.recalled || incoming.some((event) => event.deleted.includes(message.id));
      if (message.hasReaction) message.reactions = previous?.reactions || [];
      history.set(message.id, message);
    }
    const ordered = [...history.values()].sort((first, second) => BigInt(first.id) < BigInt(second.id) ? -1 : 1);
    if (ordered.length > 600) {
      for (const message of ordered.splice(0, ordered.length - 300)) history.delete(message.id);
    }
    const reactionMessages = ordered.filter((message) => !message.hidden && message.hasReaction).slice(-40);
    let reactionError = false;
    try {
      await this.reactions(state, account, reactionMessages, expectedId);
    } catch (error) {
      if (error.code === "ACCOUNT_CHANGED") throw error;
      reactionError = true;
    }
    await this.verifyAccount(account, expectedId);
    return {
      room: state.room,
      // Recent server messages may arrive after a newer cursor was already seen.
      messages: ordered.filter((message) => BigInt(message.id) > BigInt(after) || incomingIds.has(message.id)).slice(-300),
      reacts: ordered.filter((message) => !message.hidden).slice(-80).map((message) => ({ id: message.id, reactions: message.reactions })),
      reactionError,
      reactionGeneration: this.reactionGeneration,
      deleted: ordered.filter((message) => message.recalled).map((message) => message.id),
    };
  }

  async reactions(state, account, messages, expectedId) {
    const candidates = messages.filter((message) => !message.hidden && message.hasReaction && /^[1-9]\d{0,19}$/.test(message.id));
    const cacheKey = (message) => `${account.id}:${state.room}:${message.id}`;
    const activeKeys = new Set(candidates.map(cacheKey));
    for (const key of this.reactionCache.keys()) {
      if (!activeKeys.has(key)) this.reactionCache.delete(key);
    }
    const pending = candidates.filter((message) => Date.now() - (this.reactionCache.get(cacheKey(message))?.created || 0) > 15000);
    try {
      for (let offset = 0; offset < pending.length; offset += 10) {
        await this.verifyAccount(account, expectedId);
        const batch = pending.slice(offset, offset + 10);
        await this.readReactions(state, account, batch, expectedId);
      }
    } finally {
      for (const message of candidates) message.reactions = this.reactionCache.get(cacheKey(message))?.items || [];
    }
  }

  async readReactions(state, account, batch, expectedId) {
    const generation = this.reactionGeneration;
    const data = await this.im("chatroom/reaction_list", {
      room_id: Number(state.room), emoji_package_id: 1,
      msgids: batch.map((message) => Number.isSafeInteger(Number(message.id)) ? Number(message.id) : message.id),
    }, "读取贴表情", false);
    await this.verifyAccount(account, expectedId);
    if (!data.result || typeof data.result !== "object" || Array.isArray(data.result)) throw new Error("贴表情响应格式不正确");
    for (const message of batch) {
      if (generation !== this.reactionGeneration) break;
      const rows = data.result[message.id];
      const items = parseReactions(rows);
      this.reactionCache.set(`${account.id}:${state.room}:${message.id}`, { created: Date.now(), items });
      const current = this.history(state, account).get(message.id);
      if (current) {
        current.reactions = items;
        current.key ||= (Array.isArray(rows) && rows.find((row) => typeof row?.msg_key === "string" && row.msg_key.length <= 512)?.msg_key) || "";
      }
    }
  }

  messageTarget(state, account, id) {
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id)) throw new Error("请选择有效的消息");
    const history = this.history(state, account);
    const target = history.get(id);
    if (!target || target.hidden || target.recalled || [...history.values()].some((event) => event.deleted.includes(id))) {
      throw new Error("这条消息已失效，请刷新频道后重试");
    }
    return target;
  }

  async react(roomId, id, image, add, expectedId) {
    if (typeof add !== "boolean" || typeof image !== "string" || image.length > 4096 || !isBaiduImage(image)) throw new Error("请选择有效的表情");
    const { state, account } = await this.roomState(roomId, expectedId);
    let target = this.messageTarget(state, account, id);
    if (!isCatalogReaction(image) && !target.reactions.some((item) => item.image === image)) throw new Error("表情已失效，请重新选择");
    this.reactionGeneration += 1;
    await this.readReactions(state, account, [target], expectedId);
    target = this.messageTarget(state, account, id);
    const existing = target.reactions.find((item) => item.image === image);
    if (!!existing?.reacted === add) return { room: state.room, id, reactions: target.reactions, confirmed: true, reactionGeneration: this.reactionGeneration };
    if (!target.key) throw new Error("这条消息缺少贴表情标识，请刷新后重试");
    if (!/^[1-9]\d{0,19}$/.test(target.from)) throw new Error("这条消息缺少发送者标识，无法贴表情");
    const blcp = await this.getBlcp(account);
    if (!blcp.joinedRooms?.has(state.room)) {
      await blcp.joinChatRoom(Number(state.room));
      (blcp.joinedRooms ||= new Set()).add(state.room);
    }
    await this.verifyAccount(account, expectedId);
    this.messageTarget(state, account, id);
    target.hasReaction = true;
    try {
      await blcp.react({ method: 214, op_type: add ? 1 : 2, category: 4, emoji_package_id: 1,
        msg_key: target.key, msgid: Number.isSafeInteger(Number(id)) ? Number(id) : id,
        bduid: Number(account.id), msg_from_uk: Number.isSafeInteger(Number(target.from)) ? Number(target.from) : target.from,
        msg_to_uk: Number(state.room), emoji_content: existing?.content || image,
        app_version: APP_VERSION, sdk_version: BLCP_SDK_VERSION, device_id: blcp.cuidGalaxy2,
        uk: blcp.user.uk, appid: APP_ID });
    } finally {
      this.reactionGeneration += 1;
      this.reactionCache.delete(`${account.id}:${state.room}:${id}`);
    }
    let confirmed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 800));
      try { await this.readReactions(state, account, [target], expectedId); }
      catch (error) { if (error.code === "ACCOUNT_CHANGED") throw error; break; }
      target = this.messageTarget(state, account, id);
      confirmed = !!target.reactions.find((item) => item.image === image)?.reacted === add;
      if (confirmed) break;
    }
    return { room: state.room, id, reactions: target.reactions, confirmed, reactionGeneration: this.reactionGeneration };
  }

  async reactionDetail(roomId, id, image, expectedId, after = 1) {
    if (typeof image !== "string" || image.length > 4096 || !isBaiduImage(image)
      || !Number.isSafeInteger(after) || after < 1) throw new Error("表情或分页参数无效");
    const { state, account } = await this.roomState(roomId, expectedId);
    const target = this.messageTarget(state, account, id);
    const reaction = target.reactions.find((item) => item.image === image);
    if (!reaction) throw new Error("这个表情已不存在，请刷新后重试");
    const data = await this.im("chatroom/reaction_detail", {
      room_id: Number(state.room), emoji_package_id: 1,
      msgid: Number.isSafeInteger(Number(id)) ? Number(id) : id, emoji_content: reaction.content || image,
      sort_time_us_begin: after, sort_time_us_end: Number.MAX_SAFE_INTEGER, count: 30,
    }, "读取贴表情名单", false);
    await this.verifyAccount(account, expectedId);
    if (data.result != null && !Array.isArray(data.result)) throw new Error("贴表情名单格式不正确");
    const rows = parseReactionUsers(data.result);
    let profiles = {};
    if (rows.length) {
      try {
        const result = await this.app("/c/f/chat/getChatRoomInitInfo", {
          BDUSS: account.token, _client_version: APP_VERSION, scene: "2", chatroom_id: state.room,
          uks: JSON.stringify(rows.map((user) => user.id)),
        }, "读取频道用户资料");
        profiles = result.data?.user_info || {};
      } catch (error) { if (error.code === "ACCOUNT_CHANGED") throw error; }
    }
    await this.verifyAccount(account, expectedId);
    const history = [...this.history(state, account).values()];
    const users = rows.map((user) => {
      const profile = profiles[user.id];
      const known = history.find((message) => message.authorId === user.id);
      const portrait = String(profile?.portrait || "");
      return { id: user.id, name: String(profile?.user_name || known?.name || "贴吧用户"), after: user.time,
        avatar: isBaiduImage(portrait) ? imageUrl(portrait) : /^[\w.-]+(?:\?t=\d+)?$/.test(portrait)
          ? `https://himg.bdimg.com/sys/portrait/item/${portrait}` : known?.avatar || "" };
    });
    return { room: state.room, id, users, hasMore: Number(data.has_more) > 0 };
  }

  async uploadImage(account, blcp, upload, expectedId) {
    const timestamp = Math.floor(Date.now() / 1000);
    const fields = { appid: APP_ID, uk: blcp.user.uk, content_length: upload.bytes.length,
      content_type: upload.type, format: upload.format, api_version: 1, req_source: 12,
      img_width: upload.width, img_height: upload.height, timestamp, cuid: blcp.cuidGalaxy2, account_type: 1 };
    const body = Object.entries(fields).map(([key, value]) => `&${key}=${encodeURIComponent(value)}`).join("")
      + `&sign=${md5(`${timestamp}${account.token}${APP_ID}`)}`;
    const data = await request("https://pim.baidu.com/rest/3.0/im/bos/generate_bos_url", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    }, "申请图片上传地址");
    const params = data.response_params;
    const validUpload = (value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.port && url.hostname.endsWith(".bcebos.com");
      } catch { return false; }
    };
    if (!params?.authorization || !params.date || !validUpload(params.put_url) || !isBaiduImage(params.get_url)
      || params.thumb_url && !isBaiduImage(params.thumb_url)) throw new Error("贴吧返回的图片上传地址无效");
    await this.verifyAccount(account, expectedId);
    const response = await fetch(params.put_url, { method: "PUT", credentials: "omit", redirect: "error",
      signal: AbortSignal.timeout(60000), headers: { "Content-Type": upload.type, "Charset": "utf-8",
        Authorization: params.authorization, "x-bce-date": params.date }, body: upload.bytes });
    if (!response.ok) throw new Error(`图片上传失败（HTTP ${response.status}）`);
    await this.verifyAccount(account, expectedId);
    return { url: params.get_url, thumbnail: params.thumb_url || params.get_url };
  }

  async favoriteStickers(expectedId, refresh = false) {
    const account = await this.account(expectedId);
    if (!refresh && this.stickerCache?.accountId === account.id && Date.now() - this.stickerCache.created < 60000) {
      await this.verifyAccount(account, expectedId);
      return this.stickerCache.data;
    }
    const result = await this.app("/c/e/meme/getAllMeme", {
      BDUSS: account.token, _client_type: 2, _client_version: APP_VERSION,
    }, "同步手机端收藏表情");
    const data = parseFavoriteStickers(result.data);
    await this.verifyAccount(account, expectedId);
    this.stickerCache = { accountId: account.id, created: Date.now(), data };
    return data;
  }

  async send(roomId, text, expectedId, replyId = "", atData = null, upload = null, favoriteId = "") {
    if (upload && favoriteId) throw new Error("请一次选择一张图片或表情");
    let picture = upload ? imageUpload(upload) : null;
    if (!picture && !favoriteId && (typeof text !== "string" || !text.trim() || text.length > 2000)) throw new Error("请输入 1–2000 字的文字消息");
    const { state, account } = await this.roomState(roomId, expectedId);
    if (favoriteId) {
      const { stickers } = await this.favoriteStickers(expectedId);
      picture = stickers.find((sticker) => sticker.id === favoriteId);
      if (!picture) throw new Error("这个收藏表情已失效，请刷新表情库后重新选择");
    }
    let reply;
    if (replyId) {
      if (typeof replyId !== "string" || !/^\d{1,20}$/.test(replyId)) throw new Error("请选择有效的回复消息");
      const history = this.history(state, account);
      const target = history.get(replyId);
      if (!target?.key || target.hidden || target.recalled || [...history.values()].some((message) => message.deleted.includes(replyId))) {
        throw new Error("被回复的消息已失效，请重新选择");
      }
      reply = {
        re_msg_id: target.id, re_msg_key: target.key, re_nickname: target.name,
        re_baidu_uk: target.authorId,
        re_content_body: JSON.stringify({ text: `${target.name}：${target.text || (target.image ? "[图片]" : target.post?.title || "[消息]")}` }),
        re_content_type: target.contentType, re_ext: JSON.stringify({ msg_type: 1 }),
      };
    }
    const levelData = await this.app("/c/f/forum/getLevelInfo", {
      BDUSS: account.token, _client_version: APP_VERSION, forum_id: state.fid,
    }, "读取当前吧等级");
    if (levelData.user_level == null || !/^\d{1,2}$/.test(String(levelData.user_level))) throw new Error("未能读取当前吧等级，请稍后重试");
    const key = messageKey(state.authorId);
    const portrait = account.portrait ? `${account.portrait}?t=${Math.floor(Date.now() / 1000)}` : "";
    await this.verifyAccount(account, expectedId);

    // 真实客户端协议：BLCP WebSocket service3/method185（REST 端点已被服务端静默丢弃）
    const blcp = await this.getBlcp(account);
    // 发送前置：必须已 join 房间（SW 休眠重启后 joinedRooms 丢失会在这里补 join）
    if (!blcp.joinedRooms) blcp.joinedRooms = new Set();
    if (!blcp.joinedRooms.has(state.room)) {
      await blcp.joinChatRoom(Number(state.room));
      blcp.joinedRooms.add(state.room);
    }
    const body = picture?.url ? { url: picture.url, thumbnail: picture.thumbnail }
      : picture ? await this.uploadImage(account, blcp, picture, expectedId) : { text: text.trim() };
    const content = JSON.stringify({ text: JSON.stringify({
      room_id: state.room, type: "0", to_uid: "0", vip: String(Number(account.vip)), name: account.name,
      portrait, content_type: picture ? "1" : "0", content_body: JSON.stringify(body),
      src: "", baidu_uk: state.authorId, ...(reply ? { re_data: reply } : {}),
      ...(!picture && atData?.length ? { at_data: atData } : {}),
      ext: JSON.stringify(messageMetadata(account, state, Number(levelData.user_level), portrait, picture?.metadata, picture ? 2 : 1)),
    }) });
    await this.verifyAccount(account, expectedId);
    // origin_id 用 BLCP 登录响应里的 trigger_id（aiotieba 语义：self._user.trigger_id 由
    // BLCP login 填充）；HTTP 登录的 trigger_id 与其可能不同
    const originId = Number(blcp.user.triggerId) > 0 ? blcp.user.triggerId : Number(account.originId);
    const requestData = {
      method: 185,
      mcast_id: Number(state.room),    // 必须是数字——字符串会报 "mcast_id error"(err_code=5)
      role: 3,
      token: account.token,            // BDUSS
      appid: APP_ID,
      uk: blcp.user.uk,
      origin_id: originId,     // trigger_id
      type: 81,
      app_safe_ext: JSON.stringify({ haotianjing: { zid: "" } }),
      content,
      msg_key: key,
      account_type: 1,
      sdk_version: BLCP_SDK_VERSION,
      event_list: [
        { event: "CClickSendBegin", timestamp_ms: 0 },
        { event: "CSendBegin", timestamp_ms: 0 },
        { event: "CIMSendBegin", timestamp_ms: Math.floor(Date.now()) },
      ],
    };
    const messageId = await blcp.sendMethod185(requestData).catch((error) => {
      // 发送失败：把关键参数打到 console，方便与 aiotieba 对比定位 err_code=5
      console.error("[tieba] 发送失败详情:", error.message);
      console.error("[tieba] 发送参数:", JSON.stringify({
        uk: blcp.user.uk,
        origin_id: originId,
        msg_key: key,
        authorId: state.authorId,
        triggerId_blcp: blcp.user.triggerId,
        triggerId_http: account.originId,
        bdUid: blcp.user.bdUid,
        mcast_id: state.room,
        sdk_version: BLCP_SDK_VERSION,
      }));
      throw error;
    });
    await this.verifyAccount(account, expectedId);
    if (!messageId || String(messageId) === "0") throw new Error("贴吧未确认发送成功，请刷新消息列表后再决定是否重试");
    const current = (await chrome.storage.session.get(`room:${state.room}`))[`room:${state.room}`];
    await this.verifyAccount(account, expectedId);
    if (current?.accountId === account.id) {
      const sentKeys = Object.fromEntries(Object.entries({ ...current.sentKeys, [String(messageId)]: key }).slice(-100));
      await chrome.storage.session.set({ [`room:${state.room}`]: { ...current, sentKeys } });
    }
    await this.verifyAccount(account, expectedId);
    return { id: String(messageId), room: state.room };
  }

  /**
   * 以独立机器人账号身份发言（机器人版专用）。
   *
   * 与 send() 的区别：身份（token/name/portrait/authorId/vip）来自 bot 账号，
   * 而非浏览器 cookie 登录的聊天账号。房间上下文（fid）复用聊天账号 enter 时
   * 存下的 roomState——机器人版里管理员必先用自己的账号进入过该房间。
   *
   * @param {object} botAccount loginWithToken() 的返回（机器人账号）
   * @param {object} state      { room, fid } 聊天账号 enter 时存的房间上下文
   * @param {string} text       消息正文
   * @param {array}  atData     可选的 at_data
   */
  async sendAsBot(botAccount, state, text, atData = null) {
    if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new Error("请输入 1–2000 字的文字消息");
    if (!botAccount?.token) throw accountError("机器人账号未登录，请先在设置页填写 BDUSS");
    const room = positiveId(state.room);
    const fid = positiveId(state.fid);
    const authorId = await authorIdFromUserId(botAccount.id);

    const levelData = await this.app("/c/f/forum/getLevelInfo", {
      BDUSS: botAccount.token, _client_version: APP_VERSION, forum_id: fid,
    }, "读取当前吧等级");
    const level = levelData.user_level != null && /^\d{1,2}$/.test(String(levelData.user_level)) ? Number(levelData.user_level) : 1;
    const key = messageKey(authorId);
    const portrait = botAccount.portrait ? `${botAccount.portrait}?t=${Math.floor(Date.now() / 1000)}` : "";
    const content = JSON.stringify({ text: JSON.stringify({
      room_id: room, type: "0", to_uid: "0", vip: String(Number(botAccount.vip)), name: botAccount.name,
      portrait, content_type: "0", content_body: JSON.stringify({ text: text.trim() }),
      src: "", baidu_uk: authorId,
      ...(atData && atData.length ? { at_data: atData } : {}),
      ext: JSON.stringify(messageMetadata(botAccount, { fid, room }, level, portrait)),
    }) });

    const blcp = await this.getBlcp(botAccount);
    if (!blcp.joinedRooms) blcp.joinedRooms = new Set();
    if (!blcp.joinedRooms.has(room)) {
      await blcp.joinChatRoom(Number(room));
      blcp.joinedRooms.add(room);
    }
    const originId = Number(blcp.user.triggerId) > 0 ? blcp.user.triggerId : Number(botAccount.originId);
    const requestData = {
      method: 185,
      mcast_id: Number(room),
      role: 3,
      token: botAccount.token,
      appid: APP_ID,
      uk: blcp.user.uk,
      origin_id: originId,
      type: 81,
      app_safe_ext: JSON.stringify({ haotianjing: { zid: "" } }),
      content,
      msg_key: key,
      account_type: 1,
      sdk_version: BLCP_SDK_VERSION,
      event_list: [
        { event: "CClickSendBegin", timestamp_ms: 0 },
        { event: "CSendBegin", timestamp_ms: 0 },
        { event: "CIMSendBegin", timestamp_ms: Math.floor(Date.now()) },
      ],
    };
    const messageId = await blcp.sendMethod185(requestData).catch((error) => {
      console.error("[tieba][bot] 发送失败详情:", error.message);
      console.error("[tieba][bot] 发送参数:", JSON.stringify({
        uk: blcp.user.uk, origin_id: originId, msg_key: key, authorId,
        triggerId_blcp: blcp.user.triggerId, triggerId_http: botAccount.originId,
        bdUid: blcp.user.bdUid, mcast_id: room, sdk_version: BLCP_SDK_VERSION,
      }));
      throw error;
    });
    if (!messageId || String(messageId) === "0") throw new Error("贴吧未确认发送成功");
    return { id: String(messageId), room };
  }

  async recall(roomId, expectedId, id) {
    const { state, account } = await this.roomState(roomId, expectedId);
    let target = this.messageTarget(state, account, id);
    // 撤回本人：baidu_uk（authorId）或数字 user_id（from）任一匹配
    const own = (!!target.authorId && target.authorId === state.authorId)
      || (!!target.from && String(target.from) === String(account.id));
    if (!own) {
      const permissions = await this.roomPermissions(state, account, expectedId);
      target = this.messageTarget(state, account, id);
      if (!canRecallMessage({ ...state, ...permissions }, target)) {
        throw Object.assign(new Error("当前账号没有撤回这条消息的频道管理权限"), { code: "RECALL_FORBIDDEN" });
      }
    }
    if (!target.key || target.key.length > 512) throw new Error("这条消息缺少撤回标识，请刷新后重试");
    if (!/^[0-9a-f]{16,64}$/i.test(account.tbs || "")) throw new Error("登录校验码不可用，请重新连接后重试");
    const authorId = own ? account.id : await userIdFromAuthorId(target.authorId);
    await this.verifyAccount(account, expectedId);
    this.messageTarget(state, account, id);
    await this.app("/c/c/chatroom/withdrawMsg", {
      BDUSS: account.token, _client_version: APP_VERSION, tbs: account.tbs,
      msg_type: target.msgType || "0", uid_to: authorId, chatroom_id: state.room,
      msg_id: target.id, msg_key: target.key, forum_id: state.fid,
    }, "撤回消息");
    await this.verifyAccount(account, expectedId);
    return { room: state.room, id };
  }

  /**
   * 机器人账号撤回一条消息（基于关键词检测的自动撤回用）。
   *
   * 直接用 bot 账号（loginWithToken 结果）构造 withdrawMsg 请求，不依赖
   * historyCache——机器人走 BLCP 实时推送，历史缓存里可能没有 msg_key。
   *
   * @param {object} botAccount loginWithToken() 返回（需含 token/tbs/id）
   * @param {object} state      { room, fid } 房间上下文（fid 来自 settings.rooms）
   * @param {object} message    parseMessage 输出（需含 id/key/msgType/from/authorId）
   */
  async recallAsBot(botAccount, state, message) {
    if (!botAccount?.token) throw accountError("机器人账号未登录，请先在设置页填写 BDUSS");
    if (!message?.id || !message?.key) throw new Error("这条消息缺少撤回标识（msg_key），无法撤回");
    if (!/^[0-9a-f]{16,64}$/i.test(botAccount.tbs || "")) throw new Error("机器人账号登录校验码（tbs）不可用，请重新填写 BDUSS");
    const room = positiveId(state.room);
    const fid = positiveId(state.fid);
    // 撤回别人：uid_to = 从消息作者 baidu_uk 反解出的数字 user_id
    const authorId = await userIdFromAuthorId(message.authorId);
    await this.app("/c/c/chatroom/withdrawMsg", {
      BDUSS: botAccount.token, _client_version: APP_VERSION, tbs: botAccount.tbs,
      msg_type: message.msgType || "0", uid_to: authorId, chatroom_id: room,
      msg_id: message.id, msg_key: message.key, forum_id: fid,
    }, "机器人撤回消息");
    return { room, id: message.id };
  }
}
