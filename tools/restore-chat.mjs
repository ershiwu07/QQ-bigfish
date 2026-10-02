/**
 * 从 NapCat 的历史记录里恢复某段对话到记忆里。
 *
 * 为什么能救回来：机器人自己删掉的是**它的记忆**，但 NapCat 那边还存着聊天记录
 * （OneBot 的 get_friend_msg_history / get_group_msg_history），而且**没有截断**——
 * 比 logs/bot.log 里那份（回复被截到 80 字）完整得多。
 *
 * 用法:
 *   node tools/restore-chat.mjs --user 10001            恢复和这个人的私聊
 *   node tools/restore-chat.mjs --user 10001 --count 60 取多少条（默认 60）
 *   node tools/restore-chat.mjs --group 20001            恢复某个群的对话流水
 *
 * 只动 chats[<会话>].recent 这一个字段，别的会话、长期记忆、成员档案一律不碰。
 * 必须先停机器人（运行中的进程会用内存里的旧数据覆盖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const config = loadConfig(root, 'config/bot.config.json');

const argv = process.argv.slice(2);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const userId = valOf('--user');
const groupId = valOf('--group');
const count = Number(valOf('--count') || 60);
// --since "2026-10-01 19:17"：只恢复这个时间点之后的（本地时间）
const sinceRaw = valOf('--since');
const since = sinceRaw ? new Date(sinceRaw).getTime() : 0;
if (sinceRaw && !Number.isFinite(since)) {
  console.error(`✗ --since 的时间看不懂：${sinceRaw}（写成 2026-10-01 19:17 这样）`);
  process.exit(1);
}

if (!userId && !groupId) {
  console.error('用法: node tools/restore-chat.mjs --user <QQ号> [--count 60]');
  console.error('      node tools/restore-chat.mjs --group <群号> [--count 60]');
  process.exit(1);
}

// 机器人必须在停着的状态
const lockFile = path.join(root, 'state', 'bot.lock');
if (fs.existsSync(lockFile) && !argv.includes('--force')) {
  const pid = Number(String(fs.readFileSync(lockFile, 'utf8')).trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  if (alive) {
    console.error(`✗ 机器人还在运行（PID ${pid}）——先执行 node tools/stop.mjs，否则它会把恢复的内容盖掉。`);
    process.exit(1);
  }
}

const chatKey = groupId ? `group:${groupId}` : `private:${userId}`;

// ── 连 NapCat 拉历史 ──
const ws = new WebSocket(config.onebot.url || 'ws://127.0.0.1:3001');
let seq = 0;
const pending = new Map();
const call = (action, params) =>
  new Promise((resolve, reject) => {
    const echo = `rs-${++seq}`;
    pending.set(echo, { resolve, reject });
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }
    }, 20000);
  });
ws.addEventListener('message', (ev) => {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }
  const p = pending.get(m.echo);
  if (!p) return;
  pending.delete(m.echo);
  if (m.status === 'failed' || m.retcode !== 0) p.reject(new Error(m.wording || m.message || '接口失败'));
  else p.resolve(m.data);
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('连不上 NapCat')), { once: true });
});

let history = [];
try {
  const data = groupId
    ? await call('get_group_msg_history', { group_id: Number(groupId), count })
    : await call('get_friend_msg_history', { user_id: Number(userId), count });
  history = data?.messages || data || [];
} catch (err) {
  console.error(`✗ 拉历史失败：${err.message}`);
  process.exit(1);
}
ws.close();
if (!Array.isArray(history) || !history.length) {
  console.error('✗ 这段历史在 NapCat 那边也是空的（可能过期了）。');
  process.exit(1);
}
console.log(`从 NapCat 拿到 ${history.length} 条历史`);

/** 把 OneBot 的 message 段转成记忆里存的纯文本（跟正常收消息时一致的形态） */
function toText(raw) {
  if (!Array.isArray(raw)) return String(raw || '').trim();
  let text = '';
  let hadImage = false;
  for (const seg of raw) {
    const d = seg && seg.data ? seg.data : {};
    if (seg?.type === 'text') text += d.text || '';
    else if (seg?.type === 'image') hadImage = true;
    else if (seg?.type === 'face') text += ''; // 表情不进文本（记忆里没必要还原）
  }
  text = text.trim();
  if (!text && hadImage) return '(图片)';
  return text;
}

const selfId = String(config.onebot.expectSelfId || '');
const meName = config.bot && config.bot.selfName ? config.bot.selfName : '大肥鱼';

const entries = [];
let skippedByTime = 0;
for (const m of history) {
  const senderId = String(m.sender?.user_id ?? m.user_id ?? '');
  const isMe = selfId && senderId === selfId;
  const text = toText(m.message ?? m.raw_message);
  const time = Number(m.time) > 0 ? Number(m.time) * 1000 : Date.now();
  if (since && time < since) {
    skippedByTime += 1;
    continue;
  }
  if (!text && !isMe) continue;
  entries.push({
    // 注意字段名要和 state.mjs 的存储格式一致（紧凑写法 n/t/ts/toMe），
    // 写成 name/text 的话读出来是空的——踩过这个坑。
    n: isMe ? meName : m.sender?.card || m.sender?.nickname || senderId,
    t: text || '(空消息)',
    ts: time,
    toMe: isMe ? 0 : 1,
  });
}

// 只保留最后 maxPerChat 条（和正常运行时一致）
const cap = Number(config.memory.maxPerChat) || 40;
const kept = entries.slice(-cap);
if (since) {
  console.log(`时间过滤：${new Date(since).toLocaleString('zh-CN')} 之后，跳过 ${skippedByTime} 条更早的`);
  if (entries.length > cap) {
    console.log(`⚠ 窗口内 ${entries.length} 条超过记忆上限 ${cap}，只存最后 ${cap} 条。`);
    console.log(`  想全留住就把 config/bot.config.json 的 memory.maxPerChat 调大（它不影响每轮提示词大小）。`);
  }
}

const memFile = config.memory.absoluteFile;
const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
if (!data.chats) data.chats = {};
const before = data.chats[chatKey]?.recent?.length || 0;
data.chats[chatKey] = { ...(data.chats[chatKey] || {}), recent: kept, updatedAt: Date.now() };
fs.writeFileSync(memFile, JSON.stringify(data), 'utf8');

console.log(`\n✓ 已写入 ${chatKey}：对话记录 ${before} 条 → ${kept.length} 条（上限 ${cap}）`);
console.log(`  长期记忆、成员档案、其它会话一律没动。`);
console.log('\n恢复的最后几条：');
for (const e of kept.slice(-6)) {
  console.log(`  ${e.n}: ${e.t.replace(/\n/g, ' ').slice(0, 70)}`);
}
console.log('\n记得重新启动： wscript.exe run-hidden.vbs');
