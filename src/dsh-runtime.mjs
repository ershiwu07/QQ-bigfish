/**
 * DSH（DeepSeek Harness）长驻运行时客户端。
 *
 * 设计要点：
 * - 用 `dsh --profile sdk-minimal` 起一个**长驻**子进程，通过 stdin/stdout 说
 *   newline-delimited JSON-RPC 2.0（协议见 @deepseek-ai/dsh-sdk-protocol）。
 *   这样每条 QQ 消息只是一次请求，不用重启进程，延迟远低于「每条消息起一个 dsh」。
 * - 一个进程服务所有 QQ 会话：sessionId 就是 DSH 的 session 身份，DSH 会把
 *   会话历史持久化到 $DSH_HOME/sessions，于是每个 QQ 会话天然拥有多轮记忆。
 * - 按 sessionId 串行化：同一个会话同时只跑一轮；不同会话可以并行。
 * - 协议没有 cancel 方法（客户端只能靠关闭进程放弃一轮），所以超时的处理方式是
 *   **杀掉并重启运行时**，然后返回兜底回复。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 在某个目录下按 `<dir>/<版本>/node_modules/@deepseek-ai/dsh/lib/bin.js` 找一遍。 */
function scanUnder(root) {
  const out = [];
  try {
    for (const dir of fs.readdirSync(root)) {
      out.push(path.join(root, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    }
  } catch {
    /* 目录不存在就算了 */
  }
  return out;
}

/** 在某个目录下按 `<dir>/<node版本>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 找一遍（nvm 的布局）。 */
function scanNvm(root) {
  const out = [];
  try {
    for (const ver of fs.readdirSync(root)) {
      out.push(path.join(root, ver, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    }
  } catch {
    /* 没装 nvm 就算了 */
  }
  return out;
}

/** 在常见的 dsh 安装位置里找 `@deepseek-ai/dsh/lib/bin.js`。 */
export function resolveDshBin(explicit, projectDir = process.cwd()) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.DSH_BIN) candidates.push(process.env.DSH_BIN);

  const home = os.homedir();

  // ① 项目里自己装的那份（npm i @deepseek-ai/dsh）——新克隆的仓库最可能命中这个
  candidates.push(path.join(projectDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));

  // ② npx 缓存。Windows 在 %LOCALAPPDATA%\npm-cache\_npx，其它平台在 ~/.npm/_npx
  candidates.push(...scanUnder(path.join(home, 'AppData', 'Local', 'npm-cache', '_npx')));
  candidates.push(...scanUnder(path.join(home, '.npm', '_npx')));

  // ③ nvm 装的 node（Linux/macOS 上很常见）
  candidates.push(...scanNvm(path.join(home, '.nvm', 'versions', 'node')));

  // ④ 全局安装
  candidates.push(
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  );

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error(
    '找不到 dsh 入口（@deepseek-ai/dsh/lib/bin.js）。三种解决办法，任选一种：\n' +
      '  1) 在项目目录里装一份：  npm i @deepseek-ai/dsh\n' +
      '  2) 让它进 npx 缓存：    npx --yes @deepseek-ai/dsh --version\n' +
      '  3) 手动指定：          设环境变量 DSH_BIN，或写进 config/bot.config.json 的 dsh.bin\n' +
      '已尝试过的位置：\n  ' +
      candidates.join('\n  '),
  );
}

/** 从 assistant/message 事件里取出纯文本。 */
function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

export class DshRuntime extends EventEmitter {
  constructor({
    dshBin,
    dshHome,
    projectDir,
    profile = 'sdk-minimal',
    provider = 'deepseek-official',
    model = 'deepseek-flash',
    reasoningEffort = null,
    maxTokens = null,
    apiKey,
    persona = '',
    logger,
    env = {},
    initializeTimeoutMs = 60000,
    turnTimeoutMs = 120000,
  }) {
    super();
    this.dshBin = dshBin;
    this.dshHome = path.resolve(dshHome);
    this.projectDir = path.resolve(projectDir);
    this.profile = profile;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.maxTokens = maxTokens;
    this.apiKey = apiKey;
    this.persona = persona;
    this.logger = logger;
    this.extraEnv = env;
    this.initializeTimeoutMs = initializeTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // 请求 id -> {resolve, reject, timer, method}
    this.turns = new Map(); // sessionId -> {resolve, reject, texts, timer}
    this.queues = new Map(); // sessionId -> Promise（串行化同一会话）
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.stopping = false;
    this.ready = false;
    this.readyPromise = null;
    this.restartAttempts = 0;
    this.stats = { prompts: 0, turns: 0, failures: 0, restarts: 0, startedAt: null };
  }

  /** 启动子进程并完成 initialize 握手。可重复调用（会先停掉旧的）。 */
  async start() {
    this.stopping = false;
    this.readyPromise = this.#spawnAndHandshake();
    return this.readyPromise;
  }

  #buildEnv() {
    const env = {
      ...process.env,
      ...this.extraEnv,
      DSH_HOME: this.dshHome,
      DSH_SYSTEM_PROMPT: this.persona,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    if (this.apiKey) env.DEEPSEEK_API_KEY = this.apiKey;
    return env;
  }

  async #spawnAndHandshake() {
    const env = this.#buildEnv();
    fs.mkdirSync(this.dshHome, { recursive: true });

    this.logger?.info(`启动 DSH 运行时：profile=${this.profile} model=${this.model}`);
    this.logger?.debug(`DSH_HOME=${this.dshHome}`);

    this.child = spawn(process.execPath, [this.dshBin, '--profile', this.profile], {
      cwd: this.projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.child.on('error', (err) => {
      this.logger?.error('DSH 运行时进程错误：', err.message);
      this.#failAll(new Error(`DSH 进程错误：${err.message}`));
    });
    this.child.on('exit', (code, signal) => this.#onExit(code, signal));

    this.ready = false;
    const params = { cwd: this.projectDir, provider: this.provider, model: this.model };
    if (this.reasoningEffort) params.reasoningEffort = this.reasoningEffort;
    if (this.maxTokens) params.maxTokens = this.maxTokens;

    let result;
    try {
      result = await this.#request('initialize', params, this.initializeTimeoutMs);
    } catch (err) {
      // reasoningEffort / maxTokens 不被该路由接受时，退一步再试一次，避免整机不可用。
      if (this.reasoningEffort || this.maxTokens) {
        this.logger?.warn(`initialize 失败（${err.message}），去掉 reasoningEffort/maxTokens 重试…`);
        const bare = { cwd: this.projectDir, provider: this.provider, model: this.model };
        result = await this.#request('initialize', bare, this.initializeTimeoutMs);
      } else {
        throw err;
      }
    }

    this.ready = true;
    this.restartAttempts = 0;
    this.stats.startedAt = Date.now();
    this.logger?.info(`DSH 运行时就绪：${result?.serverInfo?.name ?? 'unknown'} ${result?.serverInfo?.version ?? ''}`);
    this.emit('ready', result);
    return result;
  }

  #onStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger?.warn('DSH stdout 出现非 JSON 行（已忽略）：', line.slice(0, 200));
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onStderr(chunk) {
    this.stderrBuf += chunk;
    let idx;
    while ((idx = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      if (line.trim()) this.logger?.debug('dsh:', line.slice(0, 500));
    }
  }

  #onMessage(msg) {
    // 响应
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || 'DSH 请求失败');
        e.code = msg.error.code;
        e.data = msg.error.data;
        entry.reject(e);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 通知
    if (msg.method === 'session.event') {
      this.#onSessionEvent(msg.params);
      return;
    }
    if (msg.method === 'session.status') {
      this.emit('status', msg.params);
      this.logger?.debug(`会话状态 ${msg.params?.sessionId}: ${msg.params?.status}`);
      return;
    }
    this.emit('notification', msg);
  }

  #onSessionEvent({ sessionId, event } = {}) {
    if (!sessionId || !event) return;
    const turn = this.turns.get(sessionId);
    this.emit('session-event', { sessionId, event });
    if (!turn) return;

    if (event.type === 'assistant/message') {
      const text = extractAssistantText(event.data?.message);
      if (text) turn.texts.push(text);
      return;
    }
    if (event.type === 'assistant/attempt') {
      // 模型这次尝试没有产出可见内容（被重试/取消/流错误），记一笔便于排查
      this.logger?.debug(`会话 ${sessionId} 有一次未产出内容的模型尝试`);
      return;
    }
    if (event.type === 'tool/call') {
      // v1 没有工具；真出现了说明配置被改过，值得警告
      this.logger?.warn(`会话 ${sessionId} 发起了工具调用：${event.data?.name}（本应无工具）`);
      return;
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason ?? { kind: 'unknown' };
      this.#settleTurn(sessionId, {
        text: turn.texts.join('\n').trim(),
        reason,
        turn: event.data?.turn,
      });
    }
  }

  #settleTurn(sessionId, outcome) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    clearTimeout(turn.timer);
    this.stats.turns += 1;
    turn.resolve(outcome);
  }

  #rejectTurn(sessionId, err) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    clearTimeout(turn.timer);
    this.stats.failures += 1;
    turn.reject(err);
  }

  #failAll(err) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    for (const sid of [...this.turns.keys()]) this.#rejectTurn(sid, err);
  }

  #onExit(code, signal) {
    const wasReady = this.ready;
    this.ready = false;
    this.#failAll(new Error(`DSH 运行时已退出（code=${code} signal=${signal}）`));
    if (this.stopping) {
      this.logger?.info('DSH 运行时已停止');
      this.emit('stopped');
      return;
    }
    this.logger?.error(`DSH 运行时意外退出（code=${code} signal=${signal}），准备重启`);
    this.emit('crashed', { code, signal });
    if (wasReady) this.#scheduleRestart();
  }

  #scheduleRestart() {
    if (this.stopping) return;
    this.restartAttempts += 1;
    this.stats.restarts += 1;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this.restartAttempts - 1, 4));
    this.logger?.warn(`${delay}ms 后重启 DSH 运行时（第 ${this.restartAttempts} 次）`);
    setTimeout(() => {
      if (this.stopping) return;
      this.readyPromise = this.#spawnAndHandshake().catch((err) => {
        this.logger?.error('DSH 运行时重启失败：', err.message);
        this.#scheduleRestart();
        throw err;
      });
      // 避免未处理的 rejection 让进程崩掉
      this.readyPromise.catch(() => {});
    }, delay);
  }

  #request(method, params, timeoutMs) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('DSH 运行时进程不可用'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new Error(`DSH 请求超时：${method}`);
        e.code = 'REQUEST_TIMEOUT';
        reject(e);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 同一会话的请求排队执行，保证一个会话同时只有一轮。 */
  #enqueue(sessionId, task) {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // 队列本身吞掉异常，避免未处理 rejection；错误由 task 的调用方处理
    this.queues.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * 向某个会话发一条用户消息，等这一轮跑完，返回 {text, reason}。
   * @param {string} sessionId DSH 会话身份（未知则懒创建）
   * @param {string} text 用户消息
   * @param {{timeoutMs?:number, extraBlocks?:Array}} options
   *        extraBlocks 用来附带图片（SdkEncodedImageBlock，见 media.mjs）
   */
  async ask(sessionId, text, { timeoutMs = this.turnTimeoutMs, extraBlocks = [] } = {}) {
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (err) {
        throw new Error(`DSH 运行时尚不可用：${err.message}`);
      }
    }
    return this.#enqueue(sessionId, async () => {
      if (this.turns.has(sessionId)) {
        throw new Error(`会话 ${sessionId} 已有一轮在进行中`);
      }
      const turnPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.turns.delete(sessionId);
          const e = new Error(`DSH 一轮回复超时（${timeoutMs}ms）`);
          e.code = 'TURN_TIMEOUT';
          // 协议没有 cancel，只能重启运行时来放弃这一轮
          this.logger?.warn(`会话 ${sessionId} 超时，重启运行时以放弃该轮`);
          this.#hardRestart();
          reject(e);
        }, timeoutMs);
        this.turns.set(sessionId, { resolve, reject, texts: [], timer });
      });
      // 安全网：下面 session/prompt 失败时我们会 reject 这个 promise 并把错误抛给调用方，
      // 但那时它已经没人 await 了 —— 不加这个 catch，Node 会把它当成未处理的 rejection
      // 直接杀掉进程。挂一个空 handler 只是把「已处理」标上，调用方依然能看到 rejection。
      turnPromise.catch(() => {});

      try {
        const contentBlocks = [{ type: 'text', text }];
        for (const b of extraBlocks) {
          if (b && b.type) contentBlocks.push(b);
        }
        if (extraBlocks.length) {
          this.logger?.debug(`本次附带 ${extraBlocks.length} 张图片`);
        }
        await this.#request(
          'session/prompt',
          { sessionId, contentBlocks },
          Math.min(30000, timeoutMs),
        );
        this.stats.prompts += 1;
      } catch (err) {
        this.#rejectTurn(sessionId, err);
        throw err;
      }
      return turnPromise;
    });
  }

  /** 杀掉当前进程并重新起一个（用于放弃卡住的一轮）。 */
  #hardRestart() {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    } else {
      this.#scheduleRestart();
    }
  }

  async stop({ graceful = true } = {}) {
    this.stopping = true;
    if (!this.child || this.child.killed) {
      this.emit('stopped');
      return;
    }
    if (graceful) {
      try {
        await this.#request('shutdown', undefined, 5000);
      } catch {
        /* 关不掉就直接 kill */
      }
    }
    const child = this.child;
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.stopping = true;
  }
}
