#!/usr/bin/env node
/**
 * QQ 大肥鱼机器人 —— 入口。
 *
 * 用法：
 *   node src/index.mjs                 # 按 config/bot.config.json 连接 QQ（OneBot v11）
 *   node src/index.mjs --console       # 不连 QQ，直接在终端里和大肥鱼聊天（调人设最方便）
 *   node src/index.mjs --check         # 只做自检：配置 + 人设 + DSH 运行时握手
 *   node src/index.mjs --config <路径> # 指定别的配置文件
 *   node src/index.mjs --log-level debug
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona } from './config.mjs';
import { loadDotEnv } from './env.mjs';
import { createLogger } from './log.mjs';
import { DshRuntime, resolveDshBin } from './dsh-runtime.mjs';
import { checkApiKey } from './api-key.mjs';
import { createBot } from './service.mjs';
import { createStateStore, makeRunToken, pruneStaleSessions, pruneOldAttachments } from './state.mjs';
import { createSwitch } from './switch.mjs';
import { buildPokeText } from './onebot.mjs';
import { acquireSingleInstance } from './single-instance.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

function parseArgs(argv) {
  const out = { console: false, check: false, config: 'config/bot.config.json', logLevel: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--console' || a === '-c') out.console = true;
    else if (a === '--check') out.check = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--log-level') out.logLevel = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node src/index.mjs [--console] [--check] [--config <path>] [--log-level <level>]\n',
      );
      process.exit(0);
    }
  }
  return out;
}

const maskKey = (k) => (k ? `${k.slice(0, 8)}${'*'.repeat(Math.max(0, k.length - 12))}${k.slice(-4)}` : '(未设置)');

/** 日志里把一条消息描述清楚：不要动不动就写"(非文字)"，那对排查毫无帮助。 */
function describeIncoming(msg) {
  if (msg.text) return msg.text.slice(0, 100);
  const bits = [];
  if (msg.images) bits.push(`图片×${msg.images}${msg.stickers ? `(其中表情包×${msg.stickers})` : ''}`);
  if (msg.faces) bits.push(`QQ表情×${msg.faces}`);
  if (msg.bigFaces) bits.push(`大表情×${msg.bigFaces}`);
  if (msg.hasVideo) bits.push('视频');
  if (msg.hasFile) bits.push('文件');
  if (msg.hasForward) bits.push('合并转发');
  if (Array.isArray(msg.unknownSegments) && msg.unknownSegments.length) {
    bits.push(`未知段[${msg.unknownSegments.join(',')}]`);
  }
  return bits.length ? `（${bits.join('，')}）` : '（空消息）';
}

