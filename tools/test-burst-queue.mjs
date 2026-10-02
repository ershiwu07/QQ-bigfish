/**
 * 「连续提问」这条链路的定点测试：用假模型（不花钱、不连 QQ），
 * 复现并验证修复：群里突然一串问题砸过来时，不能丢、也不能刷屏。
 *
 * 用法: node tools/test-burst-queue.mjs
 */
import { loadConfig } from '../src/config.mjs';
import { createBot } from '../src/service.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

/** 造一个可控的假机器人 */
function makeBot(overrides = {}) {
  const config = structuredClone(loadConfig(process.cwd(), 'config/bot.config.json'));
  config.trigger.group = 'all';
  config.trigger.selfDecide = false; // 让策略层直接决定回，聚焦队列行为
  config.trigger.replyChance = 1;
  config.limits.minIntervalPerChatMs = 60000; // 故意设很大，用来证明「指名不受它影响」
  config.limits.afterReplyCooldownMs = 0;
  config.limits.directedGapMs = 60; // 测试里缩短，别等太久
  config.limits.globalMaxRepliesPerMinute = 999;
  config.limits.maxRepliesPerChatPerMinute = 999;
  config.limits.maxRepliesPerChatPerHour = 999;
  config.output.typingDelayMinMs = 0;
  config.output.typingDelayMaxMs = 1;
  config.output.segmentDelayMinMs = 0;
  config.output.segmentDelayMaxMs = 1;
  config.learning.enabled = false;
  Object.assign(config.limits, overrides.limits || {});
  overrides.mutate?.(config);

  const calls = []; // 每次模型调用的提示词
  const sent = []; // 每次真正发出去的消息
  const runtime = {
    async ask(sessionId, prompt, opts) {
      calls.push({ sessionId, prompt, blocks: (opts && opts.extraBlocks) || [] });
      await sleep(overrides.askDelayMs ?? 250);
      return { text: `答第${calls.length}次`, reason: { kind: 'completed' } };
    },
  };
  const bot = createBot({
    config,
    logger: silent,
    runtime,
    send: async (msg, text) => {
      sent.push(text);
    },
    runToken: `t${Date.now().toString(36)}`,
  });
  return { bot, calls, sent, config };
}

let seq = 0;
const mkMsg = (text, { at = false, kind = 'group', groupId = '20001' } = {}) => ({
  messageId: `m${++seq}`,
  kind,
  subType: kind === 'group' ? 'normal' : 'friend',
  selfId: '10000',
  userId: '10001',
  groupId: kind === 'group' ? groupId : null,
  senderName: '阿澈',
  text,
  atSelf: at,
  atAll: false,
  images: 0,
  imageUrls: [],
  cards: [],
  hasVideo: false,
  raw: {},
  time: Date.now(),
});

// ─────────────────────────────────────────────
console.log('\n【1】突然连问 4 句（都 @ 它）——不能丢，且合并成一次回答');
{
  const { bot, calls, sent } = makeBot();
  const results = await Promise.all([
    bot.handleMessage(mkMsg('在吗', { at: true }), { echo: false }),
    bot.handleMessage(mkMsg('你看这个bug咋回事', { at: true }), { echo: false }),
    bot.handleMessage(mkMsg('是不是配置错了', { at: true }), { echo: false }),
    bot.handleMessage(mkMsg('你倒是说话啊', { at: true }), { echo: false }),
  ]);
  await bot.drain();
  const repliedCount = results.filter((r) => r.replied).length;
  check('★ 4 句指名提问一条都没被丢掉', repliedCount === 4, `replied=${repliedCount}/4`);
  check(
    '★ 合并处理，回复条数远少于提问数（不刷屏）',
    sent.length < 4 && sent.length >= 1,
    `提问 4 句 → 回复 ${sent.length} 条，模型调用 ${calls.length} 次`,
  );
  const merged = calls.find((c) => c.prompt.includes('一条回复里把它们一起答掉'));
  check('★ 提示词里明确说了「这些是连着问你的，一起答」', !!merged);
  check(
    '上下文里标出了哪些是问它的（@你）',
    merged ? merged.prompt.includes('（@你）') : false,
    merged ? (merged.prompt.match(/（@你）/g) || []).length + ' 处标记' : '没找到合并批次',
  );
}

