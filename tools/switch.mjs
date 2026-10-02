/**
 * 命令行的「暂停 / 恢复 / 查看」开关。
 *
 * 用法:
 *   node tools/switch.mjs status         看现在是暂停还是说话
 *   node tools/switch.mjs pause          暂停 30 分钟（只记不回）
 *   node tools/switch.mjs pause 10       暂停 10 分钟
 *   node tools/switch.mjs pause forever  一直暂停，直到手动恢复
 *   node tools/switch.mjs resume         恢复说话
 *
 * 也可以在 QQ 里对她说（只有老板发的才算数）：静音 / 闭嘴 / 暂停 30分钟 / 恢复
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { createSwitch } from '../src/switch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const config = loadConfig(root, 'config/bot.config.json');
const file = path.join(path.dirname(config.memory.absoluteFile), 'paused.json');
const sw = createSwitch({ file });

const [cmdRaw, arg] = process.argv.slice(2);
const cmd = String(cmdRaw || 'status').toLowerCase();

function print(st) {
  if (!st.paused) {
    console.log('【状态】她现在会正常回话。');
    if (st.by) console.log(`        上一次操作来自：${st.by}`);
    return;
  }
  console.log('【状态】已暂停 —— 她还在听、还在记事，但不回话。');
  console.log(st.forever ? '        一直暂停，直到手动恢复。' : `        到 ${st.untilText} 自动恢复（约 ${st.remainingMinutes} 分钟后）。`);
  if (st.by) console.log(`        触发者：${st.by}`);
}

if (cmd === 'pause' || cmd === 'stop' || cmd === '静音') {
  const a = String(arg ?? '').trim();
  let minutes = 30;
  if (/^(forever|always|永远|一直)$/i.test(a)) minutes = 0;
  else if (a && Number.isFinite(Number(a))) minutes = Number(a);
  const st = sw.pause({ minutes, by: '命令行', reason: 'tools/switch.mjs' });
  print(st);
  console.log('\n（她不会自己告诉你这件事；想让她开口就 resume。）');
} else if (cmd === 'resume' || cmd === 'start' || cmd === '恢复') {
  const st = sw.resume({ by: '命令行' });
  print(st);
} else if (cmd === 'status' || cmd === '状态') {
  print(sw.status());
} else {
  console.log('用法: node tools/switch.mjs [status|pause [分钟|forever]|resume]');
}
console.log(`\n开关文件：${file}`);