async function main() {  const args = parseArgs(process.argv.slice(2));
  loadDotEnv(path.join(projectDir, '.env'));

  const config = loadConfig(projectDir, args.config);
  if (args.logLevel) config.logging.level = args.logLevel;
  const persona = loadPersona(config);

  const logger = createLogger({
    level: config.logging.level,
    file: config.logging.absoluteFile,
    scope: args.console ? 'console' : 'bot',
  });

  logger.info('=== QQ 大肥鱼机器人 ===');
  logger.info(`配置文件：${config.__path}`);
  logger.info(`DSH_HOME：${config.dsh.absoluteHome}`);
  logger.info(`模型：${config.dsh.provider} / ${config.dsh.model}（reasoning=${config.dsh.reasoningEffort || '默认'}）`);
  logger.info(`API Key：${maskKey(process.env.DEEPSEEK_API_KEY)}`);
  logger.info(`人设：${path.basename(config.dsh.absolutePersona)}（${persona.length} 字）`);
  logger.info(
    `群聊策略：group=${config.trigger.group}｜selfDecide=${config.trigger.selfDecide}` +
      `｜活跃度=${config.trigger.replyChance}｜冷场间隔=${config.limits.afterReplyCooldownMs}ms` +
      `｜免打扰群=${config.trigger.mutedGroups.length ? config.trigger.mutedGroups.join(',') : '无'}`,
  );
  logger.info(
    config.learning && config.learning.enabled
      ? `从群聊学习：每 ${config.learning.everyMessages} 条消息提炼一次`
      : '从群聊学习：已关闭',
  );

  // 本次进程的唯一标识：DSH 的 SDK 服务端无法接管已存在的会话，会话 id 必须每次启动都不同
  const runToken = makeRunToken();

  // 聊天记忆（跨重启）：DSH 会话每次都是新的，真正的上下文靠这份落盘记录
  const state = createStateStore({
    file: config.memory.enabled ? config.memory.absoluteFile : null,
    logger: logger.child('memory'),
    enabled: config.memory.enabled,
    maxChats: config.memory.maxChats,
    maxPerChat: config.memory.maxPerChat,
  });
  state.load();

  // 「快速停止」开关：让她闭嘴但不杀进程。老板在 QQ 上说"静音/闭嘴"或双击 pause.cmd 都能触发。
  const control = createSwitch({
    file: path.join(path.dirname(config.memory.absoluteFile), 'paused.json'),
    logger: logger.child('switch'),
  });
  {
    const st = control.status();
    if (st.paused) {
      logger.warn(
        st.forever
          ? '当前处于【暂停】状态（只记不回），要恢复：QQ 里对她说"恢复"，或双击 resume.cmd'
          : `当前处于【暂停】状态（只记不回），${st.untilText} 自动恢复；也可双击 resume.cmd`,
      );
    }
  }

  if (config.dsh.pruneStaleSessions) {
    const pruned = pruneStaleSessions({
      sessionsRoot: path.join(config.dsh.absoluteHome, 'sessions'),
      prefix: config.dsh.sessionPrefix,
      keepRunToken: runToken,
      logger: logger.child('memory'),
    });
    if (pruned.scanned > 0) {
      logger.info(
        `清理上一次运行的 DSH 会话：删除 ${pruned.removed}/${pruned.scanned} 条（这些会话无法被接管，已无用）` +
          (pruned.skippedFresh ? `，跳过 ${pruned.skippedFresh} 条最近仍在使用的` : ''),
      );
    }
  }

  // 图片附件会一直攒着不自动删，这里顺手清掉过了保质期的（默认 7 天）。
  // 安全前提：附件只被 DSH 会话日志引用，而会话是每次启动都换新的、旧的已清空；
  // 大肥鱼真正的记忆在 state/memory.json 里，不含附件。
  const keepDays = Number(config.images && config.images.pruneKeepDays);
  if (config.images && config.images.enabled === true && Number.isFinite(keepDays) && keepDays > 0) {
    const att = pruneOldAttachments(path.join(config.dsh.absoluteHome, 'attachments'), {
      keepDays,
      logger: logger.child('media'),
    });
    if (att.removed) {
      logger.info(
        `清理过期图片附件：删除 ${att.removed} 个（释放 ${(att.freedBytes / 1048576).toFixed(1)} MB），保留最近 ${keepDays} 天`,
      );
    }
  }

  const dshBin = resolveDshBin(config.dsh.bin || undefined, projectDir);

  const runtime = new DshRuntime({
    dshBin,
    dshHome: config.dsh.absoluteHome,
    projectDir,
    profile: config.dsh.profile,
    provider: config.dsh.provider,
    model: config.dsh.model,
    reasoningEffort: config.dsh.reasoningEffort || null,
    maxTokens: config.dsh.maxTokens || null,
    apiKey: process.env.DEEPSEEK_API_KEY,
    persona,
    logger: logger.child('dsh'),
    initializeTimeoutMs: config.dsh.initializeTimeoutMs,
    turnTimeoutMs: config.dsh.turnTimeoutMs,
  });
  runtime.on('crashed', () => logger.warn('DSH 运行时崩溃，正在自动重启…'));

  await runtime.start();
  logger.info('DSH 运行时已就绪');

  // 开机自检 Key 是否还有效。走 /models 接口，**不花 token**、一两秒就回来。
  // 为什么需要：Key 失效（被吊销/过期/欠费）时，SDK 不会在启动时报错，
  // 而是等到有人跟她说话才失败，且表现为"她不吭声"——很容易被当成程序坏了。
  const keyOk = await checkApiKey(logger);

  if (args.check) {
    if (keyOk === false) {
      logger.error('自检未通过：API Key 无效（其余部分正常）。');
      state.flush();
      await runtime.stop();
      logger.close();
      process.exitCode = 1;
      return;
    }
    logger.info('自检通过：配置、人设、DSH 运行时握手、API Key 全部正常。');
    state.flush();
    await runtime.stop();
    logger.close();
    return;
  }

  if (args.console) {
    await runConsole({ config, logger, runtime, state, runToken, control });
    return;
  }

  await runQq({ config, logger, runtime, projectDir, state, runToken, control });
}

