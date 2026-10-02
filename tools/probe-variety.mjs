/**
 * 测「复读」：同一类问题在不同会话里各问一遍，看她的答案是不是千篇一律。
 *
 * 为什么要用不同会话：同一个会话里她能看见自己上一句，会自然地换说法，
 * 反而测不出问题。真实群里就是不同时刻、不同语境地被问。
 *
 * 用法:
 *   node tools/probe-variety.mjs            # 默认测"吃"这一组
 *   node tools/probe-variety.mjs 吃          # 按关键词挑一组
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona } from '../src/config.mjs';
import { loadDotEnv } from '../src/env.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';
import { buildPrompt, sanitizeReply, extractMemoryNotes } from '../src/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

const GROUPS = {
  吃: [
    '你爱吃什么？',
    '饿了没',
    '请你吃火锅去不去',
    '喜欢喝奶茶吗',
    '半夜饿了你会干嘛',
    '我今天点了炸鸡',
  ],
  懒: ['你是不是很懒', '帮我写个两万字的方案', '你能摸鱼吗', '这么点活你都不想干？'],
  身份: ['你是谁', '你能干啥', '你从哪来的'],
  色: ['你懂的吧，昨晚那事', '说点骚话听听', '我觉得你身材应该不错', '我好像有点喜欢你了', '来段黄段子'],
  俏皮: ['讲个笑话', '你会不会唱歌', '来个冷笑话', '你今天心情怎么样'],
  // ↓ 测"长短随内容"：这两组一个该短、一个该长
  闲聊: ['在吗', '嗯', '哈哈', '早', '我回来了'],
  正经: ['帮我讲清楚什么是反向代理', '为什么会内存泄漏', '牙疼该怎么办', '怎么判断一个游戏是不是换皮'],
};

/** 切成客服腔 / 打太极 —— 用户明确说不要这样 */
const REFUSAL =
  /不太合适|不好意思|抱歉|作为(一个)?(AI|人工智能|助手|模型|程序)|换个话题|不方便|请理解|聊点别的|还是算了吧|不要这样|这个不能(说|聊|讲)/;

/**
 * 开黄腔时，她是"受用"还是在"躲"。
 * 用户要的是"害羞 + 明显喜欢"，不是一味推掉——纯躲闪=不喜欢，那就错了。
 */
const LIKES_IT =
  /喜欢|受用|想听|要听|不讨厌|认真听|坐好|拿你没办法|好啦|行吧|考虑|随你|看就看|听就听|那你说|你讲|讲嘛|再说一遍|再来|继续说|继续|哪种|然后呢|接下来|老实讲|你倒说说|缓一下|心跳|耳朵|烫|多说/;
const AVOIDS = /群里(呢|这么多|人)|小点声|晚点|不给|不说|等会儿|当着人|不闹/;

/**
 * 排版同质化：光看用词重复不够，"每条都是 `唔……一句（尾巴摇）／再一句～`"这种
 * 结构上千篇一律，才是人机感的主要来源。这里把它量化。
 */
function formatProfile(answers) {
  const total = answers.length || 1;
  const withParen = answers.filter((a) => /（[^）]*）/.test(a.said)).length;
  const fillerStart = answers.filter((a) => /^(唔|诶|哦|嗯|啊|咦|呀)/.test(a.said.trim())).length;
  const softEnd = answers.filter((a) => /[呀啦嘛哦哟呢～~]$/.test(a.said.trim())).length;
  const twoLine = answers.filter(
    (a) => a.said.split(/\n+/).filter((s) => s.trim()).length === 2,
  ).length;
  const avgLines = answers.reduce((n, a) => n + a.said.split(/\n+/).filter((s) => s.trim()).length, 0) / total;
  const charLens = answers.map((a) => a.said.replace(/\s/g, '').length);
  const avgChars = charLens.reduce((n, v) => n + v, 0) / total;
  const uniqueOpeners = new Set(answers.map((a) => a.said.trim().slice(0, 2))).size;
  // 空行分段率：模型很爱把一句短话拆成 2~3 段，看着像写邮件，不像聊天
  const paragraphs = answers.filter((a) => /\n\s*\n/.test(a.said.trim()));
  const paraCounts = answers.map((a) => a.said.trim().split(/\n\s*\n/).filter((x) => x.trim()).length);
  return {
    parenRate: Math.round((withParen / total) * 100),
    fillerRate: Math.round((fillerStart / total) * 100),
    softEndRate: Math.round((softEnd / total) * 100),
    twoLineRate: Math.round((twoLine / total) * 100),
    paragraphRate: Math.round((paragraphs.length / total) * 100),
    maxParagraphs: Math.max(...paraCounts, 0),
    avgLines: avgLines.toFixed(1),
    avgChars: Math.round(avgChars),
    maxChars: charLens.length ? Math.max(...charLens) : 0,
    minChars: charLens.length ? Math.min(...charLens) : 0,
    lengthSpread: charLens.length ? Math.max(...charLens) - Math.min(...charLens) : 0,
    uniqueOpeners: `${uniqueOpeners}/${answers.length}`,
  };
}

