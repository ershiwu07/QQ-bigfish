/**
 * 一次性给「成员档案」打底：把 NapCat 的群成员名单拉下来填进 memory.json，
 * 并把已有的会话记忆里提到某个人的，复制一份到他名下。
 *
 * 为什么需要：成员档案本来是"谁说话就记谁"，但那样她要等群里一个个开口才认识人，
 * 而且已经攒下来的记忆（"老陆习惯称呼大肥鱼为鱼"）也没挂到人身上，白攒了。
 *
 * 用法: node tools/seed-members.mjs            （机器人运行时也能跑，会自动合并保存）
 *       node tools/seed-members.mjs --dry      只看会改什么，不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createStateStore } from '../src/state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dry = process.argv.includes('--dry');

const config = loadConfig(root, 'config/bot.config.json');
const state = createStateStore({
  file: config.memory.absoluteFile,
  enabled: true,
  maxChats: config.memory.maxChats,
  maxPerChat: config.memory.maxPerChat,
});
state.load();

const raw = JSON.parse(fs.readFileSync(config.memory.absoluteFile, 'utf8'));
const groupKeys = Object.keys(raw.chats || {}).filter((k) => k.startsWith('group:'));

if (!groupKeys.length) {
  console.log('记忆里还没有任何群，先让群里有人说话再来跑这个。');
  process.exit(0);
}

// ── 1) 从 NapCat 拉每个群的成员名单 ──
const wsUrl = config.onebot.url || 'ws://127.0.0.1:3001';
console.log(`连接 NapCat：${wsUrl}`);
const ws = new WebSocket(wsUrl);
let seq = 0;
const pending = new Map();

const call = (action, params) =>
  new Promise((resolve, reject) => {
    const echo = `seed-${++seq}`;
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
  ws.addEventListener('error', () => reject(new Error('连不上 NapCat（它登录了吗？）')), { once: true });
});

let seeded = 0;
let attached = 0;

for (const key of groupKeys) {
  const gid = key.slice('group:'.length);
  let list = [];
  try {
    list = (await call('get_group_member_list', { group_id: Number(gid), no_cache: false })) || [];
  } catch (err) {
    console.log(`  群 ${gid}：拿名单失败（${err.message}），跳过`);
    continue;
  }
  console.log(`  群 ${gid}：${list.length} 个成员`);
  for (const mem of list) {
    const uid = mem.user_id ?? mem.uin;
    if (uid == null) continue;
    if (!dry) {
      const isNew = state.seedMember(key, String(uid), {
        name: mem.nickname || '',
        card: mem.card || '',
      });
      if (isNew) seeded += 1;
    } else {
      seeded += 1;
    }
  }

  // ── 2) 把已有记忆里提到某人的，复制一份到他名下 ──
  const chat = raw.chats[key] || {};
  const notes = Array.isArray(chat.notes) ? chat.notes.map((n) => n.t) : [];
  // 用刚拉到的名单做名字匹配（不依赖 state 的改名逻辑，直接读原始表）
  const byName = new Map();
  for (const mem of list) {
    const uid = mem.user_id ?? mem.uin;
    if (uid == null) continue;
    for (const n of [mem.card, mem.nickname]) {
      const name = String(n || '').trim();
      if (name.length >= 2) byName.set(name, { uid: String(uid), name });
    }
  }
  const hits = [];
  for (const note of notes) {
    for (const [name, info] of byName) {
      if (note.includes(name)) {
        hits.push({ uid: info.uid, fact: note, who: info.name });
        break; // 一条记忆只挂到第一个命中的人，避免一句话挂一堆人
      }
    }
  }
  if (hits.length) {
    console.log(`    已有记忆里能认领的：${hits.length} 条`);
    for (const h of hits) console.log(`      · ${h.who} ← ${h.fact.slice(0, 60)}`);
    if (!dry) {
      for (const h of hits) {
        try {
          attached += state.addMemberFacts(key, h.uid, [h.fact], config.memory.maxFactsPerMember);
        } catch {
          /* 忽略 */
        }
      }
    } else {
      attached += hits.length;
    }
  }
}

if (!dry) state.flush();
ws.close();

console.log(
  `\n${dry ? '（演练模式，没有写文件）' : '完成'}：新增成员 ${seeded} 个，归档记忆 ${attached} 条。`,
);
const st = state.stats();
console.log(`现在记忆里：${st.members} 个成员，${st.memberFacts} 条关于他们的记忆。`);
setTimeout(() => process.exit(0), 300);
