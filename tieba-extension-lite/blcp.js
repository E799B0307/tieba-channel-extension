/**
 * blcp.js — 移植自 aiotieba/core/blcp.py
 * 实现百度贴吧聊天室 BLCP 协议（自定义二进制帧 over TCP+TLS）
 *
 * 传输层：本扩展无法直接开 raw TCP socket，通过本地代理
 * （proxy/proxy.js，ws://127.0.0.1:8765）转发字节流到
 * common.lcs.baidu.com:443 (TLS)。
 *
 * 帧格式（与 aiotieba BLCPData.toBytes 一致）：
 *   [4] "lcp\x01"
 *   [4] 大端 total_length = len(rpc) + len(lcm)
 *   [4] 大端 rpc_length = len(rpc)
 *   [.] rpc bytes (RpcMeta protobuf)
 *   [.] lcm bytes (RpcData protobuf 或 JSON 或 gzip 压缩的二者)
 */

import {
  encodeVarint, encodeKey, encodeBytesField, encodeStringField, encodeVarintField,
  concatBytes, parseFields, findField, findFields, bytesToString,
} from './protobuf.js';
import { md5 as md5Pure } from './crypto.js';

export const CHAT_APPID = 10773430;
export const CHAT_SDK_VERSION = 11250036;
export const CHAT_VERSION = '12.68.1.0';
const BLCP_HOST = 'common.lcs.baidu.com';
const BLCP_PORT = 443;
const PROXY_URL = 'ws://127.0.0.1:8765';

/* ---------------- protobuf 构造（RpcMeta / Lcm.RpcData） ---------------- */

function eventTimestamp(event, tsMs) {
  const f1 = encodeStringField(1, event);
  const f2 = encodeVarintField(2, tsMs);
  return concatBytes(f1, f2);
}

/** buildRpcBody(serviceId, methodId, correlationId, compress_type=0, need_common=1) */
function buildRpcBody(serviceId, methodId, correlationId, compressType = 0, needCommon = 1) {
  // RpcRequestMeta
  const req = concatBytes(
    encodeVarintField(3, correlationId),        // log_id
    encodeVarintField(1, serviceId),            // service_id
    encodeVarintField(2, methodId),             // method_id
    encodeVarintField(4, needCommon),           // need_common
    encodeBytesField(5, eventTimestamp('CLCPReqBegin', Date.now())), // event_list
  );

  // RpcMeta
  return concatBytes(
    encodeBytesField(1, req),                   // request
    encodeVarintField(4, correlationId),        // correlation_id
    encodeVarintField(3, compressType),         // compress_type (optional; 0 可省略但保留与 py 一致)
    encodeVarintField(9, 1),                    // accept_compress_type
  );
}

/** Lcm.RpcData（lcm_request）protobuf */
function buildLcmRequest({ logId, token, cuid, device, appId, appVersion, sdkVersion, network, timestamp, startType, connType }) {
  // Common
  const common = concatBytes(
    encodeStringField(1, cuid),
    encodeStringField(2, device),
    encodeStringField(6, appId),
    encodeStringField(7, appVersion),
    encodeStringField(8, sdkVersion),
    encodeStringField(9, network),
  );
  // LcmRequest
  const lcmRequest = concatBytes(
    encodeVarintField(1, logId),
    encodeStringField(2, token),
    encodeBytesField(3, common),
    encodeVarintField(4, timestamp),
    encodeVarintField(6, startType),
    encodeVarintField(7, connType),
  );
  // RpcData
  return concatBytes(encodeBytesField(1, lcmRequest));
}

/* ---------------- 帧编解码 ---------------- */

export function packFrame(rpcBody, lcmBody) {
  const total = rpcBody.length + lcmBody.length;
  const header = new Uint8Array(4 + 4 + 4);
  header.set([0x6c, 0x63, 0x70, 0x01], 0);       // "lcp\x01"
  new DataView(header.buffer).setUint32(4, total, false);
  new DataView(header.buffer).setUint32(8, rpcBody.length, false);
  return concatBytes(header, rpcBody, lcmBody);
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}

