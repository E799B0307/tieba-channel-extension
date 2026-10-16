import { authorIdFromUserId } from "./protocol.js";

const CONFIG = "autoRecallSettings";
const RECORDS = "autoRecallRecords";
const MAX_AGE = 5 * 60 * 1000;
const validId = (value) => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
const defaults = () => ({ enabled: false, ownerId: "", botBduss: "", recallWords: [], rooms: [], revision: "", startedAt: 0 });

// Literal, case-insensitive matching, as in the supplied bot's checkRecallWords.
export function checkRecallWords(text, words) {
  const source = String(text || "").toLowerCase();
  return words.filter((word) => word && source.includes(word.toLowerCase()));
}

function messageTime(message) {
  const time = Number(message.time);
  return time >= 1e14 ? time / 1000 : time >= 1e11 ? time : time * 1000;
}

export class AutoRecallBot {
  constructor(reader, actor) {
    this.reader = reader;
    this.actor = actor;
    this.account = null;
    this.work = Promise.resolve();
    this.edits = Promise.resolve();
    this.pollTask = null;
    this.status = "未启用";
    this.stopVersion = 0;
    this.stopping = false;
  }

  async settings() {
    const stored = await chrome.storage.local.get(CONFIG);
    return { ...defaults(), ...stored[CONFIG] };
  }

  async snapshot() {
    const config = await this.settings();
    const { botBduss, ...settings } = config;
    const records = (await chrome.storage.local.get(RECORDS))[RECORDS] || [];
    return { settings, hasToken: !!botBduss, status: this.status, records: records.slice(-100).reverse() };
  }

  edit(update) {
    const task = this.edits.then(async () => {
      const config = await this.settings();
      await update(config);
      config.revision = crypto.randomUUID();
      await chrome.storage.local.set({ [CONFIG]: config });
      this.status = config.enabled ? "等待检测" : "已停用";
      return this.snapshot();
    });
    this.edits = task.catch(() => {});
    return task;
  }

  async owner(config) {
    const account = await this.reader.account(config.ownerId || undefined);
    if (config.ownerId && config.ownerId !== account.id) throw new Error("请使用添加频道时的贴吧账号");
    config.ownerId = account.id;
    return account;
  }

  save(patch) {
    const stopVersion = this.stopVersion;
    if (patch.enabled === false) { this.stopVersion += 1; this.stopping = true; }
    return this.edit(async (config) => {
      if (typeof patch.enabled !== "boolean" || !Array.isArray(patch.recallWords) || patch.recallWords.length > 200
        || patch.recallWords.some((word) => typeof word !== "string" || !word.trim() || word.length > 100)) {
        throw new Error("关键词最多 200 个，每个 1–100 字");
      }
      if (patch.botBduss !== undefined) {
        if (typeof patch.botBduss !== "string" || patch.botBduss.length > 2048 || /\s/.test(patch.botBduss)) {
          throw new Error("机器人凭据格式无效");
        }
        config.botBduss = patch.botBduss;
        this.account = null;
      }
      config.recallWords = [...new Set(patch.recallWords.map((word) => word.trim()))];
      if (patch.enabled) {
        await this.owner(config);
        if (!config.botBduss || !config.recallWords.length || !config.rooms.length) {
          throw new Error("启用前请配置机器人账号、关键词和频道");
        }
        try { this.account = await this.actor.loginWithToken(config.botBduss); }
        catch { throw new Error("机器人登录失败，请检查凭据"); }
      }
      config.startedAt = Date.now();
      config.enabled = patch.enabled;
      if (patch.enabled && stopVersion === this.stopVersion) this.stopping = false;
    });
  }

  addRoom(roomId, expectedId) {
    return this.edit(async (config) => {
      const { state, account } = await this.reader.roomState(roomId, expectedId);
      const forum = (await chrome.storage.session.get(`forum:${state.fid}`))[`forum:${state.fid}`];
      if (forum?.accountId !== account.id || forum.name !== "嘉然" || !forum.rooms.some((entry) => entry.id === state.room)) {
        throw new Error("请在侧栏查找嘉然吧并进入频道后添加");
      }
      if (config.ownerId && config.ownerId !== account.id) throw new Error("频道属于另一登录账号，请先移除原频道");
      if (!config.rooms.some((room) => room.roomId === state.room)) {
        if (config.rooms.length >= 20) throw new Error("最多启用 20 个频道");
        config.rooms.push({ roomId: state.room, fid: state.fid, name: state.name, addedAt: Date.now() });
      }
      config.ownerId = account.id;
    });
  }

