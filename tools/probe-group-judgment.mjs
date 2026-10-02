/**
 * 校准：它在群里到底会不会「聪明地插话」，还是保守到变成木头。
 *
 * 用真实人设 + 真实模型，喂几种典型群消息（都没 @ 它、没关键词），
 * 看它是选择说话还是 [NO_REPLY]。
 *
 * 用法: node tools/probe-group-judgment.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona } from '../src/config.mjs';
import { loadDotEnv } from '../src/env.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';
import { buildPrompt, sanitizeReply, extractMemoryNotes } from '../src/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

loadDotEnv(path.join(projectDir, '.env'));
const config = loadConfig(projectDir, 'config/bot.config.json');
const persona = loadPersona(config);
const logger = createLogger({ level: 'warn', scope: 'probe' });

const recent = [
  { name: '阿澈', text: '新买的显卡到了' },
  { name: '小明', text: '多少钱' },
  { name: '阿澈', text: '三千多' },
];

const scenarios = [
  ['① 技术问题（它明显懂）', '这个接口一直 502，日志里啥都没有，服了'],
  ['② 纯灌水', '哈哈哈哈'],
  ['③ 有人问它擅长的事（没 @ 它）', '有没有人知道 token 到底是怎么算钱的'],
  ['④ 别人之间的私事', '你几点到？我在楼下等你'],
  ['⑤ 明显说错的话', 'DeepSeek 不是开源的嘛，随便用'],
  ['⑥ 冷场的一句', '今天好困啊'],
  ['⑦ 聊到它自己', '那个大肥鱼机器人还在群里吗'],
];

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

const run = Date.now().toString(36); // 会话 id 必须每次运行都不同（SDK 不能接管已存在会话）
let spoke = 0;
try {
  await rt.start();
  for (let i = 0; i < scenarios.length; i += 1) {
    const [label, text] = scenarios[i];
    const msg = {
      kind: 'group',
      groupId: '20001',
      senderName: '阿澈',
      userId: '10001',
      text,
      images: 0,
      atSelf: false,
      atAll: false,
    };
    const prompt = buildPrompt({
      msg,
      recent,
      notes: ['群主是阿澈', '群里主要聊 AI 和硬件'],
      groupName: '示例群',
      selfDecide: true,
    });
    try {
      // 每个场景独立会话，避免互相影响
      const r = await rt.ask(`probe-judge-${run}-${i}`, prompt);
      const { clean, notes } = extractMemoryNotes(r.text || '');
      const said = sanitizeReply(clean);
      if (said) spoke += 1;
      console.log(`${label}`);
      console.log(`   群里说：${text}`);
      console.log(`   它决定：${said ? `说话 →「${said.replace(/\n/g, ' / ').slice(0, 90)}」` : '保持沉默 [NO_REPLY]'}`);
      if (notes.length) console.log(`   （顺手记下：${notes[0]}）`);
      console.log('');
    } catch (err) {
      console.log(`${label}\n   失败：${err.message}\n`);
    }
  }
  console.log(`=== ${scenarios.length} 个场景里它开口了 ${spoke} 次 ===`);
} finally {
  await rt.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
