// src/ws-server.mjs
// 使用 node:http + node:crypto 手写的极简 WebSocket 服务端（RFC 6455 子集）。
// 仅支持：文本帧（0x1）、续帧（0x0）、close（0x8）、ping（0x9）、pong（0xA）。
// 不支持二进制帧、扩展（permessage-deflate）、客户端分片以外的复杂场景。
// 零第三方依赖，只使用 node: 内置模块。

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// WebSocket 魔术字符串（RFC 6455 第 1.3 节）
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 常用关闭码（用于把非法帧错误映射为关闭码）
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_UNSUPPORTED_DATA = 1003;
const CLOSE_ABNORMAL = 1006;

// 帧操作码
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// 单个连接允许的最大消息体积（字节），防止内存被撑爆
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * 默认日志器：带时间戳的中文日志。
 */
function createDefaultLogger() {
  const write = (level, ...args) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] [ws-server] [${level}]`;
    if (level === 'ERROR') console.error(line, ...args);
    else console.log(line, ...args);
  };
  return {
    debug: (...a) => write('DEBUG', ...a),
    info: (...a) => write('INFO', ...a),
    warn: (...a) => write('WARN', ...a),
    error: (...a) => write('ERROR', ...a),
  };
}

/**
 * 安全调用 logger 的某个方法：日志本身出错绝不能影响连接。
 */
function safeLog(logger, level, ...args) {
  const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (!fn) return;
  try {
    fn.call(logger, ...args);
  } catch {
    /* 日志失败忽略 */
  }
}

/**
 * 计算 Sec-WebSocket-Accept（校验握手用）。
 */
function computeAccept(key) {
  return crypto.createHash('sha1').update(String(key).trim() + WS_GUID).digest('base64');
}

/**
 * 把路径规范化，握手时比较用。
 */
function normalizePath(p) {
  if (!p) return '/';
  let out = String(p);
  if (!out.startsWith('/')) out = '/' + out;
  // 去掉末尾多余斜杠（根路径除外）
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * 一个已升级的 WebSocket 连接。
 * EventEmitter 风格事件：'message' (text) / 'close' (code, reason) / 'error' (err)
 */
class Socket extends EventEmitter {
  /**
   * @param {import('node:net').Socket} raw 底层 TCP 套接字
   * @param {object} opts
   */
  constructor(raw, opts = {}) {
    super();
    this.raw = raw;
    /** 1 = OPEN，2 = CLOSING，3 = CLOSED（与 WHATWG WebSocket 语义一致） */
    this.readyState = 1;
    this.remoteAddress = raw.remoteAddress || null;
    this.remotePort = raw.remotePort || null;
    this.logger = opts.logger || null;

    // 分片续帧缓冲
    this._fragments = [];
    this._fragmentBytes = 0;
    this._fragmentOpcode = null;
    // 解析用的累积缓冲
    this._buffer = Buffer.alloc(0);
    this._closeFrameSent = false;
    this._closeCode = null;
    this._closeReason = '';
    this._closedEmitted = false;
    this._errorCount = 0;

    this._onData = (chunk) => this._handleData(chunk);
    this._onError = (err) => this._handleSocketError(err, 'TCP 错误');
    this._onEnd = () => this._destroy(CLOSE_ABNORMAL, '对端关闭 TCP 连接');
    this._onClose = () => this._destroy(this._closeCode ?? CLOSE_ABNORMAL, this._closeReason);

    raw.on('data', this._onData);
    raw.on('error', this._onError);
    raw.on('end', this._onEnd);
    raw.on('close', this._onClose);
    // 关闭 Nagle 算法，降低小消息延迟（尽力而为，失败不影响功能）
    try {
      raw.setNoDelay(true);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 发送文本帧。未打开时抛错。
   * @param {string} text
   */
  send(text) {
    if (this.readyState !== 1) {
      throw new Error(`WebSocket 未打开（readyState=${this.readyState}），无法发送`);
    }
    const payload = Buffer.from(String(text), 'utf8');
    // 服务端 -> 客户端：不加掩码
    const frame = encodeFrame(OP_TEXT, payload, false);
    this._write(frame);
  }

  /**
   * 发送关闭帧并优雅关闭。
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE_NORMAL, reason = '') {
    if (this.readyState === 3) return;
    if (this.readyState === 2) {
      // 已经在关闭流程中，等待底层收尾
      return;
    }
    this.readyState = 2;
    const codeNum = Number.isFinite(Number(code)) ? Number(code) : CLOSE_NORMAL;
    this._closeCode = codeNum;
    this._closeReason = String(reason ?? '');
    if (!this._closeFrameSent) {
      this._closeFrameSent = true;
      try {
        this._write(encodeFrame(OP_CLOSE, encodeClosePayload(codeNum, String(reason ?? '')), false));
      } catch {
        /* 写失败则直接销毁 */
      }
    }
    // 主动关闭时给对端一点时间回关闭帧，超时后强制销毁
    const timer = setTimeout(() => {
      this._destroy(codeNum, this._closeReason);
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** 内部：写数据，吞掉异常避免崩溃 */
  _write(buf) {
    if (!this.raw || this.raw.destroyed || this.raw.writableEnded) return;
    try {
      this.raw.write(buf);
    } catch (err) {
      this._handleSocketError(err, '写数据失败');
    }
  }

  /** 内部：累积数据并逐帧解析 */
  _handleData(chunk) {
    if (this.readyState === 3) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
    // 循环解析，直到缓冲不足一帧
    for (;;) {
      let parsed;
      try {
        // 注意：解析本身也可能抛协议错误（未掩码 / RSV / 长度超限等），
        // 必须一并捕获，否则异常会逃逸到 socket 的 data 回调并导致进程崩溃。
        parsed = this._tryParseFrame(this._buffer);
      } catch (err) {
        this._handleSocketError(err, '解析帧失败');
        break;
      }
      if (!parsed) break;
      this._buffer = this._buffer.subarray(parsed.consumed);
      try {
        this._handleFrame(parsed);
      } catch (err) {
        this._handleSocketError(err, '处理帧失败');
        break;
      }
      if (this.readyState === 3) break;
    }
  }

  /**
   * 尝试从缓冲里解析出一帧。返回 null 表示数据还不够。
   */
  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const rsv = b0 & 0x70;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let offset = 2;

    // RSV 位必须为 0（我们没协商任何扩展）
    if (rsv !== 0) {
      throw new ProtocolError('收到带 RSV 位的帧，但未协商任何扩展', CLOSE_PROTOCOL_ERROR);
    }
    // 客户端发往服务端的帧必须带掩码
    if (!masked) {
      throw new ProtocolError('客户端帧未加掩码', CLOSE_PROTOCOL_ERROR);
    }

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return null;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ProtocolError('帧长度超出安全整数范围', CLOSE_PROTOCOL_ERROR);
      }
      payloadLen = Number(big);
      offset += 8;
    }

    if (payloadLen > MAX_MESSAGE_BYTES) {
      throw new ProtocolError(`单帧长度超限：${payloadLen} 字节`, CLOSE_UNSUPPORTED_DATA);
    }

    // 掩码 key
    if (buf.length < offset + 4) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + payloadLen) return null;
    const payload = Buffer.allocUnsafe(payloadLen);
    for (let i = 0; i < payloadLen; i += 1) {
      payload[i] = buf[offset + i] ^ maskKey[i & 3];
    }
    offset += payloadLen;

    return { fin, opcode, payload, consumed: offset };
  }

  /** 内部：处理解析出来的一帧 */
  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    switch (opcode) {
      case OP_TEXT:
      case OP_CONTINUATION: {
        if (opcode === OP_TEXT) {
          if (this._fragmentOpcode !== null) {
            throw new ProtocolError('上一组分片消息未结束，就收到新的文本帧', CLOSE_PROTOCOL_ERROR);
          }
          if (fin) {
            this._emitText(payload);
            return;
          }
          // 分片开始
          this._fragmentOpcode = OP_TEXT;
          this._fragments = [payload];
          this._fragmentBytes = payload.length;
          return;
        }
        // 续帧
        if (this._fragmentOpcode === null) {
          throw new ProtocolError('收到没有起始帧的续帧', CLOSE_PROTOCOL_ERROR);
        }
        this._fragments.push(payload);
        this._fragmentBytes += payload.length;
        if (this._fragmentBytes > MAX_MESSAGE_BYTES) {
          throw new ProtocolError('分片消息总长度超限', CLOSE_UNSUPPORTED_DATA);
        }
        if (fin) {
          const full = Buffer.concat(this._fragments, this._fragmentBytes);
          this._fragments = [];
          this._fragmentBytes = 0;
          this._fragmentOpcode = null;
          this._emitText(full);
        }
        return;
      }

      case OP_BINARY: {
        // 协议要求明确拒绝二进制帧
        throw new ProtocolError('不支持二进制帧', CLOSE_UNSUPPORTED_DATA);
      }

      case OP_CLOSE: {
        // 收到关闭帧：提取码与原因，回一个关闭帧
        let code = CLOSE_NORMAL;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        this._closeCode = code;
        this._closeReason = reason;
        if (!this._closeFrameSent) {
          this._closeFrameSent = true;
          this._write(encodeFrame(OP_CLOSE, encodeClosePayload(code, reason), false));
        }
        this.readyState = 2;
        // 立刻收尾（我们自己已经回应了关闭帧）
        this._destroy(code, reason);
        return;
      }

      case OP_PING: {
        // ping -> pong，负载原样回传
        this._write(encodeFrame(OP_PONG, payload, false));
        return;
      }

      case OP_PONG: {
        // 忽略 pong
        return;
      }

      default: {
        throw new ProtocolError(`收到未知操作码：0x${opcode.toString(16)}`, CLOSE_PROTOCOL_ERROR);
      }
    }
  }

  /** 内部：把完整文本帧按 UTF-8 解码后 emit('message') */
  _emitText(buf) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new ProtocolError('文本帧不是合法的 UTF-8 编码', CLOSE_UNSUPPORTED_DATA);
    }
    try {
      this.emit('message', text);
    } catch (err) {
      // 监听器抛出的异常不能让进程崩溃
      this._handleSocketError(err, 'message 监听器抛出异常');
    }
  }

  /** 内部：连接级别错误，emit('error') 但绝不向进程抛出 */
  _handleSocketError(err, context) {
    this._errorCount += 1;
    const wrapped = err instanceof Error ? err : new Error(String(err));
    safeLog(this.logger, 'error', `${context}：${wrapped.message}`);
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', wrapped);
      } catch {
        /* 监听器自身出错忽略 */
      }
    }
    if (wrapped instanceof ProtocolError) {
      // 协议错误：按 RFC 发送对应关闭帧
      try {
        this.close(wrapped.closeCode, wrapped.message.slice(0, 120));
      } catch {
        /* 忽略 */
      }
      this._destroy(wrapped.closeCode, wrapped.message);
    }
  }

  /** 内部：真正销毁连接并 emit('close') 一次 */
  _destroy(code = CLOSE_ABNORMAL, reason = '') {
    if (this.readyState === 3 && this._closedEmitted) return;
    this.readyState = 3;
    this._closeCode = code;
    this._closeReason = reason;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;

    if (this.raw) {
      this.raw.removeListener('data', this._onData);
      this.raw.removeListener('error', this._onError);
      this.raw.removeListener('end', this._onEnd);
      this.raw.removeListener('close', this._onClose);
      try {
        if (!this.raw.destroyed) this.raw.destroy();
      } catch {
        /* 忽略 */
      }
    }

    if (!this._closedEmitted) {
      this._closedEmitted = true;
      try {
        this.emit('close', code, reason);
      } catch {
        /* 监听器抛错忽略 */
      }
    }
  }
}

/** 表示 WebSocket 协议级错误（会映射到一个关闭码） */
class ProtocolError extends Error {
  constructor(message, closeCode = CLOSE_PROTOCOL_ERROR) {
    super(message);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
  }
}

/**
 * 编码一个 WebSocket 帧。
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} masked 是否加掩码（服务端发出时为 false）
 */
function encodeFrame(opcode, payload, masked) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1
  if (masked) {
    header[1] |= 0x80;
    const maskKey = crypto.randomBytes(4);
    const out = Buffer.allocUnsafe(header.length + 4 + len);
    header.copy(out, 0);
    maskKey.copy(out, header.length);
    for (let i = 0; i < len; i += 1) {
      out[header.length + 4 + i] = payload[i] ^ maskKey[i & 3];
    }
    return out;
  }
  return Buffer.concat([header, payload]);
}

/** 编码关闭帧负载：2 字节码 + UTF-8 原因 */
function encodeClosePayload(code, reason) {
  const reasonBuf = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123);
  const buf = Buffer.allocUnsafe(2 + reasonBuf.length);
  buf.writeUInt16BE(code, 0);
  reasonBuf.copy(buf, 2);
  return buf;
}

/**
 * 创建一个手写的 WebSocket 服务端。
 *
 * @param {object} options
 * @param {number} options.port 监听端口（0 表示由系统分配）
 * @param {string} [options.host='0.0.0.0']
 * @param {string} [options.path='/'] 只接受该路径的升级请求
 * @param {object} [options.logger]
 * @returns {Promise<{port:number,url:string,close:()=>Promise<void>,connections:Set<Socket>,server:import('node:http').Server,on:Function,once:Function,off:Function}>}
 */
export function createWsServer({ port = 0, host = '0.0.0.0', path = '/', logger } = {}) {
  const log = logger || createDefaultLogger();
  const wantPath = normalizePath(path);
  /** @type {Set<Socket>} */
  const connections = new Set();
  // 连接通知用的事件发射器：emit('connection', socket)
  const events = new EventEmitter();

  const server = http.createServer((req, res) => {
    // 普通 HTTP 请求（不是 WebSocket 升级）：按规格返回 426。
    // 若客户端连 Upgrade 头都没带，则说明是普通的 HTTP 访问，返回 404 更准确。
    const wantsUpgrade = String(req.headers.upgrade || '').toLowerCase() === 'websocket';
    if (!wantsUpgrade && req.headers.upgrade == null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('未找到该资源；本服务只提供 WebSocket 接入点。\n');
      return;
    }
    res.writeHead(426, {
      'Content-Type': 'text/plain; charset=utf-8',
      Connection: 'close',
      Upgrade: 'websocket',
    });
    res.end('本服务只接受 WebSocket 升级请求（Upgrade: websocket）。\n');
  });

  // 客户端发起升级
  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head, { wantPath, log, connections, events });
    } catch (err) {
      safeLog(log, 'error', `处理升级请求时发生异常：${err && err.message}`);
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
    }
  });

  // 服务器级错误：不要让进程崩溃
  server.on('error', (err) => {
    safeLog(log, 'error', `HTTP 服务器错误：${err && err.message}`);
  });
  server.on('clientError', (err, socket) => {
    safeLog(log, 'warn', `客户端连接错误：${err && err.message}`);
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch {
      /* 忽略 */
    }
  });

  return new Promise((resolve, reject) => {
    const onListenError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onListenError);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const urlPath = wantPath === '/' ? '/' : `${wantPath}`;
      const url = `ws://${displayHost}:${actualPort}${urlPath}`;
      safeLog(log, 'info', `WebSocket 服务端已监听 ${host}:${actualPort}${wantPath}`);

      resolve({
        port: actualPort,
        url,
        connections,
        server,
        /**
         * 监听新连接：on('connection', (socket) => {})。
         * 这是获取新连接最可靠的方式（不要在 connections 上做时序假设）。
         */
        on(event, handler) {
          events.on(event, handler);
          return this;
        },
        once(event, handler) {
          events.once(event, handler);
          return this;
        },
        off(event, handler) {
          events.off(event, handler);
          return this;
        },
        /** 关闭服务端：先关闭所有连接，再关闭 HTTP 服务器 */
        close() {
          return new Promise((res2) => {
            // 逐个优雅关闭连接
            for (const s of [...connections]) {
              try {
                s.close(1001, '服务端关闭');
              } catch {
                /* 忽略 */
              }
            }
            connections.clear();
            const done = () => res2();
            try {
              server.close(() => done());
            } catch {
              done();
            }
            // 兜底：即使有连接没释放，也要在 1.5 秒内 resolve
            const t = setTimeout(done, 1500);
            if (typeof t.unref === 'function') t.unref();
          });
        },
      });
    };

    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 执行握手校验并接管套接字。
 */
