/**
 * 「自主参与 + 长期记忆」这套新逻辑的定向测试。
 * 不调用模型、不连 QQ、不碰 dsh-home —— 只验纯逻辑，跑得飞快且零成本。
 *
 * 用法: node tools/test-agent-mode.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { createPolicy } from '../src/policy.mjs';
import { sanitizeReply, extractMemoryNotes, buildPrompt, buildDigestPrompt } from '../src/text.mjs';
import { createStateStore, pruneOldAttachments } from '../src/state.mjs';

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

const silent = { debug() {}, info() {}, warn() {}, error() {} };

// ─────────────────── 1. 长期记忆的读写 ───────────────────
console.log('\n【1】[记忆] 行的抽取');
{
  const r1 = extractMemoryNotes('早上好呀～\n[记忆] 小明在做一个爬虫项目，卡在登录验证');
  check('抽出 [记忆] 行', r1.notes.length === 1 && r1.notes[0].includes('爬虫'), JSON.stringify(r1.notes));
  check('[记忆] 行不会出现在正文里', r1.clean.trim() === '早上好呀～', JSON.stringify(r1.clean));

  const r2 = extractMemoryNotes('【记忆】：群主叫阿澈\n正文在这');
  check('支持全角【记忆】和冒号', r2.notes.length === 1 && r2.notes[0] === '群主叫阿澈', JSON.stringify(r2.notes));

  const r3 = extractMemoryNotes('[REMEMBER] he likes python');
  check('支持 [REMEMBER] 英文写法', r3.notes.length === 1 && r3.clean === '', JSON.stringify(r3));

  const r4 = extractMemoryNotes('就是普通一句回复，不记得什么');
  check('没有记忆行时 notes 为空', r4.notes.length === 0 && r4.clean.includes('普通一句'));
}

// ─────────────────── 2. [NO_REPLY] 哨兵 ───────────────────
console.log('\n【2】[NO_REPLY] 哨兵的识别');
{
  check('纯哨兵 → 不发', sanitizeReply('[NO_REPLY]') === '');
  check('哨兵带标点 → 不发', sanitizeReply('[NO_REPLY]。') === '');
  check('哨兵后面还写了废话 → 也不发', sanitizeReply('[NO_REPLY]\n（还是不说话好了）') === '');
  check('正常回复不受影响', sanitizeReply('在的～怎么啦？') === '在的～怎么啦？');
  // 这一条很重要：记忆行被剔掉之后，正文可能只剩哨兵
  const r = extractMemoryNotes('[NO_REPLY]\n[记忆] 群里在讨论换电脑');
  check('只剩哨兵时也不发（但记忆照样记下）', sanitizeReply(r.clean) === '' && r.notes.length === 1);
}

// ─────────────────── 3. 提示词组装 ───────────────────
console.log('\n【3】提示词组装');
{
  const msg = { kind: 'group', groupId: '20001', senderName: '阿澈', text: '在吗', images: 0 };
  const p = buildPrompt({
    msg,
    recent: [{ name: '小明', text: '昨天那个bug修好了' }],
    notes: ['小明在做爬虫项目', '群主是阿澈'],
    groupName: '示例群',
    selfDecide: true,
  });
  check('带上了【你记得的事】', p.includes('【你记得的事】') && p.includes('爬虫'), '');
  check('带上了【最近消息】', p.includes('【最近消息】') && p.includes('昨天那个bug修好了'));
  check('带上了【最新消息】', p.includes('【最新消息】') && p.includes('阿澈: 在吗'));
  check('带上了群名', p.includes('示例群'));
  check('selfDecide 时有 NO_REPLY 提醒', p.includes('[NO_REPLY]') && p.includes('[记忆]'));
  const p2 = buildPrompt({ msg, selfDecide: false });
  check('selfDecide 关闭时没有该提醒', !p2.includes('[NO_REPLY]'));
}

// ─────────────────── 4. 主动参与的两个闸门 ───────────────────
console.log('\n【4】主动参与：冷场间隔 / 活跃度 / 指名必应');
{
  const base = loadConfig(process.cwd(), 'config/bot.config.json');
  const mkPolicy = (mutate) => {
    const cfg = structuredClone(base);
    cfg.trigger.group = 'all';
    cfg.trigger.selfDecide = true;
    cfg.trigger.replyChance = 1;
    cfg.limits.afterReplyCooldownMs = 20000;
    cfg.limits.minIntervalPerChatMs = 0;
    mutate?.(cfg);
    return createPolicy({ config: cfg, logger: silent });
  };
  let seq = 0;
  const ambient = () => ({
    messageId: `m${++seq}`, kind: 'group', subType: 'normal', selfId: '10000',
    userId: '10001', groupId: '20001', senderName: '阿澈',
    text: '今天中午吃啥好呢', atSelf: false, atAll: false, images: 0, raw: {}, time: Date.now(),
  });
  const directed = () => ({ ...ambient(), atSelf: true, text: '大肥鱼你说呢' });

  const p1 = mkPolicy();
  const first = p1.decide(ambient());
  check('没人点它时也会交给模型判断（group=all）', first.action === 'reply', first.reason);

  // 它刚说过话 → 冷场间隔内不再接话
  p1.noteReply(`group:20001`);
  const during = p1.decide(ambient());
  check('它刚说完话 → 冷场间隔内不接', during.action === 'ignore' && during.reason === 'after-reply-cooldown', during.reason);

  const directedDuring = p1.decide(directed());
  check('★ 冷场间隔内被 @ 仍然必应（不能把叫它当没听见）', directedDuring.action === 'reply', directedDuring.reason);

  const p2 = mkPolicy((c) => {
    c.trigger.replyChance = 0;
  });
  const skipped = p2.decide(ambient());
  check('replyChance=0 时闲聊一律跳过（省钱档）', skipped.action === 'ignore' && skipped.reason === 'chance-skip', skipped.reason);
  const stillAt = p2.decide(directed());
  check('★ replyChance=0 时被 @ 依然必应', stillAt.action === 'reply', stillAt.reason);

  const p3 = mkPolicy();
  const kw = p3.decide({ ...ambient(), text: '这事得问大肥鱼才行' });
  check('关键词仍然是指名（不受活跃度影响）', kw.action === 'reply' && kw.reason === 'group-keyword', kw.reason);
}

// ─────────────────── 5. 记忆落盘 ───────────────────
console.log('\n【5】长期记忆落盘与去重');
{
  const file = path.join(os.tmpdir(), `bigfish-notes-test-${Date.now()}.json`);
  const st = createStateStore({ file, logger: silent, enabled: true, debounceMs: 10 });
  st.load();
  const a = st.addNotes('group:123', ['小明在做爬虫', '小明在做爬虫', '群主是阿澈'], 5);
  check('同一事实去重（3 条进、2 条存）', a === 2, `added=${a}`);
  check('能读回来', st.getNotes('group:123').length === 2, JSON.stringify(st.getNotes('group:123')));
  st.addNotes('group:123', ['A', 'B', 'C', 'D'], 5);
  const notes = st.getNotes('group:123');
  check('超过上限时丢最早的', notes.length === 5 && !notes.includes('小明在做爬虫'), JSON.stringify(notes));
  st.flush();
  const st2 = createStateStore({ file, logger: silent, enabled: true, debounceMs: 10 });
  st2.load();
  check('重载后记忆还在（跨重启）', st2.getNotes('group:123').length === 5, `${st2.getNotes('group:123').length} 条`);
  check('stats 能看到记忆条数', st2.stats().notes === 5, JSON.stringify(st2.stats()));
  fs.rmSync(file, { force: true });
}

// ─────────────────── 6. 定期提炼（学习）的提示词 ───────────────────
console.log('\n【6】定期提炼（学习群聊内容）');
{
  const p = buildDigestPrompt({
    groupName: '示例群',
    groupId: '20001',
    messages: [
      { name: '阿澈', text: '这个角色的大招倍率好高' },
      { name: '小明', text: '毕竟她是主C啊' },
    ],
    existingNotes: ['群主是阿澈'],
  });
  check('带上了群名和聊天记录', p.includes('示例群') && p.includes('大招倍率'));
  check('要求以 [记忆] 开头输出', p.includes('[记忆]'));
  check('带上了已有记忆（避免重复记）', p.includes('【已经记住的】') && p.includes('群主是阿澈'));
  check('明确提到游戏/角色/术语是重点', p.includes('游戏') && p.includes('角色'));
  check('没新东西时要求输出 NO_REPLY', p.includes('[NO_REPLY]'));
  const p2 = buildDigestPrompt({ groupId: '1', messages: [{ name: 'A', text: 'hi' }] });
  check('没有已有记忆时不出现该段', !p2.includes('【已经记住的】'));
}

// ─────────────────── 7. 识图 / 链接卡片 ───────────────────
console.log('\n【7】识图与链接卡片的解析');
{
  const { normalizeMessage } = await import('../src/onebot.mjs');
  const { sniffMime } = await import('../src/media.mjs');

  const evt = {
    post_type: 'message',
    message_type: 'group',
    group_id: 20001,
    user_id: 10001,
    self_id: 10000,
    message:
      '[CQ:at,qq=10000][CQ:image,file=a.jpg,url=https://example.com/a.jpg]' +
      '[CQ:image,file=b.png,url=https://example.com/b.png][CQ:video,file=v.mp4]',
    sender: { nickname: '阿澈', card: '阿澈' },
    time: Math.floor(Date.now() / 1000),
  };
  const m = normalizeMessage(evt, '10000');
  check('图片数量统计正确', m.images === 2, `images=${m.images}`);
  check('★ 拿到了图片的可下载地址', m.imageUrls.length === 2 && m.imageUrls[0].url.includes('a.jpg'), JSON.stringify(m.imageUrls[0]));
  check('识别出视频段', m.hasVideo === true);

  const cardEvt = {
    ...evt,
    message:
      '[CQ:json,data={"app":"com.tencent.structmsg","meta":{"detail_1":{"title":"星穹铁道新角色PV","desc":"官方发布","qqdocurl":"https://b23.tv/xxx"}}}]',
  };
  const mc = normalizeMessage(cardEvt, '10000');
  check(
    '★ 能从分享卡片里抽出标题/简介/链接',
    mc.cards.length === 1 && mc.cards[0].title.includes('星穹铁道') && mc.cards[0].url.includes('b23.tv'),
    JSON.stringify(mc.cards[0] || null),
  );
  check('卡片消息没有图片', mc.images === 0);

  // 文件头判断格式，不信后缀名
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const gif = Buffer.from('GIF89a', 'ascii');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  check('识别 PNG', sniffMime(png) === 'image/png');
  check('识别 JPEG', sniffMime(jpg) === 'image/jpeg');
  check('识别 GIF', sniffMime(gif) === 'image/gif');
  check('识别 WEBP', sniffMime(webp) === 'image/webp');
  check('拒绝非图片（比如 zip）', sniffMime(Buffer.from('PK\x03\x04', 'ascii')) === null);

  // 提示词里要把「能看到的图」和「只有标题的链接」区分清楚
  const pImg = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: 'A', text: '', images: 1, cards: [], hasVideo: false },
    imagesAttached: 1,
  });
  check('能看到的图片 → 提示词说「你能看到」', pImg.includes('你能看到'));
  const pNoImg = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: 'A', text: '', images: 1, cards: [], hasVideo: false },
    imagesAttached: 0,
  });
  check('取不到图 → 提示词说「看不到内容」', pNoImg.includes('看不到内容'));
  const pCard = buildPrompt({
    msg: {
      kind: 'group',
      groupId: '1',
      senderName: 'A',
      text: '看这个',
      images: 0,
      cards: [{ title: '新角色PV', desc: '官方', url: 'u' }],
      hasVideo: true,
    },
  });
  check('卡片 → 带上标题简介，并说明看不到里面内容', pCard.includes('新角色PV') && pCard.includes('看不到里面的具体内容'));
  check('视频文件 → 明确说明看不到画面', pCard.includes('看不到画面'));
}

// ─────────────────── 8. 图片消息的路由 ───────────────────
console.log('\n【8】图片消息该不该处理');
{
  const base = loadConfig(process.cwd(), 'config/bot.config.json');
  const mk = (mutate) => {
    const cfg = structuredClone(base);
    cfg.trigger.group = 'all';
    cfg.trigger.selfDecide = true;
    cfg.trigger.replyChance = 1;
    cfg.limits.afterReplyCooldownMs = 0;
    cfg.limits.minIntervalPerChatMs = 0;
    cfg.images.enabled = true;
    mutate?.(cfg);
    return createPolicy({ config: cfg, logger: silent });
  };
  let seq = 0;
  const imgMsg = (o = {}) => ({
    messageId: `i${++seq}`, kind: o.kind || 'group', subType: 'normal', selfId: '10000',
    userId: '10001', groupId: '20001', senderName: '阿澈',
    text: '', atSelf: !!o.atSelf, atAll: false, images: 1, imageUrls: [{ url: 'http://x/1.png' }], raw: {}, time: Date.now(),
  });

  const p1 = mk();
  // 图片现在不省 token：alwaysLook=true 时一律看一眼，跟 @ 不 @ 无关、跟骰子无关。
  // 看归看，说不说仍由模型自己判断（selfDecide），所以不会变成刷屏机器。
  const pNoChance = mk((c) => {
    c.trigger.replyChance = 0; // 骰子必不过
    c.images.alwaysLook = true;
  });
  const always = pNoChance.decide(imgMsg());
  check(
    '★ 图片一律看一眼（不靠骰子省这个钱）',
    always.action === 'reply' && always.reason === 'group-image-ambient',
    always.reason,
  );
  check('★ 图片消息标记为 mustProcess（队列里永不丢弃）', always.mustProcess === true);

  // 想省的时候：关掉 alwaysLook，仍然可以退回"随缘看看"
  const pAmbientOff = mk((c) => {
    c.trigger.replyChance = 0;
    c.images.alwaysLook = false;
    c.images.considerAmbient = true;
  });
  const skipped = pAmbientOff.decide(imgMsg());
  check(
    '关掉 alwaysLook 后，骰子没过就不看（省钱模式还在）',
    skipped.action === 'ignore' && String(skipped.reason).startsWith('chance'),
    skipped.reason,
  );

  const pNoAmbient = mk((c) => {
    c.images.alwaysLook = false;
    c.images.considerAmbient = false;
    c.trigger.replyChance = 1;
  });
  const strict = pNoAmbient.decide(imgMsg());
  check(
    '两个开关都关掉 → 非指名的图一律不看',
    strict.action === 'ignore' && strict.reason === 'image-ambient-skipped',
    strict.reason,
  );

  const at = p1.decide(imgMsg({ atSelf: true }));
  check('★ 群里 @ 它并发了图 → 一定看图', at.action === 'reply' && at.reason === 'group-image-directed', at.reason);

  const p2 = mk((c) => {
    c.images.enabled = false;
  });
  const noImgSupport = p2.decide(imgMsg({ atSelf: true }));
  check('关掉识图后，图仍然不看', noImgSupport.action === 'ignore' && noImgSupport.reason === 'image-only-unsupported', noImgSupport.reason);

  const p3 = mk();
  const priv = p3.decide(imgMsg({ kind: 'private' }));
  check('★ 私聊发图（无文字）→ 会看图', priv.action === 'reply', priv.reason);
}

// ─────────────────── 9. 自动化维护：记忆去重 + 附件清理 ───────────────────
console.log('\n【9】自动化维护');
{
  const file = path.join(os.tmpdir(), `bigfish-maint-test-${Date.now()}.json`);
  const st = createStateStore({ file, logger: silent, enabled: true, debounceMs: 10 });
  st.load();
  st.addNotes('group:1', ['小明在做一个爬虫项目，卡在登录验证'], 20);
  const added = st.addNotes(
    'group:1',
    ['小明在做一个爬虫项目，卡在登录验证那一步', '群里主要在聊星穹铁道'],
    20,
  );
  const notes = st.getNotes('group:1');
  check(
    '★ 换了说法的同一条事实被合并，不再重复堆积',
    notes.length === 2 && added === 1,
    `新增 ${added} 条，现共 ${notes.length} 条：${JSON.stringify(notes)}`,
  );
  st.flush();
  fs.rmSync(file, { force: true });

  // 附件清理：造两个文件，一个改成 30 天前
  const attRoot = path.join(os.tmpdir(), `bigfish-att-test-${Date.now()}`);
  const oldDir = path.join(attRoot, 'v1', 'objects', 'ab');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, 'old');
  const newFile = path.join(oldDir, 'new');
  fs.writeFileSync(oldFile, 'x'.repeat(1000));
  fs.writeFileSync(newFile, 'y'.repeat(100));
  const longAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  fs.utimesSync(oldFile, longAgo, longAgo);

  const res = pruneOldAttachments(attRoot, { keepDays: 7 });
  check(
    '★ 过期附件被自动清掉，新附件保留',
    res.removed === 1 && res.kept === 1 && !fs.existsSync(oldFile) && fs.existsSync(newFile),
    `删除 ${res.removed}，保留 ${res.kept}，释放 ${res.freedBytes} 字节`,
  );
  check('清理结果能报出释放的空间', res.freedBytes === 1000, `${res.freedBytes} 字节`);
  fs.rmSync(attRoot, { recursive: true, force: true });
}

// ─────────────────── 10. QQ 内置表情 / 表情包 / 图片地址兜底 ───────────────────
console.log('\n【10】QQ 内置表情与表情包');
{
  const { normalizeMessage } = await import('../src/onebot.mjs');
  const { faceTag } = await import('../src/qq-face.mjs');
  const { collectImageBlocks } = await import('../src/media.mjs');

  check('表情编号翻名字', faceTag(20) === '[偷笑]' && faceTag(9) === '[大哭]', `${faceTag(20)} ${faceTag(9)}`);
  check('没收录的编号退化成中性说法（不瞎猜）', faceTag(9999) === '[QQ表情9999]', faceTag(9999));
  check('脏输入也不炸', faceTag('id=14') === '[微笑]' && faceTag(undefined) === '[QQ表情]', `${faceTag('id=14')} ${faceTag(undefined)}`);
  // 新式大表情：id 能到 300+，静态表追不上，所以优先用 NapCat 带的名字
  const { faceTagFrom } = await import('../src/qq-face.mjs');
  check(
    '★ 优先用 NapCat 自带的 faceText（新式大表情 id=344 也能读对）',
    faceTagFrom(344, '/大怨种', true) === '[大表情:大怨种]',
    faceTagFrom(344, '/大怨种', true),
  );
  check('普通表情带名字时也用名字', faceTagFrom(5, '/流泪', false) === '[流泪]', faceTagFrom(5, '/流泪', false));
  check('没名字时退回静态表', faceTagFrom(20, null, false) === '[偷笑]', faceTagFrom(20, null, false));

  const base = {
    post_type: 'message',
    message_type: 'group',
    group_id: 20001,
    user_id: 10001,
    self_id: 10000,
    sender: { nickname: '小雪', card: '小雪' },
    time: Math.floor(Date.now() / 1000),
  };

  // CQ 字符串：纯表情
  const mFace = normalizeMessage({ ...base, message: '[CQ:face,id=20]' }, '10000');
  check('★ 纯表情消息不再读成空（文本里带上 [偷笑]）', mFace.text === '[偷笑]', JSON.stringify(mFace.text));
  check('表情数量统计正确', mFace.faces === 1);

  // 文字里夹表情
  const mMixed = normalizeMessage({ ...base, message: '在吗[CQ:face,id=9]你看看' }, '10000');
  check(
    '文字里的表情也翻译了',
    mMixed.text === '在吗[大哭]你看看',
    JSON.stringify(mMixed.text),
  );

  // segment 数组形式（NapCat 默认上报格式）
  const mArr = normalizeMessage(
    {
      ...base,
      message: [
        { type: 'text', data: { text: '哈哈' } },
        { type: 'face', data: { id: '13' } },
        { type: 'image', data: { file: 'x.jpg', url: 'http://e/x.jpg', sub_type: 1 } },
      ],
    },
    '10000',
  );
  check('segment 数组里的表情也翻译', mArr.text === '哈哈[呲牙]', JSON.stringify(mArr.text));
  check('★ 识别出表情包（sub_type=1）而不同于普通图片', mArr.stickers === 1 && mArr.images === 1, `stickers=${mArr.stickers}`);
  check('数组里的图片拿到了地址', mArr.imageUrls.length === 1 && mArr.imageUrls[0].sticker === true);

  const mRps = normalizeMessage({ ...base, message: '[CQ:rps,type=1][CQ:dice,type=2]' }, '10000');
  check('猜拳和骰子也能读出来', mRps.text === '[猜拳][骰子]', JSON.stringify(mRps.text));

  // 大表情 / 抖动 / 戳一戳 / 合并转发：以前这些一律读成空
  const mBig = normalizeMessage({ ...base, message: '[CQ:mface,emoji_id=1,summary=[动画表情]]' }, '10000');
  check('大表情能读出来（带上 summary）', mBig.text.includes('大表情'), JSON.stringify(mBig.text));
  check('大表情单独计数', mBig.bigFaces === 1 && mBig.images === 0, `bigFaces=${mBig.bigFaces}`);
  const mShake = normalizeMessage({ ...base, message: '[CQ:shake][CQ:poke,qq=1]' }, '10000');
  check('窗口抖动 / 戳一戳能读出来', mShake.text === '[窗口抖动][戳一戳]', JSON.stringify(mShake.text));
  const mFwd = normalizeMessage({ ...base, message: '[CQ:forward,id=abc]' }, '10000');
  check('合并转发能读出来', mFwd.text === '[合并转发的消息]' && mFwd.hasForward === true, JSON.stringify(mFwd.text));

  // ★ 最关键的诊断能力：不认识的段必须被记下来
  const mUnknown = normalizeMessage({ ...base, message: '[CQ:someNewThing,data=xyz]' }, '10000');
  check(
    '★ 不认识的段类型被记录下来（这样才能查出"消息读不出来"）',
    mUnknown.unknownSegments.length === 1 && mUnknown.unknownSegments[0] === 'someNewThing',
    JSON.stringify(mUnknown.unknownSegments),
  );
  check('不认识的段不会硬塞进文本（免得它瞎回应）', mUnknown.text === '', JSON.stringify(mUnknown.text));

  const mArrayBig = normalizeMessage(
    { ...base, message: [{ type: 'text', data: { text: '看' } }, { type: 'mface', data: { summary: '哈哈' } }] },
    '10000',
  );
  check('数组形式的大表情也拼进文本', mArrayBig.text.includes('看') && mArrayBig.text.includes('大表情'), JSON.stringify(mArrayBig.text));

  // 真实抓到的结构：新式大表情走 face 段，但带 raw.faceText
  const mRealBigFace = normalizeMessage(
    {
      ...base,
      message: [
        {
          type: 'face',
          data: { id: '344', raw: { faceIndex: 344, faceText: '/大怨种', faceType: 2 } },
        },
      ],
    },
    '10000',
  );
  check(
    '★ 真实大表情结构（face+raw.faceText）读出中文名',
    mRealBigFace.text === '[大表情:大怨种]',
    JSON.stringify(mRealBigFace.text),
  );

  // 提示词里要区分「表情包」和「图片」
  const pSticker = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: 'A', text: '', images: 1, stickers: 1, cards: [] },
    imagesAttached: 1,
  });
  check('提示词里说清了是"表情包"', pSticker.includes('表情包'), '');
  const pPhoto = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: 'A', text: '', images: 1, stickers: 0, cards: [] },
    imagesAttached: 1,
  });
  check('普通图片仍然叫"图片"', pPhoto.includes('张图片') && !pPhoto.includes('表情包'));

  // 图片地址为空的兜底：不能再静默跳过
  const warns = [];
  const capLogger = { debug() {}, info() {}, warn: (...a) => warns.push(a.join(' ')), error() {} };
  const res = await collectImageBlocks(
    { images: 1, imageUrls: [{ url: '', file: '' }] },
    { enabled: true, maxPerMessage: 2 },
    capLogger,
  );
  check(
    '★ 图片地址为空时明确报警（不再静默跳过）',
    res.blocks.length === 0 && warns.some((w) => w.includes('没有任何可用地址')),
    warns[0] || '(没有日志)',
  );

  // 有 file 但直连失败 → 应该去问 get_image 换地址
  const warns2 = [];
  const cap2 = { debug() {}, info() {}, warn: (...a) => warns2.push(a.join(' ')), error() {} };
  let asked = null;
  const res2 = await collectImageBlocks(
    { images: 1, imageUrls: [{ url: 'file:///definitely/not/here.jpg', file: 'abc.image' }] },
    { enabled: true, maxPerMessage: 2 },
    cap2,
    {
      resolveImageUrl: async (file) => {
        asked = file;
        return null; // 模拟 get_image 也没给可用地址
      },
    },
  );
  check('★ 直连失败时会去问 get_image 换地址', asked === 'abc.image', `asked=${asked}`);
  check('换不到时如实记日志并跳过', res2.blocks.length === 0 && warns2.some((w) => w.includes('跳过一张图片')), warns2[0] || '');
}

// ─────────────────── 11. 发送前兜底：顶撞话必须被改写掉 ───────────────────
console.log('\n【11】发送前兜底：否定式反问');
{
  const { softenReply } = await import('../src/text.mjs');
  const cases = [
    // 注意：改写会连那段末尾的标点一起吃掉落，聊天里这样更自然
    ['你做的呀，还问。', '你做的呀'],
    ['还用问？当然是我呀', '当然是我呀'],
    ['唔……你以为呢', '唔……'],
    ['不然呢，我还能干嘛', '我还能干嘛'],
    ['调什么调，我挺好的', '我挺好的'],
    ['哪句不对味你说，我改。', '哪句不对味你说，我重说。'],
    ['你倒是说句话呀', '说句话呀'],
    ['你说是就是吧', '好吧好吧'],
  ];
  let ok = 0;
  for (const [input, expect] of cases) {
    const r = softenReply(input);
    const good = r.text === expect;
    if (good) ok += 1;
    else console.log(`      ↳ "${input}" → "${r.text}"（期望 "${expect}"）`);
  }
  check(`★ ${cases.length} 句顶撞话全部被改写干净`, ok === cases.length, `${ok}/${cases.length}`);

  const clean = softenReply('在的呀～怎么啦');
  check('正常的话不会被误改', clean.changed === false && clean.text === '在的呀～怎么啦');
  const empty = softenReply('你以为呢');
  check('整句只剩顶撞话时，改写后为空（宁可不说）', empty.text === '', `"${empty.text}"`);
}

// ─────────────────── 12. 拍一拍（走 notice 事件，不是 message） ───────────────────
console.log('\n【12】QQ 拍一拍');
{
  const { isPokeNotice, isPokeRecall, normalizePokeNotice, buildPokeText } = await import('../src/onebot.mjs');

  const notice = {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    time: 1759000000,
    self_id: 10000,
    user_id: 10001,
    target_id: 10000,
    group_id: 20001,
    raw_info: [
      { type: 'nor', text: '拍了拍' },
      { type: 'nor', text: '我的肚子' },
    ],
  };
  check('★ 能认出拍一拍的 notice 事件', isPokeNotice(notice) === true);
  check(
    '普通消息不会被误判成拍一拍',
    isPokeNotice({ post_type: 'message', message_type: 'group' }) === false,
  );

  const poked = normalizePokeNotice(notice, '10000');
  check('★ 拍的是它自己 → 标成 atSelf 并写明"你"', poked.atSelf === true && poked.text.includes('你'), poked.text);
  check('拍一拍被转成一条普通消息，后面的链路都能用', poked.kind === 'group' && poked.groupId === '20001' && poked.isPoke === true);
  check('拍一拍的原文被拼接出来', /拍了拍/.test(poked.text), poked.text);

  // 群里 A 拍 B（不是拍它）
  const other = normalizePokeNotice(
    { ...notice, user_id: 10003, target_id: 10002, raw_info: [{ type: 'nor', text: '拍了拍' }, { type: 'nor', text: '的肩膀' }] },
    '10000',
  );
  check('别人互拍 → 不算拍它', other.atSelf === false, other.text);
  const named = buildPokeText({ fromName: '老陆', toName: '小雪', atSelf: false, rawInfo: [{ type: 'nor', text: '的肩膀' }] });
  check('别人互拍时能读出双方名字', named.includes('老陆') && named.includes('小雪'), named);

  // 私聊拍一拍
  const priv = normalizePokeNotice({ ...notice, group_id: undefined }, '10000');
  check('私聊的拍一拍也能认', priv.kind === 'private' && priv.groupId === null && priv.atSelf === true, priv.text);

  // QQ 原文里已经带了名字时不能重复
  const dup = buildPokeText({
    fromName: '阿澈',
    toName: '大肥鱼',
    atSelf: true,
    rawInfo: [{ type: 'nor', text: '阿澈 拍了拍 大肥鱼' }],
  });
  check('原文自带名字时不会重复', (dup.match(/阿澈/g) || []).length === 1, dup);

  // raw_info 为空也要能造出一句像样的话
  const empty = buildPokeText({ fromName: '阿澈', atSelf: true, rawInfo: [] });
  check('raw_info 为空时也能造出句子', empty === '[拍一拍] 阿澈 拍了拍你', empty);

  check('撤回的拍一拍会被认出来（并忽略，不当成互动）', isPokeRecall({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke_recall' }) === true);
}

// ─────────────────── 13. 记住群里不同的人（成员档案） ───────────────────
console.log('\n【13】成员档案：记住群里不同的人');
{
  const file = path.join(os.tmpdir(), `bigfish-members-${Date.now()}.json`);
  const st = createStateStore({ file, logger: silent, enabled: true, debounceMs: 10 });
  st.load();
  const chat = 'group:20001';

  st.touchMember(chat, '10003', { name: '老陆', card: '老陆' });
  st.touchMember(chat, '10003', { name: '老陆', card: '老陆' });
  st.touchMember(chat, '10002', { name: '小雪', card: '小雪' });
  const lzj = st.getMember(chat, '10003');
  check('★ 收到消息就自动建档（含发言次数）', lzj && lzj.count === 2 && lzj.name === '老陆', JSON.stringify(lzj));

  st.addMemberFacts(chat, '10003', ['喜欢星穹铁道，习惯半夜在线'], 40);
  st.addMemberFacts(chat, '10003', ['喜欢玩星穹铁道，习惯半夜在线'], 40);
  const lzj2 = st.getMember(chat, '10003');
  check('★ 关于某个人的记忆能存下来，且近似重复会合并', lzj2.facts.length === 1, JSON.stringify(lzj2.facts));

  check(
    '★ 用名字能找回这个人（学习时只有名字）',
    st.findMemberIdByName(chat, '老陆') === '10003' &&
      st.findMemberIdByName(chat, '小雪') === '10002',
    `${st.findMemberIdByName(chat, '老陆')} / ${st.findMemberIdByName(chat, '小雪')}`,
  );
  check('认不出的人会返回 null（不硬塞）', st.findMemberIdByName(chat, '查无此人') === null);

  st.seedMember(chat, '10006', { name: '拿轱辘', card: '拿轱辘' });
  const seeded = st.getMember(chat, '10006');
  check('预填成员不会把发言次数算成 1', seeded && seeded.count === 0, `count=${seeded?.count}`);

  const roster = st.memberRoster(chat, 10);
  check('花名册按发言多少排序', roster[0]?.name === '老陆', JSON.stringify(roster.map((r) => r.name)));
  check(
    '统计里能看到成员和成员记忆数',
    st.stats().members === 3 && st.stats().memberFacts === 1,
    JSON.stringify(st.stats()),
  );
  st.flush();
  fs.rmSync(file, { force: true });

  const p = buildPrompt({
    msg: {
      kind: 'group',
      groupId: '20001',
      senderName: '老陆',
      userId: '10003',
      text: '在吗',
      images: 0,
      cards: [],
    },
    member: {
      userId: '10003',
      name: '老陆',
      card: '老陆',
      nickname: '',
      count: 37,
      last: Date.now() - 3600000,
      facts: ['喜欢星穹铁道'],
    },
    roster: [
      { userId: '10003', name: '老陆', count: 37 },
      { userId: '10002', name: '小雪', count: 12 },
    ],
  });
  check('★ 提示词里写了"正在说话的人"', p.includes('正在说话的人') && p.includes('老陆'), '');
  check('提示词里带上了关于这个人的记忆', p.includes('喜欢星穹铁道'), '');
  check('提示词里带上了"这个群里的常客"', p.includes('这个群里的常客') && p.includes('小雪'), '');
  const pNobody = buildPrompt({
    msg: { kind: 'group', groupId: '1', senderName: '新人', userId: '999', text: '在吗', images: 0, cards: [] },
    member: { userId: '999', name: '新人', card: '', nickname: '', count: 1, last: Date.now(), facts: [] },
  });
  check('不认识的人会明确说"还没有印象，别装熟"', pNobody.includes('别装熟'), '');
}

// ─────────────────── 14. 按人记记忆的格式 + 快速停止 ───────────────────
console.log('\n【14】按人记记忆的格式 / 快速停止');
{
  const { extractMemoryNotes } = await import('../src/text.mjs');
  const out = extractMemoryNotes(
    ['好呀～', '[记忆] 老陆 :: 喜欢星穹铁道', '[记忆] 群里管酒馆叫 ST', '[记忆] 小雪 :: 在学画画'].join('\n'),
  );
  check('★ 「名字 :: 事实」被识别成个人记忆', out.memberNotes.length === 2, JSON.stringify(out.memberNotes));
  check('不带名字的仍然进会话记忆', out.notes.length === 1 && out.notes[0].includes('酒馆'), JSON.stringify(out.notes));
  check('记忆行不会发到群里', out.clean.trim() === '好呀～', JSON.stringify(out.clean));
  check(
    '名字和事实都没解析错',
    out.memberNotes[0].name === '老陆' &&
      out.memberNotes[0].fact === '喜欢星穹铁道' &&
      out.memberNotes[1].name === '小雪',
    JSON.stringify(out.memberNotes),
  );

  const { parseControlCommand, createSwitch } = await import('../src/switch.mjs');
  check('认得出"静音"', parseControlCommand('静音')?.kind === 'pause');
  check(
    '认得出"闭嘴 10分钟"并解析时长',
    parseControlCommand('闭嘴 10分钟')?.minutes === 10,
    JSON.stringify(parseControlCommand('闭嘴 10分钟')),
  );
  check('认得出"暂停1小时"', parseControlCommand('暂停1小时')?.minutes === 60, JSON.stringify(parseControlCommand('暂停1小时')));
  check('认得出"恢复"', parseControlCommand('恢复')?.kind === 'resume');
  check('闲聊不会被误判成指令（"早点休息"）', parseControlCommand('早点休息') === null);

  const sfile = path.join(os.tmpdir(), `bigfish-switch-${Date.now()}.json`);
  const sw = createSwitch({ file: sfile });
  check('默认是"会说话"', sw.status().paused === false);
  sw.pause({ minutes: 30, by: '测试' });
  check(
    '★ 暂停后 isPaused 为真',
    sw.isPaused() === true && sw.status().remainingMinutes > 0,
    JSON.stringify(sw.status()),
  );
  sw.resume({ by: '测试' });
  check('恢复后不再暂停', sw.isPaused() === false);
  sw.pause({ minutes: 0.0001, by: '测试' }); // 极短，等于立刻到期
  await new Promise((r) => setTimeout(r, 60));
  check('★ 到点会自动恢复（不会一直哑着）', sw.isPaused() === false);
  sw.pause({ minutes: 0, by: '测试' });
  check('传 0 表示一直暂停到手动恢复', sw.status().forever === true);
  sw.resume();
  fs.rmSync(sfile, { force: true });
}

// ─────────────────── 15. 不许空行分段（"次次三段"太刻意） ───────────────────
console.log('\n【15】回复不许空行分段');
{
  const { sanitizeReply } = await import('../src/text.mjs');

  const a = sanitizeReply('不是呀，我是鲸鱼。\n\n怎么突然问这个？');
  check('★ 空行分段被合并成一句', !/\n/.test(a) && a.includes('我是鲸鱼'), JSON.stringify(a));

  const b = sanitizeReply('还行呀，瘫了一天\n\n中午想吃炸鸡\n\n你呢');
  check('★ 三段合并成一句，且缺标点处补了逗号', !/\n/.test(b) && b.includes('，'), JSON.stringify(b));
  check('合并后不该有连着两个逗号', !/，，/.test(b), JSON.stringify(b));

  const c = sanitizeReply('```js\nconst a = 1;\n\nconsole.log(a);\n```');
  check('代码块里的换行不受影响', /\n/.test(c) && c.includes('const a = 1;'), JSON.stringify(c));

  const d = sanitizeReply('在呀');
  check('本来就一句话的不会被改坏', d === '在呀', JSON.stringify(d));
}

// ─────────────────── 16. 联网之后：markdown 链接要变成 QQ 能看的样子 ───────────────────
console.log('\n【16】联网搜索带来的 markdown 残留');
{
  const { sanitizeReply } = await import('../src/text.mjs');
  const a = sanitizeReply('北京今天晴，22℃。[中国天气网](http://bj.weather.com.cn/a.html)');
  check(
    '★ markdown 链接被转成纯文本（QQ 不渲染 md）',
    !a.includes('](') && a.includes('中国天气网') && a.includes('http'),
    JSON.stringify(a),
  );
  const b = sanitizeReply('看这个 <https://example.com/x>');
  check('尖括号包住的网址去掉了尖括号', b === '看这个 https://example.com/x', JSON.stringify(b));
  const c = sanitizeReply('**重点**：版本是 4.6');
  check('粗体标记照旧被去掉', c === '重点：版本是 4.6', JSON.stringify(c));
  const d = sanitizeReply('就是普通一句话，没有链接');
  check('普通回复不受影响', d === '就是普通一句话，没有链接', JSON.stringify(d));
}

console.log(`\n=== 结果：${pass} 项通过，${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
