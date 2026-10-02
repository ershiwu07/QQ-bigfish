/**
 * 桥接层自己的状态存储：跨重启的「聊天记忆」+ 无用的旧 DSH 会话清理。
 *
 * 为什么需要它（重要）：
 * DSH 的 SDK 服务端（dsh-sdk-jsonrpc-server）只用**内存**里的 map 记录自己创建过哪些
 * 会话，进程一重启就是空的，于是它无条件调用 `agents.create({ sessionId })`；
 * 而 dsh-session 的 store 里已经有这条会话 → 抛 `session "xxx" already exists`。
 * 也就是说：**SDK profile 没有任何「接管/恢复已存在会话」的路径**，稳定 id 必然在第二次
 * 启动时全面报错。
 *
 * 所以本项目的做法是：
 *   1) 每次进程启动生成一个 runToken，DSH 会话 id 带上它 → 永不冲突（见 service.mjs）。
 *   2) 真正有价值的上下文（群聊里别人说了什么、大肥鱼之前回了什么）由本模块落盘保存，
 *      重启后照常作为【最近消息】喂给模型 —— 记忆因此不会丢。
 *   3) 上一次运行的会话日志已经不可能被接管，启动时顺手清掉，避免无限占用磁盘。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 生成一个运行期标识（会拼进 DSH 会话 id）。 */
export function makeRunToken() {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 6);
  return `${t}${r}`;
}

/** 粗略相似度：去掉标点空白后的字符 bigram Jaccard 系数。用于识别「换了个说法的同一条事实」。 */
function similarity(a, b) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[\s，。、；：！？""''（）()\[\]【】,.;:!?"'`~～\-_/\\]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i += 1) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  let union = 0;
  for (const [g, c] of gx) {
    const d = gy.get(g) || 0;
    inter += Math.min(c, d);
    union += Math.max(c, d);
  }
  for (const [g, c] of gy) if (!gx.has(g)) union += c;
  return union ? inter / union : 0;
}

/**
 * 持久化的聊天记忆。
 * 存的是每个会话最近的若干条消息（含大肥鱼自己的回复），结构尽量紧凑：
 *   { version, chats: { [chatKey]: { recent: [{ n, t, ts, toMe }], notes: [{t,ts}], updatedAt } } }
 */
