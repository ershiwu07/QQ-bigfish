/**
 * 探针：只验证「DSH 长驻运行时 + 大肥鱼人设」这条链路，
 * 不涉及 QQ。用来在接 QQ 之前确认模型能正常回话、人设生效、多轮记忆生效。
 *
 * 用法：node tools/probe-dsh.mjs
 * 结果同时打印到终端并写入 tools/probe-output.txt（UTF-8，避免终端乱码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/env.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

loadDotEnv(path.join(projectDir, '.env'));
const config = JSON.parse(fs.readFileSync(path.join(projectDir, 'config/bot.config.json'), 'utf8'));
const persona = fs.readFileSync(path.join(projectDir, config.dsh.personaFile), 'utf8');

const out = [];
const say = (s = '') => {
  out.push(s);
  process.stdout.write(s + '\n');
};

const logger = createLogger({ level: 'info', scope: 'probe' });
const dshBin = resolveDshBin(config.dsh.bin || undefined, projectDir);
say(`dsh 入口：${dshBin}`);
say(`API Key：${process.env.DEEPSEEK_API_KEY ? '已从 .env 读到（' + process.env.DEEPSEEK_API_KEY.slice(0, 8) + '…）' : '缺失！'}`);
say(`人设长度：${persona.length} 字`);
say('');

const rt = new DshRuntime({
  dshBin,
  dshHome: path.join(projectDir, config.dsh.dshHome),
  projectDir,
  profile: config.dsh.profile,
  provider: config.dsh.provider,
  model: config.dsh.model,
  reasoningEffort: config.dsh.reasoningEffort,
  maxTokens: config.dsh.maxTokens,
  apiKey: process.env.DEEPSEEK_API_KEY,
  persona,
  logger,
  initializeTimeoutMs: config.dsh.initializeTimeoutMs,
  turnTimeoutMs: config.dsh.turnTimeoutMs,
});

// 会话 id 必须每次运行都不同：SDK 服务端无法接管已存在的会话
const run = Date.now().toString(36);
const sessionA = `qq-probe-a-${run}`;
const questions = [
  '在吗？',
  '今天上班好累，一点都不想干活',
  '用一句话解释一下什么是 token',
  '你就是大肥鱼吧',
  '你现在能用哪些工具？只列工具名，一个都没有就回答“没有”。',
];

try {
  const t0 = Date.now();
  await rt.start();
  say(`握手耗时：${Date.now() - t0}ms`);
  say('');

  for (const q of questions) {
    const started = Date.now();
    try {
      const r = await rt.ask(sessionA, q);
      say(`>>> 用户：${q}`);
      say(`<<< 大肥鱼 [${Date.now() - started}ms, turn/end=${r.reason?.kind}]:`);
      say(r.text || '(空回复)');
      say('');
    } catch (err) {
      say(`>>> 用户：${q}`);
      say(`!!! 失败：${err.message}`);
      say('');
    }
  }

  // 第二个会话应该看不到第一个会话的历史（验证会话隔离）
  const started = Date.now();
  const r2 = await rt.ask(`qq-probe-b-${run}`, '我叫什么名字？我们之前聊过什么？');
  say(`>>> 用户（新会话）：我叫什么名字？我们之前聊过什么？`);
  say(`<<< 大肥鱼 [${Date.now() - started}ms]:`);
  say(r2.text || '(空回复)');
  say('');
  say(`统计：${JSON.stringify(rt.stats)}`);
} catch (err) {
  say(`探针失败：${err.stack || err.message}`);
} finally {
  await rt.stop().catch(() => {});
  fs.writeFileSync(path.join(here, 'probe-output.txt'), out.join('\n'), 'utf8');
  setTimeout(() => process.exit(0), 200);
}