/** 终端聊天模式：用来调人设，不碰 QQ。 */
async function runConsole({ config, logger, runtime, state, runToken, control = null }) {
  let seq = 0;
  const bot = createBot({
    config,
    logger: logger.child('bot'),
    runtime,
    state,
    runToken,
    send: async (_msg, text) => {
      process.stdout.write(`\n\x1b[36m大肥鱼:\x1b[0m ${text}\n> `);
    },
  });

  process.stdout.write(
    '\n进入终端聊天模式（不连接 QQ）。直接输入消息回车；输入 /quit 退出，/stats 看统计。\n> ',
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      process.stdout.write('> ');
      continue;
    }
    if (text === '/quit' || text === '/exit') break;
    if (text === '/stats') {
      process.stdout.write(`${JSON.stringify(bot.snapshot(), null, 2)}\n> `);
      continue;
    }
    seq += 1;
    await bot.handleMessage({
      messageId: `console-${seq}`,
      kind: 'private',
      subType: 'friend',
      selfId: 'console',
      userId: 'console-user',
      groupId: null,
      senderName: '你',
      text,
      atSelf: false,
      atAll: false,
      images: 0,
      raw: {},
      time: Date.now(),
    });
    process.stdout.write('> ');
  }

  await runtime.stop();
  state.flush();
  logger.close();
  process.exit(0);
}