function tryParseJson(bytes) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { return null; }
}

/** 解析一个 RpcMeta（proto）为 { serviceId, methodId, correlationId, errorCode, errorText, isNotify } */
function parseRpcMeta(bytes) {
  const fields = parseFields(bytes);
  let serviceId = 0, methodId = 0, correlationId = 0, errorCode = 0, errorText = '', isNotify = false;

  const response = findField(fields, 2);
  if (response && response.value) {
    const rf = parseFields(response.value);
    serviceId = Number(findField(rf, 1)?.value ?? 0);
    methodId = Number(findField(rf, 2)?.value ?? 0);
    const logId = findField(rf, 3);
    const ec = findField(rf, 4);
    const et = findField(rf, 5);
    errorCode = Number(ec?.value ?? 0);
    errorText = et?.value ? bytesToString(et.value) : '';
  } else {
    // 可能是 request meta（回显），从 request 取 service/method
    const request = findField(fields, 1);
    if (request?.value) {
      const rf = parseFields(request.value);
      serviceId = Number(findField(rf, 1)?.value ?? 0);
      methodId = Number(findField(rf, 2)?.value ?? 0);
    }
  }
  const cid = findField(fields, 4);
  if (cid) correlationId = Number(cid.value);

  const notify = findField(fields, 8);
  if (notify?.value) {
    const nf = parseFields(notify.value);
    isNotify = true;
    serviceId = Number(findField(nf, 1)?.value ?? serviceId);
    methodId = Number(findField(nf, 2)?.value ?? methodId);
  }
  return { serviceId, methodId, correlationId, errorCode, errorText, isNotify };
}

/** 解析 Lcm body 为 { kind:'json', data } 或 { kind:'rpcdata', fields } */
function parseLcmBody(bytes) {
  // 先尝试直接 JSON
  const j = tryParseJson(bytes);
  if (j !== null) return { kind: 'json', data: j };

  // 尝试 protobuf RpcData：能解析且字段合法即可
  try {
    const fields = parseFields(bytes);
    if (fields.length > 0) return { kind: 'rpcdata', fields };
  } catch { /* fallthrough */ }

  return { kind: 'raw', bytes };
}

/* ---------------- 主类 ---------------- */

export class BLCPClient {
  constructor({ bduss, cuidGalaxy2, c3Aid, zId = '', sampleId = '' }) {
    this.bduss = bduss;
    this.cuidGalaxy2 = cuidGalaxy2;
    this.c3Aid = c3Aid;
    this.zId = zId;
    this.sampleId = sampleId;
    this.ws = null;
    this.status = -1;          // -1 未连接, 0 已连接未登录, 1 已登录
    this.waiters = new Map();  // correlationId -> {resolve, reject, timer}
    this.messageHandlers = []; // 收到 notify 消息时回调
    this._reader = null;
    this._buf = new Uint8Array(0);
    this._writeLock = Promise.resolve();

    // 登录后填充
    this.user = { userId: 0, portrait: '', nickName: '', uk: 0, triggerId: -1, bdUid: 0, loginId: 0, isVip: false, glevel: 0 };
  }

  onMessage(handler) { this.messageHandlers.push(handler); }

