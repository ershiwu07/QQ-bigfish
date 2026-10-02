// src/onebot.mjs
// OneBot v11（NapCat）客户端接入层。
// 零第三方依赖：WebSocket 客户端使用 Node 24 内置的全局 WebSocket，只用到 node:events。
//
// 职责：
//   1. 与 NapCat 的 WS 反向/正向连接（支持 Authorization: Bearer <token>）
//   2. 调用 OneBot action 并按 echo 匹配响应
//   3. 把原始事件归一化成方便使用的对象
//   4. 断线自动重连（指数退避）+ 心跳

import { EventEmitter } from 'node:events';
import { faceTag, faceTagFrom } from './qq-face.mjs';

// ---------------- 常量 ----------------

/** 心跳间隔：30 秒 */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 单次连接尝试的超时（避免一直挂着不返回） */
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;
/** 重连退避的基准抖动比例（避免多个实例同时重连打爆服务端） */
const BACKOFF_JITTER_RATIO = 0.2;

// ---------------- 错误类型 ----------------

/**
 * OneBot API 调用失败错误。
 * 附带 action / retcode / wording 字段，方便调用方精确处理。
 */
export class OneBotError extends Error {
  /**
   * @param {string} message
   * @param {{action?:string, retcode?:number, wording?:string, data?:any, cause?:Error}} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'OneBotError';
    this.action = info.action ?? null;
    this.retcode = info.retcode ?? null;
    this.wording = info.wording ?? null;
    this.data = info.data ?? null;
    if (info.cause) this.cause = info.cause;
  }
}

// ---------------- 工具函数 ----------------

/** 默认日志器（中文输出） */
function createDefaultLogger() {
  const write = (level, ...args) => {
    const line = `[${new Date().toISOString()}] [onebot] [${level}]`;
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

/** 安全日志：日志自身出错不影响主流程 */
function safeLog(logger, level, ...args) {
  const fn = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (!fn) return;
  try {
    fn.call(logger, ...args);
  } catch {
    /* 忽略 */
  }
}

/**
 * 解码 CQ 码里的 HTML 实体转义。
 * OneBot v11 规定 CQ 参数内的 & [ ] , 会被转义。
 * @param {string} s
 */
export function decodeCqEntities(s) {
  return String(s ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/** 去掉所有 [CQ:...] 片段，并把剩下的文本做实体解码 */
export function stripCqCodes(s) {
  return decodeCqEntities(String(s ?? '').replace(/\[CQ:[^\]]*\]/g, ''));
}

/** 从 CQ 参数串里取一个字段，例如 pickParam('id=4,name=x', 'id') → '4' */
function pickParam(params, key) {
  const m = String(params || '').match(new RegExp(`(?:^|,)${key}=([^,]*)`, 'i'));
  return m ? m[1] : '';
}

/** 大表情 / 原创表情：协议里没有图，但通常带一句 summary 可以当文字用 */
function bigFaceTag(params) {
  const m = String(params || '').match(/(?:^|,)summary=([^,]*)/i);
  const raw = m ? decodeCqEntities(m[1]) : '';
  const clean = raw.replace(/^[[【]|[\]】]$/g, '').trim();
  return clean ? `[大表情:${clean.slice(0, 40)}]` : '[大表情]';
}

/**
 * 判断一个事件是不是「拍一拍」。
 * QQ 的拍一拍走的是 notice 事件（不是 message！），
 * 形如 { post_type:'notice', notice_type:'notify', sub_type:'poke', user_id, target_id, group_id, raw_info }。
 */
export function isPokeNotice(raw) {
  if (!raw || raw.post_type !== 'notice') return false;
  if (raw.notice_type !== 'notify') return false;
  const sub = String(raw.sub_type ?? '');
  return sub === 'poke' || sub === 'poke_recall';
}

/** 拍一拍被撤回了（这种情况不该当成一次互动去回应） */
export function isPokeRecall(raw) {
  return isPokeNotice(raw) && String(raw.sub_type ?? '') === 'poke_recall';
}

/**
 * 把 QQ 那句拍一拍的原文拼出来。
 * QQ 给的 raw_info 是分段文本，拼起来就是群里显示的那句话，例如：
 *   [{type:'nor',text:'拍了拍'},{type:'nor',text:'我的肚子'}]  → "拍了拍我的肚子"
 * @returns {string} 例如 "拍了拍你的肚子"
 */
export function buildPokeText({ fromName, toName, atSelf, rawInfo }) {
  const who = fromName || '有人';
  const target = atSelf ? '你' : toName || '别人';
  let action = (Array.isArray(rawInfo) ? rawInfo : [])
    .map((x) => (x && typeof x.text === 'string' ? x.text : ''))
    .join('')
    .trim();
  if (action) {
    // QQ 原文里可能已经带了拍人者的名字，去掉避免"张三 张三 拍了拍"
    if (fromName && action.startsWith(fromName)) action = action.slice(fromName.length).trim();
    // QQ 给的原文是以被拍的人为主语的（"拍了拍我的肚子"），拍的是它就换成"你"。
    // 注意不能用 \b —— 中日韩文字没有 ASCII 词边界，\b我\b 永远匹配不上。
    if (atSelf) {
      action = action.replace(/(拍[了拍]*\s*)我/, '$1你');
      if (action.startsWith('我')) action = `你${action.slice(1)}`;
    }
  }
  // 原文不完整（有些版本 raw_info 是空的）就自己造一句
  if (!action || !action.includes('拍')) {
    action = `拍了拍${target}${action || ''}`;
  }
  return `[拍一拍] ${who} ${action}`;
}

/**
 * 把「拍一拍」的 notice 事件转成一条普通消息，这样后面的策略/记忆/队列全都能用。
 * 拍的是它自己时标成 atSelf，等于"有人直接戳它"。
 */
export function normalizePokeNotice(raw, selfId) {
  const effectiveSelfId =
    selfId != null ? String(selfId) : raw.self_id != null ? String(raw.self_id) : null;
  const isGroup = raw.group_id != null;
  const fromId = raw.user_id != null ? String(raw.user_id) : '';
  const toId = raw.target_id != null ? String(raw.target_id) : '';
  const atSelf = Boolean(effectiveSelfId && toId && toId === effectiveSelfId);
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const senderName = sender.card || sender.nickname || fromId;
  const poke = { fromId, toId, fromName: senderName, toName: toId, atSelf, rawInfo: raw.raw_info };

  return {
    messageId: `poke-${raw.time || 0}-${fromId}-${toId}`,
    kind: isGroup ? 'group' : 'private',
    subType: isGroup ? 'normal' : 'friend',
    selfId: effectiveSelfId,
    userId: fromId,
    groupId: isGroup ? String(raw.group_id) : null,
    senderName,
    text: buildPokeText(poke),
    atSelf,
    atAll: false,
    images: 0,
    stickers: 0,
    faces: 0,
    bigFaces: 0,
    imageUrls: [],
    cards: [],
    hasVideo: false,
    hasFile: false,
    hasForward: false,
    unknownSegments: [],
    isPoke: true,
    poke,
    raw,
    time: raw.time || Math.floor(Date.now() / 1000),
  };
}

/**
 * 把 CQ 码渲染成「人能读懂」的文本：
 *   · QQ 内置表情 → [偷笑] 这类标签（不翻译的话，纯表情消息读出来是空的）
 *   · 大表情 / 原创表情 → [大表情:动画表情]
 *   · 猜拳 / 骰子 / 窗口抖动 / 戳一戳 / 合并转发 → 对应的中文标签
 *   · 其余 CQ 码照旧删掉
 */
export function renderCqToText(s) {
  return decodeCqEntities(
    String(s ?? '')
      .replace(/\[CQ:face,([^\]]*)\]/gi, (_, params) => faceTag(pickParam(params, 'id')))
      .replace(/\[CQ:(?:mface|marketface|bface),([^\]]*)\]/gi, (_, params) => bigFaceTag(params))
      .replace(/\[CQ:shake[^\]]*\]/gi, () => '[窗口抖动]')
      .replace(/\[CQ:poke[^\]]*\]/gi, () => '[戳一戳]')
      .replace(/\[CQ:forward[^\]]*\]/gi, () => '[合并转发的消息]')
      .replace(/\[CQ:rps,[^\]]*\]/gi, () => '[猜拳]')
      .replace(/\[CQ:dice,[^\]]*\]/gi, () => '[骰子]')
      .replace(/\[CQ:reply[^\]]*\]/gi, () => '')
      .replace(/\[CQ:[^\]]*\]/g, ''),
  );
}

