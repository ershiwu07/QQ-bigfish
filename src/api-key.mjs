/**
 * API Key 自检。走 /models 接口，**不消耗 token**。
 *
 * 为什么值得单独做一件事：Key 被吊销／过期／欠费时，SDK **不会抛异常**，
 * 而是把错误放在返回值里（reason.error）。于是程序表面一切正常，
 * 只是"收到消息却一声不吭"——看起来和"程序坏了"一模一样，极难排查。
 * 所以这里在启动阶段就主动问一次。
 */

/** DSH 走的是 Anthropic 兼容端点（…/anthropic/v1），而 /models 挂在站点根上。 */
function modelsUrl() {
  const base = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com')
    .replace(/\/anthropic\/v1\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  return `${base}/models`;
}

/**
 * @returns {Promise<true|false|null>} true=有效；false=无效（401/403）；null=无法判断（没填或网络不通）
 */
export async function checkApiKey(logger) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    logger?.warn('没有读到 DEEPSEEK_API_KEY（.env 里没填？）——她将无法回话。');
    return null;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(modelsUrl(), {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      logger?.info('API Key 自检通过。');
      return true;
    }
    const body = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      logger?.error(`★ API Key 无效（HTTP ${res.status}）——她能收消息、能记事，但一句话也说不出来。`);
      logger?.error('  → 去 DeepSeek 平台生成新 Key，填进 .env 的 DEEPSEEK_API_KEY，然后重启机器人。');
      return false;
    }
    logger?.warn(`API Key 自检没通过（HTTP ${res.status}）：${body.slice(0, 160)}`);
    return null;
  } catch (err) {
    // 网络不通不算致命（可能只是这台机器暂时连不上），返回 null 让调用方自行决定。
    logger?.warn(`API Key 自检跳过（网络问题）：${err.message}`);
    return null;
  }
}
