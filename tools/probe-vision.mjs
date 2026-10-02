/**
 * 实测「识图」这条链路：把一张图走完整流程（读文件 → 判断格式 → base64 → 塞进 prompt）
 * 交给模型，看它是否真的看见了。用来确认 deepseek-flash 的图片输入真的通了。
 *
 * 用法:
 *   node tools/probe-vision.mjs <图片路径> [问题]
 *   node tools/probe-vision.mjs "D:\NapCat\napcat\cache\qrcode.png" "这张图里是什么？"
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadPersona } from '../src/config.mjs';
import { loadDotEnv } from '../src/env.mjs';
import { createLogger } from '../src/log.mjs';
import { DshRuntime, resolveDshBin } from '../src/dsh-runtime.mjs';
import { collectImageBlocks } from '../src/media.mjs';
import { buildPrompt, sanitizeReply } from '../src/text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..');

const imgArg = process.argv[2];
const question = process.argv[3] || '这张图里是什么？用一两句话说说你看到了什么。';
const isUrl = /^https?:\/\//i.test(String(imgArg || ''));
if (!imgArg || (!isUrl && !fs.existsSync(imgArg))) {
  console.error('用法: node tools/probe-vision.mjs <图片路径或http地址> [问题]');
  process.exit(1);
}
const imgPath = imgArg;

loadDotEnv(path.join(projectDir, '.env'));
const config = loadConfig(projectDir, 'config/bot.config.json');
const persona = loadPersona(config);
const logger = createLogger({ level: 'info', scope: 'vision' });

console.log(`图片：${isUrl ? '（网络地址）' + imgPath.slice(0, 110) + '…' : imgPath}`);
if (!isUrl) console.log(`大小：${(fs.statSync(imgPath).size / 1024).toFixed(1)} KB`);
console.log(`问题：${question}\n`);

// 1) 走真实的图片处理链路
const fakeMsg = {
  kind: 'group',
  groupId: '20001',
  senderName: '阿澈',
  userId: '10001',
  text: question,
  images: 1,
  imageUrls: [isUrl ? { url: imgPath, file: '' } : { url: '', file: imgPath }],
  cards: [],
  hasVideo: false,
  atSelf: true,
  atAll: false,
};
const media = await collectImageBlocks(fakeMsg, config.images, logger);
console.log(`取到图片块：${media.blocks.length} 张（失败 ${media.failed}，跳过 ${media.skipped}）`);
if (!media.blocks.length) {
  console.error('❌ 一张都没取到，链路断了');
  process.exit(1);
}
const b = media.blocks[0];
console.log(`格式：${b.mimeType}   base64 长度：${b.data.length}\n`);

const prompt = buildPrompt({
  msg: fakeMsg,
  recent: [{ name: '小明', text: '刚做了个二维码' }],
  notes: [],
  groupName: '示例群',
  selfDecide: false,
  imagesAttached: media.blocks.length,
});

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
  const t0 = Date.now();
  // 2) 带图片块请求
  const r = await rt.ask(`probe-vision-${Date.now().toString(36)}`, prompt, {
    extraBlocks: media.blocks,
  });
  console.log(`模型回复（${Date.now() - t0}ms，turn/end=${r.reason?.kind}）：`);
  console.log(`  ${sanitizeReply(r.text || '') || '(空)'}`);
} catch (err) {
  console.error(`❌ 带图请求失败：${err.message}`);
} finally {
  await rt.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
