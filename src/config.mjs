/**
 * 配置加载：把 config/bot.config.json 与内置默认值合并，并解析相对路径。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  onebot: {
    mode: 'forward',
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    expectSelfId: '',
    reverse: { host: '127.0.0.1', port: 3002, path: '/onebot' },
  },
  dsh: {
    bin: '',
    dshHome: 'dsh-home',
    profile: 'sdk-minimal',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
    maxTokens: 1200,
    turnTimeoutMs: 120000,
    initializeTimeoutMs: 60000,
    sessionPrefix: 'qq',
    sessionRotateTurns: 300,
    personaFile: 'config/persona.md',
    pruneStaleSessions: true,
  },
  memory: {
    enabled: true,
    file: 'state/memory.json',
    maxChats: 2000,
    // 每个会话保留多少条对话流水。**它不影响每轮提示词大小**
    // （提示词只取 context.recentXxxMessages 条，还有 context.maxChars 兜着），
    // 所以放宽到 160 几乎没有成本，却能把一整晚的对话留住。
    maxPerChat: 160,
    maxNotesPerChat: 60,
    maxFactsPerMember: 40,
  },
  learning: {
    enabled: true,
    everyMessages: 25,
    maxMessagesPerDigest: 30,
  },
  images: {
    enabled: true,
    maxPerMessage: 3,
    maxBytes: 4194304,
    timeoutMs: 15000,
    pruneKeepDays: 7,
    lookbackMs: 300000,
    considerAmbient: true,
    alwaysLook: true,
    retry: 1,
  },
  /**
   * 养她、部署她的人。认得出这个人，是她自我认知的一部分。
   * 名字和 QQ 号都填上：她在提示词里会一直看到，群里出现就能认出来。
   */
  owner: {
    name: '',
    userId: '',
    aliases: [],
    note: '',
  },
  trigger: {
    private: 'all',
    group: 'at_or_keyword',
    keywords: ['大肥鱼', '肥鱼', '鲸鱼娘'],
    mutedGroups: [],
    groupWhitelist: [],
    alwaysReplyGroups: [],
    privateWhitelist: [],
    privateBlocklist: [],
    ignoreAtAll: false,
    ignoreSelf: true,
    selfDecide: false,
    replyToEmptyAt: true,
    replyChance: 1,
  },
  limits: {
    minIntervalPerChatMs: 2500,
    afterReplyCooldownMs: 0,
    directedGapMs: 1200,
    maxDirectedPerMinute: 12,
    maxParkedPerChat: 3,
    maxRepliesPerChatPerMinute: 8,
    maxRepliesPerChatPerHour: 60,
    globalMaxRepliesPerMinute: 30,
    keywordCooldownMs: 60000,
    dedupeWindowMs: 120000,
  },
  context: { recentGroupMessages: 8, recentPrivateMessages: 6, maxChars: 1500 },
  output: {
    maxCharsPerMessage: 400,
    maxSegments: 3,
    typingDelayMinMs: 600,
    typingDelayMaxMs: 1800,
    segmentDelayMinMs: 500,
    segmentDelayMaxMs: 1400,
    splitLongReplies: true,
  },
  fallback: { onTimeout: '……脑子卡了一下，你再说一遍？', onError: '' },
  logging: { level: 'info', file: 'logs/bot.log', logMessages: true },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：数组按「整体替换」处理（配置里的名单要能覆盖默认值）。 */
export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith('_')) continue; // 忽略 _note 之类的说明字段
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

const toNumArray = (v) =>
  (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .filter((x) => x !== '' && x !== null && x !== undefined)
    .map((x) => String(x));

export function loadConfig(projectDir, configPath = 'config/bot.config.json') {
  const abs = path.isAbsolute(configPath) ? configPath : path.join(projectDir, configPath);

  // 首次运行：把模板复制成正式配置。
  // 为什么这么做：正式配置里要填你自己的 QQ 号，所以它被 .gitignore 排除；
  // 仓库里只放 bot.config.example.json。这样既能开箱即跑，又不会把私人信息推上去。
  if (!fs.existsSync(abs)) {
    const example = abs.replace(/\.json$/i, '.example.json');
    if (fs.existsSync(example)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(example, abs);
      console.log(`\n首次运行：已从模板创建配置文件`);
      console.log(`  ${path.relative(projectDir, example)}  →  ${path.relative(projectDir, abs)}`);
      console.log(`  ★ 请打开它，把 onebot.expectSelfId 填成你的机器人 QQ 号，然后重新启动。\n`);
    }
  }

  let raw = {};
  if (fs.existsSync(abs)) {
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (err) {
      throw new Error(`配置文件解析失败（${abs}）：${err.message}`);
    }
  }
  const config = deepMerge(DEFAULT_CONFIG, raw);
  config.__path = abs;
  config.__projectDir = projectDir;

  // 群号/QQ 号统一成字符串，避免 JSON 里写数字还是字符串的差异
  for (const key of ['mutedGroups', 'groupWhitelist', 'alwaysReplyGroups', 'privateWhitelist', 'privateBlocklist']) {
    config.trigger[key] = toNumArray(config.trigger[key]);
  }
  config.trigger.keywords = (config.trigger.keywords || []).filter((k) => typeof k === 'string' && k.length > 0);

  // 路径解析
  config.dsh.absoluteHome = path.isAbsolute(config.dsh.dshHome)
    ? config.dsh.dshHome
    : path.join(projectDir, config.dsh.dshHome);
  config.dsh.absolutePersona = path.isAbsolute(config.dsh.personaFile)
    ? config.dsh.personaFile
    : path.join(projectDir, config.dsh.personaFile);
  config.memory.absoluteFile = config.memory.file
    ? path.isAbsolute(config.memory.file)
      ? config.memory.file
      : path.join(projectDir, config.memory.file)
    : null;
  config.logging.absoluteFile = config.logging.file
    ? path.isAbsolute(config.logging.file)
      ? config.logging.file
      : path.join(projectDir, config.logging.file)
    : null;

  // 合法性检查
  if (!['forward', 'reverse'].includes(config.onebot.mode)) {
    throw new Error(`onebot.mode 只能是 forward 或 reverse，当前是 ${config.onebot.mode}`);
  }
  if (!fs.existsSync(config.dsh.absolutePersona)) {
    throw new Error(`人设文件不存在：${config.dsh.absolutePersona}`);
  }
  // 没填 expectSelfId 时不阻塞启动，但要说清楚风险：
  // 填了它才能在 NapCat 登错号（比如手滑登上主号）时拒绝回复。
  if (!String(config.onebot.expectSelfId || '').trim()) {
    config.__warnNoSelfId =
      'onebot.expectSelfId 是空的：现在不会校验登录号。' +
      '强烈建议填上机器人小号的 QQ —— 万一 NapCat 登错号（比如上了你的主号），它才会拒绝回复。';
  }
  return config;
}

export function loadPersona(config) {
  return fs.readFileSync(config.dsh.absolutePersona, 'utf8').trim();
}
