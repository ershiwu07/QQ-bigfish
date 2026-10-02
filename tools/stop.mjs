/**
 * 停止机器人（无窗口模式下用）。
 * 从 state/bot.lock 读出 PID，连同它的子进程（DSH 运行时）一起结束。
 *
 * 用法: node tools/stop.mjs   或双击 stop.cmd
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = path.join(projectDir, 'state', 'bot.lock');

if (!fs.existsSync(lock)) {
  console.log('没找到 state/bot.lock —— 机器人大概没在跑。');
  process.exit(0);
}

const pid = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
if (!Number.isFinite(pid) || pid <= 0) {
  console.log(`锁文件内容不正常（"${fs.readFileSync(lock, 'utf8').trim()}"），直接删掉它。`);
  fs.rmSync(lock, { force: true });
  process.exit(0);
}

console.log(`正在结束机器人进程 PID ${pid}（连同它的 DSH 运行子进程）…`);
try {
  // /T 连子进程一起结束：否则 DSH 运行时会被留下变成孤儿进程
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
} catch (err) {
  console.log(`taskkill 失败（可能它已经退出了）：${err.message}`);
}
fs.rmSync(lock, { force: true });
console.log('已停止。');
