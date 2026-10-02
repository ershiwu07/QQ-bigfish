/**
 * 文本处理：把模型输出洗成「QQ 里能直接发出去」的样子，并组装给模型看的用户消息。
 */

/** v2 自主决策用的哨兵：模型判断这条不用回时只输出它。 */
export const NO_REPLY = '[NO_REPLY]';

/** 模型用来写长期记忆的行标记，例如「[记忆] 小明在做爬虫项目」。 */
const MEMO_PREFIX = /^\s*[[【]\s*(记忆|remember|memo)\s*[\]】]\s*[:：]?\s*/i;

/**
 * 从模型输出里抽出长期记忆行，并把它们从要发出去的正文里剔除。
 * 这样模型一轮就能同时完成「回复」和「记住点什么」，不用额外再花一次调用。
 *
 * 两种记忆行：
 *   [记忆] 事实                           → 会话级记忆（作品、术语、群里的规矩）
 *   [记忆] 老陆 :: 喜欢星穹铁道           → 记在「老陆」这个人名下
 * 名字照抄聊天记录里显示的那个名字，落库时再翻译成 QQ 号。
 *
 * @returns {{clean: string, notes: string[], memberNotes: Array<{name:string, fact:string}>}}
 */
export function extractMemoryNotes(raw) {
  if (typeof raw !== 'string' || !raw) return { clean: '', notes: [], memberNotes: [] };
  const notes = [];
  const memberNotes = [];
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(MEMO_PREFIX);
    if (m) {
      const fact = line.slice(m[0].length).trim();
      if (fact) {
        const split = fact.match(/^(.{1,24}?)\s*(?:::|\uFF1A\uFF1A)\s*(.+)$/);
        if (split && split[2].trim()) memberNotes.push({ name: split[1].trim(), fact: split[2].trim() });
        else notes.push(fact);
      }
      continue; // 这一行不发给任何人，只进记忆
    }
    kept.push(line);
  }
  return { clean: kept.join('\n'), notes, memberNotes };
}

/**
 * 清洗模型输出：
 * - 去掉整段代码围栏之外会显得像 Markdown 渲染的标记（QQ 不渲染 Markdown，星号会原样显示）
 * - 去掉模型给自己加的说话人前缀
 * - 压掉多余空行
 * - 如果是 [NO_REPLY] 哨兵，返回空字符串（表示「不要发」）
 */
export function sanitizeReply(raw, { maxChars = 4000 } = {}) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // 不说话：正好是哨兵，或者哨兵后面还多写了解释（模型偶尔会这样）
  if (s.replace(/[。！!～~、，,\s]/g, '') === NO_REPLY) return '';
  if (new RegExp(`^${NO_REPLY.replace(/[[\]]/g, '\\$&')}`, 'i').test(s)) return '';

  // 去掉「大肥鱼：」「回答：」这类自称前缀
  s = s.replace(/^\s*(大肥鱼|鲸鱼娘|肥鱼|我|助手|回答|回复)\s*[:：]\s*/, '');

  // 去掉 markdown 标题与粗体/斜体标记（保留内容），行内代码去掉反引号
  s = s
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');

  // markdown 链接 → QQ 里能看的样子。
  // 开了联网搜索之后她会自然带出处；写成 [中国天气网](http://…) 的话，
  // QQ 不渲染 markdown，用户看到的就是一堆方括号套括号。
  s = s
    .replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1');

  // 统一省略号与空白
  s = s.replace(/\.{3,}/g, '……').replace(/[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  // ── 不许空行分段 ──
  // 模型很爱把一句短话拆成两三段（"不是呀，我是鲸鱼。⏎⏎怎么突然问这个？"），
  // 看着像在写邮件，不像聊天。这里把换行合并成一句连续的话；
  // 上一段没有句末标点时补一个逗号，免得两句话粘在一起。
  // 代码块要留着换行，所以先把它摘出来。
  const codeBlocks = [];
  s = s.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });
  s = s.replace(/\n+/g, (_m, offset, whole) => {
    const before = whole.slice(0, offset).trimEnd();
    const last = before.slice(-1);
    return /[。！？!?…；;：:，,、）)】」」]$/.test(last) ? '' : '，';
  });
  s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)]).trim();

  // 去掉「（……）装可爱」之外的零宽字符
  s = s.replace(/[\u200b-\u200f\ufeff]/g, '');

  if (s.length > maxChars) s = s.slice(0, maxChars).trimEnd() + '……';
  return s;
}

