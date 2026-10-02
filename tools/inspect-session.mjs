/**
 * 回看「模型到底看到了什么、判了什么」。
 *
 * 无窗口模式下，日志只告诉你"收到消息"，但不告诉你它为什么没说话——
 * 这个工具直接读 DSH 的会话日志，把每一轮逐条还原出来。
 *
 * 用法:
 *   node tools/inspect-session.mjs                  # 最近活跃的那个会话
 *   node tools/inspect-session.mjs qq-group-20001
 *   node tools/inspect-session.mjs qq-group-20001 5   # 只看最后 5 轮
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(projectDir, 'config/bot.config.json');
const sessionsRoot = path.join(config.dsh.absoluteHome, 'sessions');

const wantPrefix = process.argv[2] || null;
const limit = Number.parseInt(process.argv[3] || '6', 10);

if (!fs.existsSync(sessionsRoot)) {
  console.error(`找不到会话目录：${sessionsRoot}\n（机器人还没跑过就不会有）`);
  process.exit(1);
}

// 收集所有会话文件（sessions/<项目目录>/<会话名>/session.v4.jsonl）
const found = [];
for (const proj of fs.readdirSync(sessionsRoot)) {
  const projPath = path.join(sessionsRoot, proj);
  if (!fs.statSync(projPath).isDirectory()) continue;
  for (const name of fs.readdirSync(projPath)) {
    const file = path.join(projPath, name, 'session.v4.jsonl');
    if (!fs.existsSync(file)) continue;
    if (wantPrefix && !name.startsWith(wantPrefix)) continue;
    found.push({ name, file, mtime: fs.statSync(file).mtimeMs });
  }
}
if (!found.length) {
  console.error(wantPrefix ? `没有匹配 "${wantPrefix}" 的会话` : '没有任何会话文件');
  process.exit(1);
}
found.sort((a, b) => b.mtime - a.mtime);
const target = found[0];

console.log(`会话：${target.name}`);
console.log(`文件：${target.file}`);
console.log(`最后写入：${new Date(target.mtime).toLocaleString()}`);
if (found.length > 1) {
  console.log(`（另有 ${found.length - 1} 个匹配的会话，这里看的是最新的那个）`);
}
console.log('');

// 解析成「一轮 = 我们发出去的提示词 + 模型最后那句输出」
const turns = [];
let current = null;
for (const line of fs.readFileSync(target.file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  const data = ev.data || {};
  const textOf = (msg) =>
    (Array.isArray(msg?.content) ? msg.content : [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');

  if (ev.type === 'user/message') {
    const prompt = textOf(data.content ? data : data.message);
    const latest = (prompt.match(/【最新消息】\s*\n(.+)/) || [])[1] || '(未知)';
    const recalled = /【你记得的事】/.test(prompt);
    const contextLines = (prompt.match(/【最近消息】([\s\S]*?)【最新消息】/) || [])[1];
    current = {
      at: ev.time ? new Date(ev.time).toLocaleTimeString() : '',
      latest: latest.trim(),
      recall: recalled,
      contextCount: contextLines ? contextLines.split('\n').filter((l) => l.trim().startsWith('-') || /:/.test(l)).length : 0,
      output: null,
    };
    turns.push(current);
  } else if (ev.type === 'assistant/message' && current) {
    current.output = (current.output || '') + textOf(data.message);
  }
}

console.log(`共 ${turns.length} 轮，显示最后 ${Math.min(limit, turns.length)} 轮：\n`);
for (const t of turns.slice(-limit)) {
  console.log(`── ${t.at} ────────────────────────────`);
  console.log(`  它看到  ：${t.latest.slice(0, 110)}`);
  if (t.recall) console.log('  长期记忆：已注入【你记得的事】');
  const out = (t.output || '').trim();
  if (!out) console.log('  它的输出：(空)');
  else if (out.includes('[NO_REPLY]')) console.log('  它的输出：[NO_REPLY] → 判断不该插话，保持沉默');
  else console.log(`  它的输出：${out.replace(/\n/g, ' / ').slice(0, 150)}`);
  console.log('');
}
