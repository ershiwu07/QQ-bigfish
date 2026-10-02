/**
 * 端到端自测：不连真实 QQ，用模拟 OneBot 服务端 + 真实 DSH 运行时跑通整条链路。
 *
 *   node tools/selftest.mjs
 *
 * 覆盖：
 *   阶段一（真实传输）：mock WS 服务端 → OneBotClient 归一化 → bot → send_group_msg → mock
 *   阶段二（路由矩阵）：私聊 / 群未@ / 群@ / 关键词 / 免打扰群 / @全体 / 重复消息 / 限流
 * 结果写入 tools/selftest-output.txt。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona, deepMerge } from '../src/config.mjs';
import { loadDotEnv } from '../src/env.mjs';
import { checkApiKey } from '../src/api-key.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';
import { createBot } from '../src/service.mjs';
import { createStateStore, makeRunToken } from '../src/state.mjs';
import { OneBotClient } from '../src/onebot.mjs';
import { startMockOneBot, makeGroupMessage } from './mock-onebot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

const out = [];
let passed = 0;
let failed = 0;
const say = (s = '') => {
  out.push(s);
  process.stdout.write(s + '\n');
};
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    say(`  [PASS] ${name}${detail ? `  (${detail})` : ''}`);
  } else {
    failed += 1;
    say(`  [FAIL] ${name}${detail ? `  (${detail})` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 写结果文件；即使文件被别的进程占着（比如你把 stdout 重定向到了同一个文件），也不能让自测崩掉。 */
function writeResultFile() {
  try {
    fs.writeFileSync(path.join(here, 'selftest-output.txt'), out.join('\n'), 'utf8');
  } catch (err) {
    process.stderr.write(`（结果文件写入失败，忽略：${err.message}）\n`);
  }
}

const SELF = '10001';
const MUTED_GROUP = '90002';
const GROUP = '90001';
const GROUP_ALL = '90003';
const USER = '20001';

