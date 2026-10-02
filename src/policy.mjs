/**
 * 触发策略：决定「这条 QQ 消息要不要回」。
 *
 * 这是 v1 的规则版决策器。v2 要升级成「半自主 Agent」时，只需要在
 * decide() 返回 reply 之后，把最终是否发送交给模型自己判断（见 service.mjs 里的
 * selfDecide 处理），规则层仍然作为第一道成本/骚扰闸门。
 */

export function chatKeyOf(msg) {
  return msg.kind === 'group' ? `group:${msg.groupId}` : `private:${msg.userId}`;
}

const hasTextOf = (msg) => typeof msg.text === 'string' && msg.text.trim().length > 0;

export function createPolicy({ config, logger }) {
  const t = config.trigger;
  const lim = config.limits;
  const seenMessages = new Map(); // messageId -> 时间戳
  const chatReplies = new Map(); // chatKey -> 时间戳数组（所有回复）
  const directedReplies = new Map(); // chatKey -> 时间戳数组（仅「指名」的回复）
  const lastKeywordReplyAt = new Map(); // chatKey -> 时间戳
  const globalReplies = [];
  const counters = { considered: 0, replied: 0, ignored: 0, byReason: {} };

  const bump = (reason) => {
    counters.byReason[reason] = (counters.byReason[reason] || 0) + 1;
  };

  const prune = (arr, windowMs, now) => {
    while (arr.length && now - arr[0] > windowMs) arr.shift();
    return arr;
  };

  /** 这个会话上一次由它说话是什么时候（0 表示还没说过）。 */
  const lastReplyAt = (chatKey) => {
    const arr = chatReplies.get(chatKey);
    return arr && arr.length ? arr[arr.length - 1] : 0;
  };

  /** 记录「已经回了一条」，用于限流。 */
  function noteReply(chatKey, { keyword = false, directed = false } = {}) {
    const now = Date.now();
    if (!chatReplies.has(chatKey)) chatReplies.set(chatKey, []);
    chatReplies.get(chatKey).push(now);
    globalReplies.push(now);
    if (directed) {
      if (!directedReplies.has(chatKey)) directedReplies.set(chatKey, []);
      directedReplies.get(chatKey).push(now);
    }
    if (keyword) lastKeywordReplyAt.set(chatKey, now);
    counters.replied += 1;
  }

  function decide(msg) {
    counters.considered += 1;
    const now = Date.now();
    const chatKey = chatKeyOf(msg);
    const decide_ = (action, reason, extra = {}) => {
      if (action === 'ignore') {
        counters.ignored += 1;
        bump(reason);
      }
      return { action, reason, chatKey, ...extra };
    };

    // 0. 去重：OneBot 断线重连后可能重推同一条消息
    const mid = String(msg.messageId ?? '');
    if (mid) {
      for (const [k, ts] of seenMessages) {
        if (now - ts > lim.dedupeWindowMs) seenMessages.delete(k);
      }
      if (seenMessages.has(mid)) return decide_('ignore', 'duplicate');
      seenMessages.set(mid, now);
    }

    // 1. 空消息（只有图片/表情且没有文字）先放行给群/私聊规则，但记录图片数
    const hasText = typeof msg.text === 'string' && msg.text.trim().length > 0;

    if (msg.kind === 'group') {
      const gid = String(msg.groupId);

      if (t.mutedGroups.includes(gid)) return decide_('ignore', 'muted-group');

      if (t.groupWhitelist.length > 0 && !t.groupWhitelist.includes(gid)) {
        return decide_('ignore', 'group-not-whitelisted');
      }

      if (msg.atAll && !t.ignoreAtAll) return decide_('ignore', 'at-all');

      let hitKeyword = false;
      if (hasText && t.keywords.length) {
        const lower = msg.text.toLowerCase();
        hitKeyword = t.keywords.some((k) => lower.includes(k.toLowerCase()));
      }

      const always = t.alwaysReplyGroups.includes(gid);
      let shouldReply = false;
      switch (t.group) {
        case 'all':
          shouldReply = true;
          break;
        case 'at_only':
          shouldReply = msg.atSelf || always;
          break;
        case 'whitelist':
          shouldReply = always; // 白名单在上面已校验
          break;
        case 'at_or_keyword':
        default:
          shouldReply = msg.atSelf || hitKeyword || always;
          break;
      }
      if (!shouldReply) return decide_('ignore', msg.atSelf ? 'group-rule' : 'not-mentioned');

      // 关键词触发有冷却，避免有人刷关键词
      const onlyKeyword = !msg.atSelf && !always && hitKeyword;
      if (onlyKeyword) {
        const last = lastKeywordReplyAt.get(chatKey) || 0;
        if (now - last < lim.keywordCooldownMs) return decide_('ignore', 'keyword-cooldown');
      }

      if (!hasText) {
        // 没打字的情况分三种，处理方式不同：
        //   ① 只发了图 + 被点名（@ 或关键词）→ 现在能看到图了，交给模型看
        //   ② 只发了图 + 没人点它      → 默认不回（群里每张梗图都看一遍太贵）
        //                               但 images.considerAmbient 打开时，放它去走活跃度骰子，
        //                               这样群里发梗图它偶尔会自己凑一句，不像个死物
        //   ③ 连图都没有的空 @        → 相当于喊它一声，应一下
        const imagesUsable = msg.images > 0 && config.images && config.images.enabled === true;
        const directedHere = Boolean(msg.atSelf || onlyKeyword || always);
        const canSeeImage = imagesUsable && directedHere;
        const canAnswerEmptyAt = msg.images === 0 && msg.atSelf && t.replyToEmptyAt;
        const ambientImageChance =
          imagesUsable && !directedHere && config.images && config.images.considerAmbient === true;
        if (!canSeeImage && !canAnswerEmptyAt && !ambientImageChance) {
          if (msg.images > 0) {
            return decide_('ignore', imagesUsable ? 'image-ambient-skipped' : 'image-only-unsupported');
          }
          return decide_('ignore', 'empty-message');
        }
      }

      // ── 「主动参与」模式的两个闸门 ──
      // directed = 有人明确点了它（@ 或关键词）。这种必须交给模型，
      // 不能因为掷骰子或冷场间隔就把「叫它」当成没听见。
      // 注意：alwaysReplyGroups 只是「这个群可以多聊」，不算指名。
      const directed = Boolean(msg.atSelf || onlyKeyword);
      // 图片：配置了 alwaysLook 就一律看一眼（不靠骰子省这个钱）。
      // 看归看，说不说仍然交给模型自己判断（selfDecide），所以不会变成刷屏机器。
      const imageAlwaysLook =
        msg.images > 0 && config.images && config.images.enabled === true && config.images.alwaysLook === true;
      const mustProcess = imageAlwaysLook && !directed;
      if (!directed && !imageAlwaysLook && t.group === 'all') {
        // 闸门① 冷场间隔：它刚说完话，就让别人说一会儿，别抢话
        const lim2 = Number(lim.afterReplyCooldownMs);
        const last = lastReplyAt(chatKey);
        if (Number.isFinite(lim2) && lim2 > 0 && last && now - last < lim2) {
          return decide_('ignore', 'after-reply-cooldown');
        }
        // 闸门② 活跃度：0~1，越小越省钱也越安静；1 表示每条都交给模型判断
        const chance = Number(t.replyChance);
        if (Number.isFinite(chance) && chance < 1 && Math.random() >= chance) {
          return decide_('ignore', 'chance-skip');
        }
      }

      // 图片走「指名」那套宽松限流：只保留一个防刷的硬上限
      const rate = checkRate(chatKey, now, directed || imageAlwaysLook);
      if (rate) return decide_('ignore', rate);

      const replyReason = !hasText
        ? msg.images > 0
          ? directed
            ? 'group-image-directed'
            : 'group-image-ambient'
          : 'group-at-empty'
        : msg.atSelf
          ? 'group-at'
          : onlyKeyword
            ? 'group-keyword'
            : 'group-always';
      return decide_('reply', replyReason, { keyword: onlyKeyword, directed, mustProcess });
    }

    if (msg.kind === 'private') {
      const uid = String(msg.userId);
      if (t.privateBlocklist.includes(uid)) return decide_('ignore', 'user-blocked');
      if (t.private === 'none') return decide_('ignore', 'private-disabled');
      if (t.private === 'whitelist' && !t.privateWhitelist.includes(uid)) {
        return decide_('ignore', 'user-not-whitelisted');
      }
      if (t.privateWhitelist.length > 0 && !t.privateWhitelist.includes(uid)) {
        return decide_('ignore', 'user-not-whitelisted');
      }
      if (!hasText) {
        // 私聊里朋友发张截图不附文字是很常见的，能看图就该看
        const imagesUsable = msg.images > 0 && config.images && config.images.enabled === true;
        if (!imagesUsable) return decide_('ignore', msg.images > 0 ? 'image-only-unsupported' : 'empty-message');
      }

      // 私聊本质就是「指名跟它说话」，同样走指名规则
      const rate = checkRate(chatKey, now, true);
      if (rate) return decide_('ignore', rate);

      return decide_('reply', 'private-message', { directed: true });
    }

    return decide_('ignore', 'unsupported-message-type');
  }

  /**
   * 返回 null 表示通过；否则返回被拦截的原因。
   *
   * 指名（@ 它 / 命中关键词 / 私聊）走一套独立的规则：
   * **只保留一个防刷的硬上限，不检查「间隔太短」和「每分钟条数」** ——
   * 因为那些规则原本是为「防止它自己乱插话」设计的，用在这里会把别人
   * 连着问它的正经问题当成刷屏丢掉，表现就是「聊开了它反而接不上」。
   * 指名的连续提问由 service.mjs 排队合并处理，不会刷屏。
   */
  function checkRate(chatKey, now, directed = false) {
    if (directed) {
      const dArr = prune(directedReplies.get(chatKey) || [], 60000, now);
      directedReplies.set(chatKey, dArr);
      const cap = Number(lim.maxDirectedPerMinute) > 0 ? Number(lim.maxDirectedPerMinute) : 12;
      if (dArr.length >= cap) return 'rate-directed-per-minute';
      prune(globalReplies, 60000, now);
      if (globalReplies.length >= lim.globalMaxRepliesPerMinute) return 'rate-global';
      return null;
    }

    const arr = prune(chatReplies.get(chatKey) || [], 60 * 60 * 1000, now);
    chatReplies.set(chatKey, arr);

    const last = arr.length ? arr[arr.length - 1] : 0;
    if (last && now - last < lim.minIntervalPerChatMs) return 'rate-min-interval';

    const inMinute = arr.filter((ts) => now - ts < 60000).length;
    if (inMinute >= lim.maxRepliesPerChatPerMinute) return 'rate-per-minute';
    if (arr.length >= lim.maxRepliesPerChatPerHour) return 'rate-per-hour';

    prune(globalReplies, 60000, now);
    if (globalReplies.length >= lim.globalMaxRepliesPerMinute) return 'rate-global';

    return null;
  }

  return {
    decide,
    noteReply,
    chatKeyOf,
    /**
     * 这条消息是不是「直接冲着它说的」。
     * 只用于在记忆里打标记（渲染成「（@你）」），让模型看得出哪些是在连着问它。
     * 与 decide 里的 directed 保持同样的判断口径。
     */
    isDirected: (msg) => {
      if (!msg) return false;
      if (msg.kind === 'private') return true;
      if (msg.atSelf) return true;
      if (!hasTextOf(msg) || !t.keywords.length) return false;
      const lower = String(msg.text).toLowerCase();
      return t.keywords.some((k) => lower.includes(String(k).toLowerCase()));
    },
    /**
     * 发送前的二次校验。
     * 为什么需要：decide() 在「消息到达时」判断，而模型调用要 1 秒左右；
     * 两条消息几乎同时到达时，它们都会在任一回复被记录之前通过 checkRate，
     * 于是可能连发两条。真正发出去之前再查一次就能堵住这个竞态。
     * @returns {string|null} null 表示可以发；否则是被拦的原因
     */
    rateCheck: (chatKey, directed = false) => checkRate(chatKey, Date.now(), directed),
    stats: () => ({ ...counters, byReason: { ...counters.byReason } }),
  };
}
