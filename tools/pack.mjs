/**
 * 打包成可以直接上传 GitHub 的干净副本。
 *
 *   node tools/pack.mjs             生成 dist/qq-bigfish/ 并压成 dist/qq-bigfish-<版本>.zip
 *   node tools/pack.mjs --no-zip    只生成目录，不压缩
 *   node tools/pack.mjs --zip-only  不重建目录，只把现有的 dist/qq-bigfish/ 重新压一遍
 *                                   （已发布之后要给别人一个 zip 时用这个，不碰 .git）
 *   node tools/pack.mjs --force     即使 dist/qq-bigfish/ 已是 git 仓库也照删重建（会丢提交历史）
 *
 * 做四件事：
 *   1. 按白名单复制文件（**不是**黑名单——宁可少带，也不能漏带隐私数据）；
 *   2. 在产物目录上再跑一遍隐私体检，不通过就整个删掉；
 *   3. 结构性断言：关键文件在不在、shell 是不是真关了、npm 脚本有没有指向不存在的文件；
 *   4. 压缩成 zip（用 Node 内置能力，项目本身零依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { audit } from './audit-privacy.mjs';
import { collectPackFiles } from './pack-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const distRoot = path.join(root, 'dist');
const outDir = path.join(distRoot, 'qq-bigfish');

// 文件清单在 tools/pack-files.mjs 里（和 sync-repo.mjs 共用一份，避免改一处漏一处）
const noZip = process.argv.includes('--no-zip');
const zipOnly = process.argv.includes('--zip-only');

// ─────────────────────────── zip 打包器 ───────────────────────────
/** 极简 zip 打包器（deflate + CRC32），只为不引入第三方依赖 */
function writeZip(files, zipPath) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { rel, abs } of files) {
    const data = fs.readFileSync(abs);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  return fs.statSync(zipPath).size;
}

/** 遍历目录，收集文件（跳过 .git / node_modules 之类的垃圾） */
function collectForZip(dir, relBase = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', '__pycache__', '.DS_Store'].includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = relBase ? path.join(relBase, e.name) : e.name;
    if (e.isDirectory()) out.push(...collectForZip(abs, rel));
    else out.push({ rel, abs });
  }
  return out;
}

function zipPathFor() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return path.join(distRoot, `qq-bigfish-${pkg.version}.zip`);
}

// ─────────────────── --zip-only：不重建目录，只重压 zip ───────────────────
// 已发布之后 dist/qq-bigfish/ 是个 git 仓库，不能删；但你可能想给别人一个 zip。
if (zipOnly) {
  if (!fs.existsSync(outDir)) {
    console.error('\n✗ dist/qq-bigfish/ 不存在，没什么可压的。先跑 node tools/pack.mjs\n');
    process.exit(1);
  }
  const files = collectForZip(outDir);
  const zipPath = zipPathFor();
  const size = writeZip(files, zipPath);
  console.log(`\n✅ 已重新打包（没动目录、没碰 .git）：dist/${path.basename(zipPath)}`);
  console.log(`   ${(size / 1024).toFixed(0)} KB，${files.length} 个文件\n`);
  process.exit(0);
}

// ── 0. 别把已经建好的 git 仓库连根删掉 ──
// 发布流程是：pack 生成干净副本 → 在副本里 git init/commit/push。
// 如果之后又跑一次 pack，副本会被整个删除重建 —— .git 和提交历史一起没了。
if (fs.existsSync(path.join(outDir, '.git')) && !process.argv.includes('--force')) {
  console.log('\n⚠ dist/qq-bigfish/ 已经是一个 git 仓库了（你多半已经在里面提交/推送过）。');
  console.log('  重新打包会把它整个删掉，**连 .git 一起**，提交历史就没了。');
  console.log('  日常改动：node tools/sync-repo.mjs --write  （改完在那个目录里 commit/push）');
  console.log('  只想刷新 zip：node tools/pack.mjs --zip-only');
  console.log('  确实要从头重来（会丢历史）：node tools/pack.mjs --force\n');
  process.exit(1);
}