/**
 * 按逗号拆分 CQ 参数，但忽略 {} [] "" 内部的逗号。
 * 为什么需要：OneBot 规范要求 CQ 参数里的逗号转义成 &#44;，但很多实现（尤其分享卡片）
 * 直接把 JSON 塞进 data=，里面全是逗号。粗暴 split(',') 会把 JSON 切成碎片。
 */
function splitCqParams(s) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = false;
  let quote = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      buf += ch;
      if (ch === '\\') {
        i += 1;
        buf += s[i] ?? '';
      } else if (ch === quote) {
        inStr = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 解析出文本里所有 CQ 片段。
 * @param {string} s
 * @returns {Array<{type:string, data:Record<string,string>}>}
 */
export function parseCqCodes(s) {
  const out = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let m;
  while ((m = re.exec(String(s ?? ''))) !== null) {
    const type = m[1];
    const data = {};
    const rawParams = m[2] || '';
    const body = rawParams.startsWith(',') ? rawParams.slice(1) : rawParams;
    if (body) {
      if (type === 'json' || type === 'xml') {
        // data 里可能有逗号、花括号、引号，甚至是整段 XML —— 直接取到结尾最稳
        const mm = body.match(/(?:^|,)data=([\s\S]*)$/);
        if (mm) {
          data.data = decodeCqEntities(mm[1]);
          out.push({ type, data });
          continue;
        }
      }
      for (const pair of splitCqParams(body)) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1);
        data[k] = decodeCqEntities(v);
      }
    }
    out.push({ type, data });
  }
  return out;
}