// ─────────────────────────────────────────────
console.log('\n【2】逐句问，每句都要答上（指名不受「间隔太短」限制）');
{
  const { bot, sent } = makeBot();
  const r = [];
  for (const q of ['第一个问题', '第二个问题', '第三个问题']) {
    r.push(await bot.handleMessage(mkMsg(q, { at: true }), { echo: false }));
  }
  await bot.drain();
  check(
    '★ 连着 3 句逐句问，全部答上（旧版第 2、3 句会被限流丢掉）',
    r.every((x) => x.replied) && sent.length === 3,
    `replied=${r.filter((x) => x.replied).length}/3，发出 ${sent.length} 条`,
  );
}

// ─────────────────────────────────────────────
console.log('\n【3】非指名闲聊仍然被限流管住（防抢话不能丢）');
{
  const { bot } = makeBot();
  const first = await bot.handleMessage(mkMsg('大家好啊'), { echo: false });
  await bot.drain();
  const second = await bot.handleMessage(mkMsg('今天天气不错'), { echo: false });
  await bot.drain();
  check('第一条主动插话能回', first.replied === true, first.reason);
  check(
    '紧接着第二条主动插话被拦下（minInterval=60s）',
    second.replied === false && String(second.reason).startsWith('rate-'),
    second.reason,
  );
  const atDuring = await bot.handleMessage(mkMsg('喂你说话', { at: true }), { echo: false });
  await bot.drain();
  check('★ 但同一时刻被 @ 依然必应', atDuring.replied === true, atDuring.reason);
}

// ─────────────────────────────────────────────
console.log('\n【4】防刷硬上限仍在（防止有人刷它）');
{
  const { bot } = makeBot({ limits: { maxDirectedPerMinute: 2 } });
  const r = [];
  for (const q of ['一', '二', '三']) {
    r.push(await bot.handleMessage(mkMsg(q, { at: true }), { echo: false }));
  }
  await bot.drain();
  check(
    '指名回复超过硬上限后被拦下（留了防滥用兜底）',
    r[0].replied === true && r[1].replied === true && r[2].replied === false && r[2].reason === 'rate-directed-per-minute',
    r.map((x) => x.reason).join(' / '),
  );
}

// ─────────────────────────────────────────────
console.log('\n【5】私聊连着问也走同一条路');
{
  const { bot, sent } = makeBot();
  const r = await Promise.all([
    bot.handleMessage(mkMsg('在吗', { kind: 'private' }), { echo: false }),
    bot.handleMessage(mkMsg('帮我看看这个', { kind: 'private' }), { echo: false }),
    bot.handleMessage(mkMsg('在不在', { kind: 'private' }), { echo: false }),
  ]);
  await bot.drain();
  check('私聊连问 3 句都答上', r.every((x) => x.replied), `replied=${r.filter((x) => x.replied).length}/3`);
  check('私聊也被合并（不刷屏）', sent.length <= 2, `发出 ${sent.length} 条`);
}

