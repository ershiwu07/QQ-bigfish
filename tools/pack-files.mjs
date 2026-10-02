/**
 * 「哪些文件属于发布包」的唯一事实来源。
 *
 * `tools/pack.mjs`（打包成干净副本）和 `tools/sync-repo.mjs`
 * （把开发目录的改动同步进已发布仓库）都从这里取清单，
 * 避免两处各写一份、日后改一处漏一处。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 要打包的目录（整份带走） */
export const INCLUDE_DIRS = ['src', 'tools', 'config', 'docs'];

/**
 * 单独点名要带的文件。
 * ★ dsh-home/cordis.patch.yml 必须在列表里：
 *   它关掉了 shell 工具。少了它，DSH 会用默认配置启动 → pwsh 暴露出来 →
 *   群里任何人 @ 一下就能在买家电脑上执行命令。（这个坑真踩过，
 *   是"模拟新人部署"的测试抓出来的。）
 */
export const INCLUDE_FILES = [
  'README.md',
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  '.env.example',
  'package.json',
  'run-hidden.vbs',
  'start.cmd',
  'start.ps1',
  'status.cmd',
  'pause.cmd',
  'resume.cmd',
  'stop.cmd',
  path.join('dsh-home', 'cordis.patch.yml'),
];

/** 要排除的文件（按相对路径）。前几项是隐私数据，后几项是作者专属。 */
export const EXCLUDE = [
  // 隐私：你自己的 QQ 号
  path.join('config', 'bot.config.json'),
  // 运行期生成的临时文件
  path.join('tools', 'probe-output.txt'),
  path.join('tools', 'selftest.config.json'),
  path.join('tools', 'selftest-memory.json'),
  path.join('tools', 'selftest-output.txt'),
  // 作者专属：公开仓库里只该有给使用者的文档和工具
  'MAINTAINING.md',
  path.join('tools', 'publish.mjs'),
  path.join('tools', 'sync-repo.mjs'),
];

/** 一律不带走的目录名 */
export const EXCLUDE_NAMES = new Set(['node_modules', '__pycache__', '.DS_Store', '.git']);

/**
 * 算出发布包应该包含哪些文件。
 * @param {string} root 开发目录
 * @returns {{rel:string, abs:string}[]}
 */
export function collectPackFiles(root) {
  const out = [];
  const walk = (dir, relBase) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE_NAMES.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = relBase ? path.join(relBase, e.name) : e.name;
      if (EXCLUDE.includes(rel)) continue;
      if (e.isDirectory()) walk(abs, rel);
      else out.push({ rel, abs });
    }
  };
  for (const f of INCLUDE_FILES) {
    const abs = path.join(root, f);
    if (fs.existsSync(abs)) out.push({ rel: f, abs });
  }
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) walk(abs, d);
  }
  return out;
}