/**
 * 判断一条 CQ 的 qq 参数是否指向机器人自己。
 * qq=all 一律不算 atSelf（按规格要求）。
 */
function isAtSelf(qqValue, selfId) {
  if (qqValue == null) return false;
  const qq = String(qqValue).trim();
  if (qq === '' || qq.toLowerCase() === 'all') return false;
  if (selfId == null) return false;
  return qq === String(selfId).trim();
}

/**
 * 从分享卡片（[CQ:json] / [CQ:xml]）里尽量抽出标题、简介、链接。
 * 群里转发的视频、文章、小程序大多走这个通道 —— 模型看不了视频画面，
 * 但这些文字信息足够让它知道「群里在聊什么」。
 */
function extractCard(data) {
  const raw = (data && (data.data || data.content)) || '';
  if (!raw || typeof raw !== 'string') return null;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    /* 可能是 XML，走下面的兜底 */
  }
  const pick = (src, ...keys) => {
    for (const k of keys) {
      const v = src && src[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  if (obj && typeof obj === 'object') {
    const meta = obj.meta && typeof obj.meta === 'object' ? obj.meta : {};
    const detail = meta.detail_1 || meta.detail || meta.news || meta.manifest || Object.values(meta)[0] || {};
    const title = pick(detail, 'title') || pick(obj, 'prompt') || pick(detail, 'desc');
    const desc = pick(detail, 'desc', 'summary', 'tag');
    const url = pick(detail, 'qqdocurl', 'jumpUrl', 'url', 'sourceUrl');
    if (title || desc || url) {
      return { title: title.slice(0, 200), desc: desc.slice(0, 300), url: url.slice(0, 300) };
    }
    return null;
  }
  // XML 兜底：按标签抓
  const grab = (re) => (raw.match(re) || [])[1]?.trim() || '';
  const title = grab(/<title[^>]*>([^<]{1,200})<\/title>/i);
  const desc = grab(/<desc[^>]*>([^<]{1,300})<\/desc>/i);
  const url = grab(/url="([^"]{1,300})"/i) || grab(/<url>([^<]{1,300})<\/url>/i);
  if (title || desc || url) return { title, desc, url };
  return null;
}

/**
 * 把 message 字段（string 或 segment 数组）统一成便于统计的结构。
 * @param {string|Array} message
 * @returns {{text:string, atSelf:boolean, atAll:boolean, images:number,
 *            imageList:Array<{url:string,file:string}>, cards:Array<object>,
 *            hasVideo:boolean, hasFile:boolean, segments:number}}
 */
function analyzeMessage(message, selfId) {
  let text = '';
  let atSelf = false;
  let atAll = false;
  let images = 0;
  let stickers = 0;
  let faces = 0;
  let bigFaces = 0;
  let segments = 0;
  const imageList = [];
  const cards = [];
  const unknownSegments = [];
  let hasVideo = false;
  let hasFile = false;
  let hasForward = false;

  const knownTypes = new Set([
    'text', 'at', 'image', 'face', 'mface', 'marketface', 'bface',
    'video', 'file', 'json', 'xml', 'rps', 'dice', 'reply', 'shake', 'poke', 'forward',
  ]);

  // 注意：这里只做「计数/判定」，**不拼文本**。
  // 文本渲染只有两处：字符串分支走 renderCqToText，数组分支在下面内联拼。
  // 两边都拼的话会重复（踩过这个坑）。
  const handleCq = (type, data) => {
    segments += 1;
    if (type === 'at') {
      const qq = data.qq ?? data.user_id ?? '';
      const qqStr = String(qq).trim();
      if (qqStr.toLowerCase() === 'all') atAll = true;
      else if (isAtSelf(qqStr, selfId)) atSelf = true;
    } else if (type === 'image') {
      images += 1;
      // sub_type=1 是「表情包 / 收藏的表情」，不是普通图片 —— 读法不一样
      const sticker = String(data.sub_type ?? '') === '1';
      if (sticker) stickers += 1;
      imageList.push({ url: data.url || '', file: data.file || '', sticker });
    } else if (type === 'face') {
      faces += 1;
    } else if (type === 'mface' || type === 'marketface' || type === 'bface') {
      bigFaces += 1;
    } else if (type === 'video') {
      hasVideo = true;
    } else if (type === 'file') {
      hasFile = true;
    } else if (type === 'forward') {
      hasForward = true;
    } else if (type === 'json' || type === 'xml') {
      const c = extractCard(data);
      if (c) cards.push(c);
    } else if (!knownTypes.has(type)) {
      // 完全不认识的段：只记下来，不硬塞进文本（免得让模型对看不懂的东西瞎回应）
      unknownSegments.push(type);
    }
  };

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (!seg || typeof seg !== 'object') continue;
      const type = String(seg.type ?? '');
      const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
      const segText = data.text;
      if (type === 'text') {
        segments += 1;
        if (segText != null) text += String(segText);
        continue;
      }
      handleCq(type, data);
      // 表情/大表情/抖动/戳一戳/转发要在文本里留个痕迹，否则这些消息读出来就是空的
      if (type === 'face') {
        // 优先用 NapCat 带的名字（新式大表情 id 能到 300+，静态表追不上）
        const raw = data.raw && typeof data.raw === 'object' ? data.raw : {};
        text += faceTagFrom(data.id, raw.faceText, String(raw.faceType) === '2');
      } else if (type === 'mface' || type === 'marketface' || type === 'bface') {
        text += bigFaceTag(`summary=${data.summary || ''}`);
      } else if (type === 'shake') text += '[窗口抖动]';
      else if (type === 'poke') text += '[戳一戳]';
      else if (type === 'forward') text += '[合并转发的消息]';
      else if (type === 'rps') text += '[猜拳]';
      else if (type === 'dice') text += '[骰子]';
    }
  } else if (typeof message === 'string') {
    for (const cq of parseCqCodes(message)) handleCq(cq.type, cq.data);
    text = renderCqToText(message);
  } else if (message != null) {
    // 兜底：非预期类型，按字符串处理
    const asStr = String(message);
    for (const cq of parseCqCodes(asStr)) handleCq(cq.type, cq.data);
    text = renderCqToText(asStr);
  }

  // text 需要是"去掉所有 CQ 码后的纯文本"，array 分支里 text 段本身就是纯文本，
  // 但仍然要做一次实体解码（例如文本段里出现了字面量 &#91;）。
  text = decodeCqEntities(text).trim();

  return {
    text,
    atSelf,
    atAll,
    images,
    stickers,
    faces,
    bigFaces,
    imageList,
    cards,
    hasVideo,
    hasFile,
    hasForward,
    unknownSegments,
    segments,
  };
}

