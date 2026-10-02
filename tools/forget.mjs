/**
 * 遗忘工具：清掉某段对话或某个人的记忆。**写之前自动备份**，随时能还原。
 *
 * 用法:
 *   node tools/forget.mjs --list                    看看现在记了些什么
 *   node tools/forget.mjs --chat private:10001 清掉这段对话（保留长期记忆）
 *   node tools/forget.mjs --chat private:10001 --all   连长期记忆一起清
 *   node tools/forget.mjs --member 10001       清掉这个人的成员档案（含关于他的记忆）
 *   node tools/forget.mjs --restore <备份文件>       从备份还原
 *
 * 注意：**必须先停机器人**（node tools/stop.mjs）。
 * 运行中的进程把记忆放在内存里，它下一次保存就会把你的修改盖掉。
 *
 * 另外：DSH 的会话历史也要清，否则同一次运行里她还能从会话里看到旧对话。
 * 本工具默认会一并清掉对应的会话目录（--keep-sessions 可跳过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const config = loadConfig(root, 'config/bot.config.json');
const memFile = config.memory.absoluteFile;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};

const list = has('--list');
const chatKey = valOf('--chat');
const memberId = valOf('--member');
const restoreFile = valOf('--restore');
const alsoNotes = has('--all');
const keepSessions = has('--keep-sessions');
const noBackup = has('--no-backup');
// --purge <正则>：按内容擦条目（长期记忆 + 成员档案里的条目）。
// 用途：记忆里攒下了和当前人设矛盾的旧事实（比如"她是个项目"、把某人写成她的主人），
// 整段清太狠，按关键词擦最合适。加 --purge-recent 连对话流水一起擦。
const purgeRe = valOf('--purge');
const purgeRecent = has('--purge-recent');

// ── 前置检查：机器人不能在跑 ──
const lockFile = path.join(root, 'state', 'bot.lock');
if (fs.existsSync(lockFile) && !has('--force')) {
  const pid = Number(String(fs.readFileSync(lockFile, 'utf8')).trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  if (alive) {
    console.error(`✗ 机器人还在运行（PID ${pid}）——它内存里的旧记忆会把这次修改盖掉。`);
    console.error('  先执行： node tools/stop.mjs   然后重跑本命令。');
    process.exit(1);
  }
}

if (!fs.existsSync(memFile)) {
  console.error(`✗ 找不到记忆文件：${memFile}`);
  process.exit(1);
}

const backup = (tag) => {
  if (noBackup) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(path.dirname(memFile), `memory.backup-${stamp}-${tag}.json`);
  fs.copyFileSync(memFile, dest);
  return dest;
};

// ── 还原 ──
if (restoreFile) {
  const src = path.isAbsolute(restoreFile) ? restoreFile : path.join(root, restoreFile);
  if (!fs.existsSync(src)) {
    console.error(`✗ 备份文件不存在：${src}`);
    process.exit(1);
  }
  const before = backup('before-restore');
  fs.copyFileSync(src, memFile);
  console.log(`✓ 已从 ${path.basename(src)} 还原`);
  console.log(`  （还原前的状态备份在 ${path.basename(before)}）`);
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
const chats = data.chats || {};

// ── 列出 ──
if (list || (!chatKey && !memberId && !purgeRe)) {
  console.log(`记忆文件：${memFile}\n`);
  const keys = Object.keys(chats);
  if (!keys.length) console.log('  （空的）');
  for (const k of keys) {
    const c = chats[k] || {};
    const mem = Object.keys(c.members || {}).length;
    const mf = Object.values(c.members || {}).reduce((n, m) => n + (m.f?.length || 0), 0);
    console.log(
      `  ${k.padEnd(24)} 对话 ${String(c.recent?.length || 0).padStart(3)} 条｜长期记忆 ${
        c.notes?.length || 0
      } 条｜成员 ${mem} 个（${mf} 条关于他们）`,
    );
  }
  console.log('\n要清哪一段：node tools/forget.mjs --chat <上面那个 key> [--all]');
  process.exit(0);
}

const jobs = [];
const purged = { notes: 0, facts: 0, recent: 0 };

// ── 按内容擦条目 ──
if (purgeRe) {
  let re;
  try {
    re = new RegExp(purgeRe);
  } catch (err) {
    console.error(`✗ --purge 的正则写错了：${err.message}`);
    process.exit(1);
  }
  console.log(`按内容擦（正则：${purgeRe}）：`);
  for (const [k, c] of Object.entries(chats)) {
    const keepNotes = [];
    for (const n of c.notes || []) {
      if (re.test(n.t || '')) {
        purged.notes += 1;
        console.log(`  · 长期记忆 [${k}] ${String(n.t).slice(0, 80)}`);
      } else keepNotes.push(n);
    }
    c.notes = keepNotes;

    for (const [uid, mem] of Object.entries(c.members || {})) {
      const keepF = [];
      for (const f of mem.f || []) {
        if (re.test(f.t || '')) {
          purged.facts += 1;
          console.log(`  · 档案 [${k}] ${mem.c || mem.n || uid}：${String(f.t).slice(0, 70)}`);
        } else keepF.push(f);
      }
      mem.f = keepF;
    }

    if (purgeRecent) {
      const keepR = [];
      for (const r of c.recent || []) {
        if (re.test(r.t || '')) {
          purged.recent += 1;
        } else keepR.push(r);
      }
      c.recent = keepR;
    }
  }
  console.log(
    `  共擦掉：长期记忆 ${purged.notes} 条、成员档案 ${purged.facts} 条${
      purgeRecent ? `、对话流水 ${purged.recent} 条` : ''
    }`,
  );
}

// ── 清某段对话 ──
if (chatKey) {
  if (!chats[chatKey]) {
    console.error(`✗ 记忆里没有这个会话：${chatKey}`);
    console.error('  先跑 --list 看看有哪些。');
    process.exit(1);
  }
  const c = chats[chatKey];
  console.log(`清 ${chatKey}：`);
  console.log(`  · 对话记录 ${c.recent?.length || 0} 条 → 0`);
  c.recent = [];
  if (alsoNotes) {
    console.log(`  · 长期记忆 ${c.notes?.length || 0} 条 → 0（--all）`);
    c.notes = [];
    for (const m of Object.values(c.members || {})) m.f = [];
  } else if ((c.notes?.length || 0) > 0) {
    console.log(`  · 长期记忆 ${c.notes.length} 条**保留**（要一起清就加 --all）`);
  }
  c.updatedAt = Date.now();
  jobs.push(chatKey);
}

// ── 清某个人的成员档案 ──
if (memberId) {
  const uid = String(memberId);
  let hits = 0;
  for (const [k, c] of Object.entries(chats)) {
    const m = c.members?.[uid];
    if (!m) continue;
    hits += 1;
    const name = m.c || m.n || uid;
    console.log(`清 ${k} 里「${name}」的档案：${m.f?.length || 0} 条关于他的记忆 → 0`);
    delete c.members[uid];
    // 顺手把他的名字从对话记录里擦掉？不擦 —— 那是聊天流水，不是档案。
  }
  if (!hits) console.log(`（没有找到 ${uid} 的成员档案）`);
}

if (!jobs.length && !memberId && !purgeRe) {
  console.error('没指定要清什么。用 --list / --chat / --member / --purge。');
  process.exit(1);
}

const backupPath = backup('forget');
fs.writeFileSync(memFile, JSON.stringify(data), 'utf8');
console.log(
  backupPath
    ? `\n✓ 已写入（备份：${path.basename(backupPath)}）`
    : '\n✓ 已写入（--no-backup：没有备份，删了就没了）',
);

// ── 顺手清掉对应的 DSH 会话目录 ──
// 不清的话，同一次运行里她还能从会话历史里看到旧对话。
if (!keepSessions && jobs.length) {
  const sessionsRoot = path.join(config.dsh.absoluteHome, 'sessions');
  const prefix = config.dsh.sessionPrefix;
  let removed = 0;
  try {
    for (const projectDir of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;
      const dir = path.join(sessionsRoot, projectDir.name);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const hit = jobs.some((k) => {
          const kind = k.startsWith('group:') ? 'group' : 'private';
          const id = k.split(':')[1];
          return entry.name.startsWith(`${prefix}-${kind}-${id}`);
        });
        if (hit) {
          fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
          removed += 1;
        }
      }
    }
  } catch (err) {
    console.log(`（会话目录没清成，忽略：${err.message}）`);
  }
  if (removed) console.log(`  另外清掉了 ${removed} 个 DSH 会话目录（重新启动后对话就是全新的）`);
}

console.log('\n记得重新启动： wscript.exe run-hidden.vbs   或双击 start.cmd');
if (backupPath) console.log(`想还原： node tools/forget.mjs --restore ${path.basename(backupPath)}`);
else console.log('（这次没备份，没法还原）');
