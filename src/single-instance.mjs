/**
 * 单实例保护。
 *
 * 为什么需要：现在有多个入口都能启动机器人（计划任务开机自启、桌面快捷方式、手敲命令）。
 * 同时跑两个实例会导致**同一条消息被回复两次**，而且两个实例还会互相覆盖同一份
 * state/memory.json。所以启动时先抢一个锁文件；抢不到说明已经有一个在跑，直接退出。
 *
 * 实现要点：
 * - 用 `wx` 标志原子创建锁文件，避免两个进程同时启动时的竞态。
 * - 锁文件里记 PID；如果持锁进程已经死了（比如上次崩溃/被强杀），锁就是「陈旧锁」，
 *   直接抢过来，否则崩溃之后再也起不来了。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 进程是否还活着：signal 0 只做权限/存在性检查，不真的发信号。 */
function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明进程存在但不属于我们，仍算活着
    return err && err.code === 'EPERM';
  }
}

function readPid(file) {
  try {
    return Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
  } catch {
    return NaN;
  }
}

/**
 * @returns {{release: () => void, pid: number, stole: boolean}|null}
 *          返回 null 表示已有一个存活的实例在跑。
 */
export function acquireSingleInstance(lockFile) {
  const self = process.pid;
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  } catch {
    /* 建不了目录就继续试写文件 */
  }

  const makeHandle = (stole) => ({
    pid: self,
    stole,
    release: () => {
      try {
        if (readPid(lockFile) === self) fs.unlinkSync(lockFile);
      } catch {
        /* 文件已经被别人删了就算了 */
      }
    },
  });

  // 原子创建：成功就说明我们是唯一持有者
  try {
    fs.writeFileSync(lockFile, String(self), { flag: 'wx' });
    return makeHandle(false);
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  const other = readPid(lockFile);
  if (other === self) return makeHandle(false); // 理论上不会发生
  if (isAlive(other)) return null; // 真的有人在跑

  // 陈旧锁：持锁进程已死，抢过来
  try {
    fs.writeFileSync(lockFile, String(self));
    return makeHandle(true);
  } catch {
    return null;
  }
}
