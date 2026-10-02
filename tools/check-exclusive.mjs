/**
 * 查一遍记忆里有没有藏"专一/排他"的表述——这类内容会让她对别人说"我心里有人了"。
 * 用法: node tools/check-exclusive.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const config = loadConfig(root, 'config/bot.config.json');
const m = JSON.parse(fs.readFileSync(config.memory.absoluteFile, 'utf8'));

const SUSPECT = /喜欢|爱|对象|老婆|老公|有人|专属|只有|男朋|女朋|阿澈|主人|他是我/;

console.log('=== 会话级长期记忆里可疑的条目 ===');
let hits = 0;
for (const [k, c] of Object.entries(m.chats)) {
  for (const n of c.notes || []) {
    if (SUSPECT.test(n.t)) {
      hits += 1;
      console.log(`  [${k}] ${n.t.slice(0, 100)}`);
    }
  }
}
if (!hits) console.log('  （没有）');

console.log('\n=== 成员档案里可疑的条目 ===');
hits = 0;
for (const [k, c] of Object.entries(m.chats)) {
  for (const [uid, mem] of Object.entries(c.members || {})) {
    for (const f of mem.f || []) {
      if (SUSPECT.test(f.t)) {
        hits += 1;
        console.log(`  [${k}] ${mem.c || mem.n || uid}：${f.t.slice(0, 100)}`);
      }
    }
  }
}
if (!hits) console.log('  （没有）');

console.log('\n=== 各会话最近对话里的"专一"信号 ===');
for (const [k, c] of Object.entries(m.chats)) {
  const own = (c.recent || []).filter((r) => r.n === '大肥鱼');
  const bad = own.filter((r) => /我心里(已经)?有人|有对象|有人了|我的人|只认他|老婆|老公/.test(r.t || ''));
  if (bad.length) {
    console.log(`  [${k}] ${bad.length} 条：`);
    for (const b of bad.slice(-3)) console.log(`     ${(b.t || '').slice(0, 90)}`);
  }
}
