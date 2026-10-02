// tools/mock-onebot.mjs
// 一个模拟 NapCat 的 OneBot v11 服务端，基于 src/ws-server.mjs 手写 WebSocket 服务端。
// 用途：离线端到端自测（不依赖真实的 QQ / NapCat）。
//
// 行为：
//   - 接受任意 WS 连接（不校验 token）
//   - 连接后立即推送 meta_event / lifecycle
//   - 按 OneBot v11 语义响应 action 请求，并回同样的 echo
//   - 支持主动向已连接客户端推送 message 事件
//
// 零第三方依赖。

import { createWsServer } from '../src/ws-server.mjs';

/** 机器人自身的登录号（模拟值） */
export const MOCK_SELF_ID = 10001;

/** 默认假群列表 */
const DEFAULT_GROUPS = [
  { group_id: 88880001, group_name: '大肥鱼测试群', member_count: 3, max_member_count: 200 },
  { group_id: 88880002, group_name: '另一个测试群', member_count: 5, max_member_count: 200 },
];

/** 默认日志器 */
function createDefaultLogger() {
  const write = (level, ...args) => {
    const line = `[${new Date().toISOString()}] [mock-onebot] [${level}]`;
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

function safeLog(logger, level, ...args) {
  const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (!fn) return;
  try {
    fn.call(logger, ...args);
  } catch {
    /* 忽略 */
  }
}

// ---------------- 事件构造辅助 ----------------

/**
 * CQ 码转义（OneBot v11 规定：& [ ] , 需要转义）。
 */
function escapeCqParam(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

/**
 * 生成群消息事件（message 为 CQ 字符串形式）。
 * @param {object} o
 * @param {number|string} [o.selfId=10001]
 * @param {number|string} o.userId 发送者 QQ
 * @param {number|string} o.groupId 群号
 * @param {string} [o.text=''] 纯文本（自动做 CQ 转义）
 * @param {string} [o.senderName] 昵称/群名片
 * @param {number} [o.atSelf=true] 是否在消息前加 [CQ:at,qq=<selfId>]
 * @param {number|string} [o.messageId] 指定 message_id，否则自动分配
 * @param {number} [o.time] 秒级时间戳，默认当前
 * @param {Array} [o.extraSegments] 追加的 CQ 段（对象 {type,data}），会拼到 message 字符串
 */
export function makeGroupMessage({
  selfId = MOCK_SELF_ID,
  userId,
  groupId,
  text = '',
  senderName,
  atSelf = true,
  messageId,
  time,
  subType = 'normal',
  extraSegments = [],
} = {}) {
  const body = escapeCqParam(text);
  const parts = [];
  if (atSelf) parts.push(`[CQ:at,qq=${selfId}]`);
  if (body) parts.push(body);
  for (const seg of extraSegments) {
    parts.push(segmentToCq(seg));
  }
  const message = parts.join(' ');

  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: subType,
    message_id: messageId,
    group_id: Number(groupId),
    user_id: Number(userId),
    self_id: Number(selfId),
    raw_message: message,
    font: 0,
    message,
    time: Number.isFinite(Number(time)) ? Number(time) : Math.floor(Date.now() / 1000),
    sender: {
      user_id: Number(userId),
      nickname: senderName ?? `用户${userId}`,
      card: senderName ?? `用户${userId}`,
      role: 'member',
    },
  };
}

/**
 * 生成私聊消息事件（message 为 CQ 字符串形式）。
 */
export function makePrivateMessage({
  selfId = MOCK_SELF_ID,
  userId,
  text = '',
  senderName,
  messageId,
  time,
  subType = 'friend',
  extraSegments = [],
} = {}) {
  const parts = [];
  const body = escapeCqParam(text);
  if (body) parts.push(body);
  for (const seg of extraSegments) {
    parts.push(segmentToCq(seg));
  }
  const message = parts.join(' ');

  return {
    post_type: 'message',
    message_type: 'private',
    sub_type: subType,
    message_id: messageId,
    user_id: Number(userId),
    self_id: Number(selfId),
    raw_message: message,
    font: 0,
    message,
    time: Number.isFinite(Number(time)) ? Number(time) : Math.floor(Date.now() / 1000),
    sender: {
      user_id: Number(userId),
      nickname: senderName ?? `用户${userId}`,
    },
  };
}

/** 把 {type, data} 段转成 CQ 字符串（供 extraSegments 使用） */
function segmentToCq(seg) {
  if (!seg || typeof seg !== 'object') return '';
  const type = String(seg.type ?? '');
  const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
  if (type === 'text') return String(data.text ?? '');
  const params = Object.entries(data)
    .map(([k, v]) => `${k}=${escapeCqParam(v)}`)
    .join(',');
  return `[CQ:${type}${params ? ',' + params : ''}]`;
}

// ---------------- 服务端 ----------------

/**
 * 启动模拟 OneBot 服务端。
 *
 * @param {object} options
 * @param {number} [options.port=0]
 * @param {object} [options.logger]
 * @param {boolean} [options.autoAccept=true] 是否自动同意加好友/加群请求（影响返回内容）
 * @returns {Promise<{port:number,url:string,close:()=>Promise<void>,state:object,server:object}>}
 */
export async function startMockOneBot({ port = 0, logger, autoAccept = true } = {}) {
  const log = logger || createDefaultLogger();

  /** 已发送消息记录：{action, params, time} */
  const sent = [];
  let messageIdSeq = 1000;
  let echoSeq = 0;

  const wsServer = await createWsServer({ port, host: '127.0.0.1', path: '/', logger: log });

  const state = {
    /** 所有被发送的消息：{action, params, time} */
    sent,
    /** 当前连接集合 */
    connections: wsServer.connections,
    /** 服务端 URL 与端口 */
    url: wsServer.url,
    port: wsServer.port,
    /** 假群列表 */
    groups: [...DEFAULT_GROUPS],
    /** 机器人登录号 */
    selfId: MOCK_SELF_ID,
    /** 收到的 action 请求原始记录（便于断言） */
    received: [],
    /**
     * 向所有已连接客户端推送一条事件对象。
     * 自动补全规则（便于构造"字段缺失"的测试用例）：
     *   - self_id：undefined 时补 MOCK_SELF_ID；显式传 null 则保留 null
     *   - time：undefined 时补当前秒级时间戳；显式传 null / 0 则保留
     *   - message_id：undefined 时自动分配；显式传 null 则保留 null
     * @param {object} evt 事件对象
     * @returns {number|null} 推送的 message_id；无连接时返回 null
     */
    pushEvent(evt) {
      if (!evt || typeof evt !== 'object') return null;
      const payload = { ...evt };
      if (payload.self_id === undefined) payload.self_id = MOCK_SELF_ID;
      if (payload.time === undefined) payload.time = Math.floor(Date.now() / 1000);

      // 分配 message_id（仅当调用方完全没有提供该字段时）
      let assignedId = payload.message_id;
      if (payload.post_type === 'message' || payload.message_type) {
        if (assignedId === undefined) {
          messageIdSeq += 1;
          assignedId = messageIdSeq;
        }
        payload.message_id = assignedId;
      }

      const text = JSON.stringify(payload);
      let delivered = 0;
      for (const sock of [...wsServer.connections]) {
        if (sock.readyState !== 1) continue;
        try {
          sock.send(text);
          delivered += 1;
        } catch (err) {
          safeLog(log, 'warn', `推送事件失败：${err && err.message}`);
        }
      }
      safeLog(log, 'debug', `推送事件 ${payload.post_type}/${payload.message_type ?? '-'} 给 ${delivered} 个连接`);
      return assignedId ?? null;
    },
    /**
     * 推送一条 message 事件（规格要求的名字）。
     * @param {object} evt
     * @returns {number|null} message_id
     */
    pushMessage(evt) {
      return state.pushEvent(evt);
    },
    /** 便捷：直接推送一条群消息，返回 message_id */
    pushGroupMessage(opts) {
      return state.pushEvent(makeGroupMessage(opts));
    },
    /** 便捷：直接推送一条私聊消息，返回 message_id */
    pushPrivateMessage(opts) {
      return state.pushEvent(makePrivateMessage(opts));
    },
  };

  /** 构造标准成功响应 */
  const ok = (echo, data) => ({ status: 'ok', retcode: 0, data: data ?? null, echo: echo ?? null });
  /** 构造标准失败响应 */
  const fail = (echo, retcode, wording) => ({
    status: 'failed',
    retcode,
    wording: wording ?? 'error',
    data: null,
    echo: echo ?? null,
  });

  /**
   * 处理一次 action 调用，返回响应对象。
   */
  function handleAction(req) {
    const action = String(req.action ?? '');
    const params = req.params && typeof req.params === 'object' ? req.params : {};
    const echo = req.echo ?? null;

    switch (action) {
      case 'get_login_info':
        return ok(echo, { user_id: MOCK_SELF_ID, nickname: '大肥鱼' });

      case 'get_status':
        return ok(echo, { online: true, good: true, app_initialized: true, app_enabled: true });

      case 'get_version_info':
        return ok(echo, {
          app_name: 'mock-onebot',
          app_version: '1.0.0',
          protocol_version: 'v11',
        });

      case 'get_group_list':
        return ok(echo, state.groups.map((g) => ({ ...g })));

      case 'get_group_member_info': {
        const groupId = Number(params.group_id);
        const userId = Number(params.user_id);
        return ok(echo, {
          group_id: groupId,
          user_id: userId,
          nickname: `用户${userId}`,
          card: `群名片${userId}`,
          sex: 'unknown',
          age: 18,
          area: '',
          join_time: Math.floor(Date.now() / 1000) - 86400,
          last_sent_time: Math.floor(Date.now() / 1000),
          level: '1',
          role: 'member',
          unfriendly: false,
          title: '',
        });
      }

      case 'get_stranger_info': {
        const userId = Number(params.user_id);
        return ok(echo, {
          user_id: userId,
          nickname: `陌生人${userId}`,
          sex: 'unknown',
          age: 18,
          qid: '',
          level: '1',
          login_days: 1,
        });
      }

      case 'send_private_msg': {
        messageIdSeq += 1;
        sent.push({ action, params: { ...params }, time: Date.now() });
        return ok(echo, { message_id: messageIdSeq });
      }

      case 'send_group_msg': {
        messageIdSeq += 1;
        sent.push({ action, params: { ...params }, time: Date.now() });
        return ok(echo, { message_id: messageIdSeq });
      }

      case 'set_friend_add_request': {
        sent.push({ action, params: { ...params }, time: Date.now() });
        return ok(echo, autoAccept ? { accepted: true } : { accepted: false });
      }

      case 'set_group_add_request': {
        sent.push({ action, params: { ...params }, time: Date.now() });
        return ok(echo, autoAccept ? { accepted: true } : { accepted: false });
      }

      default:
        return fail(echo, 1404, 'unknown action');
    }
  }

  // 新连接：立即推送 lifecycle 元事件
  wsServer.on('connection', (sock) => {
    safeLog(log, 'info', `模拟客户端已连接：${sock.remoteAddress}:${sock.remotePort}`);

    sock.on('message', (text) => {
      let req;
      try {
        req = JSON.parse(text);
      } catch {
        safeLog(log, 'warn', `收到非 JSON 请求，已忽略：${String(text).slice(0, 200)}`);
        return;
      }
      state.received.push(req);

      const action = String(req?.action ?? '');
      const resp = handleAction(req);
      echoSeq += 1;
      try {
        sock.send(JSON.stringify(resp));
      } catch (err) {
        safeLog(log, 'error', `发送响应失败：${err && err.message}`);
        return;
      }
      safeLog(
        log,
        'debug',
        `action=${action} echo=${req?.echo ?? 'null'} -> status=${resp.status} retcode=${resp.retcode}`,
      );
    });

    sock.on('error', (err) => {
      safeLog(log, 'warn', `连接错误（已忽略，不影响进程）：${err && err.message}`);
    });

    sock.on('close', () => {
      safeLog(log, 'info', '模拟客户端连接已关闭');
    });

    // 连接后立即发送 lifecycle，模拟 NapCat 行为
    try {
      sock.send(
        JSON.stringify({
          post_type: 'meta_event',
          meta_event_type: 'lifecycle',
          sub_type: 'connect',
          self_id: MOCK_SELF_ID,
          time: Math.floor(Date.now() / 1000),
        }),
      );
    } catch (err) {
      safeLog(log, 'error', `发送 lifecycle 失败：${err && err.message}`);
    }
  });

  safeLog(log, 'info', `模拟 OneBot 服务端已就绪：${wsServer.url}`);

  return {
    port: wsServer.port,
    url: wsServer.url,
    state,
    server: wsServer,
    /** 关闭模拟服务端（含所有连接） */
    async close() {
      await wsServer.close();
      safeLog(log, 'info', '模拟 OneBot 服务端已关闭');
    },
  };
}

export default startMockOneBot;
