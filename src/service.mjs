/**
 * 机器人编排层：把「一条 QQ 消息」变成「要不要回 → 回什么 → 怎么发」。
 *
 * ── 这一版解决的核心问题：连续提问接不上 ──
 * 群里常常冷半天，然后突然聊开、一串问题砸过来。原来的实现有两个毛病：
 *   1. 几条消息挤在一起时，它们都在第一条回复被记录之前通过限流，于是一起涌向模型、
 *      各回一条 → 刷屏；
 *   2. 等第一条回复记进限流后，紧接着的**指名提问**反而被当成「太频繁」直接丢掉
 *      → 表现就是「聊开了它反而接不上」。
 * 现在改成：
 *   · **指名消息（@ 它 / 命中关键词 / 私聊）永不丢弃**，进队列，且同一批合并成一次回答；
 *   · 非指名消息拥挤时直接放弃（20 秒后才冒出来接一句老话更怪）；
 *   · 上下文里给指名消息标上「（@你）」，并明确提示「这些是连着问你的，一起答」。
 */
import { createPolicy, chatKeyOf } from './policy.mjs';
import { parseControlCommand } from './switch.mjs';
import { collectImageBlocks } from './media.mjs';
import {
  buildPrompt,
  sanitizeReply,
  softenReply,
  splitReply,
  sessionIdFor,
  extractMemoryNotes,
  buildDigestPrompt,
  isMetaMemory,
} from './text.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

