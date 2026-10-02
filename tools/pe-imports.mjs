/**
 * 诊断：读取一个 Windows PE（.node/.dll）的导入表，列出它依赖哪些 DLL，
 * 并检查每个依赖在当前环境下能否被找到。
 *
 * 用途：定位 "The specified module could not be found" 这类加载失败到底缺了什么。
 * 用法: node pe-imports.mjs <目标文件> <附加搜索目录...>
 */
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
const extraDirs = process.argv.slice(3);
if (!target) {
  console.error('用法: node pe-imports.mjs <目标文件> [附加搜索目录...]');
  process.exit(1);
}

const buf = fs.readFileSync(target);

// ---- 解析 PE 头 ----
const peOff = buf.readUInt32LE(0x3c);
if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件');
const coff = peOff + 4;
const machine = buf.readUInt16LE(coff);
const numSections = buf.readUInt16LE(coff + 2);
const sizeOpt = buf.readUInt16LE(coff + 16);
const opt = coff + 20;
const magic = buf.readUInt16LE(opt);
const is64 = magic === 0x20b;
const dataDir = opt + (is64 ? 112 : 96);
const importRva = buf.readUInt32LE(dataDir + 8);
const importSize = buf.readUInt32LE(dataDir + 12);

console.log(`文件      : ${target}`);
console.log(`架构      : ${is64 ? 'x64' : 'x86'} (machine=0x${machine.toString(16)})`);
console.log(`导入表RVA : 0x${importRva.toString(16)} (size=${importSize})`);

// ---- 节表：RVA -> 文件偏移 ----
const sections = [];
const secOff = opt + sizeOpt;
for (let i = 0; i < numSections; i += 1) {
  const s = secOff + i * 40;
  sections.push({
    name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
    vsize: buf.readUInt32LE(s + 8),
    vaddr: buf.readUInt32LE(s + 12),
    rawSize: buf.readUInt32LE(s + 16),
    rawPtr: buf.readUInt32LE(s + 20),
  });
}
const rvaToOff = (rva) => {
  for (const s of sections) {
    if (rva >= s.vaddr && rva < s.vaddr + Math.max(s.vsize, s.rawSize)) {
      return s.rawPtr + (rva - s.vaddr);
    }
  }
  return null;
};

// ---- 遍历导入描述符 ----
const imports = [];
let off = rvaToOff(importRva);
if (off == null) {
  console.log('解析不到导入表（RVA 不在任何节内）');
  process.exit(0);
}
for (let i = 0; i < 4096; i += 1) {
  const d = off + i * 20;
  const nameRva = buf.readUInt32LE(d + 12);
  const firstThunk = buf.readUInt32LE(d + 16);
  if (nameRva === 0 && firstThunk === 0) break;
  const nameOff = rvaToOff(nameRva);
  if (nameOff == null) break;
  let end = nameOff;
  while (end < buf.length && buf[end] !== 0) end += 1;
  imports.push(buf.toString('ascii', nameOff, end));
}

// ---- 检查每个依赖能否找到 ----
const searchDirs = [
  path.dirname(path.resolve(target)), // 加载模块所在目录（Windows 优先）
  'C:\\Windows\\System32',
  ...extraDirs.filter(Boolean),
  ...(process.env.PATH || '').split(';').filter(Boolean),
];

console.log(`\n共依赖 ${imports.length} 个 DLL：\n`);
let missing = 0;
for (const dll of imports) {
  const found = searchDirs.find((dir) => {
    try {
      return fs.existsSync(path.join(dir, dll));
    } catch {
      return false;
    }
  });
  if (found) {
    console.log(`  [OK]      ${dll.padEnd(34)} ${found}`);
  } else {
    missing += 1;
    console.log(`  [缺失]    ${dll.padEnd(34)} 在所有搜索路径里都没找到`);
  }
}
console.log(`\n结论：缺失 ${missing} 个依赖 DLL`);
