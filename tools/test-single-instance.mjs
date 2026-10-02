/**
 * 单实例保护的验证：父进程持锁 → 子进程必须被拦下；陈旧锁必须能被接管。
 * 用法: node tools/test-single-instance.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireSingleInstance } from '../src/single-instance.mjs';

const lock = path.join(os.tmpdir(), 'bigfish-lock-test.lock');
const self = process.argv[1];

if (process.argv[2] === 'child') {
  const h = acquireSingleInstance(lock);
  process.stdout.write(h ? 'CHILD_GOT_LOCK' : 'CHILD_BLOCKED');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  [PASS] ${name}${detail ? '  (' + detail + ')' : ''}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
};

fs.rmSync(lock, { force: true });

// 1) 父进程持锁，子进程应被拦下
const a = acquireSingleInstance(lock);
check('父进程能拿到锁', !!a);
const r = spawnSync(process.execPath, [self, 'child'], { encoding: 'utf8' });
const childOut = (r.stdout || '').trim();
check('子进程被正确拦下（不会双开）', childOut === 'CHILD_BLOCKED', childOut || r.stderr?.trim());

// 2) 释放后，新进程应能拿到
a.release();
check('释放后锁文件被删掉', !fs.existsSync(lock));
const c = acquireSingleInstance(lock);
check('释放后可以重新拿锁', !!c);
c.release();

// 3) 陈旧锁（持锁进程已死）应被接管，否则崩溃后就再也起不来
fs.writeFileSync(lock, '999999');
const d = acquireSingleInstance(lock);
check('陈旧锁能被接管（防止崩溃后起不来）', !!d && d.stole === true, d ? `stole=${d.stole}` : 'null');
d?.release();

// 4) PID 复用风险之外：锁文件内容应是我们自己的 pid
fs.writeFileSync(lock, String(process.pid));
const e = acquireSingleInstance(lock);
check('锁文件里是自己 PID 时视为已持有', !!e, e ? `stole=${e.stole}` : 'null');
e?.release();

fs.rmSync(lock, { force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
