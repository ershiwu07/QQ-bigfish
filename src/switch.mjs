/**
 * 「快速停止」开关。
 *
 * 为什么需要两层：
 *   1. 想让程序完全停下来  → tools/stop.mjs（杀进程）
 *   2. 只是让她别说话了    → 这个开关。她还在听、还在记事，只是不回话、不花钱。
 *      群里她要是说上瘾了，这个比杀进程实用得多（杀进程再起来要 2 分钟）。
 *
 * 开关状态存在 state/paused.json，支持「暂停 N 分钟」，到点自动恢复，
 * 所以不会出现"忘了恢复，以为程序坏了"。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createSwitch({ file, logger } = {}) {
  let data = { paused: false, until: 0, by: '', reason: '' };

  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (raw && typeof raw === 'object') data = { ...data, ...raw };
      }
    } catch (err) {
      logger?.warn?.(`读取暂停开关失败（当作未暂停）：${err.message}`);
    }
    return data;
  }

  function save() {
    try {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger?.warn?.(`写入暂停开关失败：${err.message}`);
    }
  }

  /** 现在是否处于暂停（到点会自动恢复） */
  function isPaused() {
    if (!data.paused) return false;
    if (data.until && Date.now() >= data.until) {
      data = { paused: false, until: 0, by: data.by || '', reason: '到点自动恢复' };
      save();
      logger?.info?.('暂停时间到，她恢复说话了');
      return false;
    }
    return true;
  }

  /**
   * @param {{minutes?:number, by?:string, reason?:string}} opts
   *        minutes 传 0 或负数表示「一直暂停，直到手动恢复」
   */
  function pause({ minutes = 30, by = '', reason = '' } = {}) {
    const m = Number(minutes);
    data = {
      paused: true,
      until: Number.isFinite(m) && m > 0 ? Date.now() + m * 60000 : 0,
      by: String(by || ''),
      reason: String(reason || ''),
    };
    save();
    return status();
  }

  function resume({ by = '' } = {}) {
    data = { paused: false, until: 0, by: String(by || ''), reason: '' };
    save();
    return status();
  }

  function status() {
    const paused = isPaused();
    return {
      paused,
      until: data.until || 0,
      untilText: data.until ? new Date(data.until).toLocaleString('zh-CN') : '',
      remainingMinutes:
        paused && data.until ? Math.max(0, Math.round((data.until - Date.now()) / 60000)) : 0,
      forever: paused && !data.until,
      by: data.by || '',
    };
  }

  load();
  return { isPaused, pause, resume, status, reload: load };
}

/** 只认「以控制词开头」的消息，避免把"早点休息"这种闲聊误判成命令 */
const PAUSE_WORDS = /^(暂停|静音|闭嘴|别说了|安静|先别说话|别说话了)/;
const RESUME_WORDS = /^(恢复|继续|可以说话|醒醒|出来吧|解除静音|继续说话)/;

/**
 * 解析管理指令（只有老板能触发）。
 * @returns {{kind:'pause'|'resume', minutes?:number}|null}
 */
export function parseControlCommand(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  if (PAUSE_WORDS.test(t)) {
    const m = t.match(/(\d+)\s*(分钟|分|小时|时|h|min)?/i);
    let minutes = 30;
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) minutes = /小时|时|h/i.test(m[2] || '') ? n * 60 : n;
    }
    return { kind: 'pause', minutes };
  }
  if (RESUME_WORDS.test(t)) return { kind: 'resume' };
  return null;
}
