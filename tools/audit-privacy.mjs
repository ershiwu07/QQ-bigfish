/**
 * 隐私体检：提交或打包之前跑一遍。
 *
 *   node tools/audit-privacy.mjs          只扫"会被提交"的文件（默认）
 *   node tools/audit-privacy.mjs --self   连被 .gitignore 排除的目录一起看（自检用，会报很多）
 *   node tools/audit-privacy.mjs --root <目录>   扫别的目录（打包时用来验证产物）
 *
 * 也可以当模块用：`import { audit } from './audit-privacy.mjs'`，返回结构化结果。
 *
 * 设计上的一个关键点：**本工具不硬编码任何真实的 QQ 号或昵称**——
 * 否则它自己就成了泄露源。全部用启发式规则：
 *
 *   · sk- 开头的 API Key
 *   · 32 位十六进制串（MD5，比如 QQ 快速登录用的密码摘要）
 *   · 9~11 位连续数字（真实 QQ 号通常是这个长度；仓库里的示例号是 5 位）
 *   · 本机用户目录路径
 *   · password / passwd / token= 之类的赋值
 *
 * 另外还会检查 .gitignore 是否真的排除了那几个必排项——
 * 这条比什么都重要：记忆目录里是真实群聊。
 *
 * CLI 有任何发现 → 退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, '..');

/** 会被提交的文件类型 */
const EXTS = ['.mjs', '.js', '.json', '.md', '.cmd', '.ps1', '.vbs', '.yml', '.yaml', '.txt', '.example'];
/** 永远不进仓库的目录 */
const IGNORED_DIRS = ['node_modules', 'dist', '.git', 'state', 'logs', 'dsh-home'];
/** dsh-home 里唯一要提交的文件 */
const IGNORED_DIR_EXCEPTIONS = [path.join('dsh-home', 'cordis.patch.yml')];
/** 已被 .gitignore 排除的单个文件（它们的"是否被排除"由 .gitignore 自检负责） */
const IGNORED_FILES = [
  '.env',
  path.join('config', 'bot.config.json'),
  path.join('tools', 'probe-output.txt'),
  path.join('tools', 'selftest.config.json'),
  path.join('tools', 'selftest-memory.json'),
  path.join('tools', 'selftest-output.txt'),
];

const RULES = [
  { name: 'API Key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: '疑似 MD5/密码摘要', re: /\b[0-9a-fA-F]{32}\b/ },
  // 前后不接 / . - 之类的字符，避免把 URL、版本号里的数字当成 QQ 号；
  // 只认 9~11 位（真实 QQ 号就这个长度），13 位的毫秒时间戳自然不会命中。
  { name: '疑似 QQ 号（9~11 位数字）', re: /(?<![\w/.\-])\d{9,11}(?![\w/])/ },
  { name: '本机用户目录', re: /[A-Za-z]:\\Users\\[^\\\s"']+/ },
  { name: '密码赋值', re: /(password|passwd|pwd)\s*[:=]\s*["'][^"']{4,}/i },
  { name: 'token 赋值', re: /(access_?token|api_?key|secret)\s*[:=]\s*["'][^"']{8,}/i },
  { name: '私钥文件', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** 这些行里的命中是正常内容，不算泄露 */
const RULE_EXCEPTIONS = {
  '疑似 MD5/密码摘要': [/(sha256|sha1|md5|hash|integrity)/i],
  // 秒级时间戳（2020~2036）长得和 10 位 QQ 号一样，只能放过
  '疑似 QQ 号（9~11 位数字）': [/\b(1[6-9]\d{8}|2[01]\d{8})\b/],
};

function walk(root, dir, out, selfMode) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.includes(e.name)) {
        if (selfMode && !['node_modules', '.git', 'dist'].includes(e.name)) walk(root, full, out, selfMode);
        continue;
      }
      walk(root, full, out, selfMode);
    } else {
      const inIgnoredDir = IGNORED_DIRS.some((d) => rel.startsWith(d + path.sep));
      if (inIgnoredDir && !IGNORED_DIR_EXCEPTIONS.includes(rel)) continue;
      if (!selfMode && IGNORED_FILES.includes(rel)) continue;
      if (!EXTS.includes(path.extname(full).toLowerCase()) && !e.name.startsWith('.env')) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * @param {string} root 要扫描的目录
 * @returns {{files:number, findings:Array, missing:Array, ok:boolean}}
 */
export function audit(root = PROJECT_ROOT, { selfMode = false } = {}) {
  const files = walk(root, root, [], selfMode);
  const findings = [];
  for (const f of files) {
    const rel = path.relative(root, f);
    if (rel === '.gitignore') continue;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // 二进制
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!rule.re.test(line)) continue;
        const excepts = RULE_EXCEPTIONS[rule.name] || [];
        if (excepts.some((x) => x.test(line))) continue;
        findings.push({ file: rel, line: i + 1, rule: rule.name, text: line.trim().slice(0, 100) });
      }
    }
  }

  const giPath = path.join(root, '.gitignore');
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const MUST_IGNORE = ['.env', 'config/bot.config.json', 'state/', 'logs/', 'dsh-home/'];
  const missing = MUST_IGNORE.filter((m) => !gi.includes(m));

  return { files: files.length, findings, missing, ok: findings.length === 0 && missing.length === 0 };
}

function main() {
  const argv = process.argv.slice(2);
  const selfMode = argv.includes('--self');
  const rootArg = argv.indexOf('--root');
  const root = rootArg >= 0 && argv[rootArg + 1] ? path.resolve(argv[rootArg + 1]) : PROJECT_ROOT;

  const r = audit(root, { selfMode });
  console.log(`\n扫描 ${r.files} 个${selfMode ? '' : '会被提交的'}文件…（${root}）\n`);

  if (r.findings.length) {
    console.log(`❌ 发现 ${r.findings.length} 处可疑内容：\n`);
    const byRule = {};
    for (const f of r.findings) (byRule[f.rule] ||= []).push(f);
    for (const [rule, list] of Object.entries(byRule)) {
      console.log(`  【${rule}】${list.length} 处`);
      for (const x of list.slice(0, 15)) console.log(`      ${x.file}:${x.line}  ${x.text}`);
      if (list.length > 15) console.log(`      …还有 ${list.length - 15} 处`);
    }
  } else {
    console.log('✅ 没有发现密钥、QQ 号、本机路径等痕迹');
  }

  if (r.missing.length) {
    console.log(`\n❌ .gitignore 缺少这些必排项：${r.missing.join('、')}`);
    console.log('   （记忆/日志目录里是真实群聊，一旦推上去就收不回来了）');
  } else {
    console.log('✅ .gitignore 已排除 .env / config / state / logs / dsh-home');
  }

  console.log(r.ok ? '\n可以安全提交。\n' : '\n处理完上面这些再提交。\n');
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