export function createStateStore({
  file,
  logger,
  enabled = true,
  maxChats = 2000,
  maxPerChat = 40,
  debounceMs = 1500,
}) {
  let data = { version: 1, chats: {} };
  let timer = null;
  let dirty = false;

  function load() {
    if (!enabled || !file) return;
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object') {
        data = { version: 1, chats: parsed.chats };
        logger?.info(`已载入聊天记忆：${Object.keys(data.chats).length} 个会话（${file}）`);
      }
    } catch (err) {
      logger?.warn(`聊天记忆载入失败（忽略，从空开始）：${err.message}`);
      data = { version: 1, chats: {} };
    }
  }

  function get(chatKey) {
    const entry = data.chats[chatKey];
    return Array.isArray(entry?.recent)
      ? entry.recent.map((x) => ({
          name: x.n,
          text: x.t,
          time: x.ts,
          toMe: Boolean(x.toMe),
          images: Array.isArray(x.img) ? x.img.map((i) => ({ url: i.u, file: i.f })) : [],
          imgUsed: Boolean(x.imgUsed),
        }))
      : [];
  }

  /**
   * 把某张图标记为「已经喂给过模型」。
   * 为什么需要：图片一旦进入 DSH 会话，后续轮次本来就还能看到它；
   * 如果不标记，每个后续消息都会把同一张图重新下载、重新分析一遍 —— 又慢又费钱。
   */
  function markImagesUsed(chatKey, urls) {
    if (!enabled || !Array.isArray(urls) || urls.length === 0) return false;
    const rec = data.chats[chatKey];
    if (!Array.isArray(rec?.recent)) return false;
    const want = new Set(urls.filter(Boolean).map(String));
    if (want.size === 0) return false;
    for (let i = rec.recent.length - 1; i >= 0; i -= 1) {
      const item = rec.recent[i];
      if (!Array.isArray(item.img) || item.imgUsed) continue;
      if (item.img.some((x) => want.has(x.u) || want.has(x.f))) {
        item.imgUsed = 1;
        scheduleSave();
        return true;
      }
    }
    return false;
  }

  /**
   * 长期记忆：被「提炼过」的事实，而不是原始聊天流水。
   * 由模型在回复里用 [记忆] 行主动写入（见 text.mjs 的 extractMemoryNotes）。
   */
  function getNotes(chatKey) {
    const entry = data.chats[chatKey];
    return Array.isArray(entry?.notes) ? entry.notes.map((x) => x.t) : [];
  }

  function addNotes(chatKey, texts, maxNotes = 60) {
    if (!enabled || !Array.isArray(texts) || texts.length === 0) return 0;
    const rec = data.chats[chatKey] ?? { recent: [], updatedAt: 0 };
    if (!Array.isArray(rec.notes)) rec.notes = [];
    let added = 0;
    let merged = 0;
    for (const raw of texts) {
      const t = String(raw).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!t) continue;
      // 完全一样：跳过
      if (rec.notes.some((n) => n.t === t)) continue;
      // 换了说法的同一条事实（比如模型两次提炼措辞不同）：用新的替换旧的，不新增。
      // 这样记忆会自己保持干净，不用你手工删重复。
      const dup = rec.notes.findIndex((n) => similarity(n.t, t) >= 0.8);
      if (dup >= 0) {
        rec.notes.splice(dup, 1);
        rec.notes.push({ t, ts: Date.now() });
        merged += 1;
        continue;
      }
      rec.notes.push({ t, ts: Date.now() });
      added += 1;
    }
    const cap = Number.isFinite(Number(maxNotes)) && Number(maxNotes) > 0 ? Number(maxNotes) : 60;
    while (rec.notes.length > cap) rec.notes.shift();
    rec.updatedAt = Date.now();
    data.chats[chatKey] = rec;
    if (added || merged) scheduleSave();
    if (merged) logger?.debug?.(`长期记忆：${merged} 条近似重复已被新表述替换`);
    return added;
  }

  function push(chatKey, entry) {
    if (!enabled) return;
    const name = String(entry.name ?? '').slice(0, 60);
    const text = String(entry.text ?? '').slice(0, 500);
    const rec = data.chats[chatKey] ?? { recent: [], updatedAt: 0 };
    // toMe：这条是不是直接冲着它说的（@ 它 或命中关键词）。
    // 必须记下来 —— 否则模型看到一串问题时，不知道这些都是问它的。
    // img：这条带的图片地址。用途是「先发图、再问这是什么」这种人类习惯 ——
    // 后一条消息本身没有图，但要能把前面那张找回来。
    const imgs = Array.isArray(entry.images)
      ? entry.images
          .slice(0, 3)
          .map((x) => ({ u: String(x && x.url ? x.url : '').slice(0, 600), f: String(x && x.file ? x.file : '').slice(0, 200) }))
          .filter((x) => x.u || x.f)
      : [];
    const item = { n: name, t: text, ts: Date.now(), toMe: entry.toMe ? 1 : 0 };
    if (imgs.length) item.img = imgs;
    rec.recent.push(item);
    while (rec.recent.length > maxPerChat) rec.recent.shift();
    rec.updatedAt = Date.now();
    data.chats[chatKey] = rec;
    evictIfNeeded();
    scheduleSave();
  }

  function evictIfNeeded() {
    const keys = Object.keys(data.chats);
    if (keys.length <= maxChats) return;
    keys
      .sort((a, b) => (data.chats[a].updatedAt || 0) - (data.chats[b].updatedAt || 0))
      .slice(0, keys.length - maxChats)
      .forEach((k) => delete data.chats[k]);
  }

  function scheduleSave() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function saveNow() {
    if (!enabled || !file || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, file); // 原子替换，避免写一半崩掉把记忆写坏
      dirty = false;
    } catch (err) {
      logger?.warn(`聊天记忆保存失败：${err.message}`);
    }
  }

  // ─────────────── 群成员档案 ───────────────
  // 为什么需要：光有「最近的聊天记录」，她只知道这几句谁说的；
  // 有了按人的档案，别人一开口她就知道"这是谁、他喜欢什么、上次聊到哪"。
  // 这才是"记住群里不同的人"。

  /** 每收到一条消息就调一次：累计次数、刷新昵称/群名片、记最后发言时间。不需要模型。 */
  function touchMember(chatKey, userId, { name = '', card = '' } = {}) {
    if (!enabled || userId == null || userId === '') return;
    const rec = data.chats[chatKey] ?? { recent: [], notes: [], updatedAt: 0 };
    if (!rec.members || typeof rec.members !== 'object') rec.members = {};
    const key = String(userId);
    const m = rec.members[key] ?? { cnt: 0, f: [] };
    m.cnt = (m.cnt || 0) + 1;
    m.last = Date.now();
    if (name) m.n = String(name).slice(0, 60);
    if (card) m.c = String(card).slice(0, 60);
    if (!Array.isArray(m.f)) m.f = [];
    rec.members[key] = m;
    rec.updatedAt = Date.now();
    data.chats[chatKey] = rec;
    scheduleSave();
  }

  /**
   * 首次填充成员（从 NapCat 的群成员接口拉名单时用）。
   * 和 touchMember 的区别：**不动发言次数**，所以不会把"从没说过话的人"算成活跃成员。
   */
  function seedMember(chatKey, userId, { name = '', card = '' } = {}) {
    if (!enabled || userId == null || userId === '') return false;
    const rec = data.chats[chatKey] ?? { recent: [], notes: [], updatedAt: 0 };
    if (!rec.members || typeof rec.members !== 'object') rec.members = {};
    const key = String(userId);
    const existed = Boolean(rec.members[key]);
    const m = rec.members[key] ?? { cnt: 0, f: [] };
    if (name && !m.n) m.n = String(name).slice(0, 60);
    if (card && !m.c) m.c = String(card).slice(0, 60);
    if (!Array.isArray(m.f)) m.f = [];
    rec.members[key] = m;
    data.chats[chatKey] = rec;
    if (!existed) scheduleSave();
    return !existed;
  }

  /** 读某个人的档案（提示词里用） */
  function getMember(chatKey, userId) {
    const m = data.chats[chatKey]?.members?.[String(userId)];
    if (!m) return null;
    return {
      userId: String(userId),
      name: m.c || m.n || String(userId),
      card: m.c || '',
      nickname: m.n || '',
      count: m.cnt || 0,
      last: m.last || 0,
      facts: Array.isArray(m.f) ? m.f.map((x) => x.t) : [],
    };
  }

  /** 给某个人记事实（去重 + 近似合并，和长期记忆同一套规则） */
  function addMemberFacts(chatKey, userId, texts, maxFacts = 40) {
    if (!enabled || userId == null || !Array.isArray(texts) || texts.length === 0) return 0;
    const rec = data.chats[chatKey];
    if (!rec?.members?.[String(userId)]) return 0;
    const m = rec.members[String(userId)];
    if (!Array.isArray(m.f)) m.f = [];
    let added = 0;
    for (const raw of texts) {
      const t = String(raw).replace(/\s+/g, ' ').trim().slice(0, 240);
      if (!t) continue;
      if (m.f.some((x) => x.t === t)) continue;
      // 成员记忆都是短事实句，阈值比会话记忆松一点：
      // "喜欢星穹铁道，习惯半夜在线" 和 "喜欢玩星穹铁道，习惯半夜在线" 相似度 0.79，
      // 用 0.8 就漏了，同一条事实会攒两份。
      const dup = m.f.findIndex((x) => similarity(x.t, t) >= 0.75);
      if (dup >= 0) {
        m.f.splice(dup, 1);
        m.f.push({ t, ts: Date.now() });
        continue;
      }
      m.f.push({ t, ts: Date.now() });
      added += 1;
    }
    const cap = Number.isFinite(Number(maxFacts)) && Number(maxFacts) > 0 ? Number(maxFacts) : 40;
    while (m.f.length > cap) m.f.shift();
    rec.updatedAt = Date.now();
    if (added) scheduleSave();
    return added;
  }

  /** 用名字找成员 id：模型提炼出的记忆里只有名字，得对上号 */
  function findMemberIdByName(chatKey, name) {
    const members = data.chats[chatKey]?.members;
    if (!members) return null;
    const want = String(name ?? '').trim();
    if (want.length < 1) return null;
    const entries = Object.entries(members);
    for (const [id, m] of entries) if (m.c === want || m.n === want) return id;
    for (const [id, m] of entries) {
      const names = [m.c, m.n].filter(Boolean);
      if (names.some((x) => x.includes(want) || want.includes(x))) return id;
    }
    return null;
  }

  /** 群成员花名册（按发言多少排序），用于让她知道群里都有谁 */
  function memberRoster(chatKey, limit = 15) {
    const members = data.chats[chatKey]?.members;
    if (!members) return [];
    return Object.entries(members)
      .sort((a, b) => (b[1].cnt || 0) - (a[1].cnt || 0))
      .slice(0, limit)
      .map(([id, m]) => ({ userId: id, name: m.c || m.n || id, count: m.cnt || 0 }));
  }

  return {
    load,
    get,
    getNotes,
    addNotes,
    push,
    markImagesUsed,
    touchMember,
    seedMember,
    getMember,
    addMemberFacts,
    findMemberIdByName,
    memberRoster,
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      saveNow();
    },
    stats: () => ({
      chats: Object.keys(data.chats).length,
      entries: Object.values(data.chats).reduce((n, c) => n + (c.recent?.length || 0), 0),
      notes: Object.values(data.chats).reduce((n, c) => n + (c.notes?.length || 0), 0),
      members: Object.values(data.chats).reduce((n, c) => n + Object.keys(c.members || {}).length, 0),
      memberFacts: Object.values(data.chats).reduce(
        (n, c) => n + Object.values(c.members || {}).reduce((k, m) => k + (m.f?.length || 0), 0),
        0,
      ),
    }),
  };
}