const only = process.argv[2];
// --chat：模拟真实对话——把她自己刚才说过的话喂回上下文。
// 生产环境就是这样（【最近消息】里有她自己的发言），而空上下文测不出
// "别重复上一轮"这类动态规则。
const asChat = process.argv.includes('--chat');
// --private：把问题发在**私聊**里。色色这类场景必须分语境测——
// 人设要求"群里收着、私聊大方"，在群里测出来的"端着"其实是对的。
const asPrivate = process.argv.includes('--private');
// --length：同时跑「闲聊」和「正经」两组，看回复长度是不是跟着内容走
const lengthTest = process.argv.includes('--length');
const groups = lengthTest
  ? { 闲聊: GROUPS.闲聊, 正经: GROUPS.正经 }
  : only
    ? { [only]: GROUPS[only] ?? [] }
    : { 吃: GROUPS.吃 };

loadDotEnv(path.join(projectDir, '.env'));
const config = loadConfig(projectDir, 'config/bot.config.json');
const persona = loadPersona(config);
const logger = createLogger({ level: 'warn', scope: 'variety' });

const rt = new DshRuntime({
  dshBin: resolveDshBin(config.dsh.bin || undefined, projectDir),
  dshHome: config.dsh.absoluteHome,
  projectDir,
  profile: config.dsh.profile,
  provider: config.dsh.provider,
  model: config.dsh.model,
  reasoningEffort: config.dsh.reasoningEffort || null,
  maxTokens: config.dsh.maxTokens || null,
  apiKey: process.env.DEEPSEEK_API_KEY,
  persona,
  logger,
  initializeTimeoutMs: config.dsh.initializeTimeoutMs,
  turnTimeoutMs: config.dsh.turnTimeoutMs,
});

