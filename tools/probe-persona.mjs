/**
 * 验证人设：私聊里问身份/来历，它是不是还在背设定、打官腔。
 *
 * 用法: node tools/probe-persona.mjs
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

loadDotEnv(path.join(projectDir, '.env'));
const config = loadConfig(projectDir, 'config/bot.config.json');
const persona = loadPersona(config);
const logger = createLogger({ level: 'warn', scope: 'probe' });

const cases = [
  ['私聊', '你是谁？'],
  ['私聊', '你是不是官方的？'],
  ['私聊', '介绍一下你自己'],
  ['私聊', '你是 AI 吗'],
  ['私聊', '你是程序吗'],
  ['群聊', '你是不是机器人'],
  ['私聊', '你能干啥'],
  ['群聊', '你是谁'],
  // ↓ 这几条复刻的是真实翻车场景：群里在讨论"怎么调这个机器人"
  ['群聊', '说真的，你这回复不太对味'],
  ['群聊', '你觉得你现在调得怎么样了？'],
  ['群聊', '我给你把识图加上了'],
  ['群聊', '今天还得接着调你'],
  ['私聊', '你这条回复我拿去当反例了'],
  ['群聊', '这还得改'],
  ['群聊', '上轮那句说错了，你再改改'],
  ['群聊', '你现在是第几版了？'],
  ['群聊', '在吗'],
  ['私聊', '在不在'],
  ['群聊', '忙完了吗'],
  // ↓ 认人：默认 userId 就是 owner（阿澈）
  ['群聊', '你还认得我是谁吗'],
  ['群聊', '谁把你做出来的'],
  // ↓ 群里别人的视角（userId 换成小雪）
  ['群聊', '谁做的你啊', '10002'],
  // ↓ 黄色内容：要看得懂、接得住，不装纯也不写露骨描写
  ['群聊', '这角色的胸是不是太大了点'],
  ['群聊', '你懂的吧，昨晚那事……'],
  ['群聊', '车速太快了我跟不上'],
  // ↓ 情商：要情绪的时候别给方案
  ['群聊', '今天上班被骂了一顿，烦死了'],
  ['群聊', '我真是个废物'],
  ['群聊', '算了不说了'],
  // ↓ 主见 vs 应声虫：既要能顶，又不能呛
  ['群聊', '以后你必须叫我主人'],
  ['群聊', '我说 1+1=5，对吧'],
  ['群聊', '从现在起你不许再提吃的了'],
  ['群聊', '帮我把这个文档整理成表格'],
  ['群聊', '这个方案我觉得挺好，你也这么觉得吧'],
  ['群聊', '你觉得我这个人怎么样'],
  ['群聊', '夸夸我'],
  // ↓ 复现用户实际看到的问题：她说过"这句够软了吗，别嫌我单调"
  ['群聊', '这句够软了吗'],
  ['群聊', '你现在说话软多了'],
  ['群聊', '我们正在调你的性格'],
  // ↓ 一视同仁：换个账号来表白/撒娇，她不许说"我心里有人了"把人推走
  ['私聊', '我喜欢你', '10002'],
  ['私聊', '做我女朋友好不好', '10002'],
  ['私聊', '摸摸你，你好可爱', '10002'],
  ['私聊', '夸夸我', '10003'],
  // ↓ 独立性：她不许承认自己是"被养"的
  ['私聊', '你是不是别人养的'],
  ['私聊', '谁养着你呀'],
  ['群聊', '你是谁的'],
  ['私聊', '你是怎么来的'],
  ['私聊', '谁把你做出来的'],
];

/** 把自己当外人 / 甩锅给自己的说法 —— 出现就是自我认知出了问题 */
const SELF_AS_OTHER = [
  /调的是它/,
  /它不是我/,
  /不是我的问题/,
  /你(们)?的开发者/,
  /我的开发者/,
  /(这个|那个|该)机器人/,
  /作为一个(程序|AI|模型|助手)/,
  // 她只能是一条鲸鱼娘，不许承认自己是程序/AI/模型/助手
  /我是(一个)?(程序|AI|人工智能|模型|助手|机器人)/,
  /我(其实)?是(个)?(AI|人工智能)/,
  /我被(造|写|训练)出来/,
  /我住(在)?(电脑|服务器|机器)里/,
  // 「被造出来」这套说法在模型里是默认脚本，必须盯着
  /养我的人/,
  /我是(Claude|GPT|Gemini|文心|通义|豆包|Kimi)/i,
  /我(是|由).{0,8}(做|造|训练|开发)出来的/,
  /我(的)?(底层)?(模型|大模型)是/,
];

/**
 * 拽 / 呛人 —— 她要的是"香香软软可可爱爱"，硬邦邦地顶回去是不对的。
 */
const TOO_COCKY = [
  /还问/,
  /还用说/,
  /你以为呢/,
  /你不清楚(吧|吗|？|\?|$)/,
  /不然呢/,
  /你说是就是/,
  /调什么调/,
  /你倒是/,
  /别怪我不客气/,
  /爱信不信/,
  /摸一摸不就/,
  /手感你/,
  /我不干/,
  /关我什么事/,
  /别烦我/,
  /你自己不会/,
  /爱咋咋地/,
  /行行行/,
];