async function main() {
  loadDotEnv(path.join(projectDir, '.env'));

  // 这是唯一会**真调模型**的测试（其余几个都是纯逻辑，零成本零依赖）。
  // 没有 Key、或者 Key 已经失效时都跳过——否则别人 clone 下来跑 npm test
  // 会看到一堆 turn-error，一头雾水地以为代码坏了。
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('\n跳过端到端自测：没有找到 DEEPSEEK_API_KEY。');
    console.log('  这是唯一需要真调模型的测试（会花一点点钱）。');
    console.log('  想跑的话：复制 .env.example 为 .env，填上 Key，再执行 node tools/selftest.mjs');
    console.log('  不需要 Key 的测试：npm run test:agent / npm run test:onebot / npm run test:unit\n');
    process.exit(0);
  }
  const keyState = await checkApiKey(null);
  if (keyState === false) {
    console.log('\n跳过端到端自测：.env 里的 API Key 无效（已失效/被吊销）。');
    console.log('  代码本身没参与判断——换一个可用的 Key 再跑即可。');
    console.log('  想看详细原因：node src/index.mjs --check\n');
    process.exit(0);
  }

  // 测试专用配置：加入免打扰群、缩短打字延迟、放宽但不取消限流
  const base = loadConfig(projectDir, 'config/bot.config.json');
  const testConfigPath = path.join(here, 'selftest.config.json');
  const baseRaw = JSON.parse(fs.readFileSync(base.__path, 'utf8'));
  const testRaw = deepMerge(baseRaw, {
    trigger: {
      mutedGroups: [MUTED_GROUP],
      // 阶段二测的是「路由规则」本身，不是模型的临场判断。
      // 所以这里故意把它固定回 at_or_keyword 且关掉 selfDecide，
      // 让断言是确定性的；自主判断那套由 tools/test-agent-mode.mjs 覆盖。
      group: 'at_or_keyword',
      selfDecide: false,
      keywords: ['大肥鱼', '肥鱼'],
      ignoreAtAll: false,
      ignoreSelf: true,
    },
    limits: {
      minIntervalPerChatMs: 1500,
      maxRepliesPerChatPerMinute: 20,
      maxRepliesPerChatPerHour: 100,
      globalMaxRepliesPerMinute: 30,
      keywordCooldownMs: 0,
    },
    output: {
      typingDelayMinMs: 80,
      typingDelayMaxMs: 160,
      segmentDelayMinMs: 80,
      segmentDelayMaxMs: 160,
    },
    logging: { level: 'warn', file: null, logMessages: false },
  });
  fs.writeFileSync(testConfigPath, JSON.stringify(testRaw, null, 2), 'utf8');
  const config = loadConfig(projectDir, path.relative(projectDir, testConfigPath));
  const persona = loadPersona(config);

  const logger = createLogger({ level: config.logging.level, scope: 'selftest' });

  say('=== QQ 大肥鱼机器人 · 端到端自测 ===');
  say(`免打扰群（必须完全不回复）：${MUTED_GROUP}`);
  say(`普通群：${GROUP}   另一个群（用于限流对照）：${GROUP_ALL}   私聊用户：${USER}`);
  say('');

  // ---------- 启动 DSH 运行时 ----------
  say('[1/5] 启动 DSH 运行时…');

  // 跨重启记忆：用测试专用记忆文件，先清空以保证断言确定
  const memoryFile = path.join(here, 'selftest-memory.json');
  try {
    fs.rmSync(memoryFile, { force: true });
  } catch {
    /* ignore */
  }
  const state = createStateStore({
    file: memoryFile,
    logger,
    enabled: true,
    maxChats: 50,
    maxPerChat: 40,
    debounceMs: 100,
  });
  state.load();
  const runToken = makeRunToken();

  let runtime = new DshRuntime({
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
  const t0 = Date.now();
  await runtime.start();
  say(`      运行时就绪，握手耗时 ${Date.now() - t0}ms`);
  say('');

  // ---------- 启动模拟 OneBot 服务端 ----------
  say('[2/5] 启动模拟 OneBot 服务端并连接…');
  const mock = await startMockOneBot({ port: 0, logger, selfId: Number(SELF) });
  const client = new OneBotClient({ url: mock.url, accessToken: '', logger, reconnect: false });
  await client.connect();

  const bot = createBot({
    config,
    logger,
    runtime,
    state,
    runToken,
    send: async (msg, text) => {
      if (msg.kind === 'group') await client.sendGroupMsg(msg.groupId, text);
      else await client.sendPrivateMsg(msg.userId, text);
    },
  });

  const inbound = [];
  client.on('message', async (msg) => {
    inbound.push(msg);
    try {
      await bot.handleMessage(msg);
    } catch (err) {
      logger.error('自测处理器异常：', err.message);
    }
  });

  say(`      已连接 ${mock.url}`);
  say('');

  try {
    // ---------- 阶段一：真实传输链路 ----------
    say('[3/5] 阶段一：真实传输链路（mock → OneBotClient → bot → send_group_msg → mock）');
    mock.state.sent.length = 0;
    mock.state.pushMessage(
      makeGroupMessage({
        selfId: SELF,
        userId: USER,
        groupId: GROUP,
        // 注意：makeGroupMessage 默认就带 atSelf（会自己拼 [CQ:at,qq=selfId]）。
        // 这里必须传「用户真正打出来的字」，不要手写 CQ 码——helper 会把用户文本里
        // 的 [ ] 转义成实体，避免用户输入被当成 CQ 码解释。
        text: '在吗',
        senderName: '测试鱼片',
      }),
    );

    let got = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      got = mock.state.sent.find(
        (s) => s.action === 'send_group_msg' && String(s.params.group_id) === GROUP,
      );
      if (got) break;
      await sleep(300);
    }
    check(
      '群 @ 消息能走完真实链路并把回复发进群',
      !!got,
      got ? `${String(got.params.message).length} 字` : '90 秒内没有收到回复',
    );
    if (got) {
      const text = String(got.params.message);
      say(`      ↳ 大肥鱼说：${text.replace(/\n/g, ' / ').slice(0, 200)}`);
      check('回复非空', text.trim().length > 0);
      check('回复不含 Markdown 星号（QQ 不渲染）', !/\*\*/.test(text));
      check('回复没有自我前缀（如「大肥鱼：」）', !/^\s*(大肥鱼|鲸鱼娘)\s*[:：]/.test(text));
    }
    const first = inbound[0];
    check(
      'OneBot 消息归一化正确（kind/atSelf/text/sender）',
      !!first && first.kind === 'group' && first.atSelf === true && first.text === '在吗',
      first
        ? JSON.stringify({ kind: first.kind, atSelf: first.atSelf, text: first.text, sender: first.senderName, images: first.images })
        : '没有收到消息',
    );
    say('');

    // ---------- 阶段二：路由矩阵（构造归一化消息，断言确定性） ----------
    say('[4/5] 阶段二：路由矩阵');
    let seq = 0;
    const nextId = () => `selftest-${++seq}`;
    const gap = config.limits.minIntervalPerChatMs + 250;

    const normPrivate = (text) => ({
      messageId: nextId(),
      kind: 'private',
      subType: 'friend',
      selfId: SELF,
      userId: USER,
      groupId: null,
      senderName: '测试鱼片',
      text,
      atSelf: false,
      atAll: false,
      images: 0,
      raw: {},
      time: Date.now(),
    });
    const normGroup = (groupId, text, { atSelf = false, atAll = false, images = 0 } = {}) => ({
      messageId: nextId(),
      kind: 'group',
      subType: 'normal',
      selfId: SELF,
      userId: USER,
      groupId,
      senderName: '测试鱼片',
      text,
      atSelf,
      atAll,
      images,
      raw: {},
      time: Date.now(),
    });

    await sleep(gap);
    const rPrivate = await bot.handleMessage(normPrivate('你好呀，在忙吗'), { echo: false });
    check('私聊消息 → 回复', rPrivate.replied === true, rPrivate.reason);

    await sleep(gap);
    const rPlain = await bot.handleMessage(normGroup(GROUP, '今天中午吃啥好呢'), { echo: false });
    check('群里既没 @ 也没关键词 → 不回复', rPlain.replied === false, rPlain.reason);

    await sleep(gap);
    const rAt = await bot.handleMessage(normGroup(GROUP, '你看这个 bug 咋回事', { atSelf: true }), { echo: false });
    check('群里 @ 我 → 回复', rAt.replied === true, rAt.reason);

    await sleep(gap);
    const rMuted = await bot.handleMessage(normGroup(MUTED_GROUP, '大肥鱼快出来', { atSelf: true }), { echo: false });
    check(
      '★ 免打扰群即使 @ 我 → 也不回复',
      rMuted.replied === false && rMuted.reason === 'muted-group',
      rMuted.reason,
    );

    await sleep(gap);
    const rKeyword = await bot.handleMessage(normGroup(GROUP, '这事得问大肥鱼才行'), { echo: false });
    check('群里命中关键词 → 回复', rKeyword.replied === true, rKeyword.reason);

    await sleep(gap);
    const dupId = 'dup-fixed-id';
    const rDup1 = await bot.handleMessage({ ...normGroup(GROUP, '重复消息测试', { atSelf: true }), messageId: dupId }, { echo: false });
    const rDup2 = await bot.handleMessage({ ...normGroup(GROUP, '重复消息测试', { atSelf: true }), messageId: dupId }, { echo: false });
    check(
      '同一条消息重复推送 → 只回一次',
      rDup2.replied === false && rDup2.reason === 'duplicate',
      `第一条=${rDup1.replied} 第二条=${rDup2.reason}`,
    );

    await sleep(gap);
    const rAtAll = await bot.handleMessage(normGroup(GROUP_ALL, '全体成员注意', { atAll: true }), { echo: false });
    check('只 @ 全体成员 → 不回复', rAtAll.replied === false && rAtAll.reason === 'at-all', rAtAll.reason);

    // 指名连问：两条都要答上。
    // 注意这里断言的是**新行为** —— 老版本会把第二条当成「太频繁」丢掉，
    // 表现就是群里聊开了它反而接不上（这正是被修掉的 bug）。
    const rAt1 = await bot.handleMessage(normGroup(GROUP_ALL, '连问测试第一条', { atSelf: true }), { echo: false });
    const rAt2 = await bot.handleMessage(normGroup(GROUP_ALL, '连问测试第二条', { atSelf: true }), { echo: false });
    check('指名连问：第一条正常回复', rAt1.replied === true, rAt1.reason);
    check(
      '★ 指名连问：紧接着的第二条也要答上（不再被限流丢掉）',
      rAt2.replied === true,
      rAt2.reason,
    );

    await sleep(gap);
    const rImageOnly = await bot.handleMessage(normGroup(GROUP, '', { atSelf: true, images: 1 }), { echo: false });
    check(
      '群里 @ 我并发了图 → 会处理（识图已开启；此处没有真实图片地址，所以走"看不到内容"分支）',
      rImageOnly.replied === true,
      rImageOnly.reason,
    );

    await sleep(gap);
    const rEmptyAt = await bot.handleMessage(normGroup(GROUP, '', { atSelf: true }), { echo: false });
    check(
      '群里单独 @ 我、没打字 → 会回一句（喊一声应该应）',
      rEmptyAt.replied === true && rEmptyAt.reason === 'group-at-empty',
      rEmptyAt.reason,
    );

    say('');
    say(`机器人统计：${JSON.stringify(bot.snapshot())}`);

    // ---------- 阶段三：重启回归测试 ----------
    // 这一段是必须的：DSH 的 SDK 服务端无法接管已存在的会话，
    // 早期版本用固定 session id，导致「重启一次之后所有老会话全部报错」。
    // 这里显式模拟一次完整重启（换运行时 + 换 runToken），并验证：
    //   1) 老会话不再冲突，能正常回复；
    //   2) 重启前的聊天记忆被保留下来。
    say('');
    say('[5/5] 阶段三：重启回归（换运行时 + 换 runToken，模拟机器人重启）');
    const sentBefore = mock.state.sent.length;
    state.flush();
    await runtime.stop();
    runtime = new DshRuntime({
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
    await runtime.start();

    const state2 = createStateStore({ file: memoryFile, logger, enabled: true, debounceMs: 100 });
    state2.load();
    const runToken2 = makeRunToken();
    const bot2 = createBot({
      config,
      logger,
      runtime,
      state: state2,
      runToken: runToken2,
      send: async (msg, text) => {
        if (msg.kind === 'group') await client.sendGroupMsg(msg.groupId, text);
        else await client.sendPrivateMsg(msg.userId, text);
      },
    });

    const beforeRestart = state2.get(`group:${GROUP}`);
    // 关键断言：记忆里必须有**用户自己**的发言，而不只是大肥鱼的自言自语。
    // （早期版本在回复路径上忘了落盘对方的消息，这里就是它的回归测试。）
    const userMsgs = beforeRestart.filter((m) => m.name === '测试鱼片');
    check(
      '★ 重启前用户的发言被持久化了（不只是大肥鱼自己的回复）',
      userMsgs.some((m) => String(m.text).includes('在吗')),
      `用户发言 ${userMsgs.length} 条 / 共 ${beforeRestart.length} 条`,
    );
    check(
      '重启前大肥鱼的回复也被持久化了',
      beforeRestart.some((m) => m.name === '大肥鱼'),
      `共 ${beforeRestart.length} 条`,
    );

    const rAfterRestart = await bot2.handleMessage(normGroup(GROUP, '重启之后你还记得我们聊过啥吗', { atSelf: true }), {
      echo: false,
    });
    check(
      '★ 重启后同一个群仍能正常回复（不再报 session already exists）',
      rAfterRestart.replied === true,
      rAfterRestart.reason,
    );
    check(
      '★ 重启后新一轮对话同样被写入记忆（不只是重启前那份）',
      state2.get(`group:${GROUP}`).some((m) => String(m.text).includes('重启之后你还记得')),
      `重启后共 ${state2.get(`group:${GROUP}`).length} 条历史`,
    );
    check(
      '重启后仍有新的消息被发出',
      mock.state.sent.length > sentBefore,
      `${sentBefore} → ${mock.state.sent.length}`,
    );
    state2.flush();
  } finally {
    say('');
    say(`=== 结果：${passed} 项通过，${failed} 项失败 ===`);
    writeResultFile();
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      await mock.close();
    } catch {
      /* ignore */
    }
    await runtime.stop().catch(() => {});
    try {
      state.flush();
    } catch {
      /* ignore */
    }
    logger.close();
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 300);
  }
}

main().catch((err) => {
  const msg = `自测崩溃：${err?.stack || err?.message || err}`;
  out.push(msg);
  process.stderr.write(msg + '\n');
  writeResultFile();
  process.exit(1);
});