  /* ---------- 连接（经本地代理转发到 TCP+TLS） ---------- */
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(PROXY_URL);
      this.ws = ws;
      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        reject(new Error('连接本地代理超时，请先启动 proxy/proxy.js (node proxy.js)'));
      }, 5000);

      ws.onopen = () => {
        // 告诉代理要连接的目标
        ws.send(JSON.stringify({ op: 'connect', host: BLCP_HOST, port: BLCP_PORT }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data);
          if (msg.op === 'connected') {
            clearTimeout(timeout);
            this.status = 0;
            this._startReader();
            resolve();
          } else if (msg.op === 'error') {
            clearTimeout(timeout);
            reject(new Error(msg.error || '代理连接失败'));
          }
        } else {
          this._onBytes(new Uint8Array(ev.data));
        }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('无法连接本地代理 ws://127.0.0.1:8765')); };
      ws.onclose = () => {
        this.status = -1;
        this._rejectAllWaiters(new Error('连接已断开'));
      };
    });
  }

  _startReader() {
    this._reader = (async () => {
      // 帧解析在 _onBytes 中进行
    })();
  }

  _onBytes(bytes) {
    // 追加到缓冲区并尝试解析完整帧
    const merged = new Uint8Array(this._buf.length + bytes.length);
    merged.set(this._buf, 0);
    merged.set(bytes, this._buf.length);
    this._buf = merged;

    while (true) {
      if (this._buf.length < 4) break;
      if (this._buf[0] !== 0x6c || this._buf[1] !== 0x63 || this._buf[2] !== 0x70 || this._buf[3] !== 0x01) {
        // 非法帧头，丢弃一个字节重试（容错）
        this._buf = this._buf.slice(1);
        continue;
      }
      if (this._buf.length < 12) break;
      const dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.length);
      const totalLen = dv.getUint32(4, false);
      const rpcLen = dv.getUint32(8, false);
      const frameTotal = 12 + totalLen;
      if (this._buf.length < frameTotal) break;

      const frame = this._buf.slice(0, frameTotal);
      this._buf = this._buf.slice(frameTotal);
      this._handleFrame(frame.slice(12), rpcLen);
    }
  }

  _handleFrame(body, rpcLen) {
    const rpcBytes = body.slice(0, rpcLen);
    const lcmBytes = body.slice(rpcLen);
    const meta = parseRpcMeta(rpcBytes);

    if (meta.isNotify) {
      // 群聊消息等服务器主动推送；LcmBody 是 JSON（含 messages）
      const parsed = parseLcmBody(lcmBytes);
      const packet = parsed.kind === 'json' ? parsed.data : (parsed.kind === 'rpcdata' ? parseRpcDataToObj(parsed.fields) : null);
      for (const h of this.messageHandlers) {
        try { h(packet, meta); } catch {}
      }
      return;
    }

    // 心跳响应（service 1 method 3）直接忽略
    if (meta.serviceId === 1 && meta.methodId === 3) return;

    // 匹配请求等待器
    const w = this.waiters.get(meta.correlationId);
    if (w) {
      this.waiters.delete(meta.correlationId);
      clearTimeout(w.timer);
      w.resolve({ meta, lcmBytes, lcm: parseLcmBody(lcmBytes) });
    }
  }

  _rejectAllWaiters(err) {
    for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters.clear();
  }

  async _write(bytes) {
    this._writeLock = this._writeLock.then(async () => {
      if (this.ws?.readyState === 1) this.ws.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    });
    await this._writeLock;
  }

  /** 发送请求并等待响应（correlationId 匹配） */
  async _request(serviceId, methodId, lcmBody, correlationId = null, timeoutMs = 8000) {
    if (correlationId === null) correlationId = Math.floor(Math.random() * 9e15) + 1e15;
    const rpcBody = buildRpcBody(serviceId, methodId, correlationId);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(correlationId);
        reject(new Error(`BLCP 请求超时 service=${serviceId} method=${methodId}`));
      }, timeoutMs);
      this.waiters.set(correlationId, { resolve, reject, timer });
    });

    await this._write(packFrame(rpcBody, lcmBody));
    return promise;
  }

  /* ---------- 登录（三步握手） ---------- */
  async login() {
    // 第一步：握手 service 1 / method 1
    const blcpToken = await this.generateLcmToken();
    const ts = Date.now();
    // log_id 需等于 correlationId
    const cid1 = Math.floor(Math.random() * 9e15) + 1e15;
    const lcm1b = buildLcmRequest({
      logId: cid1, token: blcpToken, cuid: this.cuidGalaxy2, device: 'android',
      appId: String(CHAT_APPID), appVersion: CHAT_VERSION, sdkVersion: '3460016',
      network: 'wifi', timestamp: ts, startType: -1, connType: 1,
    });
    const r1 = await this._request(1, 1, lcm1b, cid1);
    this._checkHandshake(r1, 'BLCP Handshake 1');

    // 第二步：service 4 / method 1（部分参数来自 CommonUrlParamManager）
    const reqdict2 = {
      params: {
        appname: 'tieba',
        sid: this.sampleId,
        ua: '900_1600_android_12.68.1.0_240',
        uid: this._enuid(),
        cfrom: '1008550l',
        from: '1008550l',
        network: '1_-1',
        p_sv: '32',
        mps: '',
        mpv: '1',
        c3_aid: this.c3Aid,
        type_id: '0',
      },
      filter: { aps: { cpu_abi: 'armeabi-v7a' }, command: { step: '0' } },
    };
    const lcm2 = new TextEncoder().encode(JSON.stringify(reqdict2));
    const r2 = await this._request(4, 1, lcm2);
    this._checkHandshake2(r2, 'BLCP Handshake 2');

    // 第三步：service 2 / method 50（登录）
    const reqdict3 = {
      method: 50,
      appid: CHAT_APPID,
      device_id: 'android_' + this.cuidGalaxy2,
      account_type: 1,
      token: this.bduss,
      version: 4,
      sdk_version: CHAT_SDK_VERSION,
      app_version: CHAT_VERSION,
      app_open_type: 0,
      client_identifier: JSON.stringify({ zid: '', version_code: '' }),
      tail: 0,
      timeout: 10,
      cookie: '',
      device_info: {
        app_version: CHAT_VERSION,
        os_version: '32',
        platform: 'android',
        appid: String(CHAT_APPID),
        from: '1008550l',
        cfrom: '1008550l',
      },
      rpc: JSON.stringify({ rpc_retry_time: 0 }),
      user_type: 0,
      client_logid: Math.floor(Date.now() * 1000),
    };
    const lcm3 = new TextEncoder().encode(JSON.stringify(reqdict3));
    const r3 = await this._request(2, 50, lcm3, 2000003149381050);
    this._checkHandshake3(r3, 'BLCP Handshake 3');

    // 解析登录响应，填充 user
    const rep = r3.lcm.kind === 'json' ? r3.lcm.data : {};
    // 统一转数字：接口可能把大整数回传成字符串，method185 的 uk/origin_id 需要数字类型
    this.user.uk = Number(rep.uk) || 0;
    this.user.bdUid = Number(rep.bd_uid) || 0;
    this.user.triggerId = Number(rep.trigger_id?.[0]) || -1;
    this.user.loginId = Number(rep.login_id) || 0;

    this.status = 1;
    return this.user;
  }

  _enuid() {
    // EnUid：cuid_galaxy2 的变种 base64（libbase64encoder_v2_0.so）
    // 见 lib/crypto.js enuid；这里内联避免循环依赖
    const bytes = new TextEncoder().encode(this.cuidGalaxy2);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _checkHandshake(r, msg) {
    const parsed = r.lcm.kind === 'rpcdata' ? parseRpcDataToObj(r.lcm.fields) : null;
    if (r.meta.errorText && r.meta.errorText !== 'success') throw new Error(msg + ': ' + r.meta.errorText);
    if (parsed && parsed.lcmResponse?.errorMsg && parsed.lcmResponse.errorMsg !== 'success') {
      throw new Error(msg + ': ' + parsed.lcmResponse.errorMsg);
    }
  }
  _checkHandshake2(r, msg) {
    const d = r.lcm.kind === 'json' ? r.lcm.data : null;
    if (r.meta.errorText && r.meta.errorText !== 'success') throw new Error(msg + ': ' + r.meta.errorText);
    if (d && d.errno !== undefined && String(d.errno) !== '0') throw new Error(msg + ': errno=' + d.errno);
  }
  _checkHandshake3(r, msg) {
    const d = r.lcm.kind === 'json' ? r.lcm.data : null;
    if (r.meta.errorText && r.meta.errorText !== 'success') throw new Error(msg + ': ' + r.meta.errorText);
    if (d && d.err_code !== undefined && d.err_code !== 0) throw new Error(msg + ': err_code=' + d.err_code);
  }

  async generateLcmToken() {
    const cuid = this.cuidGalaxy2;
    const ts = Date.now();
    const requestId = String(ts);
    const signStr = String(CHAT_APPID) + cuid + 'android' + String(ts);
    const sign = await this._md5Hex(signStr);
    const data = {
      app_id: String(CHAT_APPID),
      app_version: CHAT_VERSION,
      cuid,
      device_type: 'android',
      manufacture: '',
      model_type: '',
      request_id: requestId,
      sdk_version: '3460016',
      sign,
      ts,
      user_key: '',
    };
    const resp = await fetch('https://pim.baidu.com/rest/5.0/generate_lcm_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
      body: JSON.stringify(data),
    });
    const rjson = await resp.json();
    return rjson.token ?? '';
  }

  async _md5Hex(str) {
    const h = await md5Pure(new TextEncoder().encode(str));
    return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- 心跳 ---------- */
  async heartbeat() {
    if (this.status !== 1) return;
    // py: RpcData{ lcm_request{ log_id=correlationId, timestamp=now } }
    const cid = Math.floor(Math.random() * 9e15) + 1e15;
    const lcmRequest = concatBytes(
      encodeVarintField(1, cid),        // log_id
      encodeVarintField(4, Date.now()), // timestamp
    );
    const lcm = concatBytes(encodeBytesField(1, lcmRequest)); // RpcData.lcm_request
    try {
      await this._write(packFrame(buildRpcBody(1, 3, cid), lcm));
    } catch { /* 心跳失败忽略 */ }
  }

  /* ---------- 加入聊天室 ---------- */
  async joinChatRoom(chatroomId) {
    if (this.status !== 1) throw new Error('IM 未登录');
    const reqdict = {
      method: 201,
      mcast_id: chatroomId,
      appid: CHAT_APPID,
      uk: this.user.uk,
      origin_id: this.user.triggerId,
      msg_key: 'k' + Math.floor(Date.now() * 100000),
      sdk_version: CHAT_SDK_VERSION,
      is_reliable: false,
      client_logid: Math.floor(Date.now() * 1000 * 1000),
      rpc: JSON.stringify({ rpc_retry_time: 0 }),
    };
    const lcm = new TextEncoder().encode(JSON.stringify(reqdict));
    const r = await this._request(3, 201, lcm);
    const d = r.lcm.kind === 'json' ? r.lcm.data : null;
    if (r.meta.errorText && r.meta.errorText !== 'success') {
      throw new Error(`加入房间失败: err_code=${r.meta.errorCode} ${r.meta.errorText}`);
    }
    if (d && d.err_code !== undefined && d.err_code !== 0) {
      throw new Error(`加入房间失败: err_code=${d.err_code} ${d.err_msg || d.errmsg || d.error_msg || ''}`);
    }
    return true;
  }

  /* ---------- 发送消息（method 185） ---------- */
  /** 用内建 _buildSendRequestData 构造（简单文本发送） */
  async sendChatroomMsg({ roomId, forumId, text, atData = [], robot = -1 }) {
    if (this.status !== 1) throw new Error('IM 未登录');
    const u = this.user;
    const requestData = this._buildSendRequestData({ roomId, forumId, text, atData, robot, user: u });
    return this.sendMethod185(requestData);
  }

  /** 发送一个已构造好的 method185 请求体，返回服务端 msgid（字符串） */
  async sendMethod185(requestData) {
    if (this.status !== 1) throw new Error('IM 未登录');
    const correlationId = Math.floor(Date.now() * 1000 * 1000);
    requestData.client_logid = correlationId;
    requestData.rpc = JSON.stringify({ rpc_retry_time: 0 });

    const lcm = new TextEncoder().encode(JSON.stringify(requestData));
    const r = await this._request(3, 185, lcm, correlationId);
    const d = r.lcm.kind === 'json' ? r.lcm.data : null;
    if (r.meta.errorText && r.meta.errorText !== 'success') {
      throw new Error(`发送失败: err_code=${r.meta.errorCode} ${r.meta.errorText}`);
    }
    if (d && d.err_code !== undefined && d.err_code !== 0) {
      // 完整透出原始响应，便于定位 err_code=5 的确切含义
      const raw = JSON.stringify(d).slice(0, 500);
      throw new Error(`发送失败: err_code=${d.err_code} err_msg=${d.err_msg || d.errmsg || d.error_msg || "(空)"} | 原始响应: ${raw}`);
    }
    // 服务端确认消息 id
    return d?.response_params?.msgid ?? d?.msgid ?? null;
  }

  async react(requestData) {
    if (this.status !== 1) throw new Error('IM 未登录');
    const correlationId = this._reactionId = Math.max(Date.now() * 1000, (this._reactionId || 0) + 1);
    const body = { ...requestData, client_logid: correlationId, rpc: JSON.stringify({ rpc_retry_time: 0 }) };
    const response = await this._request(3, 214, new TextEncoder().encode(JSON.stringify(body)), correlationId);
    const data = response.lcm.kind === 'json' ? response.lcm.data : null;
    if (Number(response.meta.errorCode || 0) !== 0 || !data || Number(data.err_code ?? data.error_code ?? 0) !== 0) {
      throw new Error('贴表情请求未成功：' + (data?.err_msg || response.meta.errorText || '响应不可用'));
    }
    return data;
  }

  _buildSendRequestData({ roomId, forumId, text, atData, robot, user, level }) {
    // 与 aiotieba send_chatroom_msg/_api.py construct_request_data 一致
    const portrait = (user.portrait || '') + '?t=' + Math.floor(Date.now() / 1000);
    const contentText = {
      room_id: String(roomId),
      type: '0',
      to_uid: '0',
      vip: String(user.isVip ? 1 : 0),
      name: user.nickName || '',
      portrait,
      content_type: '0',
      content_body: JSON.stringify({ text }),
      src: '',
      baidu_uk: this.getBDUKfromUserId(String(user.userId)),
      ext: {},
    };

    // ext_data
    const extData = {
      main_data: this._buildMainData({ forumId, portrait, user, level }),
      is_sys_msg: 0,
      version: '',
      portrait,
      robot_role: 0,
      role: 0,
      send_status: 0,
      from: 'android',
      session_id: roomId,
      type: 1,
      user_name: user.nickName || '',
      level: level ?? 0,
      forum_id: forumId,
    };
    if (robot === -1) extData.content = {};
    else extData.content = { robot_params: { scene: 'tieba_group_chat', type: robot } };

    contentText.ext = JSON.stringify(extData);
    if (atData && atData.length) contentText.at_data = atData;

    const content = JSON.stringify({ text: JSON.stringify(contentText) });

    const appSafeExt = { haotianjing: { zid: this.zId || '' } };
    const requestData = {
      method: 185,
      mcast_id: roomId,
      role: 3,
      token: this.bduss,
      appid: CHAT_APPID,
      uk: user.uk,
      origin_id: user.triggerId,
      type: 81,
      app_safe_ext: JSON.stringify(appSafeExt),
      content,
      msg_key: this.getmsgkey(this.getBDUKfromUserId(String(user.userId))),
      account_type: 1,
      sdk_version: CHAT_SDK_VERSION,
      event_list: [
        { event: 'CClickSendBegin', timestamp_ms: 0 },
        { event: 'CSendBegin', timestamp_ms: 0 },
        { event: 'CIMSendBegin', timestamp_ms: Math.floor(Date.now()) },
      ],
    };
    return requestData;
  }

  _buildMainData({ forumId, portrait, user, level }) {
    const mainData = [];
    if (user.isVip) {
      mainData.push({
        icon: {
          height: 75, priority: 2,
          schema: 'https://tieba.baidu.com/mo/q/hybrid-business-vip/tbvip?customfullscreen=1&nonavigationbar=1',
          type: '1', url: 'https://tieba-ares.cdn.bcebos.com/mis/2023-7/1689061482682/13afea50121d.png', width: 75,
        }, type: 2,
      });
    }
    const namedata = {
      text: { short_enable: 1, short_length: 5, short_priority: 1, priority: 1, str: user.nickName || '', suffix: '...', type: '1' },
      type: 1,
    };
    if (user.isVip) namedata.text.text_color = { day: 'CAM_X0301', night: 'CAM_X0301', type: 2 };
    mainData.push(namedata);
    mainData.push({
      icon: {
        height: 15, priority: 5,
        schema: 'https://tieba.baidu.com/mo/q/hybrid-main-user/taskCenter?customfullscreen=1&nonavigationbar=1',
        type: '3', url: 'local://icon/icon_mask_level_usergrouth_' + (user.glevel || 0) + '?type=webp', width: 24,
      }, type: 2,
    });
    mainData.push({
      icon: {
        height: 12, priority: 2,
        schema: 'https://tieba.baidu.com/mo/q/wise-bawu-core/forum-level?customfullscreen=1&forum_id=' + forumId + '&nonavigationbar=1&obj_locate=5&portrait=' + portrait,
        type: '4', url: 'local://icon/icon_level_' + String(level ?? 0).padStart(2, '0') + '?type=webp', width: 16,
      }, type: 2,
    });
    return mainData;
  }

  /* ---------- AES-CBC getBDUKfromUserId（固定密钥） ---------- */
  async getBDUKfromUserId(userIdStr) {
    const key = new Uint8Array([0x41, 0x46, 0x44, 0x33, 0x31, 0x31, 0x38, 0x33, 0x32, 0x45, 0x44, 0x45, 0x45, 0x41, 0x45, 0x46]); // "AFD311832EDEEAEF"
    const iv = new Uint8Array([0x32, 0x30, 0x31, 0x31, 0x31, 0x32, 0x31, 0x32, 0x31, 0x34, 0x33, 0x30, 0x30, 0x30, 0x31, 0x30]); // "2011121211143000"
    // PKCS7 padding
    const plain = new TextEncoder().encode(userIdStr);
    const padLen = 16 - (plain.length % 16);
    const padded = new Uint8Array(plain.length + padLen);
    padded.set(plain);
    padded.fill(padLen, plain.length);
    const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, padded));
    // base64url 去 padding
    let bin = '';
    for (const b of enc) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  getmsgkey(bduk) {
    return bduk + String(Math.floor(Date.now()) * 1000) + String(Math.floor(Math.random() * 2e9) - 1e9);
  }

  /* ---------- 断开 ---------- */
  close() {
    try { this.ws?.close(); } catch {}
    this.status = -1;
  }
}

/** 将 RpcData protobuf fields 转为对象（含 lcm_response） */
function parseRpcDataToObj(fields) {
  const obj = { lcmRequest: null, lcmResponse: null, lcmNotify: null };
  const lr = findField(fields, 1);
  const lresp = findField(fields, 2);
  if (lr?.value) {
    const rf = parseFields(lr.value);
    obj.lcmRequest = {
      logId: Number(findField(rf, 1)?.value ?? 0),
      token: findField(rf, 2)?.value ? bytesToString(findField(rf, 2).value) : '',
      timestamp: Number(findField(rf, 4)?.value ?? 0),
    };
  }
  if (lresp?.value) {
    const rf = parseFields(lresp.value);
    obj.lcmResponse = {
      logId: Number(findField(rf, 1)?.value ?? 0),
      errorCode: Number(findField(rf, 2)?.value ?? 0),
      errorMsg: findField(rf, 3)?.value ? bytesToString(findField(rf, 3).value) : '',
    };
  }
  return obj;
}