/**
 * 清理上一次运行遗留的 DSH 会话目录。
 * 只删 sessionsRoot 下、名字以 `<prefix>-` 开头、且不带当前 runToken 的会话目录；
 * 另外还会跳过「最近还在被写」的会话（minAgeMs 以内），这样即使误在机器人运行期间
 * 又启动了一个进程（比如跑 --check），也不会去动正在使用的会话日志。
 * 任何异常都只记日志，不影响启动。
 */
export function pruneStaleSessions({ sessionsRoot, prefix, keepRunToken, logger, minAgeMs = 10 * 60 * 1000 }) {
  const result = { removed: 0, scanned: 0, skippedFresh: 0 };
  const cutoff = Date.now() - minAgeMs;
  try {
    if (!fs.existsSync(sessionsRoot)) return result;
    const escaped = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}-`);
    for (const projectDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const projectPath = path.join(sessionsRoot, projectDir.name);
      let sessions;
      try {
        sessions = fs.readdirSync(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sessions) {
        if (!s.isDirectory() || !re.test(s.name)) continue;
        result.scanned += 1;
        if (keepRunToken && s.name.endsWith(`-${keepRunToken}`)) continue;

        const sessionPath = path.join(projectPath, s.name);
        if (isRecentlyActive(sessionPath, cutoff)) {
          result.skippedFresh += 1;
          continue;
        }

        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          result.removed += 1;
        } catch (err) {
          logger?.warn(`清理旧会话 ${s.name} 失败：${err.message}`);
        }
      }
    }
  } catch (err) {
    logger?.warn(`清理旧会话时出错（忽略）：${err.message}`);
  }
  return result;
}

/** 会话目录里是否有 cutoff 之后被修改过的文件（说明可能仍在使用）。 */
function isRecentlyActive(dir, cutoff) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(path.join(entry.parentPath ?? dir, entry.name));
        if (st.mtimeMs >= cutoff) return true;
      } catch {
        /* 拿不到时间就当作不活跃 */
      }
    }
  } catch {
    return true; // 读不了目录时保守处理：不删
  }
  return false;
}

/**
 * 清理过期的图片附件。
 *
 * 为什么可以放心删：附件只被 DSH 的会话日志引用，而会话是「每次启动都换新、旧的清掉」的
 * （见上面 pruneStaleSessions）；大肥鱼真正的记忆在 state/memory.json 里，不含附件。
 * 所以超过 keepDays 没被动过的附件，不可能还被活着的会话引用。
 *
 * @returns {{removed:number, kept:number, freedBytes:number}}
 */
export function pruneOldAttachments(root, { keepDays = 7, logger } = {}) {
  const result = { removed: 0, kept: 0, freedBytes: 0 };
  try {
    if (!root || !fs.existsSync(root)) return result;
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath ?? root, entry.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(full, { force: true });
          result.removed += 1;
          result.freedBytes += st.size;
        } else {
          result.kept += 1;
        }
      } catch (err) {
        logger?.debug?.(`跳过附件 ${entry.name}：${err.message}`);
      }
    }
  } catch (err) {
    logger?.warn?.(`清理旧附件时出错（忽略）：${err.message}`);
  }
  return result;
}