  removeRoom(roomId) {
    return this.edit(async (config) => {
      if (!validId(roomId)) throw new Error("频道无效");
      config.rooms = config.rooms.filter((room) => room.roomId !== roomId);
      if (!config.rooms.length) { config.enabled = false; config.ownerId = ""; }
    });
  }

  accept(messages, ownerId) {
    const task = this.work.then(() => this.process(messages, ownerId));
    this.work = task.catch(() => { this.status = "检测失败，请检查登录与代理连接"; });
    return task;
  }

  async process(messages, ownerId) {
    let records = (await chrome.storage.local.get(RECORDS))[RECORDS] || [];
    let updated = false;
    for (const message of messages) {
      const deleted = message.recalled ? [message.id, ...(message.deleted || [])] : message.deleted || [];
      for (const row of records) {
        if (row.ownerId === ownerId && message.room === row.room && deleted.includes(row.id) && row.status === "accepted") {
          row.status = "confirmed";
          updated = true;
        }
      }
    }
    if (updated) await chrome.storage.local.set({ [RECORDS]: records });
    const config = await this.settings();
    if (this.stopping || !config.enabled || !ownerId || config.ownerId !== ownerId) return;
    for (const message of messages) {
      const room = config.rooms.find((entry) => entry.roomId === message.room);
      const time = messageTime(message);
      if (!room || !validId(message.id) || !message.authorId || !message.text
        || message.system || message.removed || message.hidden || message.recalled || message.deleted?.length
        || !Number.isFinite(time) || time < Math.max(config.startedAt, room.addedAt, Date.now() - MAX_AGE)
        || time > Date.now() + 60000) continue;
      const words = checkRecallWords(message.text, config.recallWords);
      if (messages.some((event) => event.room === message.room && event.deleted?.includes(message.id))) continue;
      if (!words.length || records.some((row) => row.ownerId === ownerId && row.room === room.roomId && row.id === message.id)) continue;
      // A later history read can fill msg_key; do not consume the message until then.
      if (!message.key) continue;
      const guard = async () => {
        await this.reader.account(ownerId);
        const current = await this.settings();
        if (this.stopping || !current.enabled || current.revision !== config.revision) throw Object.assign(new Error("配置已变化"), { code: "BOT_CANCELLED" });
      };
      try {
        await guard();
        if (!this.account || this.account.token !== config.botBduss || Date.now() - this.account.created > 300000) {
          this.account = await this.actor.loginWithToken(config.botBduss);
        }
        if (message.authorId === await authorIdFromUserId(this.account.id)) continue;
      } catch (error) {
        this.status = error.code === "BOT_CANCELLED" ? "配置已更新" : "检测暂停，请检查登录状态";
        return;
      }
      const row = { ownerId, room: room.roomId, name: room.name, id: message.id, words, at: Date.now(), status: "pending" };
      // Persist before the request: restarting the worker must never repeat a withdrawal.
      records = records.filter((entry) => entry.at > Date.now() - 86400000);
      if (records.length >= 2000 && records[0].at >= Date.now() - MAX_AGE) {
        this.status = "近期处理记录已满，暂停自动撤回";
        return;
      }
      records.push(row);
      records = records.slice(-2000);
      await chrome.storage.local.set({ [RECORDS]: records });
      try {
        await this.actor.recallAsBot(this.account, { room: room.roomId, fid: room.fid }, message, guard);
        row.status = "accepted";
        this.status = "正在检测";
      } catch (error) {
        row.status = error.code === "BOT_CANCELLED" ? "cancelled" : error.code === "RECALL_FORBIDDEN" ? "forbidden" : "failed";
      }
      await chrome.storage.local.set({ [RECORDS]: records });
    }
  }

  poll() {
    if (this.pollTask) return this.pollTask;
    this.pollTask = this.scan().catch(() => { this.status = "检测暂停，请检查登录状态与网络"; })
      .finally(() => { this.pollTask = null; });
    return this.pollTask;
  }

  async scan() {
    const config = await this.settings();
    if (this.stopping || !config.enabled) return;
    const account = await this.reader.account(config.ownerId);
    const authorId = await authorIdFromUserId(account.id);
    this.status = "正在检测";
    for (const room of config.rooms) {
      const current = await this.settings();
      if (this.stopping || !current.enabled || current.revision !== config.revision) return;
      try {
        await this.reader.ensureJoined(room.roomId, account.id);
        const state = { room: room.roomId, fid: room.fid, name: room.name, accountId: account.id, authorId, sentKeys: {} };
        const data = await this.reader.readMessages(state, account);
        await this.accept(data.messages, account.id);
      } catch (error) {
        if (error.code === "ACCOUNT_CHANGED") throw error;
        this.status = "部分频道检测失败，请检查网络与权限";
      }
    }
  }
}