// ─────────────────────────────────────────────
console.log('\n【6】"先发图、再问这是什么" —— 后一条要把前一张图找回来');
{
  // 造一张真的 1x1 PNG，好让图片下载链路真的跑通（不是 mock）
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const imgFile = path.join(os.tmpdir(), `bigfish-lookback-${Date.now()}.png`);
  fs.writeFileSync(imgFile, Buffer.from(pngB64, 'base64'));

  const { bot, calls } = makeBot({
    mutate: (c) => {
      c.images.considerAmbient = false; // 让那条图被策略跳过，只能靠"回看"救回来
      c.images.lookbackMs = 90000;
    },
  });

  // ① 群里先发一张图，没 @ 它 → 按策略跳过不看
  const imgOnly = mkMsg('', { at: false });
  imgOnly.images = 1;
  imgOnly.imageUrls = [{ url: '', file: imgFile }];
  const r1 = await bot.handleMessage(imgOnly, { echo: false });
  await bot.drain();
  check('第一步：没点它的图被跳过（符合省钱的默认）', r1.replied === false, r1.reason);

  // ② 紧接着 @ 它问"这是什么"（这条消息本身没有图）
  const ask = mkMsg('这是什么', { at: true });
  const r2 = await bot.handleMessage(ask, { echo: false });
  await bot.drain();

  const last = calls[calls.length - 1] || { blocks: [], prompt: '' };
  check(
    '★ 后一条 @ 它的消息把刚才那张图找回来了',
    last.blocks.length === 1,
    `带图 ${last.blocks.length} 张`,
  );
  check(
    '★ 提示词里说明了这是"刚刚发过的那张图"',
    last.prompt.includes('刚刚发过一张图'),
    last.prompt.includes('刚刚发过一张图') ? '已说明' : '没说明',
  );
  check('这一步确实回复了', r2.replied === true, r2.reason);

  fs.rmSync(imgFile, { force: true });
}

// ─────────────────────────────────────────────
console.log('\n【7】同一张图不重复喂（群里"花我token是吧"的那个问题）');
{
  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const imgFile = path.join(os.tmpdir(), `bigfish-once-${Date.now()}.png`);
  fs.writeFileSync(imgFile, Buffer.from(pngB64, 'base64'));

  const { bot, calls } = makeBot({
    mutate: (c) => {
      c.images.alwaysLook = true; // 图一律看一眼
      c.images.lookbackMs = 300000;
    },
  });

  const imgMsg2 = mkMsg('', { at: false });
  imgMsg2.images = 1;
  imgMsg2.imageUrls = [{ url: '', file: imgFile }];
  await bot.handleMessage(imgMsg2, { echo: false });
  await bot.drain();
  const firstBlocks = (calls[calls.length - 1] || {}).blocks?.length || 0;
  check('★ 图片消息本身：看了一次', firstBlocks === 1, `带图 ${firstBlocks} 张`);

  // 后面两条纯文字消息（同一个人接着说话）不该把那张图再喂一遍
  for (const t of ['然后呢', '你倒是说句话']) {
    const m = mkMsg(t, { at: false });
    m.atSelf = true; // 指名，保证一定会走到模型
    await bot.handleMessage(m, { echo: false });
    await bot.drain();
  }
  const reattached = calls.slice(1).filter((c) => (c.blocks || []).length > 0).length;
  check(
    '★ 后续消息不会把同一张图重新读一遍（它已经进会话历史了）',
    reattached === 0,
    `后续 ${calls.length - 1} 次调用中重复带图 ${reattached} 次`,
  );

  fs.rmSync(imgFile, { force: true });
}

// ─────────────────────────────────────────────
console.log('\n【8】一视同仁：不许按"发消息的人是谁"区别对待');
{
  const { buildPrompt } = await import('../src/text.mjs');
  const owner = {
    name: '阿澈',
    userId: '10001',
    aliases: ['阿澈', '25'],
    note: '他是你的人，你们在一起。',
  };
  // 关键：发消息的是**别人**，但配置里把 owner 填成"阿澈"。
  // 如果提示里出现了"阿澈/你的主人/就是他发的"，说明特殊化又回来了。
  const p = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: '小雪', userId: '10002', text: '在吗', images: 0, cards: [] },
    owner,
  });
  check('★ 不再注入"谁是你的主人"', !p.includes('【你的人】'), '');
  check('★ 别人的消息里不出现主人名字/QQ', !p.includes('阿澈') && !p.includes('10001'), '');
  check('★ 也没有"这条就是他发的"这类特殊化提示', !p.includes('就是他发的'), '');
  check('提示里没有"开发者/部署"这类工程词', !/开发者|部署|提示词/.test(p), '');

  // 同一个人的消息：换个 userId 进来，提示除昵称外应当完全一致（态度不因身份变化）
  const a = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: '甲', userId: '1', text: '在吗', images: 0, cards: [] },
    owner,
  });
  const b = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: '乙', userId: '2', text: '在吗', images: 0, cards: [] },
    owner,
  });
  check(
    '★ 张三和李四发同样的话，给她的提示只差名字',
    a.replace('甲', '乙') === b,
    a.replace('甲', '乙') === b ? '' : '提示内容有身份相关的差异',
  );
}