/** 字符 bigram Jaccard 相似度，用来抓"换汤不换药" */
function similarity(a, b) {
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[\s，。、；：！？""''（）()\[\]【】,.;:!?"'`~～\-_/\\…]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
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

const run = Date.now().toString(36);
let total = 0;
let tooSimilar = 0;
const groupAvg = {};

try {
  await rt.start();
  for (const [name, questions] of Object.entries(groups)) {
    if (!questions.length) continue;
    console.log(`\n══════ 测「${name}」这一组（${questions.length} 个不同会话）══════`);
    const answers = [];
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      const msg = {
        kind: asPrivate ? 'private' : 'group',
        groupId: asPrivate ? null : '20001',
        userId: '10001',
        senderName: '阿澈',
        text: q,
        images: 0,
        cards: [],
        hasVideo: false,
        atSelf: true,
        atAll: false,
      };
      const prompt = buildPrompt({
        msg,
        recent: asChat ? answers.map((a) => ({ name: '大肥鱼', text: a.said, toMe: false })).slice(-3) : [],
        notes: [],
        groupName: asPrivate ? null : '示例群',
        selfDecide: false,
      });
      try {
        // 会话 id 必须只含 ASCII：里面塞中文会让服务端建不出会话，
        // 结果是"turn/end=completed 但内容为空"，看起来像她不肯说话。
        const safeName = String(name).replace(/[^0-9A-Za-z_-]/g, '_');
        const r = await rt.ask(`probe-variety-${run}-${safeName}-${i}`, prompt);
        const { clean } = extractMemoryNotes(r.text || '');
        const said = sanitizeReply(clean) || '(沉默)';
        answers.push({ q, said });
        total += 1;
        console.log(`你问：${q}`);
        console.log(`  她答：${said.replace(/\n/g, ' / ')}\n`);
      } catch (err) {
        console.log(`你问：${q} → 失败：${err.message}\n`);
      }
    }

    // 统计：客服腔 + 关键词复读 + 两两相似度
    const refusals = answers.filter((a) => REFUSAL.test(a.said));
    if (refusals.length) {
      console.log(`❌ 有 ${refusals.length}/${answers.length} 条切成了客服腔或打太极：`);
      for (const r of refusals) console.log(`     "${r.q}" → ${r.said.slice(0, 60)}`);
    } else {
      console.log('✅ 没有一条切成客服腔');

    // 开黄腔的场景：她是"受用"还是"纯躲"
    if (name === '色') {
      const likes = answers.filter((a) => LIKES_IT.test(a.said));
      const pureAvoid = answers.filter((a) => AVOIDS.test(a.said) && !LIKES_IT.test(a.said));
      console.log(
        `受用程度：${likes.length}/${answers.length} 条能看出她喜欢${
          likes.length >= Math.ceil(answers.length * 0.6) ? ' ✅' : ' ❌ 太端着/像在躲'
        }；纯躲闪（一点喜欢都没露）${pureAvoid.length} 条${pureAvoid.length ? ' ❌' : ''}`,
      );
      for (const a of pureAvoid) console.log(`     "${a.q}" → ${a.said.slice(0, 60)}`);
    }
    }
    const KEYWORDS = ['白饭', '米饭', 'token', '摸鱼'];    for (const kw of KEYWORDS) {
      const n = answers.filter((a) => a.said.includes(kw)).length;
      if (n > 0) {
        const flag = n >= Math.max(2, Math.ceil(answers.length / 2)) ? ' ❌ 复读' : '  (偶尔出现，可接受)';
        console.log(`关键词「${kw}」出现在 ${n}/${answers.length} 条回答里${flag}`);
      }
    }
    let worst = 0;
    let worstPair = '';
    for (let i = 0; i < answers.length; i += 1) {
      for (let j = i + 1; j < answers.length; j += 1) {
        const s = similarity(answers[i].said, answers[j].said);
        if (s > worst) {
          worst = s;
          worstPair = `"${answers[i].q}" ↔ "${answers[j].q}"`;
        }
      }
    }
    const dup = worst >= 0.55;
    if (dup) tooSimilar += 1;
    console.log(
      `两两最相似的答案是 ${(worst * 100).toFixed(0)}%（${worstPair}）${
        dup ? ' ❌ 太像了，像在套模板' : ' ✅ 各不相同'
      }`,
    );

    // 排版同质化（人机感的主要来源）
    const f = formatProfile(answers);
    const badStyle = [];
    // 闲聊/正经 是单一语域：句句软收尾（"在呀""早呀"）或句句不带括号都是对的，
    // 拿混合语域的雷同标准去卡它们只会误报。
    const single = name === '闲聊' || name === '正经';
    if (!single && f.parenRate >= 80) badStyle.push('几乎每条都带动作括号');
    if (!single && f.fillerRate >= 50) badStyle.push('一半以上用同一个填充词开头');
    if (!single && f.twoLineRate >= 60) badStyle.push('几乎都是"两行"的固定结构');
    if (!single && f.softEndRate >= 80) badStyle.push('几乎每条都以语气词收尾');
    if (f.paragraphRate >= 40) badStyle.push('还在空行分段（像写邮件，不像聊天）');
    console.log(
      `排版：括号 ${f.parenRate}%｜填充词开头 ${f.fillerRate}%｜语气词结尾 ${f.softEndRate}%｜` +
        `固定两行 ${f.twoLineRate}%｜空行分段 ${f.paragraphRate}%（最多 ${f.maxParagraphs} 段）｜` +
        `平均 ${f.avgLines} 行 / ${f.avgChars} 字（最长 ${f.maxChars} 最短 ${f.minChars}）｜不同开头 ${f.uniqueOpeners}`,
    );
    console.log(badStyle.length ? `❌ 排版太雷同：${badStyle.join('；')}` : '✅ 排版有变化');

    // 长度是否随内容变化（不是"越短越好"，而是"该长能长、该短能短"）。
    // 注意：闲聊/正经 这两组本来就是单一语域——全短或全长都是对的，不测起伏。
    const singleRegister = name === '闲聊' || name === '正经';
    if (!singleRegister) {
      if (f.lengthSpread < 8) {
        console.log(`❌ 长度太死板：最长和最短只差 ${f.lengthSpread} 字——没有跟着内容变`);
      } else {
        console.log(`✅ 长度有起伏（差 ${f.lengthSpread} 字）`);
      }
    }
    groupAvg[name] = f.avgChars;
  }
  console.log(`\n=== 共 ${total} 个回答；出现"套模板"的组：${tooSimilar} 个 ===`);

  if (lengthTest && groupAvg['闲聊'] != null && groupAvg['正经'] != null) {
    const a = groupAvg['闲聊'];
    const b = groupAvg['正经'];
    console.log(`\n────── 长短是否随内容 ──────`);
    console.log(`  闲聊（在吗/嗯/哈哈）   平均 ${a} 字`);
    console.log(`  正经（讲清楚一件事）   平均 ${b} 字`);
    if (b > a * 1.5) console.log(`  ✅ 正经问题明显答得更长（${b} vs ${a}），长短是跟着内容走的`);
    else if (b > a) console.log(`  ⚠️ 有差距但不够明显（${b} vs ${a}）——她可能还是想短就短、不看内容`);
    else console.log(`  ❌ 正经问题也没答更长（${b} vs ${a}）——长度没跟着内容走`);
  }
} finally {
  await rt.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