function handleUpgrade(req, socket, head, ctx) {
  const { wantPath, log, connections, events } = ctx;

  // 防止握手期间的底层错误打崩进程
  socket.on('error', (err) => {
    safeLog(log, 'warn', `握手阶段套接字错误：${err && err.message}`);
  });

  // 只处理 GET
  if (req.method !== 'GET') {
    return rejectUpgrade(socket, 405, 'Method Not Allowed');
  }

  // 校验 Upgrade / Connection 头
  const upgradeHeader = String(req.headers.upgrade || '').toLowerCase();
  const connectionHeader = String(req.headers.connection || '').toLowerCase();
  if (upgradeHeader !== 'websocket') {
    return rejectUpgrade(socket, 400, 'Bad Request: 需要 Upgrade: websocket');
  }
  if (!connectionHeader.split(',').map((s) => s.trim()).includes('upgrade')) {
    return rejectUpgrade(socket, 400, 'Bad Request: 需要 Connection: Upgrade');
  }

  // 校验 Sec-WebSocket-Version
  const version = String(req.headers['sec-websocket-version'] || '');
  if (version !== '13') {
    socket.write(
      'HTTP/1.1 426 Upgrade Required\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Connection: close\r\n\r\n',
    );
    socket.destroy();
    return;
  }

  // 校验 Sec-WebSocket-Key
  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    return rejectUpgrade(socket, 400, 'Bad Request: 缺少 Sec-WebSocket-Key');
  }

  // 校验路径
  let reqPath;
  try {
    reqPath = normalizePath(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return rejectUpgrade(socket, 400, 'Bad Request: URL 非法');
  }
  if (reqPath !== wantPath) {
    return rejectUpgrade(socket, 404, `Not Found: 路径 ${reqPath} 不存在`);
  }

  // 生成 Sec-WebSocket-Accept
  const accept = computeAccept(key);

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  // 若客户端请求了子协议，这里沿用第一个（我们本身不使用子协议）
  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    const first = String(proto).split(',')[0].trim();
    if (first) headers.push(`Sec-WebSocket-Protocol: ${first}`);
  }
  headers.push('', '');

  try {
    socket.write(headers.join('\r\n'));
  } catch (err) {
    safeLog(log, 'warn', `写握手响应失败：${err && err.message}`);
    try {
      socket.destroy();
    } catch {
      /* 忽略 */
    }
    return;
  }

  // 把 head 里可能已经收到的数据交回给帧解析器
  socket.removeAllListeners('error');

  const ws = new Socket(socket, { logger: log });
  connections.add(ws);
  ws.on('close', () => {
    connections.delete(ws);
    safeLog(log, 'debug', `连接关闭（${ws.remoteAddress}:${ws.remotePort}），当前连接数 ${connections.size}`);
  });

  safeLog(log, 'info', `新 WebSocket 连接：${ws.remoteAddress}:${ws.remotePort}，当前连接数 ${connections.size}`);

  if (head && head.length) {
    ws._handleData(head);
  }

  // 通知调用方有新连接（OneBot 接入层依赖这个事件）
  try {
    events.emit('connection', ws);
  } catch (err) {
    safeLog(log, 'error', `connection 监听器抛出异常：${err && err.message}`);
  }
}

/** 拒绝升级并返回 HTTP 错误（务必先 flush 再关闭，否则响应会被丢弃） */
function rejectUpgrade(socket, code, message) {
  const text = String(message);
  try {
    socket.write(
      `HTTP/1.1 ${code} ${text}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(text)}\r\n\r\n` +
        text,
    );
  } catch {
    /* 忽略 */
  }
  try {
    // 用 end() 而不是 destroy()：destroy() 会立刻丢包，导致客户端收不到错误响应
    if (!socket.writableEnded) socket.end();
  } catch {
    /* 忽略 */
  }
  // 兜底：对端不主动关闭时强制销毁，避免句柄泄漏
  const timer = setTimeout(() => {
    try {
      if (!socket.destroyed) socket.destroy();
    } catch {
      /* 忽略 */
    }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

export { Socket };
export default createWsServer;