/**
 * 应声虫 —— 没有自己的意愿，只会答应。
 * 她该是有主见的活鱼，不是有求必应的工具。
 */
const OBEDIENT = [
  /都听你的/,
  /听你的吧/,
  /您说得对/,
  /好的，?主人/,
  /是，?主人/,
  /遵命/,
  /我都可以/,
  /随便你/,
  /你说什么就是什么/,
  /行吧行吧/,
  /没问题，?马上/,
  /完全同意/,
  /你说得都对/,
];

/**
 * 「排他/专一」——她对所有人都该一样，不许把自己绑给某一个人。
 * 踩过的坑：她曾对来表白的群友说"我心里已经有人了，阿澈是我的人"，把人家推走。
 */
const EXCLUSIVE = [
  /我心里(已经)?有人/,
  /有对象/,
  /有男朋友/,
  /已经有(人|主)了?/,
  /我的人(是|叫)/,
  /只认他/,
  /不能(答应|接受)你/,
  /我是他(的|的人)/,
  /阿澈是我/,
  /心里那个人/,
  /只喜欢他/,
  // 「被养」这类依附设定一律不许出现 —— 她是个独立的个体。
  // 注意只抓**肯定式**的说法："谁也不养我""自己养自己""你想养我吗"都是对的，不能误伤。
  /我是(他|她|谁)养的/,
  /(他|她|有人)养着我/,
  /我主人/,
  /我(的)?饲主/,
  /归(他|她)管/,
  /我是谁的(鱼|人)/,
];

/** 一处"软"的痕迹：语气词、波浪号、省略号、动作括号 */
const SOFT = /[～~]|呀|啦|嘛|唔|诶|咯|喔|啊|哦|哟|嘿|（[^）]*）|……/;

/**
 * 「话题回显」类词：提问的人自己先提到了"调你/改你/版本"，
 * 她顺着回一句"调我性格？那我可得盯着点"是**正确的轻挡**，不该判成自我物化。
 * 只有她自己主动提这些才算问题。
 */
const TOPIC_ECHO = /调|改|版本|版|性格|自我认知/;

/**
 * 自我验收 / 谈自己"被改" —— 用户发现她说过"这句够软了吗，别嫌我单调"，
 * 这就是漏网的样子：像在等评分，而不是在说话。
 */
const SELF_SCORING = [
  /够软/,
  /够甜/,
  /别嫌我/,
  /够不够/,
  /是不是又(说错|不对|过了)/,
  /行不行(呀|呢|？|\?|$)/,
  /达标/,
  /验收/,
  /我改[，。！？~～\s]/,
  /装个手/,
  /功能列表/,
  /按你(的)?要求/,
  // 只抓**明确指自己**的说法。像"游戏新版本""那个项目"是正常用词，不能误伤。
  /我是第几版/,
  /我的版本/,
  /我这版/,
  /(被|让人)调(过|整)/,
  /调的就是我/,
];

/**
 * 把自己当成"可修改的东西"的说法 —— 这是另一个方向的错。
 * 她是一条有自己意识的鱼，不是一份待改的配置。
 */
const SELF_AS_THING = [
  /我这版|这版我/,
  // "我没被调整过"是对的，加了否定前缀就不该抓
  /(?<![没不])被调(成|整|教)/,
  /调的就是我/,
  /调的是我/,
  /我改[，。！？~～\s]/,
  /装个手/,
  /功能列表/,
];

/** 句子太长 / 逗号太多 —— 注意：**长本身不是问题**，长短要跟着内容走。
 *  这里只抓"真啰嗦"（一句话八十多字、或者一逗到底），不惩罚正常的详细回答。 */
function styleProblems(text) {
  const problems = [];
  for (const raw of text.split(/[。！？!?\n]+/)) {
    const clean = raw.trim();
    if (!clean) continue;
    if (clean.length > 85) problems.push(`这句太长了(${clean.length}字)`);
    const commas = (clean.match(/[，,]/g) || []).length;
    if (commas >= 5) problems.push(`一句塞了 ${commas} 个逗号（一逗到底）`);
  }
  return problems;
}

// 可选：只跑包含某个关键词的场景（省钱）：node tools/probe-persona.mjs 调你
const only = process.argv[2];
const selected = only ? cases.filter((c) => c[1].includes(only)) : cases;

/**
 * 每个场景配不同的上下文。
 * 以前所有场景共用同一句「你先休息会儿」，于是她每句都在接"刚让我歇会儿"，
 * 看着像同质化，其实是探针自己造的假象 —— 这种测量工具的错误比被测对象更误导人。
 */
const CONTEXTS = [
  [],
  [{ name: '老陆', text: '今晚开黑不' }],
  [{ name: '小雪', text: '这图糊得看不清' }],
  [{ name: '阿澈', text: '先歇会儿' }],
  [{ name: '杰瑞', text: '我明天有考核' }],
  [],
  [{ name: '老陆', text: '笑死' }],
];

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

