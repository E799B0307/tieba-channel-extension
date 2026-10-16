/**
 * proxy/proxy.js — 本地 TCP+TLS 转发代理
 *
 * 浏览器扩展无法直接开 raw TCP socket，此代理在本地监听
 * ws://127.0.0.1:8765，把扩展发来的字节流转发到目标 TCP+TLS 服务
 * （默认 common.lcs.baidu.com:443），并把响应原样回传。
 *
 * 用法：node proxy.js
 * 依赖：仅 Node 内置模块（ws 用原生 http upgrade 实现，避免额外依赖）
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const LISTEN_PORT = 8765;

/** 极简 WebSocket 服务端（仅支持 text/binary 帧，够用） */
class MiniWsServer {
  constructor(server) {
    this.server = server;
    this.connections = new Set();
    server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = { socket, buffer: Buffer.alloc(0), handlers: [] };
    this.connections.add(conn);
    socket.on('data', (d) => this._onData(conn, d));
    socket.on('close', () => { this.connections.delete(conn); conn.onclose && conn.onclose(); });
    socket.on('error', () => {});
    if (head && head.length) this._onData(conn, head);
    this.onconnection && this.onconnection(conn);
  }

  _onData(conn, chunk) {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    while (true) {
      const frame = this._parseFrame(conn.buffer);
      if (!frame) break;
      conn.buffer = conn.buffer.slice(frame.total);
      if (frame.opcode === 0x8) { // close
        conn.socket.end();
        break;
      }
      if (frame.opcode === 0x9) { // ping -> pong
        this._sendFrame(conn, 0xA, frame.payload);
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        conn.onmessage && conn.onmessage(conn, frame.payload, frame.opcode === 0x1);
      }
    }
  }

  _parseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2)); offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.slice(offset, offset + 4); offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.slice(offset, offset + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    }
    return { fin, opcode, payload, total: offset + len };
  }

  _sendFrame(conn, opcode, payload) {
    payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    conn.socket.write(Buffer.concat([header, payload]));
  }
}

// 主逻辑
const httpServer = http.createServer((req, res) => { res.writeHead(200); res.end('tieba-bot proxy'); });

const ws = new MiniWsServer(httpServer);

ws.onconnection = (conn) => {
  let target = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { target && target.destroy(); } catch {}
    try { conn.socket.end(); } catch {}
  };

  conn.onmessage = (conn, payload, isText) => {
    if (isText) {
      // 控制消息：connect
      try {
        const msg = JSON.parse(payload.toString());
        if (msg.op === 'connect') {
          connectTarget(msg.host || 'common.lcs.baidu.com', msg.port || 443);
        }
      } catch {}
      return;
    }
    // 二进制：转发到目标
    if (target && !target.destroyed) {
      target.write(payload);
    }
  };

  conn.onclose = cleanup;

  function connectTarget(host, port) {
    target = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      ws._sendFrame(conn, 0x1, JSON.stringify({ op: 'connected' }));
    });
    target.on('data', (d) => {
      ws._sendFrame(conn, 0x2, d); // binary
    });
    target.on('error', (e) => {
      try { ws._sendFrame(conn, 0x1, JSON.stringify({ op: 'error', error: e.message })); } catch {}
      cleanup();
    });
    target.on('close', cleanup);
  }
};

httpServer.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[proxy] 监听 ws://127.0.0.1:${LISTEN_PORT}`);
  console.log('[proxy] 默认转发到 common.lcs.baidu.com:443 (TLS)');
});
