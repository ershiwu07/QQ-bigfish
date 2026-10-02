/**
 * 带时间戳、带级别、可同时写文件的分级日志。
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

export function createLogger({ level = 'info', file = null, scope = 'bot' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  if (file) {
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    stream = fs.createWriteStream(abs, { flags: 'a' });
  }

  const write = (lvl, args) => {
    if (LEVELS[lvl] > threshold) return;
    const line = `${ts()} [${lvl.toUpperCase().padEnd(5)}] [${scope}] ${args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ')}`;
    // stderr 用于 warn/error，stdout 用于 info/debug，方便管道分离
    if (lvl === 'warn' || lvl === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    if (stream) stream.write(line + '\n');
  };

  return {
    error: (...a) => write('error', a),
    warn: (...a) => write('warn', a),
    info: (...a) => write('info', a),
    debug: (...a) => write('debug', a),
    child: (childScope) => createLogger({ level, file, scope: `${scope}:${childScope}` }),
    close: () => stream?.end(),
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
