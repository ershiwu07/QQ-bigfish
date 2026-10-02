/**
 * 一次性工具：从 GitHub 拉取 NapCat 最新 Release 的资源。
 * 为什么要 --use-system-ca：本机 Steam++ 对 github 做了 TLS 中间人，
 * 它的根证书装在 Windows 证书库里，Node 默认不信任，必须用系统 CA。
 *
 * 用法: node --use-system-ca fetch-napcat.mjs <输出目录> [资源名...]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const outDir = process.argv[2];
const wanted = process.argv.slice(3);
if (!outDir) {
  console.error('用法: node --use-system-ca fetch-napcat.mjs <输出目录> [资源名...]');
  process.exit(1);
}

const API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const headers = { 'User-Agent': 'napcat-fetch', Accept: 'application/vnd.github+json' };

const res = await fetch(API, { headers });
if (!res.ok) {
  console.error(`取 Release 失败：HTTP ${res.status}`);
  process.exit(1);
}
const rel = await res.json();
console.log(`版本：${rel.tag_name}（${rel.published_at}）`);

const targets = (rel.assets || []).filter(
  (a) => wanted.length === 0 || wanted.includes(a.name),
);
if (!targets.length) {
  console.error('没有匹配的资源。可选：' + (rel.assets || []).map((a) => a.name).join(', '));
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

for (const a of targets) {
  const dest = path.join(outDir, a.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) {
    console.log(`${a.name}: 已存在且大小一致，跳过`);
    continue;
  }
  const t0 = Date.now();
  process.stdout.write(`下载 ${a.name}（${(a.size / 1048576).toFixed(1)} MB）…`);
  const r = await fetch(a.browser_download_url, { headers: { 'User-Agent': 'napcat-fetch' } });
  if (!r.ok) {
    console.log(` 失败 HTTP ${r.status}`);
    continue;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const expect = (a.digest || '').replace(/^sha256:/, '');
  const ok = expect ? sha === expect : null;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(' 完成');
  console.log(`  路径   : ${dest}`);
  console.log(`  大小   : ${(buf.length / 1048576).toFixed(2)} MB  用时 ${secs}s`);
  console.log(`  sha256 : ${sha}`);
  if (ok === true) console.log('  校验   : ✅ 与 GitHub 官方 digest 一致');
  else if (ok === false) console.log(`  校验   : ❌ 不一致！官方为 ${expect}`);
  else console.log('  校验   : （官方未提供 digest，无法比对）');
}
