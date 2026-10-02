/**
 * 一条命令看清「它到底有没有在跑」。
 *
 * 用法: node tools/status.mjs     或者直接双击项目根目录的 status.cmd
 *
 * 只看真正说明问题的东西：
 *   · 机器人进程还活着吗（读 state/bot.lock 里的 PID，再探测它是否还在）
 *   · OneBot 端口 3001 通不通（直接 TCP 连一下，不依赖任何外部命令）
 *   · NapCat 登录成功没有（读它自己的控制台日志）
 *   · 最近有没有告警/报错、最后一次回复是什么时候
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const napcatLog = 'D:\\NapCat\\napcat-console.log';

const OK = '[ OK ]';
const BAD = '[ !! ]';
const INFO = '[ -- ]';
let problems = 0;

const say = (mark, label, detail = '') => {
  if (mark === BAD) problems += 1;
  console.log(`${mark} ${label.padEnd(16, ' ')} ${detail}`);
};

/** 直接 TCP 连一下端口，比查进程表可靠：端口通 = 服务真的在听 */
function portOpen(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // 存在但没权限（也算活着）
  }
}

function tailLines(file, n) {
  try {
    const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    return all.filter((l) => l.trim()).slice(-n);
  } catch {
    return [];
  }
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

console.log(`\n===== 大肥鱼 状态检查  ${new Date().toLocaleString('zh-CN')} =====\n`);

// 1) 机器人进程
const lockFile = path.join(root, 'state', 'bot.lock');
let botPid = null;
if (fs.existsSync(lockFile)) {
  botPid = Number(String(fs.readFileSync(lockFile, 'utf8')).trim());
  if (Number.isFinite(botPid) && pidAlive(botPid)) {
    say(OK, '机器人进程', `PID ${botPid} 运行中`);
  } else {
    say(BAD, '机器人进程', `锁文件里的 PID ${botPid} 已经不在了（程序没在跑）`);
  }
} else {
  say(BAD, '机器人进程', '没有 state/bot.lock —— 程序没在跑');
}

// 2) OneBot 端口
const port = 3001;
const open = await portOpen(port);
if (open) say(OK, `端口 ${port}`, 'NapCat 的 OneBot 服务在监听');
else say(BAD, `端口 ${port}`, '连不上 —— NapCat 多半没登录成功（没登录就不会开这个端口）');

// 3) NapCat 登录状态（看它自己的日志最后怎么说的）
const nap = tailLines(napcatLog, 400).map(strip);
const lastLoginOk = [...nap].reverse().find((l) => /登录成功|已登录|正常重试策略/.test(l));
const lastLoginBad = [...nap].reverse().find((l) => /快速登录错误|登录失败|Login Error|需要验证码|需要新设备验证/.test(l));
const qrPending = [...nap].reverse().find((l) => /二维码已保存到/.test(l));
if (lastLoginOk && (!lastLoginBad || nap.lastIndexOf(lastLoginOk) > nap.lastIndexOf(lastLoginBad))) {
  say(OK, 'QQ 登录', lastLoginOk.slice(0, 90));
} else if (qrPending) {
  say(BAD, 'QQ 登录', '正在等扫码 —— 二维码在 D:\\NapCat\\napcat\\cache\\qrcode.png（每约 2 分钟换一张）');
} else if (lastLoginBad) {
  say(BAD, 'QQ 登录', lastLoginBad.slice(0, 90));
} else {
  say(INFO, 'QQ 登录', '日志里没有明确的登录记录');
}

// 4) 机器人日志：最近的告警 + 最后一次回复
const botLog = path.join(root, 'logs', 'bot.log');
const botAll = tailLines(botLog, 400).map(strip);
// 只看「本次启动」之后的日志。否则会把上次运行遗留的重试也数进来，
// 数字大得吓人（"重试 357 条"），其实早就连上了 —— 那就成了狼来了。
const startMarks = botAll.map((l, i) => (/\[bot\] DSH_HOME：/.test(l) ? i : -1)).filter((i) => i >= 0);
const bot = startMarks.length ? botAll.slice(startMarks[startMarks.length - 1]) : botAll;
// 「连接失败（第 N 次）」是 NapCat 还没起来时的正常重试；
// 「发现上次崩溃留下的锁文件」是关机硬终止进程的必然结果（单实例保护会接管）。
// 这两种都不算故障，单独说明，免得吓人。
const retries = bot.filter((l) => /连接失败（第 \d+ 次）/.test(l));
const staleLock = bot.filter((l) => /发现上次崩溃留下的锁文件/.test(l));
const recentWarn = bot.filter(
  (l) => /\[WARN|\[ERROR/.test(l) && !/连接失败（第 \d+ 次）/.test(l) && !/发现上次崩溃留下的锁文件/.test(l),
);
const connected = [...bot].reverse().find((l) => /登录号已确认|已连接 OneBot/.test(l));
if (connected) say(OK, '连接记录', connected.slice(0, 90));
const lastReply = [...bot].reverse().find((l) => /回复 (group|private):/.test(l));
if (lastReply) say(INFO, '最后一次回复', lastReply.replace(/^.*回复 /, '').slice(0, 90));
else say(INFO, '最后一次回复', '（这次启动后还没回过话）');

if (retries.length) {
  const last = retries[retries.length - 1];
  const n = (last.match(/第 (\d+) 次/) || [])[1] || '?';
  say(INFO, '连接重试', `最近这段日志里有 ${retries.length} 条（最多到第 ${n} 次）—— NapCat 没起来时出现是正常的`);
}
if (staleLock.length) {
  say(INFO, '上次退出', '检测到上次是硬终止（关机导致），锁文件已被接管 —— 正常现象，不影响运行');
}
if (recentWarn.length) {
  say(BAD, '近期告警', `${recentWarn.length} 条，最后一条：${recentWarn[recentWarn.length - 1].slice(0, 80)}`);
}

// 5) 记忆（含按人的档案）
let pausedNow = false;
try {
  const mem = JSON.parse(fs.readFileSync(path.join(root, 'state', 'memory.json'), 'utf8'));
  const chats = Object.keys(mem.chats || {}).length;
  const notes = Object.values(mem.chats || {}).reduce((n, c) => n + (c.notes?.length || 0), 0);
  const members = Object.values(mem.chats || {}).reduce((n, c) => n + Object.keys(c.members || {}).length, 0);
  const memberFacts = Object.values(mem.chats || {}).reduce(
    (n, c) => n + Object.values(c.members || {}).reduce((k, m) => k + (m.f?.length || 0), 0),
    0,
  );
  say(INFO, '长期记忆', `${chats} 个会话，共 ${notes} 条会话记忆`);
  say(INFO, '认识的人', `${members} 个群成员，${memberFacts} 条关于他们的记忆`);
} catch {
  say(INFO, '长期记忆', '读不到 state/memory.json');
}

// 6) 说话开关（暂停中就不回话，这是最容易让人误以为"坏了"的状态）
try {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'state', 'paused.json'), 'utf8'));
  pausedNow = Boolean(p.paused) && (!p.until || Date.now() < p.until);
  if (pausedNow) {
    const rest = p.until ? Math.max(0, Math.round((p.until - Date.now()) / 60000)) : 0;
    say(INFO, '说话开关', p.until ? `已暂停，约 ${rest} 分钟后自动恢复` : '已暂停（一直暂停到手动恢复）');
  } else {
    say(OK, '说话开关', '正常，会回话');
  }
} catch {
  say(OK, '说话开关', '正常，会回话');
}

console.log('');
if (pausedNow) {
  console.log('注意：她现在被【暂停】了，不会回话（这是你自己设的，不是故障）。');
  console.log('      要恢复：双击 resume.cmd，或者在 QQ 里对她说"恢复"。');
  if (problems > 0) console.log(`      另外还有 ${problems} 项不对，看上面 [ !! ]。`);
} else if (problems === 0) {
  console.log('结论：一切正常，等消息就行。');
} else {
  console.log(`结论：有 ${problems} 项不对，先看上面 [ !! ] 那几行。`);
  console.log('      · 卡在扫码 → 打开 D:\\NapCat\\napcat\\cache\\qrcode.png 用手机 QQ 扫');
  console.log('      · 机器人没在跑 → 双击 start.cmd，或看 logs\\bot.log 末尾');
}
console.log('');