// ── 1. 复制 ──
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
let bytes = 0;
for (const { rel, abs } of collectPackFiles(root)) {
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  copied += 1;
  bytes += fs.statSync(dest).size;
}
console.log(`\n已复制 ${copied} 个文件（${(bytes / 1024).toFixed(0)} KB）→ dist/qq-bigfish/`);

// ── 2. 在产物上再体检一次 ──
console.log('\n对产物做隐私体检…');
const r = audit(outDir);
if (!r.ok) {
  console.log(`\n❌ 产物没通过（${r.findings.length} 处可疑 / ${r.missing.length} 项 .gitignore 缺失）`);
  for (const x of r.findings.slice(0, 20)) console.log(`   ${x.file}:${x.line}  ${x.text}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('\n产物已删除。修好之后重跑。');
  process.exit(1);
}
console.log(`✅ 产物干净（扫了 ${r.files} 个文件）`);

// ── 3. 结构性断言：少任何一样，买家就会得到一个"不安全或跑不起来"的包 ──
const mustHave = [
  path.join('dsh-home', 'cordis.patch.yml'), // 关 shell + 开只读联网 + 附件存储
  path.join('config', 'persona.md'), // 人设
  path.join('config', 'bot.config.example.json'), // 配置模板
  path.join('src', 'index.mjs'), // 入口
  '.env.example',
];
const missingFiles = mustHave.filter((f) => !fs.existsSync(path.join(outDir, f)));
if (missingFiles.length) {
  console.log(`\n❌ 产物缺少关键文件：${missingFiles.join('、')}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  console.log('产物已删除。修好之后重跑。');
  process.exit(1);
}

// patch 文件的内容也要对：必须真的关掉 shell、并且挂了只读联网
const patchText = fs.readFileSync(path.join(outDir, 'dsh-home', 'cordis.patch.yml'), 'utf8');
const patchChecks = [
  ['关掉 persistent-pwsh', /id:\s*persistent-pwsh[\s\S]{0,80}?disabled:\s*true/],
  ['关掉 terminal-pwsh', /id:\s*terminal-pwsh[\s\S]{0,80}?disabled:\s*true/],
  ['挂上只读联网工具', /dsh-tool-web/],
  ['挂上附件存储（识图要用）', /dsh-attachment-local/],
];
const badPatch = patchChecks.filter(([, re]) => !re.test(patchText)).map(([name]) => name);
if (badPatch.length) {
  console.log(`\n❌ dsh-home/cordis.patch.yml 内容不对：${badPatch.join('、')}`);
  console.log('   这个文件决定了 shell 工具是否关闭——不要跳过。');
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

// npm 脚本指向的文件必须真的在包里。
// 踩过的坑：publish:local 指向 tools/publish.mjs，而那个文件属于作者专属、被排除掉了，
// 于是使用者一跑 npm run publish:local 就直接报"找不到模块"。
const pkgInPack = JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'), 'utf8'));
const brokenScripts = [];
for (const [name, cmd] of Object.entries(pkgInPack.scripts || {})) {
  for (const m of String(cmd).matchAll(/node\s+([^\s&|]+)/g)) {
    if (!fs.existsSync(path.join(outDir, m[1]))) brokenScripts.push(`npm run ${name} → ${m[1]}`);
  }
}
if (brokenScripts.length) {
  console.log(`\n❌ 有 npm 脚本指向了包里不存在的文件：`);
  for (const b of brokenScripts) console.log(`   ${b}`);
  console.log('   （使用者跑这些脚本会直接报错。改 package.json，或者把文件加进 pack-files.mjs）');
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
}

console.log('✅ 关键文件齐全 / shell 确认关闭 / npm 脚本都指向包内存在的文件');

// ── 4. 压缩 ──
if (noZip) {
  console.log('\n--no-zip：只生成目录，不压缩。');
} else {
  const files = collectForZip(outDir);
  const zipPath = zipPathFor();
  const size = writeZip(files, zipPath);
  console.log(`\n✅ 已打包：dist/${path.basename(zipPath)}（${(size / 1024).toFixed(0)} KB，${files.length} 个文件）`);
}

console.log(`\n产物目录：dist/qq-bigfish/`);
console.log('发布/更新流程见 MAINTAINING.md（作者本地文档，不在发布包里）。\n');