/**
 * 把长回复切成若干条消息，模仿真人分几条发。
 * 优先在空行→句末标点→逗号→硬切。
 */
export function splitReply(text, { maxCharsPerMessage = 400, maxSegments = 3 } = {}) {
  const s = (text || '').trim();
  if (!s) return [];
  if (s.length <= maxCharsPerMessage) return [s];

  const chunks = [];
  const paragraphs = s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  for (const para of paragraphs) {
    if (para.length <= maxCharsPerMessage) {
      chunks.push(para);
      continue;
    }
    // 按句末标点切
    const sentences = para.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [para];
    let buf = '';
    for (const sent of sentences) {
      if ((buf + sent).length > maxCharsPerMessage && buf) {
        chunks.push(buf.trim());
        buf = '';
      }
      if (sent.length > maxCharsPerMessage) {
        // 单句还是太长：按逗号切，再不行硬切
        let rest = sent;
        while (rest.length > maxCharsPerMessage) {
          const cut = Math.max(
            rest.lastIndexOf('，', maxCharsPerMessage),
            rest.lastIndexOf('、', maxCharsPerMessage),
            rest.lastIndexOf(',', maxCharsPerMessage),
            rest.lastIndexOf(' ', maxCharsPerMessage),
          );
          const at = cut > maxCharsPerMessage * 0.5 ? cut + 1 : maxCharsPerMessage;
          chunks.push(rest.slice(0, at).trim());
          rest = rest.slice(at);
        }
        buf = rest;
      } else {
        buf += sent;
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }

  if (chunks.length <= maxSegments) return chunks;

  // 超出条数上限：把多余内容并进最后一条（并受总长保护）
  const head = chunks.slice(0, maxSegments - 1);
  const tail = chunks.slice(maxSegments - 1).join('\n');
  head.push(tail.length > maxCharsPerMessage * 1.5 ? tail.slice(0, Math.floor(maxCharsPerMessage * 1.5)) + '……' : tail);
  return head;
}

/**
 * 组装发给模型的用户消息。
 * 带一小段元信息，让人设知道「在群里还是私聊」「谁在说话」「前文是什么」「它自己记得什么」。
 */
export function buildPrompt({
  msg,
  recent = [],
  notes = [],
  groupName = null,
  selfDecide = false,
  imagesAttached = 0,
  imagesLookedBack = false,
  latestDirected = false,
  // owner 参数保留只为兼容旧调用，**不再注入任何内容**（见下面的说明）
  owner = null,
  member = null,
  roster = [],
}) {
  const lines = [];
  if (msg.kind === 'group') {
    const gn = groupName ? `「${groupName}」` : '';
    lines.push(`【场景】QQ 群${gn}（群号 ${msg.groupId}）`);
  } else {
    lines.push('【场景】QQ 私聊');
  }

  // 这里**故意不注入"谁是你的主人"**。
  // 踩过的坑：曾经在这里写「【你的人】阿澈——这条就是他发的，可以更黏一点」，
  // 结果她对那个号明显更亲、对别人收着，违背了"对所有给她发消息的人同等对待"。
  // 亲近是她的默认性格（写在人设里），不该由"发消息的人是谁"来决定。
  // config.owner 现在只用于管理指令（静音/恢复）的权限判定，不参与对话。

  // 群里都有谁（按发言多少排）。这一段变化很慢，属于固定前缀，走缓存几乎不额外花钱。
  if (Array.isArray(roster) && roster.length > 1) {
    const names = roster.slice(0, 15).map((r) => (String(msg.userId) === String(r.userId) ? `${r.name}(现在说话这个)` : r.name));
    lines.push(`【这个群里的常客】${names.join('、')}`);
  }

  if (notes.length) {
    lines.push('【你记得的事】');
    for (const n of notes) lines.push(`· ${oneLine(n)}`);
  }

  if (recent.length) {
    lines.push('【最近消息】');
    for (const r of recent) {
      // toMe 标记很关键：否则一串问题摆在面前，它不知道哪些是问它的
      lines.push(`${r.name}${r.toMe ? '（@你）' : ''}: ${oneLine(r.text)}`);
    }
  }

  // 「正在说话的人」—— 这是"记住群里不同的人"真正落地的地方。
  // 别人的话一进来，她先知道自己面对的是谁、以前记过这个人的什么。
  if (member && msg.kind === 'group') {
    const who =
      member.card && member.nickname && member.card !== member.nickname
        ? `${member.card}（昵称 ${member.nickname}）`
        : member.name;
    lines.push(`【正在说话的人】${who}（QQ ${member.userId}）`);
    const bits = [];
    if (member.count > 1) bits.push(`在群里说过 ${member.count} 次话`);
    if (member.last) {
      const mins = Math.round((Date.now() - member.last) / 60000);
      if (mins <= 1) bits.push('刚刚也在说');
      else if (mins < 60) bits.push(`上一次说话约 ${mins} 分钟前`);
      else if (mins < 60 * 24) bits.push(`上一次说话约 ${Math.round(mins / 60)} 小时前`);
    }
    if (bits.length) lines.push(`　${bits.join('，')}`);
    const facts = Array.isArray(member.facts) ? member.facts.slice(-8) : [];
    if (facts.length) {
      lines.push('　你记得关于他的事：');
      for (const f of facts) lines.push(`　· ${oneLine(f)}`);
    } else {
      lines.push('　（关于这个人你还没有特别的印象，别装熟）');
    }
  }

  lines.push('【最新消息】');
  const body = oneLine(msg.text);
  const extras = [];
  const stickerCount = Number(msg.stickers) || 0;
  if (msg.images > 0) {
    const what =
      stickerCount >= msg.images ? '表情包' : stickerCount > 0 ? '图片和表情包' : '图片';
    extras.push(
      imagesAttached > 0
        ? `对方发了 ${msg.images} 张${what}，其中 ${imagesAttached} 张就附在这条消息里，你能看到`
        : `对方发了 ${msg.images} 张${what}，但你看不到内容`,
    );
  } else if (imagesLookedBack && imagesAttached > 0) {
    // 「先发图、再问这是什么」：图在上一两条，问题在这一条
    extras.push('对方刚刚发过一张图，那张图就附在这条消息里（他问的就是关于那张图的）');
  }
  if (Array.isArray(msg.cards) && msg.cards.length) {
    for (const c of msg.cards) {
      const bits = [c.title, c.desc].filter(Boolean).join(' / ');
      if (bits) extras.push(`对方分享了一个链接/卡片：「${bits}」（你只能看到标题简介，看不到里面的具体内容）`);
    }
  }
  if (msg.hasVideo) extras.push('对方发了一段视频，你看不到画面，也不知道里面说了什么');
  if (msg.hasFile) extras.push('对方发了一个文件');

  const tail = extras.length ? `${body ? `${body}  ` : ''}（${extras.join('；')}）` : body;
  const placeholder = '(对方只是 @ 了你，没有说别的)';
  lines.push(`${msg.senderName}: ${tail || placeholder}`);
  lines.push('');
  lines.push('（下面是你们正在聊的，回最新那一句就行。别复述上面这些说明——你不是在念资料。）');
  lines.push(
    '（一条消息就是一句连着一句的话，中间别空行分段。' +
      '长短随内容：一句话能答完就一句话，需要讲清楚就把话讲清楚。）',
  );

  // 连着问它的场景：群里冷半天，突然一串问题砸过来。必须明确告诉它「这些是一起的」，
  // 并且要求合并成一条回复 —— 否则它会漏答，或者一条一条刷屏。
  const directedRecent = recent.filter((r) => r.toMe).length;
  if (latestDirected && directedRecent > 0) {
    lines.push(
      `【注意】上面【最近消息】里标着（@你）的还有 ${directedRecent} 条，是连着问你的，你还没答。` +
        '请在**这一条回复里把它们一起答掉**：不要分成好几条发，也不要只答最后一句。',
    );
  }

  // 反同质化：把她自己最近说过的话单独拎出来，明确要求换个说法。
  // 同质化最直接的来源就是"重复自己上一轮的句式"，而她自己往往看不见这一点。
  const ownRecent = recent
    .filter((r) => r.name === '大肥鱼')
    .slice(-2)
    .map((r) => oneLine(r.text))
    .filter(Boolean);
  if (ownRecent.length) {
    lines.push(`你刚才说过：「${ownRecent.join('」「')}」——这一轮换个说法，别重复上面的句式、口头禅和比喻。`);
    // 光说"形式要变"没用，得盯着最显眼的那一项：动作括号。
    // 上一轮用了括号，这一轮就明确禁用，否则很容易变成"每条都是（尾巴…）"。
    const last = ownRecent[ownRecent.length - 1] || '';
    if (/（[^）]*）/.test(last)) {
      lines.push('（上一轮你已经用过括号里的动作描写了，这一轮别再用括号——直接用话说。）');
    }
  }

  if (selfDecide) {
    // 详细的分寸规则写在人设里（静态、可被 KV 缓存），这里只做一句低成本提醒
    lines.push(
      `（提醒：觉得不该开口就只输出 ${NO_REPLY}；有值得长期记住的事就另起一行写「[记忆] 事实」，` +
        '关于某个人的写成「[记忆] 名字 :: 事实」。）',
    );
  }
  return lines.join('\n');
}

function oneLine(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' / ')
    .slice(0, 300);
}

/**
 * 生成 DSH 会话 id（限制成安全字符，避免落盘目录名出问题）。
 *
 * runToken 是「本次进程」的唯一标识，必须带上：DSH 的 SDK 服务端无法接管已存在的
 * 会话（第二次启动会抛 "already exists"），所以会话 id 必须每次进程都不同。
 * 跨重启的记忆由 state.mjs 持久化的聊天记录负责，不依赖 DSH 的会话恢复。
 */
/**
 * 「定期提炼」用的提示词：把最近的群聊记录交给模型，让它只输出 [记忆] 行。
 *
 * 为什么单独走这条路：自主判断模式下，它大多数消息都会选择沉默，而沉默时不会写记忆，
 * 结果就是「它什么都学不到」。这条提炼任务和「回不回复」完全解耦 —— 它不说话也在学。
 * 频率由 learning.everyMessages 控制（默认每 25 条群消息一次），比每条都判断便宜得多。
 */
/**
 * 这条「长期记忆」是不是在把她当程序描述？
 *
 * 为什么要有这个判断：长期记忆每一轮都会塞进提示词，攒多了她就会用
 * "日志""调试""数据库""token"这种词说话，把自己当成一个待改的东西。
 * 真实踩过：某个群攒了十几条这类记忆，她在那个群里就变成了
 * "你自己翻翻日志去——我又不会替你调试"。
 *
 * 群友确实会聊这些（聊怎么调她、上架、花多少钱），所以学习循环会一直重新学到，
 * 必须在**写入记忆**这道关口拦掉（提示词里也交代了一遍，这是确定性兜底）。
 */
export function isMetaMemory(text) {
  return /token|数据库|部署|调教|调试|日志|上架|GitHub|雌小鬼|只能看到|提示词|大模型|人工智能|\bAI\b|程序|代码|重启|服务器|养着|开发|接口|API|参数|配置/.test(
    String(text || ''),
  );
}

export function buildDigestPrompt({ groupName = null, groupId = null, messages = [], existingNotes = [] }) {
  const lines = [];
  const scene = groupName ? `QQ 群「${groupName}」` : `QQ 群（群号 ${groupId}）`;
  lines.push(`【任务】下面是${scene}最近的聊天记录。请把其中「值得长期记住」的信息提炼出来，重点是：`);
  lines.push('· 群里在玩 / 在看的游戏、动画、影视作品');
  lines.push('· 提到的角色、术语、简称，以及群里对它们的解释');
  lines.push('· 谁是谁：成员在玩什么、喜欢什么、身份或称呼');
  lines.push('· 群里的约定、梗、习惯说法');
  lines.push('');
  lines.push('输出要求：每行一条，以 [记忆] 开头；只写事实，不要写闲聊、不要复述对话；');
  lines.push('');
  lines.push('【按人记：这是重点】关于**某个具体的人**的事，写成「[记忆] 名字 :: 事实」——');
  lines.push('名字要**照抄**聊天记录里显示的那个名字（别改名、别加括号）。例如：');
  lines.push('[记忆] 老陆 :: 喜欢星穹铁道，习惯半夜在线，说话比较直');
  lines.push('[记忆] 小雪 :: 在学画画，常用"这是真的"表示赞同');
  lines.push('关于整个群、某部作品、某个术语的，直接写 [记忆] 事实，不用加名字。');
  lines.push('');
  lines.push('【不要记这几类】');
  lines.push('- 群友的猜测、判断、吐槽（例如"这东西大概是怎么做的""这个功能好像坏了"）——那是他们的看法，不是事实。');
  lines.push('- 任何关于"你自己"运行状况的猜测或评价。你正常工作与否，群友看不到真相，别把他们的推测当成事实记下来。');
  lines.push(
    '- ★ **群友聊他们自己的技术活**：怎么改她、是不是 AI、花了多少 token / 多少钱、项目上没上架、' +
      '部署到哪、用什么模型和接口。这些是"他们那边的事"，不是她世界里的事——' +
      '记下来会让她开始用日志/调试/数据库这类词说话，**一律不要记**。',
  );
  lines.push('- 一次性的临时状态（谁现在在忙、谁刚走开）。');
  lines.push(`这段里如果没有值得新记的东西，就只输出 ${NO_REPLY}，不要写别的。`);
  if (existingNotes.length) {
    lines.push('');
    lines.push('【已经记住的】不要重复这些，也不要改写它们：');
    for (const n of existingNotes) lines.push(`· ${oneLine(n)}`);
  }
  lines.push('');
  lines.push('【最近的聊天记录】');
  for (const m of messages) lines.push(`${m.name}: ${oneLine(m.text)}`);
  return lines.join('\n');
}

/**
 * 发送前的兜底：把「否定式反问」这类顶撞话改掉。
 *
 * 为什么需要提示词之外再加一道：人设里已经把这几句列进黑名单了，实测 37 个场景里
 * 仍有约 1 个漏网。这类话对被回的人感受很差，所以用确定性的规则兜住最后一道。
 *
 * 策略是**删掉那一小段**（而不是替换成别的词），这样前后文天然通顺：
 *   "你做的呀，还问。" → "你做的呀。"
 * 整句被删空时不发这条消息（宁可不说，也不要冲人）。
 *
 * @returns {{text:string, changed:boolean, removed:string[]}}
 */
const SNAP_REWRITES = [
  [/[，,、]?\s*这?还用问(呀|呢|啊)?\s*[？?！!。，,]?/g, ''],
  [/[，,、]?\s*还问(呀|呢|啊)?\s*[？?！!。，,]?/g, ''],
  [/[，,、]?\s*你以为呢\s*[？?！!。，,]?/g, ''],
  [/[，,、]?\s*不然呢\s*[？?！!。，,]?/g, ''],
  [/[，,、]?\s*这还用说\s*[？?！!。，,]?/g, ''],
  [/[，,、]?\s*你不清楚(吧|吗)?\s*[？?！!。，,]?/g, ''],
  // "X什么X" 这种回绝句式（调什么调 / 改什么改 / 问什么问）本质也是顶撞
  [/[，,、]?\s*([\u4e00-\u9fa5])什么\1\s*[？?！!。，,]?/g, ''],
  // "你倒是…"是催促式的顶撞
  [/[，,、]?\s*你倒是\s*/g, ''],
  // "我改"听着像在改配置文件；她该说"我重说"
  [/我改(?=[，。！？~～\s])/g, '我重说'],
  [/你说是就是(吧)?/g, '好吧好吧'],
];

export function softenReply(text) {
  let out = String(text ?? '');
  const removed = [];
  for (const [re, rep] of SNAP_REWRITES) {
    re.lastIndex = 0;
    const m = out.match(re);
    if (m) {
      removed.push(...m.map((s) => s.trim()).filter(Boolean));
      re.lastIndex = 0;
      out = out.replace(re, rep);
    }
  }
  if (!removed.length) return { text: out, changed: false, removed: [] };
  out = out
    .replace(/[，,、]{2,}/g, '，')
    .replace(/([。！？!?])\1+/g, '$1')
    .replace(/^\s*[，,、。]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { text: out, changed: true, removed };
}

export function sessionIdFor(msg, { prefix = 'qq', generation = 1, runToken = '' } = {}) {
  const kind = msg.kind === 'group' ? 'group' : 'private';
  const id = String(msg.kind === 'group' ? msg.groupId : msg.userId).replace(/[^0-9A-Za-z_-]/g, '_');
  const safePrefix = String(prefix).replace(/[^0-9A-Za-z_-]/g, '_') || 'qq';
  const gen = generation > 1 ? `-g${generation}` : '';
  const run = runToken ? `-r${String(runToken).replace(/[^0-9A-Za-z_-]/g, '_')}` : '';
  return `${safePrefix}-${kind}-${id}${gen}${run}`;
}