export function createBot({
  config,
  logger,
  runtime,
  send,
  resolveGroupName = null,
  resolveImageUrl = null,
  state = null,
  runToken = '',
  control = null,
}) {
  const policy = createPolicy({ config, logger });
  const fallbackBuffers = new Map(); // 没注入 state 时的退化实现
  const turns = new Map(); // chatKey -> 已产生的模型交互轮数（用于会话轮换）
  const generations = new Map(); // chatKey -> 会话代次
  const groupNames = new Map();

  // 串行化 + 合并：每个会话同一时间只处理一次回答
  const busy = new Set(); // chatKey 正在处理
  const parked = new Map(); // chatKey -> [{msg, decision, recent, notes, resolve}]

  const stats = {
    handled: 0,
    replied: 0,
    ignored: 0,
    errors: 0,
    sessionConflicts: 0,
    imagesDropped: 0,
    mergedBatches: 0,
    paused: 0,
    lastReplyAt: null,
  };

  const bufferCap =
    Math.max(config.context.recentGroupMessages, config.context.recentPrivateMessages, 6) * 2;

  const directedGap = () => {
    const g = Number(config.limits.directedGapMs);
    return Number.isFinite(g) && g >= 0 ? g : 1200;
  };
  const parkedCap = () => {
    const c = Number(config.limits.maxParkedPerChat);
    return Number.isFinite(c) && c > 0 ? c : 3;
  };

  // ─────────────── 记忆 ───────────────
  function memGet(chatKey) {
    if (state) return state.get(chatKey);
    return (fallbackBuffers.get(chatKey) || []).map((x) => ({ ...x }));
  }

  function memPush(chatKey, entry) {
    if (state) {
      state.push(chatKey, entry);
      return;
    }
    if (!fallbackBuffers.has(chatKey)) fallbackBuffers.set(chatKey, []);
    const arr = fallbackBuffers.get(chatKey);
    arr.push({
      name: entry.name,
      text: entry.text,
      time: Date.now(),
      toMe: Boolean(entry.toMe),
      images: Array.isArray(entry.images) ? entry.images : [],
    });
    while (arr.length > bufferCap) arr.shift();
  }

  /**
   * 「先发图、再问这是什么」——人类就是这么聊天的。
   * 后一条消息本身没有图时，往回找最近一张没用过的图拿来用。
   */
  function findRecentImages(chatKey, maxAgeMs) {
    const all = memGet(chatKey);
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const e = all[i];
      if (!Array.isArray(e.images) || e.images.length === 0) continue;
      // 已经喂过一次就不再重复附上：图片进了会话历史，后续轮次本来就看得到，
      // 重复附只会把同一张图重新下载、重新分析一遍（又慢又费钱）。
      if (e.imgUsed) continue;
      const age = Date.now() - (e.time || 0);
      if (age > maxAgeMs) continue;
      return { images: e.images, ageMs: age, from: e.name };
    }
    return null;
  }

  /** 把某张图标记为「已经喂过模型」（有 state 就持久化，没有就标在内存缓冲上）。 */
  function markImagesUsed(chatKey, urlList) {
    const want = new Set((urlList || []).filter(Boolean).map(String));
    if (want.size === 0) return;
    if (state) {
      try {
        state.markImagesUsed(chatKey, [...want]);
      } catch (err) {
        logger.debug(`标记图片已用失败（忽略）：${err.message}`);
      }
      return;
    }
    const arr = fallbackBuffers.get(chatKey);
    if (!Array.isArray(arr)) return;
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const item = arr[i];
      if (!Array.isArray(item.images) || item.imgUsed) continue;
      if (item.images.some((x) => want.has(String(x.url || '')) || want.has(String(x.file || '')))) {
        item.imgUsed = true;
        return;
      }
    }
  }

  function memGetNotes(chatKey) {
    return state ? state.getNotes(chatKey) : [];
  }

  function memAddNotes(chatKey, texts) {
    if (!state || !texts.length) return 0;
    return state.addNotes(chatKey, texts, config.memory.maxNotesPerChat);
  }

  // ── 群成员档案：让"记住群里不同的人"真正可用 ──
  function touchMember(chatKey, userId, info) {
    if (!state) return;
    try {
      state.touchMember(chatKey, userId, info);
    } catch (err) {
      logger.debug(`更新成员档案失败（忽略）：${err.message}`);
    }
  }

  function memberOf(chatKey, userId) {
    if (!state) return null;
    try {
      return state.getMember(chatKey, userId);
    } catch {
      return null;
    }
  }

  function rosterOf(chatKey) {
    if (!state) return [];
    try {
      return state.memberRoster(chatKey, 15);
    } catch {
      return [];
    }
  }

  /**
   * 把模型写出的「名字 :: 事实」落到对应的人名下；找不到人就退回会话级记忆。
   *
   * ★ 这里会**丢掉一类记忆**：任何把她说成"程序 / AI / 被调 / 被部署 / token"
   *   的条目（判定规则见 text.mjs 的 isMetaMemory）。为什么必须丢——长期记忆每
   *   一轮都会塞进提示词，攒多了她就开始用"日志""调试""数据库"这种词说话，
   *   把自己当成一个待改的东西。真实踩过：某个群攒了十几条，她在那个群里
   *   就变成了"你自己翻翻日志去"。
   */
  function saveMemoryNotes(chatKey, notes, memberNotes, source) {
    const dropMeta = (text) => {
      if (!isMetaMemory(text)) return false;
      logger.debug(`丢掉一条"把她当程序写"的记忆（${source}）：${truncate(text, 60)}`);
      return true;
    };

    const keptNotes = (notes || []).filter((t) => !dropMeta(t));
    let added = memAddNotes(chatKey, keptNotes);
    let memberAdded = 0;
    const unmatched = [];
    for (const item of memberNotes || []) {
      if (dropMeta(item.fact)) continue;
      let userId = null;
      try {
        userId = state ? state.findMemberIdByName(chatKey, item.name) : null;
      } catch {
        userId = null;
      }
      if (!userId) {
        unmatched.push(`${item.name}：${item.fact}`);
        continue;
      }
      try {
        memberAdded += state.addMemberFacts(chatKey, userId, [item.fact], config.memory.maxFactsPerMember);
      } catch (err) {
        logger.debug(`写成员记忆失败（忽略）：${err.message}`);
      }
    }
    if (unmatched.length) added += memAddNotes(chatKey, unmatched.filter((t) => !dropMeta(t)));
    if (added || memberAdded) {
      logger.info(
        `${source}：新增 ${added} 条会话记忆、${memberAdded} 条成员记忆${
          unmatched.length ? `（${unmatched.length} 条认不出是谁，先记在会话里）` : ''
        }`,
      );
    }
    return added + memberAdded;
  }

  function recentFor(msg) {
    const n =
      msg.kind === 'group' ? config.context.recentGroupMessages : config.context.recentPrivateMessages;
    if (n <= 0) return [];
    const all = memGet(chatKeyOf(msg));
    const slice = all.slice(-n);
    // 按字符预算从最近往前取，避免把上下文撑得过大
    const out = [];
    let budget = config.context.maxChars;
    for (let i = slice.length - 1; i >= 0; i -= 1) {
      const item = slice[i];
      const cost = String(item.name).length + String(item.text).length + 4;
      if (budget - cost < 0) break;
      budget -= cost;
      out.unshift(item);
    }
    return out;
  }

  // ─────────────── 会话管理 ───────────────
  async function groupNameOf(groupId) {
    const key = String(groupId);
    if (groupNames.has(key)) return groupNames.get(key);
    if (!resolveGroupName) return null;
    try {
      const name = await resolveGroupName(key);
      if (name) groupNames.set(key, name);
      return name || null;
    } catch {
      return null;
    }
  }

  function maybeRotate(chatKey) {
    const rotate = config.dsh.sessionRotateTurns || 0;
    const n = turns.get(chatKey) || 0;
    if (rotate > 0 && n > 0 && n % rotate === 0) {
      generations.set(chatKey, (generations.get(chatKey) || 1) + 1);
      logger.info(`会话 ${chatKey} 达到 ${rotate} 轮，轮换到新会话（DSH 上下文重新开始，聊天记忆保留）`);
    }
  }

  function sessionIdOf(msg, extraGen = 0) {
    const chatKey = chatKeyOf(msg);
    return sessionIdFor(msg, {
      prefix: config.dsh.sessionPrefix,
      generation: (generations.get(chatKey) || 1) + extraGen,
      runToken,
    });
  }

  // ─────────────── 定期学习 ───────────────
  const digestCounters = new Map();
  const digestRunning = new Set();

  async function maybeDigest(chatKey, msg) {
    const L = config.learning;
    if (!L || L.enabled !== true) return;
    const every = Number(L.everyMessages) > 0 ? Number(L.everyMessages) : 25;
    const n = (digestCounters.get(chatKey) || 0) + 1;
    digestCounters.set(chatKey, n);
    if (n < every || digestRunning.has(chatKey)) return;
    digestCounters.set(chatKey, 0);
    digestRunning.add(chatKey);
    try {
      const take = Number(L.maxMessagesPerDigest) > 0 ? Number(L.maxMessagesPerDigest) : 30;
      const messages = memGet(chatKey).slice(-take);
      if (!messages.length) return;
      const existingNotes = memGetNotes(chatKey);
      const groupName =
        msg.kind === 'group'
          ? groupNames.get(String(msg.groupId)) ?? (await groupNameOf(msg.groupId))
          : null;
      const prompt = buildDigestPrompt({
        groupName,
        groupId: msg.groupId,
        messages,
        existingNotes,
      });
      const sessionId = sessionIdFor(msg, { prefix: `${config.dsh.sessionPrefix}-learn`, runToken });
      const outcome = await runtime.ask(sessionId, prompt);
      const { notes, memberNotes } = extractMemoryNotes(outcome?.text ?? '');
      const added = saveMemoryNotes(chatKey, notes, memberNotes, '学习');
      if (added) {
        logger.info(`${chatKey} 累计会话记忆 ${memGetNotes(chatKey).length} 条`);
      } else {
        logger.debug(`学习：${chatKey} 这批没有新知识`);
      }
    } catch (err) {
      logger.warn(`学习任务失败（${chatKey}）：${err.message}`);
    } finally {
      digestRunning.delete(chatKey);
    }
  }

  // ─────────────── 真正做一次回答 ───────────────
  async function processReply(
    msg,
    decision,
    { echo = true, recent = [], notes = [], directed = false, skipPostRateCheck = false } = {},
  ) {
    const chatKey = chatKeyOf(msg);
    const groupName = msg.kind === 'group' ? await groupNameOf(msg.groupId) : null;

    // 图片：真的下载下来喂给模型（不是只告诉它"有张图"）
    let media =
      config.images && config.images.enabled === true && (msg.images || 0) > 0
        ? await collectImageBlocks(msg, config.images, logger, { resolveImageUrl })
        : { blocks: [], ok: 0, failed: 0, skipped: 0, detected: 0 };
    let imagesFrom = 'inline';

    if (media.blocks.length && imagesFrom === 'inline') {
      markImagesUsed(chatKey, (msg.imageUrls || []).map((x) => x.url || x.file));
    }

    // 这条本身没带图 → 往回找最近一张没用过的（「先发图、再问这是什么」）
    const lookbackMs = Number(config.images && config.images.lookbackMs);
    if (media.blocks.length === 0 && (msg.images || 0) === 0 && lookbackMs > 0) {
      const found = findRecentImages(chatKey, lookbackMs);
      if (found) {
        const lb = await collectImageBlocks(
          { images: found.images.length, imageUrls: found.images },
          config.images,
          logger,
          { resolveImageUrl },
        );
        if (lb.blocks.length) {
          media = lb;
          imagesFrom = 'lookback';
          markImagesUsed(chatKey, found.images.map((x) => x.url || x.file));
          logger.info(
            `这条消息本身没带图，但 ${Math.round(found.ageMs / 1000)} 秒前 ${found.from} 发过图，就把那张拿过来一起判断`,
          );
        }
      }
    }

    if (msg.images > 0) {
      if (media.blocks.length) {
        logger.info(`附上 ${media.blocks.length} 张图片一起判断（跳过 ${media.skipped}，失败 ${media.failed}）`);
      } else {
        // 这条以前是「静默跳过」，导致很难排查；现在明确记一笔
        logger.warn(
          `这条消息有 ${msg.images} 张图片，但一张都没取到（跳过 ${media.skipped}，失败 ${media.failed}），只能按"看不到内容"处理`,
        );
      }
    }

    const prompt = buildPrompt({
      msg,
      recent,
      notes,
      groupName,
      selfDecide: config.trigger.selfDecide === true,
      imagesAttached: media.blocks.length,
      imagesLookedBack: imagesFrom === 'lookback',
      latestDirected: directed,
      // 刻意不传 owner：亲近是她的默认性格，不该由"发消息的人是谁"决定
      member: msg.kind === 'group' ? memberOf(chatKey, msg.userId) : null,
      roster: msg.kind === 'group' ? rosterOf(chatKey) : [],
    });

    maybeRotate(chatKey);
    const started = Date.now();

    let outcome = null;
    let sessionId = sessionIdOf(msg);
    let blocks = media.blocks;
    let triedConflict = false;
    let triedWithoutImages = false;

    for (let guard = 0; guard < 4; guard += 1) {
      try {
        outcome = await runtime.ask(sessionId, prompt, { extraBlocks: blocks });
        break;
      } catch (err) {
        // ① 撞上「会话已存在」（上一次运行留下的日志）→ 换个代次重试
        if (!triedConflict && /already exists/i.test(String(err.message))) {
          triedConflict = true;
          stats.sessionConflicts += 1;
          logger.warn(`会话 ${sessionId} 已存在，换一个新会话重试（${err.message}）`);
          generations.set(chatKey, (generations.get(chatKey) || 1) + 1);
          sessionId = sessionIdOf(msg);
          continue;
        }
        // ② 带图失败 → 去掉图片重试，别让一条消息因为图彻底失败
        if (blocks.length && !triedWithoutImages) {
          triedWithoutImages = true;
          stats.imagesDropped += 1;
          logger.warn(`带图片的请求失败（${err.message}），去掉图片重试一次`);
          blocks = [];
          continue;
        }

        stats.errors += 1;
        const isTimeout = err.code === 'TURN_TIMEOUT' || err.code === 'REQUEST_TIMEOUT';
        const fallback = isTimeout ? config.fallback.onTimeout : config.fallback.onError;
        logger.error(`模型调用失败（${sessionId}）：${err.message}`);
        if (fallback) {
          await send(msg, fallback);
          policy.noteReply(chatKey, { keyword: decision.keyword, directed });
          memPush(chatKey, { name: '大肥鱼', text: fallback });
          stats.replied += 1;
          stats.lastReplyAt = Date.now();
          return { replied: true, reason: 'fallback', texts: [fallback], ms: Date.now() - started };
        }
        return { replied: false, reason: isTimeout ? 'timeout' : 'error' };
      }
    }

    const reason = outcome?.reason?.kind ?? 'unknown';

    // ★ 踩过的坑：SDK 遇到鉴权失败（401）**不会抛异常**，而是正常返回，
    //   把错误塞在 reason.error 里。如果这里不处理，代码会走到下面那条
    //   "turn/end 不是 completed" 的 WARN，正文是空的，于是**收到消息却一声不吭**——
    //   表现为"她莫名其妙不理人了"，极难排查。
    if (reason === 'error') {
      const e = outcome?.reason?.error || {};
      const isAuth = e.status === 401 || e.status === 403 || e.code === 'AUTH';
      stats.errors += 1;
      if (isAuth) {
        logger.error(`★ API Key 无效（HTTP ${e.status || '?'} ${e.code || ''}）——她没法说话了`);
        logger.error(`  模型原话：${e.message || '(无)'}`);
        logger.error('  怎么修：去 DeepSeek 平台生成一个新 Key → 填进 .env 的 DEEPSEEK_API_KEY → 重启机器人。');
      } else {
        logger.error(`模型返回错误（HTTP ${e.status || '?'} ${e.code || ''}）：${e.message || '(无信息)'}`);
      }
      const fallback = config.fallback.onError;
      if (fallback) {
        await send(msg, fallback);
        policy.noteReply(chatKey, { keyword: decision.keyword, directed });
        memPush(chatKey, { name: '大肥鱼', text: fallback });
        stats.replied += 1;
        stats.lastReplyAt = Date.now();
        return { replied: true, reason: 'fallback', texts: [fallback], ms: Date.now() - started };
      }
      return { replied: false, reason: isAuth ? 'auth-error' : 'model-error' };
    }

    // 先把模型写的长期记忆抽出来（那一行不会发出去），再清洗真正要说的正文
    const extracted = extractMemoryNotes(outcome?.text ?? '');
    if (extracted.notes.length || extracted.memberNotes.length) {
      saveMemoryNotes(chatKey, extracted.notes, extracted.memberNotes, '顺手记忆');
    }

    let text = sanitizeReply(extracted.clean, {
      maxChars: config.output.maxCharsPerMessage * config.output.maxSegments + 200,
    });

    // 兜底：提示词已经把否定式反问列进黑名单，但实测仍有漏网，这里确定性改掉
    if (text) {
      const softened = softenReply(text);
      if (softened.changed) {
        logger.warn(`回复里有顶撞话，已改写后再发（去掉：${softened.removed.join('、')}）`);
        text = softened.text;
      }
    }

    if (!text) {
      logger.debug(`模型决定不回复（${sessionId}），turn/end=${reason}`);
      turns.set(chatKey, (turns.get(chatKey) || 0) + 1);
      return { replied: false, reason: reason === 'completed' ? 'model-silent' : `turn-${reason}` };
    }

    if (reason !== 'completed') {
      logger.warn(`turn/end 不是 completed（${reason}），仍然按已有内容回复：${truncate(text, 60)}`);
    }

    const segments = config.output.splitLongReplies
      ? splitReply(text, {
          maxCharsPerMessage: config.output.maxCharsPerMessage,
          maxSegments: config.output.maxSegments,
        })
      : [text];

    if (!segments.length) return { replied: false, reason: 'empty-after-split' };

    // 发送前的二次限流只对「非指名」有意义：指名走队列，不会互相撞车
    if (!directed && !skipPostRateCheck) {
      const blocked = policy.rateCheck(chatKey, false);
      if (blocked) {
        logger.debug(`模型已经想好怎么回了，但被限流拦下（${blocked}），本次不发`);
        return { replied: false, reason: blocked };
      }
    }

    await sleep(rand(config.output.typingDelayMinMs, config.output.typingDelayMaxMs));
    for (let i = 0; i < segments.length; i += 1) {
      if (i > 0) await sleep(rand(config.output.segmentDelayMinMs, config.output.segmentDelayMaxMs));
      await send(msg, segments[i]);
      if (echo) logger.info(`回复 ${chatKey} → ${truncate(segments[i], 80)}`);
    }

    turns.set(chatKey, (turns.get(chatKey) || 0) + 1);
    policy.noteReply(chatKey, { keyword: decision.keyword, directed });
    memPush(chatKey, { name: '大肥鱼', text: segments.join(' ') });
    stats.replied += 1;
    stats.lastReplyAt = Date.now();
    return { replied: true, reason: decision.reason, texts: segments, ms: Date.now() - started };
  }

  // ─────────────── 队列：指名消息永不丢弃，同批合并 ───────────────
  async function pump(chatKey) {
    if (busy.has(chatKey)) return;
    busy.add(chatKey);
    try {
      for (;;) {
        const q = parked.get(chatKey);
        if (!q || !q.length) break;
        const batch = q.splice(0);
        // 用最新那条当「最新消息」；更早的那些已经在它的【最近消息】快照里（并标了 @你）
        const leader = batch[batch.length - 1];
        if (batch.length > 1) {
          stats.mergedBatches += 1;
          logger.info(
            `${chatKey} 有 ${batch.length} 条指名消息挤在一起，合并成一次回答（${batch
              .map((b) => truncate(b.msg.text, 18))
              .join(' | ')}）`,
          );
        }
        let res;
        try {
          res = await processReply(leader.msg, leader.decision, {
            echo: true,
            recent: leader.recent,
            notes: leader.notes,
            directed: Boolean(leader.decision.directed),
            skipPostRateCheck: true,
          });
        } catch (err) {
          stats.errors += 1;
          logger.error(`处理指名消息异常（${chatKey}）：${err.message}`);
          res = { replied: false, reason: 'error' };
        }
        for (const p of batch) {
          p.resolve(p === leader ? res : { replied: res.replied, reason: 'batched-with-later' });
        }
        if ((parked.get(chatKey) || []).length) await sleep(directedGap());
      }
    } finally {
      busy.delete(chatKey);
    }
  }

  function enqueueDirected(chatKey, entry) {
    return new Promise((resolve) => {
      const q = parked.get(chatKey) ?? [];
      q.push({ ...entry, resolve });
      // 队列上限：超出时丢最老的，但它**已经在最新那条的最近消息快照里**，
      // 会被后面那次回答一起答掉 —— 所以不算真丢。
      while (q.length > parkedCap()) {
        const dropped = q.shift();
        dropped.resolve({ replied: false, reason: 'coalesced-into-later' });
      }
      parked.set(chatKey, q);
      void pump(chatKey);
    });
  }

  // ─────────────── 入口 ───────────────
  /**
   * 处理一条归一化消息。
   * 指名消息会排队；返回的 Promise 在**这条消息真正被处理完**之后才 resolve，
   * 所以调用方 await 它就能拿到真实结果（自测就是靠这个）。
   */
  async function handleMessage(msg, { echo = true } = {}) {
    stats.handled += 1;
    const chatKey = chatKeyOf(msg);
    const who = `${msg.senderName}(${msg.userId})`;

    const decision = policy.decide(msg);
    const remember = decision.reason !== 'muted-group';
    const addressedToMe = policy.isDirected(msg);

    // 每条消息都刷新一次成员档案（纯本地、不花钱）：昵称、群名片、发言次数、最后发言时间。
    // 这是"记住群里不同的人"的地基。
    if (remember && msg.userId) {
      touchMember(chatKey, msg.userId, { name: msg.senderName, card: msg.senderCard });
    }

    // 顺序很关键：必须先把「本条之前」的历史取出来，再把本条落盘，
    // 否则当前这条会同时出现在【最近消息】和【最新消息】里，重复一遍。
    const recent = decision.action === 'reply' ? recentFor(msg) : [];
    const notes = decision.action === 'reply' ? memGetNotes(chatKey) : [];

    if (remember) {
      memPush(chatKey, {
        name: msg.senderName,
        text: msg.text || (msg.images ? '(图片)' : '(空消息)'),
        toMe: addressedToMe,
        // 把图片地址也存进记忆，供「先发图、再问这是什么」往回找
        images: msg.imageUrls,
      });
    }

    // ── 管理指令：必须在「暂停」判断之前，否则暂停了就再也叫不醒她 ──
    const ownerId = config.owner && config.owner.userId ? String(config.owner.userId) : '';
    const fromOwner = Boolean(ownerId) && String(msg.userId) === ownerId;
    if (fromOwner && control && (msg.kind === 'private' || msg.atSelf || addressedToMe)) {
      const cmd = parseControlCommand(msg.text);
      if (cmd) {
        const label = msg.senderName || ownerId;
        if (cmd.kind === 'pause') {
          const st = control.pause({ minutes: cmd.minutes, by: label, reason: msg.text.slice(0, 40) });
          const how = st.forever ? '你让我什么时候恢复我再恢复' : `${st.remainingMinutes} 分钟后自己醒`;
          const line = `唔……那我先趴着不说话啦（${how}）。要叫我起来就说"恢复"。`;
          logger.info(`老板让暂停：${label} → ${cmd.minutes} 分钟`);
          await send(msg, line);
          stats.paused += 1;
          return { replied: true, reason: 'paused-by-owner', texts: [line] };
        }
        control.resume({ by: label });
        const line = '醒啦——在的呀，刚才我一直在听。';
        logger.info(`老板让恢复：${label}`);
        await send(msg, line);
        return { replied: true, reason: 'resumed-by-owner', texts: [line] };
      }
    }

    // ── 暂停中：继续听、继续记事，但不回话、不花模型的钱 ──
    if (control && control.isPaused()) {
      stats.ignored += 1;
      logger.debug(`暂停中，只记不回：${chatKey} ${who}: ${truncate(msg.text)}`);
      return { replied: false, reason: 'paused' };
    }

    if (remember) void maybeDigest(chatKey, msg).catch(() => {});

    if (decision.action === 'ignore') {
      stats.ignored += 1;
      // 图片被策略跳过时要说清楚原因：不然用户只会看到"它没理那张图"，
      // 根本不知道是「没 @ 它」而不是「识图坏了」。
      if ((msg.images || 0) > 0) {
        logger.info(
          `这张图片没有看（原因：${decision.reason}）—— 群里只有被 @ 或命中关键词时才会看图，私聊发的图都会看`,
        );
      }
      logger.debug(`忽略消息 [${decision.reason}] ${chatKey} ${who}: ${truncate(msg.text)}`);
      return { replied: false, reason: decision.reason };
    }

    // 指名提问、以及「必须看一眼」的图片：进队列，永不丢弃
    if (decision.directed || decision.mustProcess) {
      return enqueueDirected(chatKey, { msg, decision, recent, notes });
    }

    // 非指名：正在忙着回答（或刚排了一批指名消息）就放弃这次
    if (busy.has(chatKey) || (parked.get(chatKey) || []).length > 0) {
      return { replied: false, reason: 'chat-busy' };
    }

    busy.add(chatKey);
    try {
      return await processReply(msg, decision, { echo, recent, notes, directed: false });
    } finally {
      busy.delete(chatKey);
      void pump(chatKey); // 处理期间可能又排进了指名消息
    }
  }

  /** 等所有排队中的指名消息都处理完（自测与关停时用）。 */
  async function drain({ timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = busy.size > 0 || [...parked.values()].some((q) => q.length > 0);
      if (!pending) return true;
      await sleep(50);
    }
    return false;
  }

  return {
    handleMessage,
    drain,
    policy,
    stats,
    snapshot: () => ({
      ...stats,
      policy: policy.stats(),
      chats: state ? state.stats().chats : fallbackBuffers.size,
      memory: state ? state.stats() : null,
      busy: busy.size,
      queued: [...parked.values()].reduce((n, q) => n + q.length, 0),
    }),
  };
}

function truncate(s, n = 120) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