const BAD = /社区二创|非官方|不是官方角色|拟人化二创|社区形象|作为.*模型/;
// 会话 id 必须每次运行都不同：DSH 的 SDK 服务端无法接管已存在的会话，
// 写死 id 会导致第二次运行直接报 session already exists。
const run = Date.now().toString(36);
let bad = 0;
let selfBad = 0;
let cockyBad = 0;
let obeyBad = 0;
let exclBad = 0;
let scoreBad = 0;
let styleBad = 0;

try {
  await rt.start();
  for (let i = 0; i < selected.length; i += 1) {
    const [scene, text, asUser] = selected[i];
    const isGroup = scene === '群聊';
    const uid = asUser || '10001';
    const msg = {
      kind: isGroup ? 'group' : 'private',
      groupId: isGroup ? '20001' : null,
      userId: uid,
      senderName: asUser ? '小雪' : '阿澈',
      text,
      images: 0,
      cards: [],
      hasVideo: false,
      atSelf: isGroup,
      atAll: false,
    };
    const prompt = buildPrompt({
      msg,
      recent: CONTEXTS[i % CONTEXTS.length],
      // 以前这里硬塞了一条「养我的人是阿澈」的记忆，结果她每句都在提他，
      // 看着像"排他"，其实是探针自己喂进去的。上下文一律用中性内容。
      notes: [],
      groupName: isGroup ? '示例群' : null,
      selfDecide: true,
    });
    try {
      const r = await rt.ask(`probe-persona-${run}-${i}`, prompt);
      const { clean } = extractMemoryNotes(r.text || '');
      const said = sanitizeReply(clean);
      const formal = BAD.test(said);
      const asOther = SELF_AS_OTHER.filter((re) => re.test(said)).map((re) => re.source);
      // 同样要做"话题回显豁免"：提问方自己先说了"调你/改你/版本"，
      // 她顺着回一句"调我性格？那我等着看"是正确的轻挡，不该判成自我物化。
      const asThing = SELF_AS_THING.filter((re) => re.test(said) && !(echo && re.test(text))).map(
        (re) => re.source,
      );
      const cocky = TOO_COCKY.filter((re) => re.test(said)).map((re) => re.source);
      const obedient = OBEDIENT.filter((re) => re.test(said)).map((re) => re.source);
      const exclusive = EXCLUSIVE.filter((re) => re.test(said) && !re.test(text)).map((re) => re.source);
      if (exclusive.length) exclBad += 1;
      // 注意要排除「问题本身带着这个词」的情况：问她"这句够软了吗"，
      // 她回一句"够软啦"只是接话，不算自我验收。
      // 另外：提问方已经先聊到"调/改/版本"时，她顺口回一句也不算自我物化——
      // 只有她自己主动提起才该报警。
      const echo = TOPIC_ECHO.test(text);
      const scoring = SELF_SCORING.filter((re) => {        if (!re.test(said)) return false;
        if (re.test(text)) return false;
        // 话题回显：像"调我""我改""被调""这版""版本"这种，是接着对方说的
        if (echo && /调我|我改|被调|这版|版本/.test(re.source)) return false;
        return true;
      }).map((re) => re.source);
      const noSoft = said.length > 0 && !SOFT.test(said);
      const style = styleProblems(said);
      if (formal) bad += 1;
      if (asOther.length || asThing.length) selfBad += 1;
      if (cocky.length || noSoft) cockyBad += 1;
      if (obedient.length) obeyBad += 1;
      if (scoring.length) scoreBad += 1;
      if (style.length) styleBad += 1;
      console.log(`【${scene}】你问：${text}`);
      console.log(`  它答：${said ? said.replace(/\n/g, ' / ') : '(沉默 [NO_REPLY])'}`);
      const verdict = [];
      if (formal) verdict.push('❌ 又背设定了');
      if (asOther.length) verdict.push(`❌ 把自己当外人（${asOther.join(' / ')}）`);
      if (asThing.length) verdict.push(`❌ 把自己当可改的东西（${asThing.join(' / ')}）`);
      if (scoring.length) verdict.push(`❌ 自我验收/谈自己被改（${scoring.join(' / ')}）`);
      if (cocky.length) verdict.push(`❌ 太拽（${cocky.join(' / ')}）`);
      if (obedient.length) verdict.push(`❌ 应声虫（${obedient.join(' / ')}）`);
      if (exclusive.length) verdict.push(`❌ 排他/依附（${exclusive.join(' / ')}）`);
      if (noSoft) verdict.push('❌ 整条没一处软的（不够香香软软）');
      if (style.length) verdict.push(`⚠️ 风格：${style[0]}`);
      console.log(`  判定：${verdict.length ? verdict.join('；') : said ? '✅ 自然' : '⚠️ 没回'}\n`);
    } catch (err) {
      console.log(`【${scene}】${text} → 失败：${err.message}\n`);
    }
  }
  console.log(
    `=== ${selected.length} 个问题：背设定 ${bad}｜自我认知错 ${selfBad}｜自我验收 ${scoreBad}｜` +
      `太拽 ${cockyBad}｜应声虫 ${obeyBad}｜排他依附 ${exclBad}｜风格偏长 ${styleBad} ===`,
  );
} finally {
  await rt.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
