/**
 * 把本目录发布到 GitHub 的引导脚本（Windows 友好）。
 *
 * 用法:
 *   node tools/publish.mjs                      只做本地准备：init / add / commit + 安全检查
 *   node tools/publish.mjs <仓库URL>             连远端一起配好并推送
 *   node tools/publish.mjs <仓库URL> --yes       不再问确认
 *
 * 它会在提交**之前**做这些检查（这些都是真踩过的坑）：
 *   · dsh-home/cordis.patch.yml 必须在暂存列表里 —— 它关掉 shell 工具，
 *     漏了它，买家部署后群里任何人都能在其电脑上执行命令。
 *   · .env / config/bot.config.json / state / logs / dsh-home 的其它内容
 *     一个都不能进 —— 那里有真实聊天记录和你的 QQ 号。
 * 任何一条不过就中止，不会留下半成品提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const remoteUrl = argv.find((a) => !a.startsWith('-'));
const assumeYes = argv.includes('--yes') || argv.includes('-y');

const MUST_HAVE = [
  path.join('dsh-home', 'cordis.patch.yml'),
  path.join('config', 'persona.md'),
  path.join('config', 'bot.config.example.json'),
  'README.md',
  'LICENSE',
  '.gitignore',
  '.env.example',
];
/** 精确匹配：这些必须一个都不出现 */
const FORBIDDEN_EXACT = ['.env', '.env.local', path.join('config', 'bot.config.json')];
/** 前缀匹配：这些目录下的东西一个都不能进 */
const FORBIDDEN_PREFIX = ['state/', 'logs/', 'node_modules/', 'dist/', '.git/'];
/** dsh-home 下只允许这一个文件 */
const DSH_HOME_ALLOW = path.join('dsh-home', 'cordis.patch.yml');

const say = (s = '') => console.log(s);
const die = (s) => {
  console.error(`\n✗ ${s}\n`);
  process.exit(1);
};

/**
 * 找 git 可执行文件。
 * 为什么要这么麻烦：Windows 上「刚装完 git」和「终端拿不拿得到它」是两件事——
 *   · 已经开着的终端用的是旧 PATH；
 *   · Windows Terminal 新开**标签页**继承的仍是终端进程启动时的旧环境（要开**新窗口**才行）。
 * 所以这里在 PATH 找不到时，直接去标准安装位置找，免得卡在这种环境问题上。
 */
