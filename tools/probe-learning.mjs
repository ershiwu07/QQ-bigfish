/**
 * 实测「从群聊里学习」这条路：拿 state/memory.json 里真实的聊天记录，
 * 跑一次提炼，看它到底能学到什么。默认只打印，不写进记忆。
 *
 * 用法:
 *   node tools/probe-learning.mjs                       # 用记忆里最活跃的那个群
 *   node tools/probe-learning.mjs group:20001       # 指定会话
 *   node tools/probe-learning.mjs group:20001 --save # 真写进记忆
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona } from '../src/config.mjs';
import { loadDotEnv } from '../src/env.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';
import { createStateStore } from '../src/state.mjs';
import { buildDigestPrompt, extractMemoryNotes } from '../src/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

loadDotEnv(path.join(projectDir, '.env'));
const config = loadConfig(projectDir, 'config/bot.config.json');
const persona = loadPersona(config);
const logger = createLogger({ level: 'warn', scope: 'probe' });

const args = process.argv.slice(2);
const save = args.includes('--save');
const wantKey = args.find((a) => !a.startsWith('--')) || null;

const state = createStateStore({
  file: config.memory.absoluteFile,
  logger,
  enabled: true,
  debounceMs: 50,
});
state.load();

// 直接读记忆文件拿全量会话（state 没暴露内部 keys）
const fs = await import('node:fs');
const raw = JSON.parse(fs.readFileSync(config.memory.absoluteFile, 'utf8'));
const chats = raw.chats || {};
let chatKey = wantKey;
if (!chatKey) {
  chatKey = Object.entries(chats)
    .filter(([, v]) => (v.recent?.length || 0) >= 3)
    .sort((a, b) => (b[1].recent?.length || 0) - (a[1].recent?.length || 0))[0]?.[0];
}
if (!chatKey || !chats[chatKey]) {
  console.error('记忆里没有足够的聊天记录可供提炼（先在群里聊几句再来）');
  process.exit(1);
}

const recent = (chats[chatKey].recent || []).map((x) => ({ name: x.n, text: x.t }));
const existingNotes = state.getNotes(chatKey);
const messages = recent.slice(-(config.learning.maxMessagesPerDigest || 30));

console.log(`会话      ：${chatKey}`);
console.log(`聊天记录  ：取最近 ${messages.length} 条（共 ${recent.length} 条流水）`);
console.log(`已有记忆  ：${existingNotes.length} 条`);
if (save) console.log('模式      ：--save（提炼结果会真写进记忆）');
console.log('\n聊天记录预览：');
for (const m of messages.slice(-10)) console.log(`  ${m.name}: ${m.text.slice(0, 70)}`);
console.log('');

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

try {
  await rt.start();
  const prompt = buildDigestPrompt({
    groupName: chatKey.includes('group') ? `群 ${chatKey.split(':')[1]}` : null,
    groupId: chatKey.split(':')[1],
    messages,
    existingNotes,
  });
  const t0 = Date.now();
  const r = await rt.ask(`probe-learn-${Date.now().toString(36)}`, prompt);
  const { notes, clean } = extractMemoryNotes(r.text || '');
  console.log(`提炼完成（${Date.now() - t0}ms）`);
  if (!notes.length) {
    console.log(`它认为这批没有值得记的新东西。原始输出：${JSON.stringify((clean || '').trim().slice(0, 120))}`);
  } else {
    console.log(`提炼出 ${notes.length} 条新知识：`);
    for (const n of notes) console.log(`  · ${n}`);
    if (save) {
      const added = state.addNotes(chatKey, notes, config.memory.maxNotesPerChat);
      state.flush();
      console.log(`\n已写入记忆：+${added} 条（现共 ${state.getNotes(chatKey).length} 条）`);
    } else {
      console.log('\n（没有写入。要真写入就加 --save）');
    }
  }
} finally {
  await rt.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