/** 由 message_type 映射 kind */
function mapKind(messageType) {
  if (messageType === 'private') return 'private';
  if (messageType === 'group') return 'group';
  return 'other';
}

/**
 * 把原始 OneBot 事件对象归一化成标准结构。
 * @param {object} evt 原始事件
 * @param {number|string|null} selfId 机器人自身 QQ
 */
export function normalizeMessage(evt, selfId) {
  const raw = evt && typeof evt === 'object' ? evt : {};
  const sender = raw.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const effectiveSelfId = raw.self_id ?? selfId ?? null;

  const {
    text,
    atSelf,
    atAll,
    images,
    stickers,
    faces,
    bigFaces,
    imageList,
    cards,
    hasVideo,
    hasFile,
    hasForward,
    unknownSegments,
  } = analyzeMessage(raw.message, effectiveSelfId);

  // 发送者 QQ：优先 user_id，其次 sender.user_id
  const userIdRaw = raw.user_id ?? sender.user_id ?? null;
  const userId = userIdRaw == null ? null : Number(userIdRaw);

  // 群号：仅群消息有
  const isGroup = raw.message_type === 'group';
  const groupIdRaw = raw.group_id ?? (isGroup ? null : null);
  const groupId = groupIdRaw == null ? null : Number(groupIdRaw);

  // 昵称：sender.card 优先，其次 sender.nickname，再其次 String(userId)
  let senderName = '';
  if (sender.card != null && String(sender.card).trim() !== '') senderName = String(sender.card);
  else if (sender.nickname != null && String(sender.nickname).trim() !== '') senderName = String(sender.nickname);
  else senderName = userIdRaw == null ? '' : String(userIdRaw);
  // 群名片和昵称分开留着：成员档案里两个都要（"群名片叫 A、QQ 昵称叫 B"是常见情况）
  const senderCard = sender.card != null && String(sender.card).trim() !== '' ? String(sender.card).trim() : '';
  const senderNickname =
    sender.nickname != null && String(sender.nickname).trim() !== '' ? String(sender.nickname).trim() : '';

  const timeRaw = Number(raw.time);
  const time = Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw * 1000 : Date.now();

  return {
    messageId: raw.message_id ?? null,
    kind: mapKind(raw.message_type),
    subType: raw.sub_type != null ? String(raw.sub_type) : '',
    selfId: effectiveSelfId,
    userId,
    groupId,
    senderName,
    senderCard,
    senderNickname,
    text,
    atSelf: Boolean(atSelf),
    atAll: Boolean(atAll),
    images,
    stickers,
    faces,
    bigFaces,
    imageUrls: imageList,
    cards,
    hasVideo,
    hasFile,
    hasForward,
    unknownSegments,
    raw,
    time,
  };
}

// ---------------- 客户端 ----------------