/** 真实 QQ 模式。 */
async function runQq({ config, logger, runtime, projectDir, state, runToken, control = null }) {
  // 单实例保护：多个启动入口（计划任务/桌面快捷方式/手敲命令）同时跑会导致双回复
  const lock = acquireSingleInstance(path.join(config.memory.absoluteFile ? path.dirname(config.memory.absoluteFile) : projectDir, 'bot.lock'));
  if (!lock) {
    logger.error(
      '已经有一个大肥鱼在跑了，本次启动直接退出。\n' +
        '同一时间只能跑一个实例，否则同一条消息会被回复两次。\n' +
        '如果你确认没有别的实例在跑，删掉 state/bot.lock 再试。',
    );
    state.flush();
    await runtime.stop();
    logger.close();
    process.exit(3);
  }
  if (lock.stole) logger.warn('发现上次崩溃留下的锁文件，已接管（说明上次是异常退出）');

  const { OneBotClient } = await import('./onebot.mjs');

  if (config.onebot.mode === 'reverse') {
    logger.error(
      '当前版本只实现了 forward（正向 WebSocket）模式。\n' +
        '请在 NapCat 里开启「正向 WebSocket」（网络配置 → 添加 → WebSocket 服务端），\n' +
        `并把 config/bot.config.json 的 onebot.mode 改回 "forward"、url 指向 ${config.onebot.url}。`,
    );
    await runtime.stop();
    logger.close();
    process.exit(2);
  }

  const client = new OneBotClient({
    url: config.onebot.url,
    accessToken: config.onebot.accessToken,
    logger: logger.child('onebot'),
    // 退避上限压到 10 秒：默认 30 秒在「NapCat 重扫二维码后才起来」这种场景下
    // 会让人干等半分钟才恢复，容易误以为坏了。
    maxReconnectDelayMs: 10000,
  });

  // 账号保险：expectSelfId 填了小号之后，一旦 NapCat 登录的不是它，
  // 我们一条都不回，并且大声报警。防止「快速登录」把主号登进去。
  const expectedSelfId = String(config.onebot.expectSelfId || '').trim();
  let wrongAccountReported = false;

  const accountMismatch = () => {
    if (!expectedSelfId) return false;
    if (client.selfId == null) return false; // 还不知道登录号，先放行
    return String(client.selfId) !== expectedSelfId;
  };

  const reportWrongAccount = () => {
    if (wrongAccountReported) return;
    wrongAccountReported = true;
    logger.error(
      `⚠️ 账号不匹配！NapCat 当前登录的是 ${client.selfId}，` +
        `但配置里 onebot.expectSelfId = ${expectedSelfId}。` +
        `机器人已拒绝回复任何消息——请去 NapCat 换回正确的号，或把 expectSelfId 改对。`,
    );
  };

  let closeCount = 0;
  client.on('open', () => {
    logger.info(`已连接 OneBot：${config.onebot.url}（登录号 ${client.selfId ?? '未知'}）`);
    if (expectedSelfId) logger.info(`账号校验已开启：只接受 ${expectedSelfId}`);
    closeCount = 0;
  });

  // 断线次数多了就给个明确的排查方向。
  // 无窗口模式下，NapCat 需要重新扫码时表现就是「一直连不上」，很容易被误判成程序坏了。
  client.on('close', () => {
    closeCount += 1;
    logger.warn(`OneBot 连接断开，等待自动重连…（第 ${closeCount} 次）`);
    if (closeCount === 4) {
      logger.error(
        '连续连不上 NapCat，最常见的原因是它还没登录 / 需要重新扫码。请检查：\n' +
          `  1) NapCat 是否在跑（WebUI: http://127.0.0.1:6099/webui）\n` +
          `  2) 是否需要重新扫码 —— 二维码在 D:\\NapCat\\napcat\\cache\\qrcode.png，用手机 QQ 打开扫\n` +
          `  3) 3001 端口是否在监听（登录成功后 OneBot 适配器才会启动）`,
      );
    }
  });
  client.on('error', (err) => logger.warn(`OneBot 错误：${err?.message || err}`));

  const groupNameCache = new Map();
  // 拍一拍的事件里只有 QQ 号、没有昵称，用这个接口补齐（带缓存；拍一拍不常见）
  const memberNameCache = new Map();
  async function resolveMemberName(groupId, userId) {
    if (!groupId || !userId) return null;
    const key = `${groupId}:${userId}`;
    if (memberNameCache.has(key)) return memberNameCache.get(key);
    try {
      const info = await client.call('get_group_member_info', {
        group_id: Number(groupId),
        user_id: Number(userId),
        no_cache: false,
      });
      const name = info && (info.card || info.nickname);
      if (name) {
        memberNameCache.set(key, String(name));
        return String(name);
      }
    } catch (err) {
      logger.debug(`取群成员名字失败（${groupId}/${userId}）：${err.message}`);
    }
    return null;
  }

  const bot = createBot({
    config,
    logger: logger.child('bot'),
    runtime,
    state,
    runToken,
    control: null, // 控制台模式不受暂停开关影响，不然调试时会莫名其妙"她不说话"
    resolveGroupName: async (groupId) => {
      if (groupNameCache.has(groupId)) return groupNameCache.get(groupId);
      try {
        const info = await client.call('get_group_info', { group_id: Number(groupId) });
        const name = info?.group_name || null;
        if (name) groupNameCache.set(groupId, name);
        return name;
      } catch {
        return null;
      }
    },
    resolveImageUrl: async (file) => {
      // NapCat 默认 enableLocalFile2Url=false，图片段里可能没有可用 url。
      // 这时用 OneBot 的 get_image 接口，拿 file 换一个能下载的地址。
      const r = await client.getImage(file);
      const url = (r && (r.url || r.file)) || null;
      return url && /^https?:\/\//i.test(url) ? url : null;
    },
    send: async (msg, text) => {
      if (msg.kind === 'group') await client.sendGroupMsg(msg.groupId, text);
      else await client.sendPrivateMsg(msg.userId, text);
    },
  });

  client.on('message', (msg) => {
    if (accountMismatch()) {
      reportWrongAccount();
      return;
    }

    // 拍一拍：事件里只有 QQ 号，先把名字补上再重建那句话，
    // 否则她只会说"10001 拍了拍你"。
    if (msg.isPoke && msg.poke) {
      void (async () => {
        if (msg.kind === 'group') {
          const from = await resolveMemberName(msg.groupId, msg.poke.fromId);
          if (from) msg.poke.fromName = from;
          if (!msg.poke.atSelf) {
            const to = await resolveMemberName(msg.groupId, msg.poke.toId);
            if (to) msg.poke.toName = to;
          }
        }
        msg.senderName = msg.poke.fromName || msg.senderName;
        msg.text = buildPokeText(msg.poke);
        if (config.logging.logMessages) {
          logger.info(
            `收到 拍一拍 ${msg.kind === 'group' ? `群 ${msg.groupId}` : '私聊'}：${msg.text}` +
              `${msg.atSelf ? '（拍的是我）' : ''}`,
          );
        }
        try {
          const res = await bot.handleMessage(msg);
          if (!res.replied) logger.debug(`未回复（${res.reason}）`);
        } catch (err) {
          logger.error('处理拍一拍时异常：', err.stack || err.message);
        }
      })();
      return;
    }

    if (config.trigger.ignoreSelf && client.selfId != null && String(msg.userId) === String(client.selfId)) {
      logger.debug('忽略自己发的消息');
      return;
    }
    if (config.logging.logMessages) {
      logger.info(
        `收到 ${msg.kind === 'group' ? `群 ${msg.groupId}` : '私聊'} ${msg.senderName}(${msg.userId})` +
          `${msg.atSelf ? ' [@我]' : ''}：${describeIncoming(msg)}`,
      );
    }
    bot
      .handleMessage(msg)
      .then((res) => {
        if (!res.replied) logger.debug(`未回复（${res.reason}）`);
      })
      .catch((err) => logger.error('处理消息时异常：', err.stack || err.message));
  });

  client.on('meta', (meta) => {
    logger.debug(`元事件：${meta.meta_event_type || meta.post_type}`);
  });

  await client.connect();
  logger.info('机器人已启动，等待消息…（Ctrl+C 退出）');

  // 登录号是异步补齐的（lifecycle 元事件 / get_login_info），稍后再明确核对一次
  const verifyTimer = setTimeout(() => {
    if (client.selfId == null) {
      logger.warn('仍未取得登录号——请确认 NapCat 里已经登录了 QQ');
    } else if (expectedSelfId && String(client.selfId) !== expectedSelfId) {
      reportWrongAccount();
    } else {
      logger.info(`登录号已确认：${client.selfId}${expectedSelfId ? '（与 expectSelfId 一致）' : ''}`);
    }
  }, 3000);
  if (typeof verifyTimer.unref === 'function') verifyTimer.unref();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭…`);
    try {
      client.close();
    } catch {
      /* ignore */
    }
    try {
      await runtime.stop();
    } catch {
      /* ignore */
    }
    try {
      state.flush();
    } catch {
      /* ignore */
    }
    try {
      lock.release();
    } catch {
      /* ignore */
    }
    logger.info(`运行统计：${JSON.stringify(bot.snapshot())}`);
    logger.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 异常：', err?.stack || String(err)));
  process.on('uncaughtException', (err) => logger.error('未捕获异常：', err?.stack || String(err)));

  // 保活：让 main() 不返回
  await new Promise(() => {});
}

main().catch((err) => {
  process.stderr.write(`启动失败：${err?.stack || err?.message || err}\n`);
  process.exit(1);
});