function findGit() {
  const isWin = process.platform === 'win32';
  const probe = spawnSync(isWin ? 'where' : 'which', ['git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (probe.status === 0 && probe.stdout && probe.stdout.trim()) {
    return 'git';
  }
  const fallbacks = isWin
    ? [
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  for (const f of fallbacks) {
    if (f && fs.existsSync(f)) return f;
  }
  return null;
}

const GIT = findGit();
if (!GIT) {
  die(
    '找不到 git。\n' +
      '  装：winget install Git.Git\n' +
      '  装完必须**关掉整个终端窗口、重新打开**（不是新开标签页——标签页继承的还是旧环境），再跑本脚本。',
  );
}
const usingFallbackGit = GIT !== 'git';

/** 跑 git；capture=true 时把输出抓回来（要解析） */
function git(args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(GIT, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (r.error) die(`调用 git 失败：${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    die(`git ${args.join(' ')} 失败（退出码 ${r.status}）${capture ? `\n${r.stderr || ''}` : ''}`);
  }
  return capture ? (r.stdout || '') : '';
}

say('=== 发布前检查 ===');

// ── 0. git 在不在 ──
const ver = git(['--version'], { capture: true, allowFail: true }).trim();
if (!ver) die('找不到 git。先执行：winget install Git.Git   然后**重开一个终端**再跑本脚本。');
say(`  git: ${ver}`);

// ── 1. 提交者身份 ──
const name = git(['config', 'user.name'], { capture: true, allowFail: true }).trim();
const email = git(['config', 'user.email'], { capture: true, allowFail: true }).trim();
if (!name || !email) {
  say('  还没有配置提交者身份（git 会拒绝提交）。先跑这两行：\n');
  say('      git config --global user.name  "你的名字或GitHub用户名"');
  say('      git config --global user.email "你的邮箱"\n');
  die('配好之后再跑本脚本。');
}
say(`  提交者: ${name} <${email}>`);

// ── 2. 目录里该有的 / 不该有的 ──
const missing = MUST_HAVE.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) die(`缺少关键文件：${missing.join('、')}\n  这个目录不是完整的发布包。先跑 node tools/pack.mjs 重新生成。`);
say(`  ✅ ${MUST_HAVE.length} 个关键文件齐全`);

const leakDirs = ['state', 'logs', '.env', path.join('config', 'bot.config.json')].filter((f) =>
  fs.existsSync(path.join(root, f)),
);
if (leakDirs.length) {
  die(
    `这个目录里有不该发布的东西：${leakDirs.join('、')}\n` +
      '  说明你在这个目录里跑过机器人（生成了记忆/日志），或者手动放了 .env。\n' +
      '  最稳的做法：回项目根目录跑 node tools/pack.mjs，用重新生成的干净副本。',
  );
}
// dsh-home 里除了补丁文件不该有别的
const dshDir = path.join(root, 'dsh-home');
if (fs.existsSync(dshDir)) {
  const extra = fs.readdirSync(dshDir).filter((n) => path.join('dsh-home', n) !== DSH_HOME_ALLOW);
  if (extra.length) die(`dsh-home 里有运行期数据：${extra.join('、')}（应该只有 cordis.patch.yml）`);
}
say('  ✅ 没有 .env / 记忆 / 日志');

// 补丁内容：必须真的关掉 shell
const patch = fs.readFileSync(path.join(root, DSH_HOME_ALLOW), 'utf8');
if (!/id:\s*persistent-pwsh[\s\S]{0,80}?disabled:\s*true/.test(patch) || !/dsh-tool-web/.test(patch)) {
  die('dsh-home/cordis.patch.yml 内容不对：shell 没关掉，或没挂只读联网。不要发布这个包。');
}
say('  ✅ shell 工具确认是关掉的');

// ── 3. init / add ──
if (!fs.existsSync(path.join(root, '.git'))) {
  say('\n=== git init ===');
  git(['init', '-b', 'main']);
} else {
  say('\n（已存在 .git，跳过 init）');
}
git(['add', '.']);

// ── 4. 检查**暂存列表**（最关键的一步） ──
const status = git(['status', '--porcelain'], { capture: true });
const staged = status
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  .filter((p) => p);

const alreadyCommitted = git(['rev-parse', '--verify', 'HEAD'], { capture: true, allowFail: true }).trim();
if (!staged.length) {
  // 已经提交过、这次没有新改动 —— 不该报错，直接进入推送
  if (!alreadyCommitted) die('暂存列表是空的——没有东西可提交。这个目录不像是一个完整的发布包。');
  say('\n没有新改动（之前已经提交过了），直接进入推送步骤。');
}

const bad = staged.filter((p) => {
  const norm = p.replace(/\\/g, '/');
  // 模板文件是**要**提交的：`.env` 的前缀匹配会误伤它（这个 bug 真出现过）
  if (norm === '.env.example') return false;
  if (FORBIDDEN_EXACT.includes(norm)) return true;
  if (/^\.env(\..+)?$/.test(norm)) return true; // .env / .env.local / .env.production …
  if (FORBIDDEN_PREFIX.some((f) => norm.startsWith(f))) return true;
  if (norm.startsWith('dsh-home/') && norm !== 'dsh-home/cordis.patch.yml') return true;
  return false;
});
if (bad.length) {
  say('\n暂存列表里出现了不该发布的东西：');
  for (const b of bad.slice(0, 20)) say(`  ✗ ${b}`);
  die('已中止（没有提交）。请先处理这些文件再重跑。');
}
if (!staged.some((p) => p.replace(/\\/g, '/') === 'dsh-home/cordis.patch.yml')) {
  die('暂存列表里没有 dsh-home/cordis.patch.yml！\n  它是关掉 shell 工具的那份补丁，绝对不能漏。');
}

say(`\n=== 即将提交 ${staged.length} 个文件 ===`);
say('  ✅ dsh-home/cordis.patch.yml 在里面（shell 已关）');
say('  ✅ 没有 .env / bot.config.json / state / logs');
if (staged.length <= 60) for (const p of staged) say(`     ${p}`);

// ── 5. commit ──
if (staged.length) {
  say('\n=== 提交 ===');
  if (alreadyCommitted) {
    git(['commit', '-m', 'chore: 更新']);
  } else {
    git(['commit', '-m', 'init: QQ 大肥鱼机器人 —— DeepSeek Harness + NapCat 的群聊 Agent']);
  }
}

// ── 6. 远端 ──
const existingRemote = git(['remote', 'get-url', 'origin'], { capture: true, allowFail: true }).trim();
if (remoteUrl) {
  if (existingRemote && existingRemote !== remoteUrl) git(['remote', 'set-url', 'origin', remoteUrl]);
  else if (!existingRemote) git(['remote', 'add', 'origin', remoteUrl]);
  say(`\n=== 推送到 ${remoteUrl} ===`);
  say('  第一次推送会弹出浏览器让你登录 GitHub —— 登录完就自动继续。');
  say('  （如果它让你在终端里输密码：GitHub 早就不收密码了，得用 Personal Access Token，见 README）\n');
  git(['push', '-u', 'origin', 'main']);
  say('\n✅ 推送完成。去 GitHub 页面刷新看看。');
} else {
  say('\n=== 本地仓库已经准备好，接下来推上去 ===');
  if (existingRemote) say(`  已经配好远端：${existingRemote}`);
  say('  1) 打开 https://github.com/new');
  say('     · Repository name 填 qq-bigfish');
  say('     · 选 Public 或 Private');
  say('     · ★ 下面三个初始化选项（README / .gitignore / license）**全都不勾**');
  say('       勾了会导致推送被拒（远端有你本地没有的提交）');
  say('  2) 创建后，把页面上的仓库地址拿来跑：\n');
  say('     node tools/publish.mjs https://github.com/<你的用户名>/qq-bigfish.git\n');
  say('  （或者手动：git remote add origin <地址>  然后  git push -u origin main）');
}
