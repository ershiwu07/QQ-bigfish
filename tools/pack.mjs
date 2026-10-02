/**
 * 打包成可以直接上传 GitHub 的干净副本。
 *
 *   node tools/pack.mjs             生成 dist/qq-bigfish/ 并压成 dist/qq-bigfish-<版本>.zip
 *   node tools/pack.mjs --no-zip    只生成目录，不压缩
 *
 * 做三件事：
 *   1. 按白名单复制文件（**不是**黑名单——宁可少带，也不能漏带隐私数据）；
 *   2. 在产物目录上再跑一遍隐私体检，不通过就整个删掉；
 *   3. 压缩成 zip（用 Node 内置能力，项目本身零依赖）。
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

// ── 0. 别把已经建好的 git 仓库连根删掉 ──
// 发布流程是：pack 生成干净副本 → 在副本里 git init/commit/push。
// 如果之后又跑一次 pack，副本会被整个删除重建 —— .git 和提交历史一起没了。
if (fs.existsSync(path.join(outDir, '.git')) && !process.argv.includes('--force')) {
  console.log('\n⚠ dist/qq-bigfish/ 已经是一个 git 仓库了（你多半已经在里面提交/推送过）。');
  console.log('  重新打包会把它整个删掉，**连 .git 一起**，提交历史就没了。');
  console.log('  日常改动请直接在那个仓库目录里改并 commit；');
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

// ── 2.5 结构性断言：这几样少了任何一样，买家就会得到一个"不安全或跑不起来"的包 ──
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
console.log('✅ 关键文件齐全，且 shell 工具确认是关掉的');

// ── 3. 压缩 ──
if (noZip) {
  console.log('\n--no-zip：只生成目录，不压缩。');
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const zipPath = path.join(distRoot, `qq-bigfish-${pkg.version}.zip`);

  /** 极简 zip 打包器（store 模式 + CRC32），只为不引入第三方依赖 */
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

  const entries = [];
  const collect = (dir, relBase = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) collect(abs, rel);
      else entries.push({ rel, abs });
    }
  };
  collect(outDir);

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { rel, abs } of entries) {
    const data = fs.readFileSync(abs);
    // deflate 压缩（和普通 zip 兼容）
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
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
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]));
  console.log(`\n✅ 已打包：dist/${path.basename(zipPath)}（${(fs.statSync(zipPath).size / 1024).toFixed(0)} KB，${entries.length} 个文件）`);
}

console.log(`\n产物目录：dist/qq-bigfish/`);
console.log('下一步（需要先装 git）：见 README 的「发布到 GitHub」一节。\n');