// ─────────────────────────────────────────────
console.log('\n【9】快速停止：静音之后不回话、但还在记事；老板能叫醒');
{
  const { createSwitch } = await import('../src/switch.mjs');
  const { createStateStore } = await import('../src/state.mjs');
  const swFile = path.join(os.tmpdir(), `bigfish-pause-${Date.now()}.json`);
  const control = createSwitch({ file: swFile });
  // 这次要真的检查"她有没有记下来"，所以给一个真实的状态存储
  const memFile = path.join(os.tmpdir(), `bigfish-pause-mem-${Date.now()}.json`);
  const state2 = createStateStore({ file: memFile, logger: silent, enabled: true, debounceMs: 10 });
  state2.load();

  const { config } = makeBot({ mutate: (c) => { c.owner = { name: '阿澈', userId: '10001', aliases: [], note: '' }; } });
  const cfg = structuredClone(config);
  cfg.owner = { name: '阿澈', userId: '10001', aliases: [], note: '' };
  const calls2 = [];
  const sent2 = [];
  const rt2 = {
    async ask(sessionId, prompt, opts) {
      calls2.push({ sessionId, prompt, blocks: (opts && opts.extraBlocks) || [] });
      await sleep(5);
      return { text: '在的呀', reason: { kind: 'completed' } };
    },
  };
  const bot2 = createBot({
    config: cfg,
    logger: silent,
    runtime: rt2,
    send: async (_m, t) => sent2.push(t),
    control,
    state: state2,
    runToken: `sw${Date.now().toString(36)}`,
  });

  control.pause({ minutes: 30, by: '测试' });
  const r1 = await bot2.handleMessage(mkMsg('你说话呀', { at: true }), { echo: false });
  await bot2.drain();
  check('★ 静音期间：不回话', r1.replied === false && r1.reason === 'paused', r1.reason);
  check('★ 静音期间：一次模型调用都不发（不花钱）', calls2.length === 0, `模型调用 ${calls2.length} 次`);
  check('静音期间仍然在记事（她还听着）', state2.stats().entries >= 1, JSON.stringify(state2.stats()));

  // 老板说"恢复" —— 必须能叫醒，否则静音就成了单向门
  const r2 = await bot2.handleMessage(mkMsg('恢复', { at: true }), { echo: false });
  check('★ 老板说"恢复"能叫醒她', r2.replied === true, r2.reason);
  check('恢复之后开关被清掉', control.isPaused() === false);

  const r3 = await bot2.handleMessage(mkMsg('现在能说话了吧', { at: true }), { echo: false });
  await bot2.drain();
  check('恢复之后正常回话', r3.replied === true, r3.reason);
  check('恢复之后开始花模型的钱了', calls2.length > 0, `模型调用 ${calls2.length} 次`);

  // 别人说"恢复"不算数
  control.pause({ minutes: 30, by: '测试' });
  const outsider = mkMsg('恢复', { at: true });
  outsider.userId = '10002';
  outsider.senderName = '小雪';
  const r4 = await bot2.handleMessage(outsider, { echo: false });
  await bot2.drain();
  check('★ 别人说"恢复"不管用（只有老板能操作）', control.isPaused() === true && r4.reason === 'paused', r4.reason);

  fs.rmSync(swFile, { force: true });
  state2.flush();
  fs.rmSync(memFile, { force: true });
}

console.log(`\n=== 结果：${pass} 项通过，${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