/**
 * OneBot v11 客户端。
 *
 * 事件：
 *   'message' (normalized)  —— 收到消息事件（已归一化）
 *   'meta'    (raw)         —— 收到 post_type === 'meta_event' 的事件
 *   'event'   (raw)         —— 收到任意其他事件
 *   'open'    ()            —— 连接建立
 *   'close'   (info)        —— 连接关闭
 *   'error'   (err)         —— 连接或协议错误
 */
export class OneBotClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.url OneBot 的 ws 地址
   * @param {string} [options.accessToken='']
   * @param {object} [options.logger]
   * @param {boolean} [options.reconnect=true]
   * @param {number} [options.reconnectDelayMs=3000]
   * @param {number} [options.maxReconnectDelayMs=30000]
   * @param {number} [options.callTimeoutMs=15000]
   */
  constructor({
    url,
    accessToken = '',
    logger,
    reconnect = true,
    reconnectDelayMs = 3000,
    maxReconnectDelayMs = 30000,
    callTimeoutMs = 15000,
  } = {}) {
    super();
    if (!url) throw new Error('OneBotClient 需要 url 参数');

    this.url = String(url);
    this.accessToken = accessToken == null ? '' : String(accessToken);
    this.logger = logger || createDefaultLogger();
    this.reconnect = Boolean(reconnect);
    this.reconnectDelayMs = Number(reconnectDelayMs) > 0 ? Number(reconnectDelayMs) : 3000;
    this.maxReconnectDelayMs =
      Number(maxReconnectDelayMs) > 0 ? Number(maxReconnectDelayMs) : 30000;
    this.callTimeoutMs = Number(callTimeoutMs) > 0 ? Number(callTimeoutMs) : 15000;

    /** @type {WebSocket|null} */
    this.ws = null;
    /** 登录号，未知为 null */
    this.selfId = null;

    this._echoSeq = 0;
    /** @type {Map<string, {resolve:Function, reject:Function, timer:any, action:string}>} */
    this._pending = new Map();
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._closing = false;
    this._manualClose = false;
    this._connectingPromise = null;
    /** headers 选项是否可用（首次连接时探测） */
    this._headersSupported = null;
  }

  /** 当前是否已连接 */
  get connected() {
    return Boolean(this.ws && this.ws.readyState === 1);
  }

  // ---------- 连接管理 ----------

  /**
   * 建立连接。若 reconnect 为 true，会持续重试直到成功（指数退避到 maxReconnectDelayMs）。
   * @returns {Promise<void>}
   */
  async connect() {
    this._closing = false;
    this._manualClose = false;
    if (this.connected) return;

    if (this._connectingPromise) return this._connectingPromise;

    const running = (async () => {
      let attempt = 0;
      for (;;) {
        if (this._closing) throw new Error('客户端已关闭，连接流程中止');
        try {
          await this._attemptOnce();
          this._reconnectAttempts = 0;
          return;
        } catch (err) {
          attempt += 1;
          if (!this.reconnect) {
            safeLog(this.logger, 'error', `连接失败（不重试）：${err && err.message}`);
            throw err;
          }
          const delay = this._nextBackoff(attempt);
          safeLog(
            this.logger,
            'warn',
            `连接失败（第 ${attempt} 次）：${err && err.message}，${delay} 毫秒后重试`,
          );
          await this._sleep(delay);
        }
      }
    })();

    this._connectingPromise = running;
    try {
      await running;
    } finally {
      if (this._connectingPromise === running) this._connectingPromise = null;
    }
  }

  /** 计算第 attempt 次重试的退避时间（指数退避 + 抖动，封顶 maxReconnectDelayMs） */
  _nextBackoff(attempt) {
    const base = this.reconnectDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(base, this.maxReconnectDelayMs);
    const jitter = capped * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
    return Math.max(200, Math.round(capped + jitter));
  }

  /** 可被 close() 打断的 sleep */
  _sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._reconnectTimer = null;
        resolve();
      }, ms);
      this._reconnectTimer = timer;
      // 注意：不 unref，否则重连期间进程可能提前退出
    });
  }

  /**
   * 创建底层 WebSocket 连接。优先尝试带 Authorization 头的写法；
   * 若当前运行时（或实现）不支持 headers 选项，则回退到无头模式。
   * @returns {WebSocket}
   */
  _createWebSocket() {
    const headers = {};
    const hasToken = this.accessToken !== '';
    if (hasToken) headers.Authorization = `Bearer ${this.accessToken}`;

    const options = Object.keys(headers).length ? { headers } : undefined;

    if (options) {
      try {
        const ws = new WebSocket(this.url, options);
        if (this._headersSupported === null) {
          this._headersSupported = true;
          safeLog(this.logger, 'debug', '内置 WebSocket 支持 headers 选项，已携带 Authorization 头');
        }
        return ws;
      } catch (err) {
        this._headersSupported = false;
        safeLog(
          this.logger,
          'warn',
          `内置 WebSocket 不支持 headers 选项（${err && err.message}），回退到无 Authorization 头模式；` +
            '若 NapCat 配置了 access_token，连接可能被拒绝。',
        );
        // 继续走下面的回退分支
      }
    }

    const ws = new WebSocket(this.url);
    if (hasToken && this._headersSupported !== true) {
      safeLog(this.logger, 'warn', '当前以无 Authorization 头模式连接（accessToken 未随握手发送）');
    }
    return ws;
  }

  /**
   * 单次连接尝试。成功（open）时 resolve，失败/关闭时 reject。
   * @returns {Promise<void>}
   */
  _attemptOnce() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = this._createWebSocket();
      } catch (err) {
        reject(err);
        return;
      }

      this.ws = ws;
      let settled = false;
      let opened = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        safeLog(this.logger, 'warn', `连接超时（${CONNECT_ATTEMPT_TIMEOUT_MS} 毫秒）`);
        try {
          ws.close();
        } catch {
          /* 忽略 */
        }
        reject(new Error('连接超时'));
      }, CONNECT_ATTEMPT_TIMEOUT_MS);

      const cleanupAttempt = () => {
        clearTimeout(timer);
        ws.removeEventListener?.('open', onOpen);
        ws.removeEventListener?.('error', onError);
        ws.removeEventListener?.('close', onEarlyClose);
      };

      const onOpen = () => {
        opened = true;
        if (!settled) {
          settled = true;
          cleanupAttempt();
          this._onOpen(ws);
          resolve();
        }
      };

      const onError = (e) => {
        let err = e && e.error instanceof Error ? e.error : new Error((e && e.message) || '');
        // Node 内置 WebSocket 的 error 事件常常带一个 message 为空串的 Error，
        // 直接打日志会变成「连接失败（第 1 次）：，2631 毫秒后重试」这种没有信息量的样子。
        // 这里补上 code / cause，便于判断到底是「拒绝连接」还是别的。
        if (!err.message) {
          const hint = err.code || err.cause?.code || err.cause?.message || e?.type || '';
          err = new Error(`WebSocket 连接错误${hint ? `（${hint}）` : ''}`);
        }
        if (!settled) {
          settled = true;
          cleanupAttempt();
          reject(err);
        }
        // 连接已建立后的错误，交回 _onError 统一处理
        if (opened) this._onError(err);
      };

      const onEarlyClose = (e) => {
        if (!settled) {
          settled = true;
          cleanupAttempt();
          const code = e && e.code != null ? e.code : 'unknown';
          reject(new Error(`连接在建立前被关闭（code=${code}）`));
        }
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onEarlyClose);
    });
  }

  /** 连接建立后挂上持续监听与定时器 */
  _onOpen(ws) {
    this._reconnectAttempts = 0;
    safeLog(this.logger, 'info', `已连接到 OneBot：${this.url}`);

    ws.addEventListener('message', (evt) => {
      try {
        this._onRawMessage(evt && evt.data);
      } catch (err) {
        safeLog(this.logger, 'error', `处理消息时发生异常：${err && err.message}`);
      }
    });

    ws.addEventListener('close', (evt) => {
      this._onClosed(evt);
    });

    ws.addEventListener('error', (evt) => {
      const err = evt && evt.error instanceof Error ? evt.error : new Error('WebSocket 连接错误');
      this._onError(err);
    });

    this._startHeartbeat();
    this.emit('open');

    // 连接后用 get_login_info 补齐 selfId（失败忽略，lifecycle 事件也会提供）
    this.getLoginInfo()
      .then((info) => {
        if (info && info.user_id != null) {
          this.selfId = info.user_id;
          safeLog(this.logger, 'info', `机器人登录号：${this.selfId}`);
        }
      })
      .catch(() => {
        /* 忽略：不影响主流程 */
      });
  }

  /** 连接关闭（非主动 close 时按需重连） */
  _onClosed(evt) {
    const code = evt && evt.code != null ? evt.code : null;
    const reason = (evt && evt.reason) || '';
    this._stopHeartbeat();

    const wasCurrent = this.ws != null;
    this.ws = null;
    this._rejectAllPending(new OneBotError('连接已关闭，请求未完成', { action: null, retcode: null }));

    if (wasCurrent) safeLog(this.logger, 'warn', `与 OneBot 的连接已关闭（code=${code}, reason=${reason || '无'}）`);
    this.emit('close', { code, reason });

    if (this._closing || this._manualClose || !this.reconnect) return;

    this._reconnectAttempts += 1;
    const delay = this._nextBackoff(this._reconnectAttempts);
    safeLog(this.logger, 'info', `将在 ${delay} 毫秒后尝试重连（第 ${this._reconnectAttempts} 次）`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closing || this._manualClose) return;
      if (this.connected) return;
      this.connect().catch((err) => {
        safeLog(this.logger, 'error', `重连失败：${err && err.message}`);
      });
    }, delay);
  }

  /** 连接级错误：只 emit，不抛出 */
  _onError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    safeLog(this.logger, 'error', `连接错误：${error.message}`);
    if (this.listenerCount('error') > 0) {
      try {
        this.emit('error', error);
      } catch {
        /* 监听器自身抛错忽略 */
      }
    }
  }

  /** 停止重连、关闭连接、清理所有定时器 */
  close() {
    this._closing = true;
    this._manualClose = true;
    this._stopHeartbeat();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._rejectAllPending(new OneBotError('客户端已关闭，请求未完成'));

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, '客户端主动关闭');
      } catch {
        /* 忽略 */
      }
    }
  }

  // ---------- 心跳 ----------

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      // 心跳失败忽略，不影响连接
      this.call('get_status', {}, { timeoutMs: Math.min(5000, this.callTimeoutMs) }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    // 心跳不应阻止进程退出
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ---------- 收消息 ----------

  /** 处理原始 WS 文本 */
  _onRawMessage(data) {
    if (typeof data !== 'string') {
      // Node 内置 WebSocket 对文本帧给 string；二进制帧我们直接忽略
      safeLog(this.logger, 'debug', '收到非文本帧，已忽略');
      return;
    }

    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      safeLog(this.logger, 'warn', `收到非 JSON 文本，已忽略：${data.slice(0, 200)}`);
      return;
    }
    if (!obj || typeof obj !== 'object') return;

    // 1) 是否是某个 action 的响应（用 echo 匹配）
    if (obj.echo != null && (obj.status != null || obj.retcode != null)) {
      if (this._resolvePending(obj)) return;
      // echo 对不上：可能是超时后被丢弃的响应，继续按事件处理
    }

    // 2) meta_event
    if (obj.post_type === 'meta_event') {
      this._handleMeta(obj);
      this.emit('meta', obj);
      return;
    }

    // 3) message 事件
    if (obj.post_type === 'message' || obj.post_type === 'message_sent') {
      const normalized = normalizeMessage(obj, this.selfId);
      // 尽力从事件里补 selfId / group_id
      if (normalized.selfId != null && this.selfId == null) this.selfId = normalized.selfId;

      // 诊断：既没文字、也没图/表情/卡片，却确实带了消息段 —— 说明遇到了我们不认识的
      // CQ 段类型。这种情况必须把原文打出来，否则只能干瞪眼（之前"图片读不出来"就是这么查出来的）。
      const nothingUsable =
        !normalized.text &&
        normalized.images === 0 &&
        normalized.faces === 0 &&
        normalized.bigFaces === 0 &&
        normalized.cards.length === 0 &&
        !normalized.hasVideo &&
        !normalized.hasFile;
      if (normalized.unknownSegments.length > 0 || (nothingUsable && normalized.raw && normalized.raw.message)) {
        safeLog(
          this.logger,
          'warn',
          `收到一条看不懂内容的消息（未知段类型: ${
            normalized.unknownSegments.join(',') || '无（段都认识，但解析后为空）'
          }）｜原文: ${JSON.stringify(normalized.raw && normalized.raw.message).slice(0, 500)}`,
        );
      }

      try {
        this.emit('message', normalized);
      } catch (err) {
        safeLog(this.logger, 'error', `message 监听器抛出异常：${err && err.message}`);
      }
      return;
    }

    // 4) 拍一拍 —— 注意它走的是 notice 事件，不是 message！
    //    这条以前被当成未知事件丢掉了，所以有人拍她，她一点感觉都没有。
    if (isPokeRecall(obj)) {
      safeLog(this.logger, 'debug', '收到「拍一拍撤回」，忽略');
    } else if (isPokeNotice(obj)) {
      const poked = normalizePokeNotice(obj, this.selfId);
      safeLog(
        this.logger,
        'debug',
        `收到拍一拍：${poked.text}${poked.atSelf ? '（拍的是我）' : ''}｜raw_info=${JSON.stringify(
          obj.raw_info || [],
        ).slice(0, 200)}`,
      );
      try {
        this.emit('message', poked);
      } catch (err) {
        safeLog(this.logger, 'error', `message 监听器抛出异常：${err && err.message}`);
      }
    } else if (obj.post_type === 'notice' && obj.notice_type === 'notify') {
      // 发现了没见过的 notify 子类型就记一笔（info 级，方便在真实环境里发现新互动形态）
      safeLog(
        this.logger,
        'info',
        `未处理的 notify 子类型：${obj.sub_type}｜原文 ${JSON.stringify(obj).slice(0, 300)}`,
      );
    }

    // 5) 其他事件（request 等）
    try {
      this.emit('event', obj);
    } catch (err) {
      safeLog(this.logger, 'error', `event 监听器抛出异常：${err && err.message}`);
    }
  }

  /** 处理 meta_event：主要提取 lifecycle 里的 self_id */
  _handleMeta(obj) {
    if (obj.meta_event_type === 'lifecycle' && obj.self_id != null) {
      if (this.selfId !== obj.self_id) {
        this.selfId = obj.self_id;
        safeLog(this.logger, 'info', `从 lifecycle 元事件获知登录号：${this.selfId}`);
      }
    } else if (this.selfId == null && obj.self_id != null) {
      this.selfId = obj.self_id;
    }
  }

  // ---------- action 调用 ----------

  /**
   * 调用 OneBot action 并等待同 echo 的响应。
   * @param {string} action
   * @param {object} [params]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<any>} API 的 data 字段
   */
  call(action, params = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) {
        reject(
          new OneBotError(`尚未连接到 OneBot，无法调用 ${action}`, {
            action,
            wording: '未连接',
          }),
        );
        return;
      }

      this._echoSeq += 1;
      const echo = `echo-${this._echoSeq}`;
      const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.callTimeoutMs;

      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(
          new OneBotError(`调用 ${action} 超时（${timeoutMs} 毫秒未收到响应）`, {
            action,
            wording: 'timeout',
          }),
        );
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      this._pending.set(echo, { resolve, reject, timer, action });

      const payload = JSON.stringify({ action, params: params || {}, echo });
      try {
        ws.send(payload);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(echo);
        reject(
          new OneBotError(`发送 ${action} 请求失败：${err && err.message}`, {
            action,
            cause: err instanceof Error ? err : undefined,
          }),
        );
      }
    });
  }

  /**
   * 用响应的 echo 匹配挂起的请求。匹配到返回 true。
   */
  _resolvePending(resp) {
    const echo = resp.echo;
    const entry = this._pending.get(echo);
    if (!entry) return false;

    this._pending.delete(echo);
    clearTimeout(entry.timer);

    const status = resp.status;
    const retcode = resp.retcode;
    const failed =
      status === 'failed' || (retcode != null && Number(retcode) !== 0);

    if (failed) {
      entry.reject(
        new OneBotError(
          `OneBot action ${entry.action} 失败：${resp.wording || status || '未知错误'}` +
            (retcode != null ? `（retcode=${retcode}）` : ''),
          {
            action: entry.action,
            retcode: retcode != null ? Number(retcode) : null,
            wording: resp.wording ?? null,
            data: resp.data,
          },
        ),
      );
      return true;
    }

    entry.resolve(resp.data);
    return true;
  }

  /** 连接关闭/主动关闭时，把所有挂起请求 reject 掉 */
  _rejectAllPending(err) {
    if (this._pending.size === 0) return;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      try {
        entry.reject(
          new OneBotError(`${err.message}（action=${entry.action}）`, {
            action: entry.action,
            retcode: err.retcode ?? null,
            wording: err.wording ?? null,
          }),
        );
      } catch {
        /* 忽略 */
      }
    }
    this._pending.clear();
  }

  // ---------- 便捷方法 ----------

  /** 发送私聊消息，返回 API data */
  sendPrivateMsg(userId, message, autoEscape = false) {
    return this.call('send_private_msg', {
      user_id: Number(userId),
      message,
      auto_escape: Boolean(autoEscape),
    });
  }

  /** 发送群消息，返回 API data */
  sendGroupMsg(groupId, message, autoEscape = false) {
    return this.call('send_group_msg', {
      group_id: Number(groupId),
      message,
      auto_escape: Boolean(autoEscape),
    });
  }

  /** 获取登录号信息 */
  getLoginInfo() {
    return this.call('get_login_info');
  }

  /**
   * 用 file 换图片的真实地址。
   * 为什么需要：NapCat 在 enableLocalFile2Url=false（默认）时，消息里的图片段可能
   * 既没有可用的 url，file 也只是一个文件名 —— 直接下载不了。这时问 NapCat 要地址。
   * @returns {Promise<{file?:string,url?:string}>}
   */
  getImage(file) {
    return this.call('get_image', { file: String(file) });
  }

  /** 获取群列表 */
  getGroupList() {
    return this.call('get_group_list');
  }

  /** 获取群成员信息 */
  getGroupMemberInfo(groupId, userId, noCache = false) {
    return this.call('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: Boolean(noCache),
    });
  }

  /** 获取陌生人（账号）信息 */
  getStrangerInfo(userId, noCache = false) {
    return this.call('get_stranger_info', {
      user_id: Number(userId),
      no_cache: Boolean(noCache),
    });
  }

  /**
   * 处理加好友请求。
   * @param {string} flag
   * @param {boolean} [approve=true]
   * @param {string} [remark='']
   */
  setFriendAddRequest(flag, approve = true, remark = '') {
    return this.call('set_friend_add_request', {
      flag: String(flag),
      approve: Boolean(approve),
      remark: String(remark ?? ''),
    });
  }

  /**
   * 处理加群请求／邀请。
   * @param {string} flag
   * @param {string} subType 'add' | 'invite'
   * @param {boolean} [approve=true]
   * @param {string} [reason='']
   */
  setGroupAddRequest(flag, subType, approve = true, reason = '') {
    return this.call('set_group_add_request', {
      flag: String(flag),
      sub_type: String(subType ?? ''),
      approve: Boolean(approve),
      reason: String(reason ?? ''),
    });
  }

  /** 通用调用别名，方便调试 */
  callAction(action, params = {}) {
    return this.call(action, params);
  }
}

export default OneBotClient;
